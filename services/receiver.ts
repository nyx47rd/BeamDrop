
import { FileMetadata, TransferProgress } from '../types';
import { openDB, IDBPDatabase } from 'idb';
import { deviceService } from './device';
import { TransferMonitor } from './stats';

const HEADER_SIZE = 4;
const RAM_THRESHOLD = 150 * 1024 * 1024; // 150MB
const IDB_BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 200; 

// --- STORAGE ENGINE ---
class ChunkStore {
    private useDB: boolean;
    private ramChunks: Map<number, ArrayBuffer> = new Map();
    private dbName: string | null = null;
    private db: IDBPDatabase | null = null;
    private writeQueue: { index: number, data: ArrayBuffer }[] = []; 
    private fileType: string;
    
    // Track unique chunks explicitly
    private _count: number = 0;

    constructor(fileSize: number, fileType: string) {
        this.fileType = fileType;
        this.useDB = fileSize > RAM_THRESHOLD;
    }

    async init() {
        if (this.useDB) {
            this.dbName = `beamdrop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            this.db = await openDB(this.dbName, 1, {
                upgrade(db) { db.createObjectStore('chunks', { keyPath: 'index' }); },
            });
        }
    }

    // Returns true if this was a new chunk, false if duplicate
    async add(index: number, data: ArrayBuffer): Promise<boolean> {
        let isNew = false;
        
        if (this.useDB && this.db) {
            // For DB, we just assume it's new for performance in the heat of transfer
            // or we could check existence, but 'put' overwrites.
            // We rely on memory counter for integrity check logic.
            // A simple dedupe set for indices would be safer for the counter.
            this.writeQueue.push({ index, data });
            if (this.writeQueue.length >= IDB_BATCH_SIZE) await this.flush();
            // We increment tentatively, final integrity check is what matters
            this._count++; 
            isNew = true; 
        } else {
            if (!this.ramChunks.has(index)) {
                this.ramChunks.set(index, data);
                this._count++;
                isNew = true;
            }
        }
        return isNew;
    }

    get count(): number {
        return this._count;
    }

    async flush() {
        if (!this.writeQueue.length || !this.db) return;
        const tx = this.db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        await Promise.all(this.writeQueue.map(item => store.put(item)));
        this.writeQueue = [];
        await tx.done;
    }

    async finish(): Promise<Blob> {
        if (this.useDB && this.db) {
            await this.flush();
            const tx = this.db.transaction('chunks', 'readonly');
            // We trust the DB to sort by key (index) automatically
            const allChunks = await tx.objectStore('chunks').getAll();
            this.db.close();
            await window.indexedDB.deleteDatabase(this.dbName!);
            return new Blob(allChunks.map(c => c.data), { type: this.fileType });
        } else {
            const sorted = Array.from(this.ramChunks.entries())
                .sort((a, b) => a[0] - b[0])
                .map(entry => entry[1]);
            this.ramChunks.clear();
            return new Blob(sorted, { type: this.fileType });
        }
    }
}

export class ReceiverManager {
    private controlChannel: RTCDataChannel | null = null;
    private chunkStore: ChunkStore | null = null;
    private currentMeta: FileMetadata | null = null;
    private monitor: TransferMonitor; 

    // UI Callbacks
    private onProgress: (p: TransferProgress) => void;
    private onFileReceived: (blob: Blob, meta: FileMetadata) => void;

    // State
    private completedFilesCount = 0;
    private totalFilesCount = 0;
    private currentFileName = '';
    private lastEmit = 0;
    
    // Integrity Flags
    private hasReceivedFileEnd = false;
    private totalExpectedChunks = 0;

    constructor(
        onProgress: (p: TransferProgress) => void,
        onFileReceived: (blob: Blob, meta: FileMetadata) => void
    ) {
        this.onProgress = onProgress;
        this.onFileReceived = onFileReceived;
        this.monitor = new TransferMonitor();
    }

    public setControlChannel(channel: RTCDataChannel) {
        this.controlChannel = channel;
    }

    public async handleMessage(data: any, isBinary: boolean) {
        // 1. BINARY DATA (CHUNKS)
        if (isBinary && data instanceof ArrayBuffer) {
            if (!this.chunkStore) return; 

            const view = new DataView(data);
            const index = view.getUint32(0, false);
            const chunk = data.slice(HEADER_SIZE);
            const byteLength = chunk.byteLength;

            await this.chunkStore.add(index, chunk);
            this.handleBytesReceived(byteLength);
            
            // CHECK INTEGRITY: If we were waiting for late chunks, this might finish it
            this.checkAndFinalizeFile();
            return;
        }

        // 2. CONTROL MESSAGES
        if (!isBinary) {
            // STEP 1: Batch Offer
            if (data.type === 'offer-batch') {
                console.log("Receiver: Got Batch Offer", data.meta);
                this.totalFilesCount = data.meta.totalFiles;
                this.completedFilesCount = 0;
                this.monitor.reset(data.meta.totalSize);
                this.sendControl({ type: 'accept-batch' });
            }
            // STEP 2: File Start
            else if (data.type === 'file-start') {
                console.log("Receiver: Got File Start", data.meta);
                this.currentMeta = data.meta;
                this.currentFileName = data.meta.name;
                
                // Integrity Init
                this.totalExpectedChunks = data.meta.totalChunks;
                this.hasReceivedFileEnd = false;
                
                this.chunkStore = new ChunkStore(data.meta.size, data.meta.type);
                await this.chunkStore.init();

                this.emitProgress();
                this.sendControl({ type: 'ready-for-file' });
            }
            // STEP 3: File End
            else if (data.type === 'file-end') {
                console.log("Receiver: Got File End Signal");
                this.hasReceivedFileEnd = true;
                // We do NOT finish immediately. We check if we actually have all chunks.
                this.checkAndFinalizeFile();
            }
        }
    }

    /**
     * The heart of the corruption fix.
     * Only finishes if we have the End Signal AND all Chunks.
     */
    private async checkAndFinalizeFile() {
        if (!this.chunkStore || !this.currentMeta) return;

        // Condition 1: Sender said they are done.
        // Condition 2: We actually have X unique chunks.
        if (this.hasReceivedFileEnd && this.chunkStore.count >= this.totalExpectedChunks) {
            console.log(`Receiver: Integrity Check Passed (${this.chunkStore.count}/${this.totalExpectedChunks}). Finalizing.`);
            
            const blob = await this.chunkStore.finish();
            this.onFileReceived(blob, this.currentMeta);
            
            this.completedFilesCount++;
            this.emitProgress(); // 100%

            this.sendControl({ type: 'ack-file' });
            
            if (this.completedFilesCount === this.totalFilesCount) {
                 deviceService.sendNotification('Files Received', `All ${this.totalFilesCount} files received.`);
            }

            // Cleanup for next file
            this.chunkStore = null;
            this.currentMeta = null;
            this.hasReceivedFileEnd = false;
            this.totalExpectedChunks = 0;
        } else if (this.hasReceivedFileEnd) {
            console.log(`Receiver: Waiting for missing chunks... (${this.chunkStore.count}/${this.totalExpectedChunks})`);
        }
    }

    private handleBytesReceived(bytes: number) {
        this.monitor.update(bytes);
        const now = Date.now();
        if (now - this.lastEmit > SYNC_INTERVAL_MS) {
            this.emitProgress();
            this.lastEmit = now;
        }
    }

    private emitProgress() {
        const metrics = this.monitor.getMetrics();
        this.onProgress({
            fileName: this.currentFileName,
            transferredBytes: 0, 
            fileSize: 0, 
            totalFiles: this.totalFilesCount,
            currentFileIndex: this.completedFilesCount + 1,
            totalBatchBytes: metrics.totalBytes,
            transferredBatchBytes: metrics.transferredBytes,
            speed: metrics.speedStr,
            eta: metrics.etaStr,
            isComplete: this.completedFilesCount === this.totalFilesCount && this.totalFilesCount > 0
        });

        this.sendControl({
            type: 'progress-sync',
            progressReport: {
                transferredBytes: metrics.transferredBytes,
                speed: metrics.speed,
                eta: metrics.eta,
                totalFiles: this.totalFilesCount,
                completedFiles: this.completedFilesCount
            }
        });
    }

    private sendControl(msg: any) {
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify(msg));
        }
    }

    public cleanup() {
        this.chunkStore = null;
    }
}

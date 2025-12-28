
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
    
    // Track unique chunks for integrity AND retransmission logic
    private receivedIndices: Set<number> = new Set();

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

    async add(index: number, data: ArrayBuffer): Promise<boolean> {
        if (this.receivedIndices.has(index)) return false; // Deduplicate immediately

        this.receivedIndices.add(index);

        if (this.useDB && this.db) {
            this.writeQueue.push({ index, data });
            if (this.writeQueue.length >= IDB_BATCH_SIZE) await this.flush();
        } else {
            this.ramChunks.set(index, data);
        }
        return true;
    }

    get count(): number {
        return this.receivedIndices.size;
    }

    // New: Calculate exactly which chunks are missing
    getMissingIndices(totalExpected: number): number[] {
        const missing: number[] = [];
        // Iterate only up to totalExpected. 
        // For very large files, this loop is still fast (1GB = ~16k chunks).
        for (let i = 0; i < totalExpected; i++) {
            if (!this.receivedIndices.has(i)) {
                missing.push(i);
                // Cap the request to avoid exploding the control channel
                if (missing.length >= 500) break; 
            }
        }
        return missing;
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
    private retransmitTimeout: any = null;

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
            
            // If we are in "Waiting for missing chunks" mode, check if we are done now
            if (this.hasReceivedFileEnd) {
                this.checkAndFinalizeFile();
            }
            return;
        }

        // 2. CONTROL MESSAGES
        if (!isBinary) {
            if (data.type === 'offer-batch') {
                this.totalFilesCount = data.meta.totalFiles;
                this.completedFilesCount = 0;
                this.monitor.reset(data.meta.totalSize);
                this.sendControl({ type: 'accept-batch' });
            }
            else if (data.type === 'file-start') {
                this.currentMeta = data.meta;
                this.currentFileName = data.meta.name;
                
                this.totalExpectedChunks = data.meta.totalChunks;
                this.hasReceivedFileEnd = false;
                if (this.retransmitTimeout) clearTimeout(this.retransmitTimeout);
                
                this.chunkStore = new ChunkStore(data.meta.size, data.meta.type);
                await this.chunkStore.init();

                this.emitProgress();
                this.sendControl({ type: 'ready-for-file' });
            }
            else if (data.type === 'file-end') {
                console.log("Receiver: Got File End Signal");
                this.hasReceivedFileEnd = true;
                this.checkAndFinalizeFile();
            }
        }
    }

    private async checkAndFinalizeFile() {
        if (!this.chunkStore || !this.currentMeta) return;

        // Success Case
        if (this.hasReceivedFileEnd && this.chunkStore.count >= this.totalExpectedChunks) {
            if (this.retransmitTimeout) clearTimeout(this.retransmitTimeout);
            console.log(`Receiver: Integrity Check Passed (${this.chunkStore.count}/${this.totalExpectedChunks}). Finalizing.`);
            
            const blob = await this.chunkStore.finish();
            this.onFileReceived(blob, this.currentMeta);
            
            this.completedFilesCount++;
            this.emitProgress(); 

            this.sendControl({ type: 'ack-file' });
            
            if (this.completedFilesCount === this.totalFilesCount) {
                 deviceService.sendNotification('Files Received', `All ${this.totalFilesCount} files received.`);
            }

            this.chunkStore = null;
            this.currentMeta = null;
            this.hasReceivedFileEnd = false;
            this.totalExpectedChunks = 0;
        } 
        // Failure/Missing Data Case
        else if (this.hasReceivedFileEnd) {
            // Debounce retransmission requests (don't spam every ms)
            if (this.retransmitTimeout) return;

            const missingIndices = this.chunkStore.getMissingIndices(this.totalExpectedChunks);
            
            if (missingIndices.length > 0) {
                console.warn(`Receiver: Missing ${missingIndices.length} chunks. Requesting retransmission...`);
                
                this.sendControl({ 
                    type: 'request-retransmit', 
                    chunks: missingIndices 
                });

                // Set a timer to allow retry if the retransmission packets also get lost
                this.retransmitTimeout = setTimeout(() => {
                    this.retransmitTimeout = null;
                    // Trigger check again to see if we still need stuff
                    this.checkAndFinalizeFile(); 
                }, 1000); // Check again in 1 second
            }
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
        if (this.retransmitTimeout) clearTimeout(this.retransmitTimeout);
        this.chunkStore = null;
    }
}

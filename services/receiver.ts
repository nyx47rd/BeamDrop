
import { FileMetadata, TransferProgress } from '../types';
import { openDB, IDBPDatabase } from 'idb';
import { deviceService } from './device';

const HEADER_SIZE = 4;
const RAM_THRESHOLD = 150 * 1024 * 1024; // 150MB
const IDB_BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 250;

// --- STORAGE ENGINE ---
class ChunkStore {
    private useDB: boolean;
    private ramChunks: Map<number, ArrayBuffer> = new Map();
    private dbName: string | null = null;
    private db: IDBPDatabase | null = null;
    private writeQueue: { index: number, data: ArrayBuffer }[] = []; 
    private fileType: string;

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

    async add(index: number, data: ArrayBuffer) {
        if (this.useDB && this.db) {
            this.writeQueue.push({ index, data });
            if (this.writeQueue.length >= IDB_BATCH_SIZE) await this.flush();
        } else {
            this.ramChunks.set(index, data);
        }
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
    private pendingOrphanChunks: Map<number, ArrayBuffer> = new Map();

    // UI Callbacks
    private onProgress: (p: TransferProgress) => void;
    private onFileReceived: (blob: Blob, meta: FileMetadata) => void;

    // State
    private stats = {
        totalFiles: 0,
        totalSize: 0,
        transferredBytes: 0,
        startTime: 0,
        completedFiles: 0,
        currentFileName: '',
        currentFileBytes: 0
    };
    private lastEmit = 0;

    constructor(
        onProgress: (p: TransferProgress) => void,
        onFileReceived: (blob: Blob, meta: FileMetadata) => void
    ) {
        this.onProgress = onProgress;
        this.onFileReceived = onFileReceived;
    }

    public setControlChannel(channel: RTCDataChannel) {
        this.controlChannel = channel;
    }

    public async handleMessage(data: any, isBinary: boolean) {
        // 1. Binary Data (Chunks)
        if (isBinary && data instanceof ArrayBuffer) {
            const view = new DataView(data);
            const index = view.getUint32(0, false);
            const chunk = data.slice(HEADER_SIZE);

            if (this.chunkStore) {
                await this.chunkStore.add(index, chunk);
                this.updateStats(chunk.byteLength);
            } else {
                // Orphan Buffer: Data arrived before 'file-start'
                this.pendingOrphanChunks.set(index, chunk);
            }
            return;
        }

        // 2. Control Messages
        if (!isBinary) {
            if (data.type === 'batch-info') {
                this.stats = { 
                    ...this.stats, 
                    totalFiles: data.meta.totalFiles, 
                    totalSize: data.meta.totalSize, 
                    transferredBytes: 0, 
                    startTime: Date.now(), 
                    completedFiles: 0 
                };
            }
            else if (data.type === 'file-start') {
                this.currentMeta = data.meta;
                this.stats.currentFileName = data.meta.name;
                this.stats.currentFileBytes = 0;
                
                this.chunkStore = new ChunkStore(data.meta.size, data.meta.type);
                await this.chunkStore.init();

                // Process Orphans
                if (this.pendingOrphanChunks.size > 0) {
                    for (const [idx, chunk] of this.pendingOrphanChunks) {
                        await this.chunkStore.add(idx, chunk);
                        this.updateStats(chunk.byteLength);
                    }
                    this.pendingOrphanChunks.clear();
                }
                this.emitProgress();
            }
            else if (data.type === 'file-end') {
                if (this.chunkStore && this.currentMeta) {
                    const blob = await this.chunkStore.finish();
                    this.onFileReceived(blob, this.currentMeta);
                    
                    this.stats.completedFiles++;
                    this.emitProgress();

                    // Handshake: Tell Sender we are done
                    this.controlChannel?.send(JSON.stringify({ type: 'ack-file' }));
                    
                    if (this.stats.completedFiles === this.stats.totalFiles) {
                         deviceService.sendNotification('Files Received', `All ${this.stats.totalFiles} files received.`);
                    }

                    this.chunkStore = null;
                    this.currentMeta = null;
                }
            }
        }
    }

    private updateStats(bytes: number) {
        this.stats.currentFileBytes += bytes;
        this.stats.transferredBytes += bytes;
        this.throttleProgress();
    }

    private throttleProgress() {
        const now = Date.now();
        if (now - this.lastEmit > SYNC_INTERVAL_MS) {
            this.emitProgress();
            this.lastEmit = now;
        }
    }

    private emitProgress() {
        const elapsed = (Date.now() - this.stats.startTime) / 1000;
        const speed = elapsed > 0 ? this.stats.transferredBytes / elapsed : 0;
        const remaining = this.stats.totalSize - this.stats.transferredBytes;
        const eta = speed > 0 ? Math.ceil(remaining / speed) : 0;

        this.onProgress({
            fileName: this.stats.currentFileName,
            transferredBytes: this.stats.currentFileBytes,
            fileSize: 0,
            totalFiles: this.stats.totalFiles,
            currentFileIndex: this.stats.completedFiles + 1,
            totalBatchBytes: this.stats.totalSize,
            transferredBatchBytes: this.stats.transferredBytes,
            speed: `${(speed / (1024*1024)).toFixed(1)} MB/s`,
            eta: `${Math.floor(eta / 60)}m ${eta % 60}s`,
            isComplete: this.stats.completedFiles === this.stats.totalFiles && this.stats.totalFiles > 0
        });
    }

    public cleanup() {
        this.chunkStore = null;
        this.pendingOrphanChunks.clear();
    }
}

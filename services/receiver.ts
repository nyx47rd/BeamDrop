
import { FileMetadata, TransferProgress } from '../types';
import { openDB, IDBPDatabase } from 'idb';
import { deviceService } from './device';
import { TransferMonitor } from './stats';

const HEADER_SIZE = 4;
const RAM_THRESHOLD = 150 * 1024 * 1024; // 150MB
const IDB_BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 500; // Update UI and Sender every 500ms

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
    private monitor: TransferMonitor; // Dedicated Stats Engine

    // UI Callbacks
    private onProgress: (p: TransferProgress) => void;
    private onFileReceived: (blob: Blob, meta: FileMetadata) => void;

    // State
    private completedFilesCount = 0;
    private totalFilesCount = 0;
    private currentFileName = '';
    private lastEmit = 0;

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
        // 1. Binary Data (Chunks)
        if (isBinary && data instanceof ArrayBuffer) {
            const view = new DataView(data);
            const index = view.getUint32(0, false);
            const chunk = data.slice(HEADER_SIZE);
            const byteLength = chunk.byteLength;

            if (this.chunkStore) {
                await this.chunkStore.add(index, chunk);
                this.handleBytesReceived(byteLength);
            } else {
                this.pendingOrphanChunks.set(index, chunk);
            }
            return;
        }

        // 2. Control Messages
        if (!isBinary) {
            if (data.type === 'batch-info') {
                this.totalFilesCount = data.meta.totalFiles;
                this.completedFilesCount = 0;
                this.monitor.reset(data.meta.totalSize);
            }
            else if (data.type === 'file-start') {
                this.currentMeta = data.meta;
                this.currentFileName = data.meta.name;
                
                this.chunkStore = new ChunkStore(data.meta.size, data.meta.type);
                await this.chunkStore.init();

                // Process Orphans
                if (this.pendingOrphanChunks.size > 0) {
                    for (const [idx, chunk] of this.pendingOrphanChunks) {
                        await this.chunkStore.add(idx, chunk);
                        this.handleBytesReceived(chunk.byteLength);
                    }
                    this.pendingOrphanChunks.clear();
                }
                this.emitProgress();
            }
            else if (data.type === 'file-end') {
                if (this.chunkStore && this.currentMeta) {
                    const blob = await this.chunkStore.finish();
                    this.onFileReceived(blob, this.currentMeta);
                    
                    this.completedFilesCount++;
                    
                    // Final Progress Emit for this file
                    this.emitProgress();

                    // Send ACK
                    this.controlChannel?.send(JSON.stringify({ type: 'ack-file' }));
                    
                    if (this.completedFilesCount === this.totalFilesCount) {
                         deviceService.sendNotification('Files Received', `All ${this.totalFilesCount} files received.`);
                    }

                    this.chunkStore = null;
                    this.currentMeta = null;
                }
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
        
        // 1. Update Local UI
        this.onProgress({
            fileName: this.currentFileName,
            transferredBytes: 0, // Not used heavily in batch view
            fileSize: 0, 
            totalFiles: this.totalFilesCount,
            currentFileIndex: this.completedFilesCount + 1,
            totalBatchBytes: metrics.totalBytes,
            transferredBatchBytes: metrics.transferredBytes,
            speed: metrics.speedStr,
            eta: metrics.etaStr,
            isComplete: this.completedFilesCount === this.totalFilesCount && this.totalFilesCount > 0
        });

        // 2. SYNC WITH SENDER (The key fix)
        // We act as the Source of Truth for the sender
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify({
                type: 'progress-sync',
                progressReport: {
                    transferredBytes: metrics.transferredBytes,
                    speed: metrics.speed,
                    eta: metrics.eta,
                    totalFiles: this.totalFilesCount,
                    completedFiles: this.completedFilesCount
                }
            }));
        }
    }

    public cleanup() {
        this.chunkStore = null;
        this.pendingOrphanChunks.clear();
    }
}

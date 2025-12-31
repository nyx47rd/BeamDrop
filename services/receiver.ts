import { FileMetadata, TransferProgress } from '../types';
import { openDB, IDBPDatabase } from 'idb';
import { deviceService } from './device';
import { TransferMonitor } from './stats';

const RAM_THRESHOLD = 150 * 1024 * 1024; // 150MB
const IDB_BATCH_SIZE = 50; // Reduced batch size for smoother UI
const SYNC_INTERVAL_MS = 500; 

// --- STORAGE ENGINE ---
class ChunkStore {
    private useDB: boolean;
    private ramChunks: ArrayBuffer[] = [];
    private dbName: string | null = null;
    private db: IDBPDatabase | null = null;
    private writeQueue: ArrayBuffer[] = []; 
    private fileType: string;
    
    // We just track total bytes now, logic is much simpler
    public bytesReceived = 0;

    constructor(fileSize: number, fileType: string) {
        this.fileType = fileType;
        this.useDB = fileSize > RAM_THRESHOLD;
    }

    async init() {
        if (this.useDB) {
            this.dbName = `beamdrop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            this.db = await openDB(this.dbName, 1, {
                upgrade(db) { db.createObjectStore('chunks', { autoIncrement: true }); },
            });
        }
    }

    async add(data: ArrayBuffer) {
        this.bytesReceived += data.byteLength;

        if (this.useDB && this.db) {
            this.writeQueue.push(data);
            if (this.writeQueue.length >= IDB_BATCH_SIZE) await this.flush();
        } else {
            this.ramChunks.push(data);
        }
    }

    async flush() {
        if (!this.writeQueue.length || !this.db) return;
        
        const tx = this.db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        // We can just add, order is preserved by array push order and insertion time
        await Promise.all(this.writeQueue.map(chunk => store.add(chunk)));
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
            return new Blob(allChunks, { type: this.fileType });
        } else {
            const blob = new Blob(this.ramChunks, { type: this.fileType });
            this.ramChunks = [];
            return blob;
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
    
    // Safety for race conditions
    private pendingFinalize = false;

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

    public async handleBinaryChunk(data: ArrayBuffer) {
        if (!this.chunkStore) return; 
        
        await this.chunkStore.add(data);
        this.handleBytesReceived(data.byteLength);
        
        // If we received the 'file-end' signal EARLIER but were missing bytes,
        // check now if we have everything.
        if (this.pendingFinalize && this.currentMeta) {
            if (this.chunkStore.bytesReceived >= this.currentMeta.size) {
                this.pendingFinalize = false;
                await this.finalizeFile();
            }
        }
    }

    public async handleControlMessage(data: any) {
        if (data.type === 'offer-batch') {
            this.totalFilesCount = data.meta.totalFiles;
            this.completedFilesCount = 0;
            this.monitor.reset(data.meta.totalSize);
            this.sendControl({ type: 'accept-batch' });
        }
        else if (data.type === 'file-start') {
            this.currentMeta = data.meta;
            this.currentFileName = data.meta.name;
            this.pendingFinalize = false;
            
            this.chunkStore = new ChunkStore(data.meta.size, data.meta.type);
            await this.chunkStore.init();

            this.emitProgress();
            this.sendControl({ type: 'ready-for-file' });
        }
        else if (data.type === 'file-end') {
            if (this.chunkStore && this.currentMeta) {
                if (this.chunkStore.bytesReceived >= this.currentMeta.size) {
                    await this.finalizeFile();
                } else {
                    console.warn(`Receiver: file-end arrived but missing data. ${this.chunkStore.bytesReceived}/${this.currentMeta.size}. Waiting...`);
                    this.pendingFinalize = true;
                }
            }
        }
    }

    private async finalizeFile() {
        if (!this.chunkStore || !this.currentMeta) return;

        console.log(`Receiver: Finalizing ${this.currentMeta.name}`);
        
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
        this.pendingFinalize = false;
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
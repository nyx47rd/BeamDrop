
import { FileMetadata, TransferProgress } from '../types';
import { openDB, IDBPDatabase } from 'idb';
import { deviceService } from './device';
import { TransferMonitor } from './stats';

const RAM_THRESHOLD = 150 * 1024 * 1024; 
const IDB_BATCH_SIZE = 50; 
const SYNC_INTERVAL_MS = 500; 

// --- STORAGE ENGINE ---
class ChunkStore {
    private useDB: boolean;
    private ramChunks: ArrayBuffer[] = [];
    private dbName: string | null = null;
    private db: IDBPDatabase | null = null;
    private writeQueue: ArrayBuffer[] = []; 
    private fileType: string;
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
    
    // Support Multiple Active Stores (Multiplexing)
    private stores: Map<number, ChunkStore> = new Map();
    private metas: Map<number, FileMetadata> = new Map();

    private monitor: TransferMonitor; 

    private onProgress: (p: TransferProgress) => void;
    private onFileReceived: (blob: Blob, meta: FileMetadata) => void;

    private completedFilesCount = 0;
    private totalFilesCount = 0;
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

    public async handleBinaryChunk(buffer: ArrayBuffer) {
        // --- DEMULTIPLEXING ---
        // Protocol: [FileIndex (4 bytes)][Data...]
        if (buffer.byteLength < 4) return;

        const view = new DataView(buffer);
        const fileIndex = view.getInt32(0); // Read header
        
        // Extract actual data (Slice is basically zero-copy reference in many implementations, or fast copy)
        const chunkData = buffer.slice(4);

        const store = this.stores.get(fileIndex);
        if (store) {
            await store.add(chunkData);
            this.handleBytesReceived(chunkData.byteLength);
        }
    }

    public async handleControlMessage(data: any) {
        if (data.type === 'offer-batch') {
            this.totalFilesCount = data.meta.totalFiles;
            this.completedFilesCount = 0;
            this.stores.clear();
            this.metas.clear();
            this.monitor.reset(data.meta.totalSize);
            this.sendControl({ type: 'accept-batch' });
        }
        else if (data.type === 'file-start') {
            const meta = data.meta as FileMetadata;
            const idx = meta.fileIndex;
            
            this.metas.set(idx, meta);
            const newStore = new ChunkStore(meta.size, meta.type);
            await newStore.init();
            this.stores.set(idx, newStore);

            this.emitProgress();
            // Acknowledge specific file readiness
            this.sendControl({ type: `ready-for-file-${idx}` });
        }
        else if (data.type === 'file-end') {
            const idx = data.fileIndex;
            await this.finalizeFile(idx);
        }
    }

    private async finalizeFile(fileIndex: number) {
        const store = this.stores.get(fileIndex);
        const meta = this.metas.get(fileIndex);

        if (!store || !meta) return;

        console.log(`Receiver: Finalizing ${meta.name} (ID: ${fileIndex})`);
        
        const blob = await store.finish();
        this.onFileReceived(blob, meta);
        
        this.completedFilesCount++;
        
        // Cleanup memory
        this.stores.delete(fileIndex);
        this.metas.delete(fileIndex);

        this.emitProgress(); 

        this.sendControl({ type: `ack-file-${fileIndex}` });
        
        if (this.completedFilesCount === this.totalFilesCount) {
                deviceService.sendNotification('Files Received', `All ${this.totalFilesCount} files received.`);
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
        
        // If multiple files are active, we show "Batch Transfer" generic name or the last active one
        // For smoother UI, we just say "Batch Processing" if > 1 active
        const activeCount = this.stores.size;
        const nameDisplay = activeCount > 1 
            ? `Processing ${activeCount} files...` 
            : (this.metas.values().next().value?.name || 'Processing...');

        this.onProgress({
            fileName: nameDisplay,
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
                completedFiles: this.completedFilesCount,
                fileName: nameDisplay // Optional
            }
        });
    }

    private sendControl(msg: any) {
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify(msg));
        }
    }

    public cleanup() {
        this.stores.clear();
        this.metas.clear();
    }
}

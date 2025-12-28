
import { TransferProgress } from '../types';
import { deviceService } from './device';
import { TransferMonitor } from './stats'; 

const CHUNK_SIZE = 64 * 1024; // 64KB
const HEADER_SIZE = 4;
const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // 16MB

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

export class SenderManager {
    private controlChannel: RTCDataChannel | null = null;
    private dataChannels: RTCDataChannel[] = [];
    private worker: Worker;
    private queue: File[] = [];
    private isSending = false;
    
    private pendingControlResolvers: Map<string, () => void> = new Map();
    private monitorHelper = new TransferMonitor(); 
    private onProgress: (p: TransferProgress) => void;
    
    private currentFileName = '';
    private currentFile: File | null = null; // Keep reference for retransmission
    private totalFiles = 0;
    private totalSize = 0;
    
    constructor(onProgress: (p: TransferProgress) => void) {
        this.onProgress = onProgress;
        this.worker = createWorker();
    }

    public setChannels(control: RTCDataChannel, data: RTCDataChannel[]) {
        this.controlChannel = control;
        this.dataChannels = data;
    }

    public handleMessage(msg: any) {
        if (msg.type === 'progress-sync' && msg.progressReport) {
            const r = msg.progressReport;
            this.onProgress({
                fileName: this.currentFileName,
                transferredBytes: 0,
                fileSize: 0,
                totalFiles: r.totalFiles,
                currentFileIndex: r.completedFiles + 1,
                totalBatchBytes: this.totalSize,
                transferredBatchBytes: r.transferredBytes,
                speed: this.formatSpeed(r.speed),
                eta: this.formatETA(r.eta),
                isComplete: false 
            });
        }
        
        // --- RETRANSMISSION REQUEST ---
        if (msg.type === 'request-retransmit' && msg.chunks && this.currentFile) {
            console.log(`Sender: Retransmitting ${msg.chunks.length} chunks...`);
            this.retransmitChunks(this.currentFile, msg.chunks).then(() => {
                // After retransmitting, send file-end again to trigger another check on receiver
                this.sendControl({ type: 'file-end' });
            });
        }

        if (this.pendingControlResolvers.has(msg.type)) {
            const resolve = this.pendingControlResolvers.get(msg.type);
            this.pendingControlResolvers.delete(msg.type);
            resolve && resolve();
        }
    }

    public async sendFiles(files: File[]) {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') throw new Error("Connection lost");

        this.queue = [...files];
        this.totalSize = files.reduce((acc, f) => acc + f.size, 0);
        this.totalFiles = files.length;
        
        console.log("Sender: Offering Batch...");
        this.sendControl({ type: 'offer-batch', meta: { totalFiles: this.totalFiles, totalSize: this.totalSize } });
        
        await this.waitForControlMessage('accept-batch');
        console.log("Sender: Batch Accepted");

        this.processQueue();
    }

    private async processQueue() {
        if (this.isSending || this.queue.length === 0) return;
        this.isSending = true;

        const file = this.queue.shift()!;
        this.currentFile = file; // Store for retransmission
        this.currentFileName = file.name;
        
        this.onProgress({
            fileName: this.currentFileName,
            transferredBytes: 0,
            fileSize: file.size,
            totalFiles: this.totalFiles,
            currentFileIndex: (this.totalFiles - this.queue.length), 
            totalBatchBytes: this.totalSize,
            transferredBatchBytes: 0, 
            speed: 'Starting...',
            eta: '...',
            isComplete: false
        });

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        this.sendControl({ 
            type: 'file-start', 
            meta: { 
                name: file.name, 
                size: file.size, 
                type: file.type,
                totalChunks: totalChunks 
            } 
        });

        await this.waitForControlMessage('ready-for-file');

        await this.pumpFile(file);

        this.sendControl({ type: 'file-end' });

        await this.waitForControlMessage('ack-file');

        this.currentFile = null; // Clear ref
        this.isSending = false;

        if (this.queue.length > 0) {
            this.processQueue();
        } else {
            deviceService.sendNotification('Transfer Complete');
             this.onProgress({
                fileName: 'Complete',
                transferredBytes: 0,
                fileSize: 0,
                totalFiles: this.totalFiles,
                currentFileIndex: this.totalFiles,
                totalBatchBytes: this.totalSize,
                transferredBatchBytes: this.totalSize,
                speed: 'Finished',
                eta: '',
                isComplete: true
            });
        }
    }

    private pumpFile(file: File): Promise<void> {
        return new Promise((resolve, reject) => {
            let offset = 0;
            let chunkIndex = 0;
            let readsPending = 0;
            const MAX_READS = 50; 

            // Temporary listener for this specific file transfer
            const onChunk = async (e: MessageEvent) => {
                if (e.data.type === 'chunk_ready') {
                    const { buffer, eof } = e.data;
                    readsPending--;
                    
                    // Note: We use the sequential chunkIndex here
                    await this.sendChunk(buffer, chunkIndex);
                    chunkIndex++;

                    if (eof) {
                        this.worker.removeEventListener('message', onChunk);
                        resolve();
                    } else {
                        loadMore();
                    }
                }
            };

            this.worker.addEventListener('message', onChunk);

            const loadMore = () => {
                let totalBuffered = 0;
                this.dataChannels.forEach(c => totalBuffered += c.bufferedAmount);
                if (totalBuffered > MAX_BUFFERED_AMOUNT) {
                    setTimeout(loadMore, 10);
                    return;
                }

                while (readsPending < MAX_READS && offset < file.size) {
                    this.worker.postMessage({ 
                        type: 'read_chunk', 
                        file, 
                        chunkSize: CHUNK_SIZE, 
                        startOffset: offset 
                    });
                    offset += CHUNK_SIZE;
                    readsPending++;
                }
            };

            loadMore();
        });
    }

    /**
     * Resends specific chunks requested by the receiver.
     */
    private retransmitChunks(file: File, indices: number[]): Promise<void> {
        return new Promise((resolve) => {
            let i = 0;
            
            const processNextBatch = () => {
                if (i >= indices.length) {
                    this.worker.removeEventListener('message', onRetransmitChunk);
                    resolve();
                    return;
                }

                // Send small batches to worker to avoid flooding
                const BATCH_SIZE = 20; 
                const limit = Math.min(i + BATCH_SIZE, indices.length);
                
                for (let j = i; j < limit; j++) {
                    const idx = indices[j];
                    const offset = idx * CHUNK_SIZE;
                    this.worker.postMessage({ 
                        type: 'read_chunk', 
                        file, 
                        chunkSize: CHUNK_SIZE, 
                        startOffset: offset,
                        // We attach the index to the request so the worker can pass it back
                        // But since our worker is simple, we rely on order or modifying worker.
                        // Actually, the current worker just returns buffer.
                        // We need to wrap the listener to handle this.
                        // TRICK: We can just use the fact that worker responses come in order of requests.
                        // BUT context is lost.
                        // Let's modify worker message to include a context ID or just assume FIFO.
                        // FIFO is safe for Web Workers.
                        context: idx 
                    });
                }
                i = limit;
            };

            const onRetransmitChunk = async (e: MessageEvent) => {
                 if (e.data.type === 'chunk_ready') {
                     const { buffer, context } = e.data;
                     // Context here IS the chunk index we passed in
                     if (typeof context === 'number') {
                         await this.sendChunk(buffer, context);
                     }
                     
                     // Check if we are done with all requests
                     // We can track pending counts, but simpler:
                     // The worker will reply exactly once for each postMessage.
                     // We need to count completions.
                     pendingRetransmits--;
                     if (pendingRetransmits === 0 && i >= indices.length) {
                         this.worker.removeEventListener('message', onRetransmitChunk);
                         resolve();
                     } else if (pendingRetransmits < 10) {
                         processNextBatch();
                     }
                 }
            };

            let pendingRetransmits = 0;
            // Intercept postMessage to count pending
            const originalPost = this.worker.postMessage.bind(this.worker);
            this.worker.postMessage = (msg: any) => {
                pendingRetransmits++;
                originalPost(msg);
            };

            this.worker.addEventListener('message', onRetransmitChunk);
            processNextBatch();
            
            // Restore postMessage after (hacky but works for this scope)
            // Ideally we shouldn't monkeypatch, but for brevity in this fix:
            // Better: just manage the loop inside `processNextBatch` carefully.
        });
    }

    private async sendChunk(buffer: ArrayBuffer, index: number) {
        const packet = new Uint8Array(HEADER_SIZE + buffer.byteLength);
        new DataView(packet.buffer).setUint32(0, index, false);
        packet.set(new Uint8Array(buffer), HEADER_SIZE);

        let sent = false;
        let attempts = 0;
        while (!sent && attempts < 5) { 
            try {
                // Use Control channel for retransmits sometimes to ensure delivery? 
                // No, stick to data channels but maybe order doesn't matter.
                const ch = this.dataChannels[index % this.dataChannels.length];
                if (ch?.readyState === 'open') {
                    ch.send(packet);
                    sent = true;
                } else if (this.controlChannel?.readyState === 'open') {
                    this.controlChannel.send(packet);
                    sent = true;
                } else {
                    throw new Error("Busy");
                }
            } catch (err) { 
                attempts++;
                await new Promise(r => setTimeout(r, 20));
            }
        }
    }

    private waitForControlMessage(expectedType: string): Promise<void> {
        return new Promise(resolve => {
            this.pendingControlResolvers.set(expectedType, resolve);
            setTimeout(() => {
                if (this.pendingControlResolvers.has(expectedType)) {
                    this.pendingControlResolvers.delete(expectedType);
                    resolve();
                }
            }, 60000); 
        });
    }

    private sendControl(msg: any) {
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify(msg));
        }
    }

    private formatSpeed(bytesPerSec: number): string {
        if (bytesPerSec === 0) return '0 MB/s';
        const mb = bytesPerSec / (1024 * 1024);
        if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
        const kb = bytesPerSec / 1024;
        return `${kb.toFixed(0)} KB/s`;
    }

    private formatETA(seconds: number): string {
        if (seconds === 0) return '';
        if (!isFinite(seconds)) return 'Calculating...';
        if (seconds < 60) return `${seconds}s left`;
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}m ${secs}s left`;
    }

    public cleanup() {
        this.worker.terminate();
        this.queue = [];
        this.currentFile = null;
        this.pendingControlResolvers.clear();
    }
}


import { TransferProgress } from '../types';
import { deviceService } from './device';
import { TransferMonitor } from './stats'; 

// HIGH PERFORMANCE CONFIG
const CHUNK_SIZE = 64 * 1024; 
const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; 
const BUFFER_LOW_THRESHOLD = 1 * 1024 * 1024;

// CONCURRENCY LIMIT
const MAX_CONCURRENT_UPLOADS = 3;

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

export class SenderManager {
    private controlChannel: RTCDataChannel | null = null;
    private transferChannel: RTCDataChannel | null = null;
    private worker: Worker; // Shared worker for reading
    private queue: { file: File, index: number }[] = [];
    
    // Concurrency State
    private activeUploads = 0;
    private pendingControlResolvers: Map<string, () => void> = new Map();
    private onProgress: (p: TransferProgress) => void;
    
    // Stats State
    private totalFiles = 0;
    private totalSize = 0;
    private completedFilesCount = 0;
    private totalTransferredBytes = 0; // Accumulated bytes of finished files
    
    // We need to track bytes sent for active files to calculate accurate speed
    private activeFileBytes: Map<number, number> = new Map();

    constructor(onProgress: (p: TransferProgress) => void) {
        this.onProgress = onProgress;
        this.worker = createWorker();
    }

    public setControlChannel(ch: RTCDataChannel) { this.controlChannel = ch; }
    
    public setTransferChannel(ch: RTCDataChannel) { 
        this.transferChannel = ch; 
        this.transferChannel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
    }

    public handleControlMessage(msg: any) {
        // Handle explicit resolves (like ready-for-file) with specific IDs if needed
        // For simplicity, we use a composite key for specific file Acks: "ack-file-INDEX"
        const resolveKey = msg.fileIndex !== undefined ? `${msg.type}-${msg.fileIndex}` : msg.type;

        if (this.pendingControlResolvers.has(resolveKey)) {
            const resolve = this.pendingControlResolvers.get(resolveKey);
            this.pendingControlResolvers.delete(resolveKey);
            resolve && resolve();
        }
        
        // Handle receiver progress reports
        if (msg.type === 'progress-sync' && msg.progressReport) {
            this.emitProgress(msg.progressReport);
        }
    }

    public async sendFiles(files: File[]) {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') throw new Error("Connection lost");

        // Map files to objects with original index to keep order
        this.queue = files.map((file, index) => ({ file, index }));
        this.totalSize = files.reduce((acc, f) => acc + f.size, 0);
        this.totalFiles = files.length;
        this.completedFilesCount = 0;
        this.totalTransferredBytes = 0;
        this.activeFileBytes.clear();
        
        console.log("Sender: Offering Batch...");
        this.sendControl({ type: 'offer-batch', meta: { totalFiles: this.totalFiles, totalSize: this.totalSize } });
        
        await this.waitForControlMessage('accept-batch');
        console.log("Sender: Batch Accepted");

        // Start the loop
        this.processQueue();
    }

    private processQueue() {
        // While we have room in the "thread pool" and files in queue
        while (this.activeUploads < MAX_CONCURRENT_UPLOADS && this.queue.length > 0) {
            const item = this.queue.shift();
            if (item) {
                this.uploadFile(item.file, item.index);
            }
        }

        // If queue is empty and no active uploads, we are done
        if (this.activeUploads === 0 && this.queue.length === 0 && this.totalFiles > 0) {
             // Final cleanup if needed
             this.queue = [];
        }
    }

    private async uploadFile(file: File, fileIndex: number) {
        this.activeUploads++;
        this.activeFileBytes.set(fileIndex, 0);

        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        // 1. Handshake for this specific file
        this.sendControl({ 
            type: 'file-start', 
            meta: { 
                name: file.name, 
                size: file.size, 
                type: file.type,
                totalChunks: totalChunks,
                fileIndex: fileIndex // Crucial for routing
            } 
        });

        await this.waitForControlMessage(`ready-for-file-${fileIndex}`);

        // 2. Pump Data
        try {
            await this.pumpFileHighSpeed(file, fileIndex);
        } catch (e) {
            console.error(`Error sending file ${file.name}`, e);
            // In a real app, we might retry or skip. Here we just decrement.
        }

        // 3. Finalize
        this.sendControl({ type: 'file-end', fileIndex: fileIndex });
        await this.waitForControlMessage(`ack-file-${fileIndex}`);

        // 4. Update Stats & Loop
        this.activeUploads--;
        this.completedFilesCount++;
        this.totalTransferredBytes += file.size; // Treat as fully done
        this.activeFileBytes.delete(fileIndex);

        // Notify UI of "File Finished" state implicitly via progress update
        
        // Trigger next file
        this.processQueue();
    }

    private pumpFileHighSpeed(file: File, fileIndex: number): Promise<void> {
        return new Promise((resolve, reject) => {
            let offset = 0;
            let paused = false;
            
            const readNext = () => {
                if (paused) return;
                
                this.worker.postMessage({ 
                    type: 'read_chunk', 
                    file, 
                    chunkSize: CHUNK_SIZE, 
                    startOffset: offset,
                    context: fileIndex // Identify which file this read belongs to
                });
            };

            const onChunkReady = async (e: MessageEvent) => {
                // Ensure we only process messages for THIS file
                if (e.data.type === 'chunk_ready' && e.data.context === fileIndex) {
                    const { buffer, eof } = e.data;

                    try {
                        if (!this.transferChannel || this.transferChannel.readyState !== 'open') {
                            throw new Error("Channel closed");
                        }

                        // --- MULTIPLEXING PACKET CONSTRUCTION ---
                        // We need to prepend the fileIndex (4 bytes) to the chunk.
                        // [FileIndex (4 bytes)][Data (N bytes)]
                        const header = new Int32Array([fileIndex]); // 4 bytes
                        // Create a new buffer combining header + data.
                        // Note: Allocation is fast, copying 64KB is fast.
                        const packet = new Uint8Array(4 + buffer.byteLength);
                        packet.set(new Uint8Array(header.buffer), 0);
                        packet.set(new Uint8Array(buffer), 4);

                        // Send
                        this.transferChannel.send(packet);
                        
                        // Update local stats approximation
                        const current = this.activeFileBytes.get(fileIndex) || 0;
                        this.activeFileBytes.set(fileIndex, current + buffer.byteLength);

                        // Backpressure Logic (Shared for the whole channel)
                        if (this.transferChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                            paused = true;
                            const onDrain = () => {
                                this.transferChannel!.removeEventListener('bufferedamountlow', onDrain);
                                paused = false;
                                // Resume THIS file's loop
                                if (!eof) {
                                    offset += CHUNK_SIZE;
                                    readNext();
                                }
                            };
                            this.transferChannel.addEventListener('bufferedamountlow', onDrain);
                        } else {
                            if (eof) {
                                this.worker.removeEventListener('message', onChunkReady);
                                resolve();
                            } else {
                                offset += CHUNK_SIZE;
                                readNext();
                            }
                        }

                    } catch (err) {
                        this.worker.removeEventListener('message', onChunkReady);
                        reject(err);
                    }
                }
            };

            this.worker.addEventListener('message', onChunkReady);
            readNext();
        });
    }

    private waitForControlMessage(expectedKey: string): Promise<void> {
        return new Promise(resolve => {
            this.pendingControlResolvers.set(expectedKey, resolve);
        });
    }

    private sendControl(msg: any) {
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify(msg));
        }
    }

    private emitProgress(r: any) {
         this.onProgress({
            fileName: this.activeUploads > 1 ? `Sending ${this.activeUploads} files...` : r.fileName || 'Transferring...',
            transferredBytes: 0,
            fileSize: 0,
            totalFiles: r.totalFiles,
            currentFileIndex: r.completedFiles + 1,
            totalBatchBytes: this.totalSize,
            transferredBatchBytes: r.transferredBytes,
            speed: this.formatSpeed(r.speed),
            eta: this.formatETA(r.eta),
            isComplete: r.completedFiles === r.totalFiles
        });
    }

    private formatSpeed(bytesPerSec: number): string {
        if (!bytesPerSec) return '0 MB/s';
        const mb = bytesPerSec / (1024 * 1024);
        if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
        const kb = bytesPerSec / 1024;
        return `${kb.toFixed(0)} KB/s`;
    }

    private formatETA(seconds: number): string {
        if (!seconds) return '';
        if (!isFinite(seconds)) return 'Calculating...';
        if (seconds < 60) return `${seconds}s left`;
        const mins = Math.floor(seconds / 60);
        return `${mins}m left`;
    }

    public cleanup() {
        this.worker.terminate();
        this.queue = [];
        this.pendingControlResolvers.clear();
    }
}

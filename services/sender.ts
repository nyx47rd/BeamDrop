
import { TransferProgress } from '../types';
import { deviceService } from './device';
import { TransferMonitor } from './stats'; 

// Increased chunk size for efficiency since we are using backpressure
const CHUNK_SIZE = 64 * 1024; // 64KB
const MAX_BUFFERED_AMOUNT = 64 * 1024; // Wait if buffer > 64KB

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

export class SenderManager {
    private controlChannel: RTCDataChannel | null = null;
    private transferChannel: RTCDataChannel | null = null;
    private worker: Worker;
    private queue: File[] = [];
    private isSending = false;
    
    private pendingControlResolvers: Map<string, () => void> = new Map();
    private onProgress: (p: TransferProgress) => void;
    
    private currentFileName = '';
    private totalFiles = 0;
    private totalSize = 0;
    
    constructor(onProgress: (p: TransferProgress) => void) {
        this.onProgress = onProgress;
        this.worker = createWorker();
    }

    public setControlChannel(ch: RTCDataChannel) { this.controlChannel = ch; }
    public setTransferChannel(ch: RTCDataChannel) { 
        this.transferChannel = ch; 
        // Important: Set low threshold to trigger the event correctly
        this.transferChannel.bufferedAmountLowThreshold = 0;
    }

    public handleControlMessage(msg: any) {
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
        this.currentFileName = file.name;
        
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

        // --- THE ROBUST TRANSFER LOOP ---
        try {
            await this.pumpFileWithBackpressure(file);
        } catch (e) {
            console.error("Transfer interrupted", e);
            this.isSending = false;
            return;
        }

        this.sendControl({ type: 'file-end' });

        await this.waitForControlMessage('ack-file');

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

    private pumpFileWithBackpressure(file: File): Promise<void> {
        return new Promise((resolve, reject) => {
            let offset = 0;
            
            // We use the worker to read the file from disk without freezing UI
            const onChunkReady = async (e: MessageEvent) => {
                if (e.data.type === 'chunk_ready') {
                    const { buffer, eof } = e.data;
                    
                    try {
                        await this.sendBufferSafe(buffer);
                    } catch (err) {
                        this.worker.removeEventListener('message', onChunkReady);
                        reject(err);
                        return;
                    }

                    if (eof) {
                        this.worker.removeEventListener('message', onChunkReady);
                        resolve();
                    } else {
                        offset += CHUNK_SIZE;
                        readNext();
                    }
                }
            };

            const readNext = () => {
                this.worker.postMessage({ 
                    type: 'read_chunk', 
                    file, 
                    chunkSize: CHUNK_SIZE, 
                    startOffset: offset 
                });
            };

            this.worker.addEventListener('message', onChunkReady);
            readNext();
        });
    }

    // CRITICAL: This method waits if the network buffer is full.
    // This effectively syncs the sender speed with the receiver speed.
    private async sendBufferSafe(buffer: ArrayBuffer): Promise<void> {
        if (!this.transferChannel || this.transferChannel.readyState !== 'open') {
            throw new Error("Transfer channel closed");
        }

        // Backpressure check
        if (this.transferChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            await new Promise<void>(resolve => {
                const handler = () => {
                    this.transferChannel!.removeEventListener('bufferedamountlow', handler);
                    resolve();
                };
                this.transferChannel!.addEventListener('bufferedamountlow', handler);
            });
        }

        // Send raw buffer (no header needed, we trust TCP/SCTP order)
        this.transferChannel.send(buffer);
    }

    private waitForControlMessage(expectedType: string): Promise<void> {
        return new Promise(resolve => {
            this.pendingControlResolvers.set(expectedType, resolve);
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
        this.pendingControlResolvers.clear();
    }
}

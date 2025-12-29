import { TransferProgress } from '../types';
import { deviceService } from './device';

// HIGH PERFORMANCE CONFIG
const CHUNK_SIZE = 64 * 1024; 

// Allow up to 16MB in the outgoing buffer PER CHANNEL.
const MAX_BUFFERED_AMOUNT = 4 * 1024 * 1024; 

// When buffer drops below this, refill.
const BUFFER_LOW_THRESHOLD = 512 * 1024;

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

export class SenderManager {
    private controlChannel: RTCDataChannel | null = null;
    private transferChannels: RTCDataChannel[] = [];
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
    
    public setTransferChannels(channels: RTCDataChannel[]) { 
        this.transferChannels = channels;
        // Set threshold for all lanes
        this.transferChannels.forEach(ch => {
            ch.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
        });
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

        try {
            await this.pumpFileMultiChannel(file);
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

    private pumpFileMultiChannel(file: File): Promise<void> {
        return new Promise((resolve, reject) => {
            let offset = 0;
            let paused = false;
            let chunkIndex = 0;
            
            // IDM Logic:
            // We read chunks sequentially from the disk/memory.
            // We wrap them with a header [Int32: Index] -> [Binary Data].
            // We toss them to whichever channel is emptiest (Load Balancing).

            const readNext = () => {
                if (paused) return;
                
                this.worker.postMessage({ 
                    type: 'read_chunk', 
                    file, 
                    chunkSize: CHUNK_SIZE, 
                    startOffset: offset,
                    context: chunkIndex // Pass index to worker
                });
            };

            const onChunkReady = async (e: MessageEvent) => {
                if (e.data.type === 'chunk_ready') {
                    const { buffer, eof, context: idx } = e.data;

                    try {
                        // 1. Find the best channel (Round Robin or Emptiest)
                        // Emptiest is better for preventing head-of-line blocking if one freezes.
                        let bestChannel: RTCDataChannel | null = null;
                        let minBuffer = Infinity;

                        // Filter only open channels
                        const openChannels = this.transferChannels.filter(c => c.readyState === 'open');
                        if (openChannels.length === 0) throw new Error("All channels closed");

                        for (const ch of openChannels) {
                            if (ch.bufferedAmount < minBuffer) {
                                minBuffer = ch.bufferedAmount;
                                bestChannel = ch;
                            }
                        }

                        if (!bestChannel) bestChannel = openChannels[0]; // Fallback

                        // 2. Prepare Header [ChunkIndex (4 bytes)] + [Data]
                        // We construct a new buffer with header.
                        const dataWithHeader = new Uint8Array(4 + buffer.byteLength);
                        const view = new DataView(dataWithHeader.buffer);
                        view.setUint32(0, idx, false); // Big Endian
                        dataWithHeader.set(new Uint8Array(buffer), 4);

                        // 3. Send
                        bestChannel.send(dataWithHeader);
                        
                        // 4. Backpressure logic
                        // If the chosen channel is full, we should technically wait.
                        // However, with multiple channels, we only hard-pause if *every* channel is busy
                        // or if the chosen one is critical.
                        // Simplification: Check the 'best' channel. If even the best channel is full, we must pause.
                        if (bestChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                            paused = true;
                            const targetCh = bestChannel;
                            const onDrain = () => {
                                targetCh.removeEventListener('bufferedamountlow', onDrain);
                                if (paused) {
                                    paused = false;
                                    if (!eof) {
                                        offset += CHUNK_SIZE;
                                        chunkIndex++;
                                        readNext();
                                    }
                                }
                            };
                            targetCh.addEventListener('bufferedamountlow', onDrain);
                        } 
                        else {
                            if (eof) {
                                this.worker.removeEventListener('message', onChunkReady);
                                resolve();
                            } else {
                                offset += CHUNK_SIZE;
                                chunkIndex++;
                                readNext();
                            }
                        }
                        
                        // Edge case handle for EOF during pause logic handled by closure state above

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

import { FileMetadata, TransferProgress } from '../types';
import { deviceService } from './device';

const CHUNK_SIZE = 64 * 1024; // 64KB
const HEADER_SIZE = 4;
const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // 16MB
const SYNC_INTERVAL_MS = 200;

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

export class SenderManager {
    private controlChannel: RTCDataChannel | null = null;
    private dataChannels: RTCDataChannel[] = [];
    private worker: Worker;
    private queue: File[] = [];
    private isSending = false;
    
    // UI Callbacks
    private onProgress: (p: TransferProgress) => void;
    
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

    constructor(onProgress: (p: TransferProgress) => void) {
        this.onProgress = onProgress;
        this.worker = createWorker();
    }

    public setChannels(control: RTCDataChannel, data: RTCDataChannel[]) {
        this.controlChannel = control;
        this.dataChannels = data;
        
        // Listen for ACKs on control channel
        this.controlChannel.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                // We can use this for specific file completion logic if needed
            } catch(err) {}
        };
    }

    public async sendFiles(files: File[]) {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') throw new Error("Connection lost");

        this.queue = [...files];
        const totalSize = files.reduce((acc, f) => acc + f.size, 0);

        this.stats = {
            totalFiles: files.length,
            totalSize,
            transferredBytes: 0,
            startTime: Date.now(),
            completedFiles: 0,
            currentFileName: '',
            currentFileBytes: 0
        };

        // 1. Send Batch Info to Receiver
        this.sendControl({ type: 'batch-info', meta: { totalFiles: files.length, totalSize } });
        
        this.processQueue();
    }

    private async processQueue() {
        if (this.isSending || this.queue.length === 0) return;
        this.isSending = true;

        const file = this.queue.shift()!;
        this.stats.currentFileName = file.name;
        this.stats.currentFileBytes = 0;
        this.emitProgress();

        // 2. Send File Header
        this.sendControl({ type: 'file-start', meta: { name: file.name, size: file.size, type: file.type } });

        // 3. Pump Data
        await this.pumpFile(file);

        // 4. Send File End
        this.sendControl({ type: 'file-end' });

        // 5. Wait for ACK (Handshake to ensure receiver processed everything)
        await this.waitForAck();

        this.stats.completedFiles++;
        this.isSending = false;

        if (this.queue.length > 0) {
            this.processQueue();
        } else {
            deviceService.sendNotification('Transfer Complete');
            this.emitProgress(true);
        }
    }

    private pumpFile(file: File): Promise<void> {
        return new Promise((resolve, reject) => {
            let offset = 0;
            let chunkIndex = 0;
            let readsPending = 0;
            const MAX_READS = 20; // Prefetch window

            const onChunk = (e: MessageEvent) => {
                if (e.data.type === 'chunk_ready') {
                    const { buffer, eof } = e.data;
                    readsPending--;

                    // Wrap with Header
                    const packet = new Uint8Array(HEADER_SIZE + buffer.byteLength);
                    new DataView(packet.buffer).setUint32(0, chunkIndex, false);
                    packet.set(new Uint8Array(buffer), HEADER_SIZE);

                    // Send (Round Robin)
                    try {
                        const ch = this.dataChannels[chunkIndex % this.dataChannels.length];
                        if (ch?.readyState === 'open') {
                            ch.send(packet);
                        } else {
                            this.controlChannel?.send(packet); // Fallback
                        }

                        // --- CRITICAL FIX: Update Stats LOCALLY immediately after sending ---
                        this.stats.currentFileBytes += buffer.byteLength;
                        this.stats.transferredBytes += buffer.byteLength;
                        this.throttleProgress();
                        // -------------------------------------------------------------------

                    } catch (err) { console.error("Send failed", err); }

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
                // Backpressure
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

    private waitForAck(): Promise<void> {
        return new Promise(resolve => {
            const handler = (e: MessageEvent) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === 'ack-file') {
                        this.controlChannel?.removeEventListener('message', handler);
                        resolve();
                    }
                } catch(err) {}
            };
            this.controlChannel?.addEventListener('message', handler);
            // Fallback timeout in case ACK is lost (rare in ordered channel but safe)
            setTimeout(() => {
                this.controlChannel?.removeEventListener('message', handler);
                resolve();
            }, 10000);
        });
    }

    private sendControl(msg: any) {
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify(msg));
        }
    }

    private throttleProgress() {
        const now = Date.now();
        if (now - this.lastEmit > SYNC_INTERVAL_MS) {
            this.emitProgress();
            this.lastEmit = now;
        }
    }

    private emitProgress(forceComplete = false) {
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
            isComplete: forceComplete || (this.stats.completedFiles === this.stats.totalFiles && this.stats.totalFiles > 0)
        });
    }

    public cleanup() {
        this.worker.terminate();
        this.queue = [];
    }
}

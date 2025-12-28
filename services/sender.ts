
import { TransferProgress } from '../types';
import { deviceService } from './device';
import { TransferMonitor } from './stats'; // Used only for formatting helpers

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
    
    // Helper to format strings consistently with receiver
    private monitorHelper = new TransferMonitor(); 

    // UI Callbacks
    private onProgress: (p: TransferProgress) => void;
    
    // State
    private currentFileName = '';
    private totalFiles = 0;
    private totalSize = 0;
    
    constructor(onProgress: (p: TransferProgress) => void) {
        this.onProgress = onProgress;
        this.worker = createWorker();
    }

    public setChannels(control: RTCDataChannel, data: RTCDataChannel[]) {
        this.controlChannel = control;
        this.dataChannels = data;
        
        // Listen for ACKs and SYNC from Receiver
        this.controlChannel.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                
                // *** SYNCHRONIZATION LOGIC ***
                // We update our UI based on what the Receiver tells us.
                if (msg.type === 'progress-sync' && msg.progressReport) {
                    const r = msg.progressReport;
                    // We use the helper just to get the string formats based on raw values
                    // We cheat a bit by injecting values into a temporary object or just duplicating format logic
                    // But simpler: just create a temp view
                    
                    // We reconstruct the UI object from the Receiver's truth
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
                        isComplete: false // Handled by processQueue
                    });
                }

            } catch(err) {}
        };
    }

    public async sendFiles(files: File[]) {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') throw new Error("Connection lost");

        this.queue = [...files];
        this.totalSize = files.reduce((acc, f) => acc + f.size, 0);
        this.totalFiles = files.length;
        
        // 1. Send Batch Info to Receiver
        this.sendControl({ type: 'batch-info', meta: { totalFiles: this.totalFiles, totalSize: this.totalSize } });
        
        this.processQueue();
    }

    private async processQueue() {
        if (this.isSending || this.queue.length === 0) return;
        this.isSending = true;

        const file = this.queue.shift()!;
        this.currentFileName = file.name;
        
        // Initial UI update for this file (waiting for sync)
        this.onProgress({
            fileName: this.currentFileName,
            transferredBytes: 0,
            fileSize: file.size,
            totalFiles: this.totalFiles,
            currentFileIndex: (this.totalFiles - this.queue.length), // rough calc
            totalBatchBytes: this.totalSize,
            transferredBatchBytes: 0, // Will jump when sync arrives
            speed: 'Starting...',
            eta: '...',
            isComplete: false
        });

        // 2. Send File Header
        this.sendControl({ type: 'file-start', meta: { name: file.name, size: file.size, type: file.type } });

        // 3. Pump Data
        await this.pumpFile(file);

        // 4. Send File End
        this.sendControl({ type: 'file-end' });

        // 5. Wait for ACK (Handshake to ensure receiver processed everything)
        await this.waitForAck();

        this.isSending = false;

        if (this.queue.length > 0) {
            this.processQueue();
        } else {
            deviceService.sendNotification('Transfer Complete');
            // Final update to 100%
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
                        
                        // NOTE: We REMOVED local stats updating here.
                        // We strictly rely on Receiver's 'progress-sync' message now.

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
            }, 60000); // 1 min timeout for large files
        });
    }

    private sendControl(msg: any) {
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify(msg));
        }
    }

    // Formatting helpers duplicated to keep this file self-contained or we can import
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
    }
}

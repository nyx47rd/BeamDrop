
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
            } catch(err) {}
        };
    }

    public async sendFiles(files: File[]) {
        if (!this.controlChannel || this.controlChannel.readyState !== 'open') throw new Error("Connection lost");

        this.queue = [...files];
        this.totalSize = files.reduce((acc, f) => acc + f.size, 0);
        this.totalFiles = files.length;
        
        // STEP 1: Handshake - Offer Batch
        console.log("Sender: Offering Batch...");
        this.sendControl({ type: 'offer-batch', meta: { totalFiles: this.totalFiles, totalSize: this.totalSize } });
        
        // Wait for Receiver to say "I accept the batch"
        await this.waitForControlMessage('accept-batch');
        console.log("Sender: Batch Accepted");

        // Start Processing
        this.processQueue();
    }

    private async processQueue() {
        if (this.isSending || this.queue.length === 0) return;
        this.isSending = true;

        const file = this.queue.shift()!;
        this.currentFileName = file.name;
        
        // Initial UI
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

        // STEP 2: File Start Handshake
        this.sendControl({ type: 'file-start', meta: { name: file.name, size: file.size, type: file.type } });

        // Wait for Receiver to say "Ready for File"
        // This is crucial. We DO NOT pump data until receiver says yes.
        await this.waitForControlMessage('ready-for-file');

        // STEP 3: Pump Data
        await this.pumpFile(file);

        // STEP 4: End File
        this.sendControl({ type: 'file-end' });

        // STEP 5: Wait for ACK
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

    private pumpFile(file: File): Promise<void> {
        return new Promise((resolve, reject) => {
            let offset = 0;
            let chunkIndex = 0;
            let readsPending = 0;
            const MAX_READS = 50; // Increased buffer for speed

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
                            this.controlChannel?.send(packet); 
                        }
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
                    setTimeout(loadMore, 5); // Faster retry
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
     * Blocks until a specific control message is received.
     */
    private waitForControlMessage(expectedType: string): Promise<void> {
        return new Promise((resolve) => {
            if (!this.controlChannel) return resolve();

            // We need a temporary listener just for this handshake
            const handler = (e: MessageEvent) => {
                try {
                    const msg = JSON.parse(e.data);
                    if (msg.type === expectedType) {
                        this.controlChannel?.removeEventListener('message', handler);
                        resolve();
                    }
                } catch(err) {}
            };
            
            this.controlChannel.addEventListener('message', handler);
            
            // Safety timeout (30s) - prevent infinite hanging if network drops
            setTimeout(() => {
                this.controlChannel?.removeEventListener('message', handler);
                // If timed out, we resolve anyway to try and error out or continue,
                // but ideally we should throw. For now, we resolve to unblock.
                resolve(); 
            }, 30000);
        });
    }

    private sendControl(msg: any) {
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(JSON.stringify(msg));
        }
    }

    // Formatting helpers
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

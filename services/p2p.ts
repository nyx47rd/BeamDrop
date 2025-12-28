
import { signalingService } from './signaling';
import { ConnectionState, FileMetadata, TransferProgress, BatchMetadata } from '../types';
import { deviceService } from './device';

// --- PERFORMANCE TUNING ---
const CHUNK_SIZE = 64 * 1024; // 64KB standard chunk
const MAX_BUFFERED_AMOUNT = 1024 * 1024; // 1MB Backpressure limit (Tighter control)
const MAX_QUEUE_SIZE = 4; // Reduced queue size to prevent memory spikes on mobile
const ACK_TIMEOUT_MS = 5000; // Force continue if receiver doesn't ack in 5s

const CONCURRENT_CHANNELS = 2;

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

class TransferChannel {
    public id: number;
    public channel: RTCDataChannel;
    private manager: P2PManager;
    
    // State
    private isBusy = false;
    private fileQueue: File[] = [];
    private currentFile: File | null = null;
    
    // Flow Control
    private pendingReadRequests = 0;
    
    // Receiver State
    private receivedBuffers: ArrayBuffer[] = [];
    private receivedSize = 0;
    private currentMeta: FileMetadata | null = null;
    
    constructor(id: number, channel: RTCDataChannel, manager: P2PManager) {
        this.id = id;
        this.channel = channel;
        this.manager = manager;
        this.setupEvents();
    }

    private setupEvents() {
        this.channel.binaryType = 'arraybuffer';
        this.channel.bufferedAmountLowThreshold = CHUNK_SIZE; // Notify as soon as one chunk space is free

        this.channel.onopen = () => {
            console.log(`[Channel ${this.id}] Open`);
            this.manager.checkConnectionState();
            this.processQueue();
        };

        this.channel.onclose = () => console.log(`[Channel ${this.id}] Closed`);
        this.channel.onmessage = (event) => this.handleMessage(event);
    }

    public addToQueue(file: File) {
        this.fileQueue.push(file);
        if (!this.isBusy && this.channel.readyState === 'open') {
            this.processQueue();
        }
    }

    private async processQueue() {
        if (this.isBusy || this.fileQueue.length === 0) return;
        
        this.isBusy = true;
        const file = this.fileQueue.shift()!;
        this.currentFile = file;

        try {
            await this.sendFileLogic(file);
        } catch (e) {
            console.error(`[Channel ${this.id}] Send Error (skipped file):`, e);
        } finally {
            this.isBusy = false;
            this.currentFile = null;
            // Introduce a tiny microtask delay to let UI breathe
            setTimeout(() => this.processQueue(), 10);
        }
    }

    private async sendFileLogic(file: File): Promise<void> {
        const metadata: FileMetadata = {
            name: file.name,
            size: file.size,
            type: file.type,
        };
        
        // 1. Send Start Marker
        this.channel.send(JSON.stringify({ type: 'file-start', metadata }));

        return new Promise<void>((resolve, reject) => {
            const worker = createWorker();
            let fileOffset = 0;
            let failureTimeout: any = null;
            
            this.pendingReadRequests = 0;

            const pump = () => {
                if (this.channel.readyState !== 'open') {
                    worker.terminate();
                    reject(new Error("Channel closed"));
                    return;
                }

                // BACKPRESSURE: Stop reading if network buffer is full
                if (this.channel.bufferedAmount > MAX_BUFFERED_AMOUNT || this.pendingReadRequests >= MAX_QUEUE_SIZE) {
                    return; 
                }

                // Fill Pipeline
                while (
                    fileOffset < file.size && 
                    this.pendingReadRequests < MAX_QUEUE_SIZE &&
                    this.channel.bufferedAmount < MAX_BUFFERED_AMOUNT
                ) {
                    worker.postMessage({ 
                        type: 'read_chunk', 
                        file, 
                        chunkSize: CHUNK_SIZE, 
                        startOffset: fileOffset 
                    });
                    
                    fileOffset += CHUNK_SIZE;
                    this.pendingReadRequests++;
                }
            };

            this.channel.onbufferedamountlow = () => pump();

            worker.onmessage = async (e) => {
                if (e.data.type === 'error') {
                    worker.terminate();
                    reject(e.data.error);
                    return;
                }

                if (e.data.type === 'chunk_ready') {
                    const { buffer, eof } = e.data;
                    this.pendingReadRequests--;

                    try {
                        // Send binary
                        this.channel.send(buffer);
                        this.manager.updateProgress(buffer.byteLength);

                        if (eof) {
                            worker.terminate();
                            this.channel.onbufferedamountlow = null;
                            
                            // CRITICAL FIX: Wait for buffer to drain before sending End-Of-File
                            // This ensures the receiver gets all bytes before the JSON command
                            await this.waitForDrain();
                            
                            this.channel.send(JSON.stringify({ type: 'file-end' }));
                            
                            // Wait for ACK with timeout prevention
                            await this.waitForAckOrTimeout();
                            resolve();
                        } else {
                            pump();
                        }
                    } catch (err) {
                        console.error("Send fail", err);
                        worker.terminate();
                        reject(err);
                    }
                }
            };

            pump();
        });
    }

    // Ensures we don't send "Finish" command while bytes are still stuck in the buffer
    private async waitForDrain(): Promise<void> {
        if (this.channel.bufferedAmount === 0) return;
        
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (this.channel.bufferedAmount === 0 || this.channel.readyState !== 'open') {
                    clearInterval(check);
                    resolve();
                }
            }, 50);
        });
    }

    private waitForAckOrTimeout(): Promise<void> {
        return new Promise(resolve => {
            let solved = false;
            const originalHandler = this.channel.onmessage;
            
            // Timeout safety net (prevents freezing)
            const timeout = setTimeout(() => {
                if (!solved) {
                    solved = true;
                    this.channel.onmessage = originalHandler;
                    console.warn(`[Channel ${this.id}] ACK Timed out, forcing continue.`);
                    resolve();
                }
            }, ACK_TIMEOUT_MS);

            const ackHandler = (event: MessageEvent) => {
                if (typeof event.data === 'string') {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'ack-finish') {
                            if (!solved) {
                                solved = true;
                                clearTimeout(timeout);
                                this.channel.onmessage = originalHandler;
                                resolve();
                            }
                        }
                    } catch(e) {}
                }
            };
            this.channel.onmessage = ackHandler;
        });
    }

    private handleMessage(event: MessageEvent) {
        const { data } = event;
        if (typeof data === 'string') {
            try { this.handleControlMessage(JSON.parse(data)); } catch(e) {}
        } else if (data instanceof ArrayBuffer) {
            this.handleBinaryData(data);
        }
    }

    private handleControlMessage(msg: any) {
        if (msg.type === 'batch-info') {
            this.manager.handleBatchInfo(msg.batchMeta);
        }
        else if (msg.type === 'file-start') {
            this.currentMeta = msg.metadata;
            this.receivedBuffers = [];
            this.receivedSize = 0;
            // Notify manager we started a file
            this.manager.notifyFileStart(msg.metadata.name);
        }
        else if (msg.type === 'file-end') {
            if (this.currentMeta) {
                // Verify size integrity
                if (this.receivedSize === this.currentMeta.size) {
                    this.finishFile(this.currentMeta);
                } else {
                    console.error(`Size Mismatch! Expected ${this.currentMeta.size}, got ${this.receivedSize}`);
                    // Still finish to unblock UI, but maybe warn?
                    this.finishFile(this.currentMeta); 
                }
                // Send ACK
                try {
                    this.channel.send(JSON.stringify({ type: 'ack-finish' }));
                } catch(e) {}
            }
        }
    }

    private handleBinaryData(buffer: ArrayBuffer) {
        if (!this.currentMeta) return;
        this.receivedBuffers.push(buffer);
        this.receivedSize += buffer.byteLength;
        this.manager.updateProgress(buffer.byteLength);
    }

    private finishFile(meta: FileMetadata) {
        const blob = new Blob(this.receivedBuffers, { type: meta.type });
        this.manager.handleFileComplete(blob, meta);
        this.receivedBuffers = [];
        this.currentMeta = null;
        this.receivedSize = 0;
    }

    public cleanup() {
        if (this.channel) this.channel.close();
        this.receivedBuffers = [];
        this.fileQueue = [];
    }
}

export class P2PManager {
  private peerConnection: RTCPeerConnection | null = null;
  private channels: TransferChannel[] = [];
  
  private myId: string = Math.random().toString(36).substr(2, 9);
  private connectionState: ConnectionState = 'idle';
  
  // Callbacks
  private stateChangeCallback: ((state: ConnectionState) => void) | null = null;
  private progressCallback: ((progress: TransferProgress) => void) | null = null;
  private fileReceivedCallback: ((file: Blob, meta: FileMetadata) => void) | null = null;
  private logCallback: ((msg: string) => void) | null = null;

  private announceInterval: any = null;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];

  // Batch State
  private batchState = {
    totalFiles: 0,
    totalSize: 0,
    transferredBytes: 0,
    startTime: 0,
    completedFilesCount: 0,
    currentFileName: '' // Track active file name globally
  };
  
  private lastProgressEmit = 0;

  constructor() {
    this.handleSignal = this.handleSignal.bind(this);
    this.onSignalingConnected = this.onSignalingConnected.bind(this);
  }

  public init(roomId: string) {
    this.updateState('signaling');
    this.cleanupPeerConnection();
    signalingService.connect(roomId, this.handleSignal, this.onSignalingConnected);
  }

  public async sendFiles(files: File[]): Promise<void> {
      if (this.channels.length === 0) throw new Error("No connection");

      const totalSize = files.reduce((acc, f) => acc + f.size, 0);
      
      this.batchState = {
          totalFiles: files.length,
          totalSize: totalSize,
          transferredBytes: 0,
          startTime: Date.now(),
          completedFilesCount: 0,
          currentFileName: 'Starting...'
      };

      const batchMeta: BatchMetadata = { totalFiles: files.length, totalSize };
      // Broadcast batch info
      this.channels.forEach(ch => {
          if(ch.channel.readyState === 'open') ch.channel.send(JSON.stringify({ type: 'batch-info', batchMeta }));
      });

      files.forEach((file, index) => {
          const channelIndex = index % this.channels.length;
          this.channels[channelIndex].addToQueue(file);
      });
  }

  public cleanup() {
    this.stopAnnouncing();
    signalingService.disconnect();
    this.cleanupPeerConnection();
    this.updateState('idle');
    this.batchState = { totalFiles: 0, totalSize: 0, transferredBytes: 0, startTime: 0, completedFilesCount: 0, currentFileName: '' };
    deviceService.disableWakeLock();
  }

  public checkConnectionState() {
      const anyOpen = this.channels.some(c => c.channel.readyState === 'open');
      if (anyOpen && this.connectionState !== 'connected') {
          this.updateState('connected');
          deviceService.enableWakeLock();
      }
  }

  public handleBatchInfo(meta: BatchMetadata) {
      this.batchState = {
          totalFiles: meta.totalFiles,
          totalSize: meta.totalSize,
          transferredBytes: 0,
          startTime: Date.now(),
          completedFilesCount: 0,
          currentFileName: 'Receiving...'
      };
  }

  public notifyFileStart(name: string) {
      this.batchState.currentFileName = name;
      this.emitProgress();
  }

  public updateProgress(bytesAdded: number) {
      this.batchState.transferredBytes += bytesAdded;
      
      const now = Date.now();
      // Rate limit to 20fps for UI smoothness
      if (now - this.lastProgressEmit > 50 || this.batchState.transferredBytes >= this.batchState.totalSize) {
          this.emitProgress();
          this.lastProgressEmit = now;
      }
  }

  public handleFileComplete(blob: Blob, meta: FileMetadata) {
      this.batchState.completedFilesCount++;
      if (this.fileReceivedCallback) {
          this.fileReceivedCallback(blob, meta);
      }
      
      if (this.batchState.completedFilesCount >= this.batchState.totalFiles) {
          deviceService.sendNotification('Transfer Complete', `All ${this.batchState.totalFiles} files received`);
      }
      
      this.emitProgress();
  }

  private emitProgress() {
      if (!this.progressCallback) return;

      const elapsed = (Date.now() - this.batchState.startTime) / 1000;
      const speed = elapsed > 0 ? this.batchState.transferredBytes / elapsed : 0;
      
      const speedStr = speed > 1024 * 1024 
          ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s` 
          : `${(speed / 1024).toFixed(0)} KB/s`;

      // FIX: Ensure we don't show "File 4 of 3". Clamp to totalFiles.
      let displayIndex = this.batchState.completedFilesCount + 1;
      if (displayIndex > this.batchState.totalFiles) displayIndex = this.batchState.totalFiles;
      
      // If complete, ensure we show 100%
      const isComplete = this.batchState.completedFilesCount === this.batchState.totalFiles;
      const transferred = isComplete ? this.batchState.totalSize : this.batchState.transferredBytes;

      this.progressCallback({
          fileName: isComplete ? 'Complete' : this.batchState.currentFileName,
          transferredBytes: 0, 
          fileSize: 0,
          totalFiles: this.batchState.totalFiles,
          currentFileIndex: displayIndex,
          totalBatchBytes: this.batchState.totalSize,
          transferredBatchBytes: transferred,
          speed: isComplete ? 'Done' : speedStr,
          isComplete: isComplete
      });
  }

  // --- WEBRTC BOILERPLATE ---
  // (Same as before, simplified for brevity in this change block)
  private log(message: string) {
    console.log(`[P2P] ${message}`);
    if (this.logCallback) this.logCallback(message);
  }

  private updateState(state: ConnectionState) {
    this.connectionState = state;
    if (this.stateChangeCallback) this.stateChangeCallback(state);
  }

  private onSignalingConnected() {
    this.startAnnouncing();
  }

  private startAnnouncing() {
    this.stopAnnouncing();
    signalingService.sendSignal({ type: 'join', senderId: this.myId });
    this.announceInterval = setInterval(() => {
        if (this.connectionState === 'idle' || this.connectionState === 'signaling') {
             signalingService.sendSignal({ type: 'join', senderId: this.myId });
        }
    }, 1500);
  }

  private stopAnnouncing() {
    if (this.announceInterval) {
        clearInterval(this.announceInterval);
        this.announceInterval = null;
    }
  }

  private cleanupPeerConnection() {
    this.channels.forEach(c => c.cleanup());
    this.channels = [];
    if (this.peerConnection) {
        this.peerConnection.close();
        this.peerConnection = null;
    }
    this.iceCandidateQueue = [];
  }

  private createPeerConnection() {
    if (this.peerConnection) return this.peerConnection;
    this.peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ]
    });

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        signalingService.sendSignal({ type: 'candidate', candidate: event.candidate, senderId: this.myId });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
        const state = this.peerConnection?.connectionState;
        if (state === 'disconnected' || state === 'failed') {
            this.updateState('disconnected');
            deviceService.disableWakeLock();
        }
    };

    this.peerConnection.ondatachannel = (event) => {
        const handler = new TransferChannel(this.channels.length, event.channel, this);
        this.channels.push(handler);
        this.checkConnectionState();
    };

    return this.peerConnection;
  }

  private async handleSignal(data: any) {
    if (data.senderId === this.myId) return;

    try {
      if (data.type === 'join') {
        if (this.connectionState === 'connected' || this.connectionState === 'connecting') return;
        this.stopAnnouncing();

        if (this.myId > data.senderId) {
            if (this.peerConnection) this.cleanupPeerConnection();
            const pc = this.createPeerConnection();

            for (let i = 0; i < CONCURRENT_CHANNELS; i++) {
                const dc = pc.createDataChannel(`beam_${i}`, { ordered: true });
                const handler = new TransferChannel(i, dc, this);
                this.channels.push(handler);
            }

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.updateState('connecting');
            signalingService.sendSignal({ type: 'offer', offer, senderId: this.myId });
        } else {
             if (!this.peerConnection) this.createPeerConnection();
        }
      }
      else if (data.type === 'offer') {
        if (this.myId > data.senderId) return;
        if (!this.peerConnection) this.createPeerConnection();
        this.updateState('connecting');
        this.stopAnnouncing();

        await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(data.offer));
        await this.processIceQueue();

        const answer = await this.peerConnection!.createAnswer();
        await this.peerConnection!.setLocalDescription(answer);
        signalingService.sendSignal({ type: 'answer', answer, senderId: this.myId });
      }
      else if (data.type === 'answer') {
         if (!this.peerConnection) return;
         await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
         await this.processIceQueue();
      }
      else if (data.type === 'candidate') {
        if (this.peerConnection?.remoteDescription) {
             await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
            this.iceCandidateQueue.push(data.candidate);
        }
      }
    } catch (err) { console.error('Signal error', err); }
  }

  private async processIceQueue() {
      if (!this.peerConnection) return;
      while (this.iceCandidateQueue.length > 0) {
          const c = this.iceCandidateQueue.shift();
          if (c) await this.peerConnection.addIceCandidate(new RTCIceCandidate(c));
      }
  }

  public onStateChange(cb: any) { this.stateChangeCallback = cb; }
  public onProgress(cb: any) { this.progressCallback = cb; }
  public onFileReceived(cb: any) { this.fileReceivedCallback = cb; }
  public onLog(cb: any) { this.logCallback = cb; }
}

export const p2pManager = new P2PManager();

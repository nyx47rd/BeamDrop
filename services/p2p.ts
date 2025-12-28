
import { signalingService } from './signaling';
import { ConnectionState, FileMetadata, TransferProgress, BatchMetadata } from '../types';
import { deviceService } from './device';

// --- PERFORMANCE TUNING ---
// 64KB is the sweet spot for WebRTC. 
// Larger chunks (256KB+) cause head-of-line blocking and spikes on mobile.
// We achieve speed by keeping the pipe full, not by making chunks huge.
const CHUNK_SIZE = 64 * 1024; 

// Flow Control Limits
// MAX_IN_FLIGHT: How much data can be "reading from disk" + "in web socket buffer" combined.
// 4MB is enough to saturate a 100mbps connection without crashing low-RAM phones.
const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024; // 2MB allowed in WebRTC buffer
const MAX_QUEUE_SIZE = 8; // Max chunks reading from disk simultaneously per channel

// Concurrent channels
const CONCURRENT_CHANNELS = 2;

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

class TransferChannel {
    public id: number;
    public channel: RTCDataChannel;
    private manager: P2PManager;
    
    // State
    private isBusy = false;
    private fileQueue: File[] = [];
    
    // Flow Control
    private pendingReadRequests = 0; // Chunks requested from worker but not yet sent to channel
    private isPaused = false;

    // Receiver State
    private receivedBuffers: ArrayBuffer[] = [];
    private receivedSize = 0;
    private currentMeta: FileMetadata | null = null;
    
    // Sender State
    private currentFile: File | null = null;

    constructor(id: number, channel: RTCDataChannel, manager: P2PManager) {
        this.id = id;
        this.channel = channel;
        this.manager = manager;
        this.setupEvents();
    }

    private setupEvents() {
        this.channel.binaryType = 'arraybuffer';
        // Low threshold to trigger "refill" event early
        this.channel.bufferedAmountLowThreshold = 64 * 1024; 

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
            console.error(`[Channel ${this.id}] Send Error:`, e);
        } finally {
            this.isBusy = false;
            this.currentFile = null;
            this.processQueue();
        }
    }

    private async sendFileLogic(file: File): Promise<void> {
        const metadata: FileMetadata = {
            name: file.name,
            size: file.size,
            type: file.type,
        };
        
        this.channel.send(JSON.stringify({ type: 'file-start', metadata }));

        return new Promise<void>((resolve, reject) => {
            const worker = createWorker();
            let fileOffset = 0;
            
            this.pendingReadRequests = 0;
            this.isPaused = false;

            // CORE PIPELINE LOGIC
            const pump = () => {
                if (this.channel.readyState !== 'open') return;

                // Stop if we have too much buffered (Backpressure)
                // We count both "OS Network Buffer" (bufferedAmount) AND "Worker processing" (pendingReadRequests)
                const networkBacklog = this.channel.bufferedAmount;
                const diskBacklog = this.pendingReadRequests * CHUNK_SIZE;

                if (networkBacklog > MAX_BUFFERED_AMOUNT || this.pendingReadRequests >= MAX_QUEUE_SIZE) {
                    this.isPaused = true;
                    return; 
                }

                this.isPaused = false;

                // Fill the pipeline
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

            // Trigger pump when network buffer drains
            this.channel.onbufferedamountlow = () => {
                pump();
            };

            worker.onmessage = (e) => {
                if (e.data.type === 'error') {
                    worker.terminate();
                    reject(e.data.error);
                    return;
                }

                if (e.data.type === 'chunk_ready') {
                    const { buffer, eof } = e.data;
                    this.pendingReadRequests--;

                    try {
                        this.channel.send(buffer);
                        this.manager.updateProgress(buffer.byteLength, file.size, file.name);

                        if (eof) {
                            worker.terminate();
                            this.channel.onbufferedamountlow = null;
                            this.channel.send(JSON.stringify({ type: 'file-end' }));
                            this.waitForAck(resolve);
                        } else {
                            // Immediately try to refill the pipe
                            pump();
                        }
                    } catch (err) {
                        console.error("Send failed", err);
                    }
                }
            };

            // Start the loop
            pump();
        });
    }

    private waitForAck(resolve: () => void) {
        const originalHandler = this.channel.onmessage;
        const ackHandler = (event: MessageEvent) => {
            if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'ack-finish') {
                        this.channel.onmessage = originalHandler;
                        resolve();
                    }
                } catch(e) {}
            }
        };
        this.channel.onmessage = ackHandler;
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
            // Notify manager sending started for UI
            this.manager.updateProgress(0, msg.metadata.size, msg.metadata.name);
        }
        else if (msg.type === 'file-end') {
            if (this.currentMeta) {
                this.finishFile(this.currentMeta);
                this.channel.send(JSON.stringify({ type: 'ack-finish' }));
            }
        }
    }

    private handleBinaryData(buffer: ArrayBuffer) {
        if (!this.currentMeta) return;
        this.receivedBuffers.push(buffer);
        this.receivedSize += buffer.byteLength;
        this.manager.updateProgress(buffer.byteLength, this.currentMeta.size, this.currentMeta.name);
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
    completedFilesCount: 0
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
          completedFilesCount: 0
      };

      const batchMeta: BatchMetadata = { totalFiles: files.length, totalSize };
      // Send batch info on all channels to ensure sync, though primarily ch0 matters
      this.channels[0].channel.send(JSON.stringify({ type: 'batch-info', batchMeta }));

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
    this.batchState = { totalFiles: 0, totalSize: 0, transferredBytes: 0, startTime: 0, completedFilesCount: 0 };
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
          completedFilesCount: 0
      };
      this.log(`Batch started: ${meta.totalFiles} files`);
  }

  public updateProgress(bytesAdded: number, currentFileSize: number, currentFileName: string) {
      this.batchState.transferredBytes += bytesAdded;
      
      const now = Date.now();
      // Rate limit UI updates to 15fps (approx 60ms) to save CPU for transfer
      if (now - this.lastProgressEmit > 60 || this.batchState.transferredBytes >= this.batchState.totalSize) {
          this.emitProgress(currentFileName);
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
      
      this.emitProgress(meta.name);
  }

  private emitProgress(currentFileName: string) {
      if (!this.progressCallback) return;

      const elapsed = (Date.now() - this.batchState.startTime) / 1000;
      const speed = elapsed > 0 ? this.batchState.transferredBytes / elapsed : 0;
      
      const speedStr = speed > 1024 * 1024 
          ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s` 
          : `${(speed / 1024).toFixed(0)} KB/s`;

      // Logic fix: Ensure file index doesn't exceed total
      const displayIndex = Math.min(this.batchState.completedFilesCount + 1, this.batchState.totalFiles);

      this.progressCallback({
          fileName: currentFileName,
          transferredBytes: 0, 
          fileSize: 0,
          totalFiles: this.batchState.totalFiles,
          currentFileIndex: displayIndex,
          totalBatchBytes: this.batchState.totalSize,
          transferredBatchBytes: this.batchState.transferredBytes,
          speed: speedStr,
          isComplete: this.batchState.transferredBytes >= this.batchState.totalSize && this.batchState.completedFilesCount === this.batchState.totalFiles
      });
  }

  // --- WEBRTC BOILERPLATE ---

  private log(message: string) {
    console.log(`[P2P] ${message}`);
    if (this.logCallback) this.logCallback(message);
  }

  private updateState(state: ConnectionState) {
    this.connectionState = state;
    if (this.stateChangeCallback) this.stateChangeCallback(state);
  }

  private onSignalingConnected() {
    this.log("Signaling connected.");
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
    this.log("Initializing WebRTC...");
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
        this.log(`Channel ${this.channels.length} attached`);
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
                const dc = pc.createDataChannel(`beam_${i}`, { ordered: true, maxRetransmits: 30 });
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

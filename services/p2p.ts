
import { signalingService } from './signaling';
import { ConnectionState, FileMetadata, TransferProgress, BatchMetadata } from '../types';
import { deviceService } from './device';

// --- PERFORMANCE TUNING ---
// 64KB is the "Golden Size" for WebRTC (SCTP) throughput.
// Smaller makes CPU work too hard (overhead). Larger risks packet loss spikes.
const CHUNK_SIZE = 64 * 1024; 

// We want to keep the WebRTC buffer relatively full (to maximize bandwidth usage)
// but strictly below the browser's crash limit.
// 256KB Low / 1MB High provides a deep buffer for high-latency networks.
const BUFFER_LOW_WATER_MARK = 256 * 1024; 
const BUFFER_HIGH_WATER_MARK = 1024 * 1024; // 1MB Max Buffer

// How many chunks to keep in JS memory ready to send immediately?
// 5 chunks * 64KB = ~320KB RAM usage. Very safe.
const LOOKAHEAD_QUEUE_SIZE = 5;

// Expanded STUN server list
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.ekiga.net' },
    { urls: 'stun:stun.ideasip.com' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle' as RTCBundlePolicy,
};

export class P2PManager {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private myId: string = Math.random().toString(36).substr(2, 9);
  private connectionState: ConnectionState = 'idle';
  
  private stateChangeCallback: ((state: ConnectionState) => void) | null = null;
  private progressCallback: ((progress: TransferProgress) => void) | null = null;
  private fileReceivedCallback: ((file: Blob, meta: FileMetadata) => void) | null = null;
  private logCallback: ((msg: string) => void) | null = null;

  // Connection management
  private announceInterval: any = null;
  private remotePeerId: string | null = null;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];

  // Batch State (Shared for Sender & Receiver)
  private batchState = {
    active: false,
    totalFiles: 0,
    totalSize: 0,
    processedFiles: 0,
    processedBytes: 0, // Total bytes processed in previous files of this batch
    startTime: 0
  };

  // Receiving state
  private receivedBuffers: ArrayBuffer[] = [];
  private receivedSize = 0; // Bytes of CURRENT file
  private currentFileMeta: FileMetadata | null = null;
  private lastProgressEmit = 0;

  // Sending state
  private finalAckResolver: (() => void) | null = null;

  // Notification debouncing
  private recentReceivedFiles: string[] = [];
  private notificationTimeout: any = null;

  constructor() {
    this.handleSignal = this.handleSignal.bind(this);
    this.onSignalingConnected = this.onSignalingConnected.bind(this);
  }

  private log(message: string) {
    console.log(`[P2P] ${message}`);
    if (this.logCallback) {
      this.logCallback(message);
    }
  }

  private updateState(state: ConnectionState) {
    this.connectionState = state;
    if (this.stateChangeCallback) {
      this.stateChangeCallback(state);
    }
  }

  public init(roomId: string) {
    this.updateState('signaling');
    this.cleanupPeerConnection();
    this.log("Connecting to signaling network...");
    signalingService.connect(roomId, this.handleSignal, this.onSignalingConnected);
  }

  private onSignalingConnected() {
    this.log("Signaling connected. Searching for device...");
    this.startAnnouncing();
  }

  private startAnnouncing() {
    this.stopAnnouncing();
    signalingService.sendSignal({ type: 'join', senderId: this.myId });
    this.announceInterval = setInterval(() => {
        if (this.connectionState === 'idle' || this.connectionState === 'signaling') {
             signalingService.sendSignal({ type: 'join', senderId: this.myId });
        }
    }, 1000);
  }

  private stopAnnouncing() {
    if (this.announceInterval) {
        clearInterval(this.announceInterval);
        this.announceInterval = null;
    }
  }

  private createPeerConnection() {
    if (this.peerConnection) return this.peerConnection;

    this.log("Initializing secure peer connection...");
    this.peerConnection = new RTCPeerConnection(ICE_SERVERS);
    this.iceCandidateQueue = [];

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        signalingService.sendSignal({
          type: 'candidate',
          candidate: event.candidate,
          senderId: this.myId,
        });
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      console.log('PeerConnection State:', state);
      
      if (state === 'connecting') {
        this.log("Verifying network path (ICE checking)...");
      } else if (state === 'connected') {
        this.log("Secure connection established!");
        this.updateState('connected');
        this.stopAnnouncing();
        deviceService.enableWakeLock();
        deviceService.sendNotification('BeamDrop Connected', 'Ready to transfer files');
      } else if (state === 'failed') {
        this.log("Connection attempt failed. Retrying...");
        this.updateState('failed');
      } else if (state === 'disconnected') {
        this.log("Peer disconnected.");
        this.updateState('disconnected');
        deviceService.disableWakeLock();
      }
    };

    this.peerConnection.ondatachannel = (event) => {
        this.log("Data channel received. Preparing transfer...");
        this.dataChannel = event.channel;
        this.setupDataChannel(this.dataChannel);
    };

    return this.peerConnection;
  }

  private setupDataChannel(channel: RTCDataChannel) {
    channel.onopen = () => {
      this.log("Data channel ready. You can now transfer files.");
      channel.binaryType = 'arraybuffer';
      // Use the Constant for low watermark
      channel.bufferedAmountLowThreshold = BUFFER_LOW_WATER_MARK;
      
      if (this.peerConnection?.connectionState === 'connected') {
        this.updateState('connected');
      }
    };
    channel.onclose = () => this.log("Data channel closed.");
    channel.onerror = (err) => console.error('Data Channel Error:', err);

    channel.onmessage = (event) => {
      const { data } = event;
      
      // 1. Handle Control Messages
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          
          if (msg.type === 'batch-info') {
             this.batchState = {
                 active: true,
                 totalFiles: msg.batchMeta.totalFiles,
                 totalSize: msg.batchMeta.totalSize,
                 processedFiles: 0,
                 processedBytes: 0,
                 startTime: Date.now()
             };
             this.log(`Incoming batch: ${this.batchState.totalFiles} files (${(this.batchState.totalSize / 1024 / 1024).toFixed(1)} MB)`);
          }
          else if (msg.type === 'file-start') {
            this.currentFileMeta = msg.metadata;
            this.receivedBuffers = [];
            this.receivedSize = 0;
            this.lastProgressEmit = 0;
            this.log(`Receiving ${msg.metadata.name} (${this.batchState.processedFiles + 1}/${this.batchState.totalFiles})...`);
          } 
          else if (msg.type === 'file-end') {
             if (this.currentFileMeta) {
                 this.finishReceivingFile(this.currentFileMeta);
                 channel.send(JSON.stringify({ type: 'ack-finish' }));
             }
          }
          else if (msg.type === 'ack-finish') {
            if (this.finalAckResolver) {
                this.finalAckResolver();
                this.finalAckResolver = null;
            }
          }
        } catch (e) { console.error(e); }
      } 
      // 2. Handle Binary Chunks
      else if (data instanceof ArrayBuffer) {
        if (!this.currentFileMeta) return;
        
        this.receivedBuffers.push(data);
        this.receivedSize += data.byteLength;
        
        this.throttledReportProgress(this.receivedSize, this.currentFileMeta.size, this.currentFileMeta.name);
      }
    };
  }

  private finishReceivingFile(meta: FileMetadata) {
      try {
        const blob = new Blob(this.receivedBuffers, { type: meta.type });
        if (this.fileReceivedCallback) this.fileReceivedCallback(blob, meta);
        this.triggerReceivedNotification(meta.name);
        
        this.batchState.processedFiles++;
        this.batchState.processedBytes += meta.size;

        this.reportProgress(meta.size, meta.size, meta.name);
      } catch(e) {
          console.error("Failed to assemble file", e);
          this.log("Error: Out of memory assembling file.");
      } finally {
        this.receivedBuffers = [];
        this.currentFileMeta = null;
      }
  }

  private throttledReportProgress(currentFileBytes: number, totalFileBytes: number, name: string) {
      const now = Date.now();
      // Optimization: Update UI every ~100ms
      if (currentFileBytes >= totalFileBytes || (now - this.lastProgressEmit > 100)) {
          this.reportProgress(currentFileBytes, totalFileBytes, name);
          this.lastProgressEmit = now;
      }
  }

  private triggerReceivedNotification(fileName: string) {
    this.recentReceivedFiles.push(fileName);
    if (this.notificationTimeout) {
      clearTimeout(this.notificationTimeout);
    }
    this.notificationTimeout = setTimeout(() => {
      const count = this.recentReceivedFiles.length;
      if (count === 1) {
        deviceService.sendNotification('File Received', `Received ${this.recentReceivedFiles[0]}`);
      } else if (count > 1) {
        deviceService.sendNotification('Batch Complete', `Received ${count} files`);
      }
      this.recentReceivedFiles = [];
      this.notificationTimeout = null;
    }, 1500); 
  }

  private async processIceQueue() {
      if (!this.peerConnection) return;
      while (this.iceCandidateQueue.length > 0) {
          const candidate = this.iceCandidateQueue.shift();
          if (candidate) {
              try { await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } 
              catch (e) { console.warn("Error adding queued ICE candidate", e); }
          }
      }
  }

  private async handleSignal(data: any) {
    if (data.senderId === this.myId) return;

    try {
      if (data.type === 'join') {
        if (this.connectionState === 'connected' || this.connectionState === 'connecting') return;
        this.log("Peer found. Handshaking...");
        this.remotePeerId = data.senderId;
        this.stopAnnouncing();

        if (this.myId > data.senderId) {
            if (this.peerConnection) this.cleanupPeerConnection();
            const pc = this.createPeerConnection();
            this.dataChannel = pc.createDataChannel('fileTransfer', { 
                ordered: true,
                maxRetransmits: 30
            });
            this.setupDataChannel(this.dataChannel);

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
         if (this.peerConnection.signalingState === "stable") return;
         await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
         await this.processIceQueue();
      }
      else if (data.type === 'candidate') {
        const candidateInit = data.candidate;
        if (this.peerConnection && this.peerConnection.remoteDescription && this.peerConnection.signalingState !== 'closed') {
             try { await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit)); } 
             catch(e) { }
        } else {
            this.iceCandidateQueue.push(candidateInit);
        }
      }
    } catch (err) { console.error('Signal error', err); }
  }

  public async sendFiles(files: File[]): Promise<void> {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
          throw new Error("Connection not open");
      }

      const totalSize = files.reduce((acc, file) => acc + file.size, 0);
      const totalFiles = files.length;
      
      this.batchState = {
          active: true,
          totalFiles,
          totalSize,
          processedFiles: 0,
          processedBytes: 0,
          startTime: Date.now()
      };

      const batchMeta: BatchMetadata = { totalFiles, totalSize };
      this.dataChannel.send(JSON.stringify({ type: 'batch-info', batchMeta }));

      for (const file of files) {
          await this.sendFileInternal(file);
          this.batchState.processedFiles++;
          this.batchState.processedBytes += file.size;
      }
      
      this.batchState.active = false;
  }

  /**
   * HIGH-PERFORMANCE PIPELINED SEND
   * Uses an in-memory queue to ensure the DataChannel is NEVER idle.
   */
  private async sendFileInternal(file: File): Promise<void> {
    const metadata: FileMetadata = {
        name: file.name,
        size: file.size,
        type: file.type,
    };
    this.dataChannel?.send(JSON.stringify({ type: 'file-start', metadata }));
    
    this.lastProgressEmit = 0;

    const worker = new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });
    
    let fileOffset = 0;
    // The "Lookahead Queue" - chunks read from worker but not yet sent to peer
    const chunkQueue: { buffer: ArrayBuffer, offset: number, eof: boolean }[] = [];
    
    // Status flags
    let isWorkerReading = false;
    let isFileDone = false;
    let hasError = false;

    return new Promise<void>((resolve, reject) => {
        
        // 1. Worker Message Handler
        worker.onmessage = (e) => {
            if (e.data.type === 'error') {
                hasError = true;
                worker.terminate();
                reject(e.data.error);
                return;
            }

            if (e.data.type === 'chunk_ready') {
                // Add to our lookahead queue
                chunkQueue.push({ 
                    buffer: e.data.buffer, 
                    offset: e.data.offset, 
                    eof: e.data.eof 
                });
                
                isWorkerReading = false; // Worker is free now

                // Try to push data to DataChannel immediately
                pump();

                // If we aren't done, and the queue isn't full, ask for more
                if (!e.data.eof) {
                   fillQueue(); 
                }
            }
        };

        // 2. Queue Filler: Keeps the worker busy until our JS queue is full
        const fillQueue = () => {
            if (hasError || isFileDone) return;
            // While we have room in RAM and worker is idle
            if (chunkQueue.length < LOOKAHEAD_QUEUE_SIZE && !isWorkerReading && fileOffset < file.size) {
                isWorkerReading = true;
                worker.postMessage({ type: 'read_chunk', file, chunkSize: CHUNK_SIZE, startOffset: fileOffset });
                fileOffset += CHUNK_SIZE;
            }
        };

        // 3. The PUMP: Pushes data to WebRTC
        const pump = async () => {
             if (hasError || !this.dataChannel) return;

             // While we have data in queue AND the channel isn't "full"
             while (chunkQueue.length > 0 && (this.dataChannel.bufferedAmount < BUFFER_HIGH_WATER_MARK)) {
                 const chunk = chunkQueue.shift();
                 if (!chunk) break;

                 try {
                     this.dataChannel.send(chunk.buffer);
                     
                     // Update UI
                     this.throttledReportProgress(chunk.offset, file.size, file.name);

                     if (chunk.eof) {
                         isFileDone = true;
                         finish();
                         return;
                     }
                 } catch (e: any) {
                     // Safety net for "queue full" error if high watermark wasn't respected
                     console.warn("Send failed, waiting for drain...", e);
                     chunkQueue.unshift(chunk); // Put it back
                     await waitForDrain(); 
                     return; 
                 }
             }

             // If we emptied the queue a bit, ask worker for more
             fillQueue();

             // If the channel is full, wait for it to drain
             if (this.dataChannel.bufferedAmount >= BUFFER_HIGH_WATER_MARK) {
                 await waitForDrain();
                 pump(); // Resume pumping after drain
             }
        };

        // 4. Backpressure Handler
        const waitForDrain = (): Promise<void> => {
            return new Promise(resolveDrain => {
                if (!this.dataChannel) return resolveDrain();
                if (this.dataChannel.bufferedAmount < BUFFER_LOW_WATER_MARK) return resolveDrain();

                const handler = () => {
                    this.dataChannel?.removeEventListener('bufferedamountlow', handler);
                    resolveDrain();
                };
                this.dataChannel.addEventListener('bufferedamountlow', handler);
            });
        };

        // 5. Completion Handler
        const finish = async () => {
            worker.terminate();
            try {
                this.dataChannel?.send(JSON.stringify({ type: 'file-end' }));
                await new Promise<void>((resolveAck) => {
                    this.finalAckResolver = resolveAck;
                    setTimeout(() => resolveAck(), 30000);
                });
                this.reportProgress(file.size, file.size, file.name);
                resolve();
            } catch (e) { reject(e); }
        };

        // Start the engine
        fillQueue();
    });
  }
  
  public async sendFile(file: File) {
      return this.sendFiles([file]);
  }

  private reportProgress(currentFileBytes: number, totalFileBytes: number, name: string) {
    if (this.progressCallback) {
        const totalBatchReceived = this.batchState.processedBytes + currentFileBytes;
        const totalBatchSize = this.batchState.totalSize || totalFileBytes;
        
        const elapsed = (Date.now() - this.batchState.startTime) / 1000;
        const speed = elapsed > 0 ? totalBatchReceived / elapsed : 0;
        
        const speedStr = speed > 1024 * 1024 
            ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s` 
            : `${(speed / 1024).toFixed(1)} KB/s`;
            
        this.progressCallback({
            fileName: name,
            transferredBytes: currentFileBytes,
            fileSize: totalFileBytes,
            
            totalFiles: this.batchState.totalFiles || 1,
            currentFileIndex: (this.batchState.processedFiles || 0) + 1,
            totalBatchBytes: totalBatchSize,
            transferredBatchBytes: totalBatchReceived,
            
            speed: speedStr,
            isComplete: totalBatchReceived >= totalBatchSize
        });
    }
  }

  public cleanup() {
    this.stopAnnouncing();
    signalingService.disconnect();
    this.cleanupPeerConnection();
    this.connectionState = 'idle';
    deviceService.disableWakeLock();
    this.batchState = { active: false, totalFiles: 0, totalSize: 0, processedFiles: 0, processedBytes: 0, startTime: 0 };
  }

  private cleanupPeerConnection() {
    if (this.dataChannel) { this.dataChannel.close(); this.dataChannel = null; }
    if (this.peerConnection) { this.peerConnection.close(); this.peerConnection = null; }
    this.iceCandidateQueue = [];
    this.receivedBuffers = [];
  }

  public onStateChange(cb: (state: ConnectionState) => void) { this.stateChangeCallback = cb; }
  public onProgress(cb: (progress: TransferProgress) => void) { this.progressCallback = cb; }
  public onFileReceived(cb: (blob: Blob, meta: FileMetadata) => void) { this.fileReceivedCallback = cb; }
  public onLog(cb: (msg: string) => void) { this.logCallback = cb; }
}

export const p2pManager = new P2PManager();

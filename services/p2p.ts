import { signalingService } from './mqttSignaling';
import { ConnectionState, FileMetadata, TransferProgress } from '../types';
import { deviceService } from './device';

const CHUNK_SIZE = 64 * 1024; // Increased to 64KB for better throughput
const MAX_BUFFERED_AMOUNT = 256 * 1024; // 256KB limit to prevent backpressure issues

// Reduced STUN server list to minimize DNS resolution time and gathering latency.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }, 
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

  // Receiving state
  private receivedBuffers: ArrayBuffer[] = [];
  private receivedSize = 0;
  private currentFileMeta: FileMetadata | null = null;
  private startTime = 0;
  private lastProgressEmit = 0; // Throttling timestamp

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
        // Activate background hacks
        deviceService.enableWakeLock();
        deviceService.enableBackgroundMode();
        deviceService.sendNotification('BeamDrop Connected', 'Ready to transfer files');
      } else if (state === 'failed') {
        this.log("Connection attempt failed. Retrying...");
        this.updateState('failed');
      } else if (state === 'disconnected') {
        this.log("Peer disconnected.");
        this.updateState('disconnected');
        deviceService.disableBackgroundMode();
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
      if (this.peerConnection?.connectionState === 'connected') {
        this.updateState('connected');
      }
    };
    channel.onclose = () => this.log("Data channel closed.");
    channel.onerror = (err) => console.error('Data Channel Error:', err);
    channel.binaryType = 'arraybuffer';

    channel.onmessage = (event) => {
      const { data } = event;
      
      // Handle Text Control Messages
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'file-start') {
            this.currentFileMeta = msg.metadata;
            this.receivedBuffers = [];
            this.receivedSize = 0;
            this.startTime = Date.now();
            this.lastProgressEmit = 0;
            this.log(`Receiving ${msg.metadata.name}...`);
          }
        } catch (e) { console.error(e); }
      } 
      // Handle Binary Chunks
      else if (data instanceof ArrayBuffer) {
        if (!this.currentFileMeta) return;
        
        this.receivedBuffers.push(data);
        this.receivedSize += data.byteLength;
        
        // Throttled Progress Report (Every 100ms max to prevent UI freeze)
        this.throttledReportProgress(this.receivedSize, this.currentFileMeta.size, this.currentFileMeta.name);

        if (this.receivedSize >= this.currentFileMeta.size) {
          const blob = new Blob(this.receivedBuffers, { type: this.currentFileMeta.type });
          if (this.fileReceivedCallback) this.fileReceivedCallback(blob, this.currentFileMeta);
          
          this.triggerReceivedNotification(this.currentFileMeta.name);

          // Force Cleanup
          this.receivedBuffers = [];
          this.currentFileMeta = null;
        }
      }
    };
  }

  private throttledReportProgress(current: number, total: number, name: string) {
      const now = Date.now();
      // Update if complete OR if 100ms has passed since last update
      if (current >= total || (now - this.lastProgressEmit > 100)) {
          this.reportProgress(current, total, name);
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
        deviceService.sendNotification('Files Received', `Received ${count} files`);
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
        this.log("Peer device found. Initiating handshake...");
        this.remotePeerId = data.senderId;
        this.stopAnnouncing();

        if (this.myId > data.senderId) {
            if (this.peerConnection) this.cleanupPeerConnection();
            const pc = this.createPeerConnection();
            this.dataChannel = pc.createDataChannel('fileTransfer', { ordered: true });
            this.setupDataChannel(this.dataChannel);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.updateState('connecting');
            this.log("Sending connection offer...");
            signalingService.sendSignal({ type: 'offer', offer, senderId: this.myId });
        } else {
             this.log("Preparing to accept connection...");
             if (!this.peerConnection) this.createPeerConnection();
        }
      }
      else if (data.type === 'offer') {
        if (this.myId > data.senderId) return;
        this.log("Received connection offer. Processing...");
        if (!this.peerConnection) this.createPeerConnection();
        this.updateState('connecting');
        this.stopAnnouncing();

        await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(data.offer));
        await this.processIceQueue();

        const answer = await this.peerConnection!.createAnswer();
        await this.peerConnection!.setLocalDescription(answer);
        
        this.log("Sending connection answer...");
        signalingService.sendSignal({ type: 'answer', answer, senderId: this.myId });
      }
      else if (data.type === 'answer') {
         if (!this.peerConnection) return;
         if (this.peerConnection.signalingState === "stable") return;
         this.log("Received answer. Finalizing connection...");
         await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
         await this.processIceQueue();
      }
      else if (data.type === 'candidate') {
        const candidateInit = data.candidate;
        if (this.peerConnection && this.peerConnection.remoteDescription && this.peerConnection.signalingState !== 'closed') {
             try { await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit)); } 
             catch(e) { console.warn("Failed to add ICE candidate", e); }
        } else {
            this.iceCandidateQueue.push(candidateInit);
        }
      }
    } catch (err) { console.error('Signal handling error:', err); }
  }

  /**
   * MEMORY OPTIMIZED SEND FUNCTION
   * Reads file in chunks instead of loading all to RAM.
   * Yields to Event Loop to prevent UI freeze.
   */
  public async sendFile(file: File): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        throw new Error("Connection not open");
    }

    const metadata: FileMetadata = {
        name: file.name,
        size: file.size,
        type: file.type,
    };
    
    // 1. Send Metadata
    this.dataChannel.send(JSON.stringify({ type: 'file-start', metadata }));
    
    // 2. Prepare for transfer
    this.startTime = Date.now();
    this.lastProgressEmit = 0;
    let offset = 0;

    // 3. Chunked Read & Send Loop (Async/Await to allow GC and UI updates)
    while (offset < file.size) {
        // A. Connection Check
        if (this.dataChannel.readyState !== 'open') throw new Error("Connection lost");

        // B. Backpressure Control: If buffer is full, wait (Yield)
        if (this.dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) {
            await new Promise(resolve => setTimeout(resolve, 50)); // Yield 50ms to drain
            continue; // Retry loop
        }

        // C. Read ONLY the current chunk from disk/blob (Memory Safe)
        const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
        const chunkBuffer = await chunkBlob.arrayBuffer();

        // D. Send
        try {
            this.dataChannel.send(chunkBuffer);
        } catch (e) {
            console.error("Send failed", e);
            throw e;
        }

        // E. Update Offsets
        offset += chunkBuffer.byteLength;

        // F. Update Progress (Throttled)
        this.throttledReportProgress(offset, file.size, file.name);

        // G. Essential Yield: Allow Main Thread to breathe every few chunks
        // Without this, the UI freezes even if using async/await
        if (offset % (CHUNK_SIZE * 5) === 0) {
            await new Promise(resolve => setTimeout(resolve, 0)); 
        }
    }

    // 4. Ensure complete
    this.reportProgress(file.size, file.size, file.name);
  }

  private reportProgress(current: number, total: number, name: string) {
    if (this.progressCallback) {
        const elapsed = (Date.now() - this.startTime) / 1000;
        const speed = elapsed > 0 ? current / elapsed : 0;
        const speedStr = speed > 1024 * 1024 ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s` : `${(speed / 1024).toFixed(1)} KB/s`;
        this.progressCallback({
            fileName: name,
            transferredBytes: current,
            totalBytes: total,
            speed: speedStr,
            isComplete: current >= total
        });
    }
  }

  public cleanup() {
    this.stopAnnouncing();
    signalingService.disconnect();
    this.cleanupPeerConnection();
    this.connectionState = 'idle';
    deviceService.disableBackgroundMode();
    deviceService.disableWakeLock();
  }

  private cleanupPeerConnection() {
    if (this.dataChannel) { this.dataChannel.close(); this.dataChannel = null; }
    if (this.peerConnection) { this.peerConnection.close(); this.peerConnection = null; }
    this.iceCandidateQueue = [];
  }

  public onStateChange(cb: (state: ConnectionState) => void) { this.stateChangeCallback = cb; }
  public onProgress(cb: (progress: TransferProgress) => void) { this.progressCallback = cb; }
  public onFileReceived(cb: (blob: Blob, meta: FileMetadata) => void) { this.fileReceivedCallback = cb; }
  public onLog(cb: (msg: string) => void) { this.logCallback = cb; }
}

export const p2pManager = new P2PManager();
import { signalingService } from './mqttSignaling';
import { ConnectionState, FileMetadata, TransferProgress } from '../types';
import { deviceService } from './device';

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
// ACK_THRESHOLD: Receiver must send ACK every X chunks.
// 16 chunks * 64KB = 1MB. Sender pauses every 1MB to let Receiver catch up.
const ACK_THRESHOLD = 16; 

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
  private chunksReceivedCount = 0;
  private currentFileMeta: FileMetadata | null = null;
  private startTime = 0;
  private lastProgressEmit = 0;

  // Sending state (Flow Control)
  private ackResolver: (() => void) | null = null;

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
      
      // 1. Handle Control Messages (Start, Ack, etc)
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          
          if (msg.type === 'file-start') {
            this.currentFileMeta = msg.metadata;
            // Immediate Reset for safety
            this.receivedBuffers = [];
            this.receivedSize = 0;
            this.chunksReceivedCount = 0;
            this.startTime = Date.now();
            this.lastProgressEmit = 0;
            this.log(`Receiving ${msg.metadata.name}...`);
          } 
          else if (msg.type === 'ack') {
            // Unblock the sender
            if (this.ackResolver) {
                this.ackResolver();
                this.ackResolver = null;
            }
          }
        } catch (e) { console.error(e); }
      } 
      // 2. Handle Binary Chunks
      else if (data instanceof ArrayBuffer) {
        if (!this.currentFileMeta) return;
        
        this.receivedBuffers.push(data);
        this.receivedSize += data.byteLength;
        this.chunksReceivedCount++;
        
        // A. Send ACK if threshold reached (Flow Control)
        if (this.chunksReceivedCount % ACK_THRESHOLD === 0) {
            channel.send(JSON.stringify({ type: 'ack' }));
        }

        // B. Update Progress UI
        this.throttledReportProgress(this.receivedSize, this.currentFileMeta.size, this.currentFileMeta.name);

        // C. Check Completion
        if (this.receivedSize >= this.currentFileMeta.size) {
          // CRITICAL FIX: Save file immediately.
          // Do NOT use setTimeout here, as the next file-start message 
          // might arrive before the timeout, clearing receivedBuffers.
          this.finishReceivingFile(this.currentFileMeta);
        }
      }
    };
  }

  private finishReceivingFile(meta: FileMetadata) {
      try {
        const blob = new Blob(this.receivedBuffers, { type: meta.type });
        if (this.fileReceivedCallback) this.fileReceivedCallback(blob, meta);
        this.triggerReceivedNotification(meta.name);
      } catch(e) {
          console.error("Failed to assemble file", e);
          this.log("Error: Out of memory assembling file.");
      } finally {
        // Cleanup memory immediately after blob creation
        this.receivedBuffers = [];
        this.currentFileMeta = null;
      }
  }

  private throttledReportProgress(current: number, total: number, name: string) {
      const now = Date.now();
      // Optimization: Increased throttling to 200ms to reduce Main Thread Load
      if (current >= total || (now - this.lastProgressEmit > 200)) {
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
        this.log("Peer found. Handshaking...");
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

  /**
   * ROBUST SEND FUNCTION WITH FLOW CONTROL
   * Pauses every ACK_THRESHOLD chunks to wait for receiver.
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
    
    this.startTime = Date.now();
    this.lastProgressEmit = 0;
    let offset = 0;
    let chunkIndex = 0;

    // 2. Read & Send Loop
    while (offset < file.size) {
        if (this.dataChannel.readyState !== 'open') throw new Error("Connection lost");

        // A. Read Chunk
        const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
        const chunkBuffer = await chunkBlob.arrayBuffer();

        // B. Send Chunk
        try {
            this.dataChannel.send(chunkBuffer);
        } catch (e) {
            console.error("Send failed", e);
            throw e;
        }

        // C. FLOW CONTROL: Wait for ACK every X chunks
        chunkIndex++;
        if (chunkIndex % ACK_THRESHOLD === 0) {
            // Create a promise that resolves when 'ack' message arrives in onmessage
            await new Promise<void>((resolve) => {
                this.ackResolver = resolve;
                // Safety timeout: if peer dies or ack lost, don't hang forever (30s)
                setTimeout(() => {
                    if (this.ackResolver === resolve) {
                         console.warn("ACK Timeout, resuming anyway...");
                         resolve(); 
                    }
                }, 10000); 
            });
        } else {
            // If not waiting for ACK, still breathe slightly for UI
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        offset += chunkBuffer.byteLength;
        this.throttledReportProgress(offset, file.size, file.name);
    }

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
    this.receivedBuffers = [];
  }

  public onStateChange(cb: (state: ConnectionState) => void) { this.stateChangeCallback = cb; }
  public onProgress(cb: (progress: TransferProgress) => void) { this.progressCallback = cb; }
  public onFileReceived(cb: (blob: Blob, meta: FileMetadata) => void) { this.fileReceivedCallback = cb; }
  public onLog(cb: (msg: string) => void) { this.logCallback = cb; }
}

export const p2pManager = new P2PManager();
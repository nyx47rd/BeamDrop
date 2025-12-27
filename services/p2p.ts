import { signalingService } from './mqttSignaling';
import { ConnectionState, FileMetadata, TransferProgress } from '../types';

const CHUNK_SIZE = 16 * 1024; // 16KB chunks
const MAX_BUFFERED_AMOUNT = 64 * 1024; // 64KB buffer limit

// Reduced STUN server list to minimize DNS resolution time and gathering latency.
// Standard WebRTC automatically prefers local (host) candidates for same-wifi connections.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // Fallback if primary fails
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
    
    // Announce immediately without waiting for interval
    signalingService.sendSignal({ type: 'join', senderId: this.myId });

    // Poll faster (every 1s instead of 2s) to speed up discovery
    this.announceInterval = setInterval(() => {
        // Only announce if we are not yet deep in connection process
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
        // Trickle ICE: Send candidates immediately as they are gathered
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
      } else if (state === 'failed') {
        this.log("Connection attempt failed. Retrying...");
        this.updateState('failed');
      } else if (state === 'disconnected') {
        this.log("Peer disconnected.");
        this.updateState('disconnected');
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
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'file-start') {
            this.currentFileMeta = msg.metadata;
            this.receivedBuffers = [];
            this.receivedSize = 0;
            this.startTime = Date.now();
          }
        } catch (e) { console.error(e); }
      } 
      else if (data instanceof ArrayBuffer) {
        if (!this.currentFileMeta) return;
        this.receivedBuffers.push(data);
        this.receivedSize += data.byteLength;
        this.reportProgress(this.receivedSize, this.currentFileMeta.size, this.currentFileMeta.name);

        if (this.receivedSize >= this.currentFileMeta.size) {
          const blob = new Blob(this.receivedBuffers, { type: this.currentFileMeta.type });
          if (this.fileReceivedCallback) this.fileReceivedCallback(blob, this.currentFileMeta);
          this.receivedBuffers = [];
          this.currentFileMeta = null;
        }
      }
    };
  }

  private async processIceQueue() {
      if (!this.peerConnection) return;
      while (this.iceCandidateQueue.length > 0) {
          const candidate = this.iceCandidateQueue.shift();
          if (candidate) {
              try {
                  await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) { console.warn("Error adding queued ICE candidate", e); }
          }
      }
  }

  private async handleSignal(data: any) {
    if (data.senderId === this.myId) return;

    try {
      if (data.type === 'join') {
        // Optimization: If we are already connecting or connected, ignore redundant join requests
        if (this.connectionState === 'connected' || this.connectionState === 'connecting') return;

        this.log("Peer device found. Initiating handshake...");
        this.remotePeerId = data.senderId;
        
        // Stop announcing immediately to reduce signaling noise
        this.stopAnnouncing();

        // Determine Offerer based on ID string comparison to avoid collision
        if (this.myId > data.senderId) {
            if (this.peerConnection) {
                // If we had a stale PC, clean it
                this.cleanupPeerConnection();
            }
            const pc = this.createPeerConnection();
            this.dataChannel = pc.createDataChannel('fileTransfer', { ordered: true });
            this.setupDataChannel(this.dataChannel);

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            this.updateState('connecting');
            this.log("Sending connection offer...");
            signalingService.sendSignal({ type: 'offer', offer, senderId: this.myId });
        } else {
             // We are the Answerer, just prepare the PC
             this.log("Preparing to accept connection...");
             if (!this.peerConnection) this.createPeerConnection();
        }
      }
      else if (data.type === 'offer') {
        // Collision check: if we are supposed to be offerer, ignore incoming offer (rare with id check)
        if (this.myId > data.senderId) return;
        
        this.log("Received connection offer. Processing...");
        if (!this.peerConnection) this.createPeerConnection();

        this.updateState('connecting');
        this.stopAnnouncing(); // Ensure we stop shouting 'join'

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
            // Queue candidate if remote description isn't set yet
            this.iceCandidateQueue.push(candidateInit);
        }
      }
    } catch (err) { console.error('Signal handling error:', err); }
  }

  public sendFile(file: File): Promise<void> {
    return new Promise(async (resolve, reject) => {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            reject(new Error("Connection not open"));
            return;
        }

        const metadata: FileMetadata = {
            name: file.name,
            size: file.size,
            type: file.type,
        };
        this.dataChannel.send(JSON.stringify({ type: 'file-start', metadata }));

        const buffer = await file.arrayBuffer();
        let offset = 0;
        this.startTime = Date.now();

        const sendLoop = () => {
            if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                reject(new Error("Connection lost"));
                return;
            }

            // High buffer check - wait longer
            if (this.dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) { 
                setTimeout(sendLoop, 5); // Faster retry than 10ms
                return;
            }

            // Send up to 5 chunks per tick to prevent UI blocking
            let chunksSent = 0;
            const MAX_CHUNKS_PER_TICK = 10; // Increased throughput

            while (offset < buffer.byteLength && chunksSent < MAX_CHUNKS_PER_TICK) {
                 // Check buffer inside inner loop too
                 if (this.dataChannel.bufferedAmount > MAX_BUFFERED_AMOUNT) break;

                 const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
                 try {
                    this.dataChannel.send(buffer.slice(offset, end));
                    offset = end;
                    chunksSent++;
                 } catch (e) {
                     reject(e);
                     return;
                 }
            }

            // Report progress based on actual bytes on wire (offset - buffered)
            const currentBuffered = this.dataChannel.bufferedAmount || 0;
            const actualSent = Math.max(0, offset - currentBuffered);
            this.reportProgress(actualSent, metadata.size, metadata.name);

            if (offset < buffer.byteLength) {
                // Yield to event loop to keep UI responsive
                setTimeout(sendLoop, 0);
            } else {
                // Buffering finished, wait for data to drain from buffer before resolving
                const checkDrain = () => {
                  if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
                      reject(new Error("Connection lost during drain"));
                      return;
                  }
                  
                  const remaining = this.dataChannel.bufferedAmount || 0;
                  if (remaining === 0) {
                    this.reportProgress(metadata.size, metadata.size, metadata.name);
                    resolve();
                  } else {
                    const finalSent = Math.max(0, metadata.size - remaining);
                    this.reportProgress(finalSent, metadata.size, metadata.name);
                    setTimeout(checkDrain, 20); // Faster check
                  }
                };
                checkDrain();
            }
        };
        sendLoop();
    });
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
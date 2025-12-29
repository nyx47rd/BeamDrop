import { signalingService } from './signaling';
import { ConnectionState, FileMetadata, TransferProgress } from '../types';
import { deviceService } from './device';
import { SenderManager } from './sender';
import { ReceiverManager } from './receiver';

export class P2PManager {
  private peerConnection: RTCPeerConnection | null = null;
  private myId: string = Math.random().toString(36).substr(2, 9);
  private connectionState: ConnectionState = 'idle';
  
  // Delegated Managers
  private sender: SenderManager;
  private receiver: ReceiverManager;

  // Connection Resources
  private controlChannel: RTCDataChannel | null = null;
  private transferChannel: RTCDataChannel | null = null;
  
  private announceInterval: any = null;

  private listeners = {
    state: (s: ConnectionState) => {},
    progress: (p: TransferProgress) => {},
    file: (b: Blob, m: FileMetadata) => {},
    log: (s: string) => {}
  };

  constructor() {
      // Initialize sub-managers with callbacks that bridge to P2PManager's listeners
      this.sender = new SenderManager((p) => this.listeners.progress(p));
      this.receiver = new ReceiverManager(
          (p) => this.listeners.progress(p),
          (b, m) => this.listeners.file(b, m)
      );
  }

  // --- PUBLIC API ---

  init(roomId: string) {
    this.updateState('signaling');
    if(this.peerConnection) this.cleanup();
    
    signalingService.connect(roomId, 
      (data) => this.handleSignal(data), 
      () => this.startAnnouncing()
    );
  }

  async sendFiles(files: File[]) {
      if (this.connectionState !== 'connected') throw new Error("Not connected");
      // Delegate to Sender
      await this.sender.sendFiles(files);
  }

  cleanup() { 
      this.peerConnection?.close(); 
      this.peerConnection = null; 
      this.transferChannel = null;
      this.controlChannel = null;
      
      this.sender.cleanup();
      this.receiver.cleanup();
      
      if (this.announceInterval) {
          clearInterval(this.announceInterval);
          this.announceInterval = null;
      }
      
      signalingService.disconnect();
      this.updateState('idle');
  }

  public onStateChange(cb: any) { this.listeners.state = cb; }
  public onProgress(cb: any) { this.listeners.progress = cb; }
  public onFileReceived(cb: any) { this.listeners.file = cb; }
  public onLog(cb: any) { this.listeners.log = cb; }


  // --- INTERNAL NETWORKING ---

  private setupPeer() {
      this.peerConnection = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      });

      this.peerConnection.onicecandidate = e => {
          if (e.candidate) signalingService.sendSignal({ type: 'candidate', candidate: e.candidate, senderId: this.myId });
      };

      this.peerConnection.onconnectionstatechange = () => {
          const state = this.peerConnection?.connectionState;
          if (state === 'disconnected' || state === 'failed') {
              this.updateState('disconnected');
              deviceService.disableWakeLock();
          } else if (state === 'connected') {
              // We do NOT set 'connected' state here yet. 
              // We must wait for DataChannels to be open.
              this.checkReadiness();
          }
      };
      
      // Handle Incoming Channels (Receiver Role mostly)
      this.peerConnection.ondatachannel = (e) => {
          this.setupChannel(e.channel);
      };
  }

  private setupChannel(ch: RTCDataChannel) {
      ch.binaryType = 'arraybuffer';
      
      // Hook into onopen to ensure we are actually ready to send
      ch.onopen = () => {
          console.log(`P2P: Channel ${ch.label} open`);
          this.checkReadiness();
      };
      
      if (ch.label === 'control') {
          this.controlChannel = ch;
          this.sender.setControlChannel(ch);
          this.receiver.setControlChannel(ch);
          
          ch.onmessage = (e) => {
              const data = JSON.parse(e.data);
              this.receiver.handleControlMessage(data);
              this.sender.handleControlMessage(data);
          }
      } 
      else if (ch.label === 'transfer') {
          this.transferChannel = ch;
          this.sender.setTransferChannel(ch);
          
          // Receiver listens to binary on this channel
          ch.onmessage = (e) => {
              if (e.data instanceof ArrayBuffer) {
                  this.receiver.handleBinaryChunk(e.data);
              }
          };
      }
  }

  // Critical: Only say "Connected" when the plumbing is actually working
  private checkReadiness() {
      if (this.connectionState === 'connected') return;

      const pcReady = this.peerConnection?.connectionState === 'connected';
      const controlReady = this.controlChannel?.readyState === 'open';
      const transferReady = this.transferChannel?.readyState === 'open';

      if (pcReady && controlReady && transferReady) {
          console.log("P2P: Fully Connected & Channels Ready");
          this.updateState('connected');
          deviceService.enableWakeLock();
      }
  }

  private async handleSignal(data: any) {
      if (data.senderId === this.myId) return;

      try {
          if (data.type === 'join') {
             if (this.connectionState === 'connected' || this.connectionState === 'connecting') return;
             if (this.myId > data.senderId) {
                 // I am the Initiator
                 this.setupPeer();
                 
                 // Create Channels (Ordered = true guarantees delivery)
                 const control = this.peerConnection!.createDataChannel('control', { ordered: true });
                 this.setupChannel(control);
                 
                 // HIGH PERFORMANCE TUNING
                 // We rely on SCTP's internal buffering.
                 const transfer = this.peerConnection!.createDataChannel('transfer', { ordered: true });
                 this.setupChannel(transfer);
                 
                 const offer = await this.peerConnection!.createOffer();
                 await this.peerConnection!.setLocalDescription(offer);
                 signalingService.sendSignal({ type: 'offer', offer, senderId: this.myId });
                 this.updateState('connecting');
             }
          }
          else if (data.type === 'offer') {
              this.setupPeer();
              await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(data.offer));
              const answer = await this.peerConnection!.createAnswer();
              await this.peerConnection!.setLocalDescription(answer);
              signalingService.sendSignal({ type: 'answer', answer, senderId: this.myId });
              this.updateState('connecting');
          }
          else if (data.type === 'answer') {
              await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(data.answer));
          }
          else if (data.type === 'candidate') {
              await this.peerConnection!.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
      } catch (e) { console.error(e); }
  }

  private startAnnouncing() {
     if (this.announceInterval) clearInterval(this.announceInterval);
     const run = () => signalingService.sendSignal({ type: 'join', senderId: this.myId });
     run();
     this.announceInterval = setInterval(run, 2000);
  }

  private updateState(s: ConnectionState) { 
      this.connectionState = s; 
      this.listeners.state(s); 
  }
}

export const p2pManager = new P2PManager();

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
  private dataChannels: RTCDataChannel[] = [];

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
      this.dataChannels = [];
      this.controlChannel = null;
      
      this.sender.cleanup();
      this.receiver.cleanup();
      
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
          if (state === 'connected') {
              this.updateState('connected');
              deviceService.enableWakeLock();
          } else if (state === 'disconnected' || state === 'failed') {
              this.updateState('disconnected');
              deviceService.disableWakeLock();
          }
      };
      
      // Handle Incoming Channels (Receiver Role mostly)
      this.peerConnection.ondatachannel = (e) => {
          this.setupChannel(e.channel);
      };
  }

  private setupChannel(ch: RTCDataChannel) {
      ch.binaryType = 'arraybuffer';
      
      if (ch.label === 'control') {
          this.controlChannel = ch;
          // Pass control channel to both managers (Sender needs it for sending control, Receiver for ACKs)
          // Ideally we check our role, but giving it to both is safe as they use it contextually.
          this.receiver.setControlChannel(ch);
      } else {
          this.dataChannels.push(ch);
      }
      
      // Wire up message handling for Receiver
      ch.onmessage = (e) => {
          const isBinary = e.data instanceof ArrayBuffer;
          const data = isBinary ? e.data : JSON.parse(e.data);
          this.receiver.handleMessage(data, isBinary);
      };

      // Check if all channels are ready to arm the Sender
      if (this.controlChannel && this.dataChannels.length >= 3) { // Assuming 3 data channels
           this.sender.setChannels(this.controlChannel, this.dataChannels);
      } else if (this.controlChannel) {
           // Fallback/Partial setup
           this.sender.setChannels(this.controlChannel, this.dataChannels);
      }
  }

  private async handleSignal(data: any) {
      if (data.senderId === this.myId) return;

      try {
          if (data.type === 'join') {
             if (this.connectionState === 'connected') return;
             if (this.myId > data.senderId) {
                 // I am the Initiator (Sender Role usually starts here)
                 this.setupPeer();
                 
                 // Create Channels
                 const control = this.peerConnection!.createDataChannel('control', { ordered: true });
                 this.setupChannel(control);
                 
                 for(let i=0; i<3; i++) {
                     const dataCh = this.peerConnection!.createDataChannel(`data_${i}`, { ordered: false });
                     this.setupChannel(dataCh);
                 }
                 
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
     const run = () => signalingService.sendSignal({ type: 'join', senderId: this.myId });
     run();
     setInterval(run, 2000);
  }

  private updateState(s: ConnectionState) { 
      this.connectionState = s; 
      this.listeners.state(s); 
  }
}

export const p2pManager = new P2PManager();

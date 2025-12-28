
import { signalingService } from './signaling';
import { ConnectionState, FileMetadata, TransferProgress, BatchMetadata } from '../types';
import { deviceService } from './device';
import { openDB, IDBPDatabase } from 'idb';

// --- CONFIGURATION ---
const CHUNK_SIZE = 64 * 1024; // 64KB (More reliable for UDP/WebRTC fragmentation)
const HEADER_SIZE = 4; // 4 Bytes for Index
const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // 16MB Backpressure limit
const RAM_THRESHOLD = 150 * 1024 * 1024; // 150MB
const IDB_BATCH_SIZE = 100;
const SYNC_INTERVAL_MS = 250;

// Worker Factory
const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

// --- STORAGE ENGINE (Optimized) ---
class ChunkStore {
    private useDB: boolean;
    private ramChunks: Map<number, ArrayBuffer> = new Map();
    private dbName: string | null = null;
    private db: IDBPDatabase | null = null;
    private writeQueue: { index: number, data: ArrayBuffer }[] = []; 
    private fileType: string;

    constructor(fileSize: number, fileType: string) {
        this.fileType = fileType;
        this.useDB = fileSize > RAM_THRESHOLD;
    }

    async init() {
        if (this.useDB) {
            this.dbName = `beamdrop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            this.db = await openDB(this.dbName, 1, {
                upgrade(db) { db.createObjectStore('chunks', { keyPath: 'index' }); },
            });
        }
    }

    async add(index: number, data: ArrayBuffer) {
        if (this.useDB && this.db) {
            this.writeQueue.push({ index, data });
            if (this.writeQueue.length >= IDB_BATCH_SIZE) await this.flush();
        } else {
            this.ramChunks.set(index, data);
        }
    }

    async flush() {
        if (!this.writeQueue.length || !this.db) return;
        const tx = this.db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        await Promise.all(this.writeQueue.map(item => store.put(item)));
        this.writeQueue = [];
        await tx.done;
    }

    async finish(): Promise<Blob> {
        if (this.useDB && this.db) {
            await this.flush();
            const tx = this.db.transaction('chunks', 'readonly');
            const allChunks = await tx.objectStore('chunks').getAll();
            this.db.close();
            await window.indexedDB.deleteDatabase(this.dbName!);
            return new Blob(allChunks.map(c => c.data), { type: this.fileType });
        } else {
            // Sort RAM chunks by index
            const sorted = Array.from(this.ramChunks.entries())
                .sort((a, b) => a[0] - b[0])
                .map(entry => entry[1]);
            this.ramChunks.clear();
            return new Blob(sorted, { type: this.fileType });
        }
    }
}

// --- MAIN SERVICE ---
export class P2PManager {
  private peerConnection: RTCPeerConnection | null = null;
  private controlChannel: RTCDataChannel | null = null;
  private dataChannels: RTCDataChannel[] = [];
  
  private myId: string = Math.random().toString(36).substr(2, 9);
  private connectionState: ConnectionState = 'idle';
  private worker: Worker | null = null;
  
  // Transfer State
  private queue: File[] = [];
  private isSending = false;
  private currentMeta: FileMetadata | null = null;
  private chunkStore: ChunkStore | null = null;
  
  // The Fix: Buffer for data that arrives before metadata
  private pendingOrphanChunks: Map<number, ArrayBuffer> = new Map(); 

  // Stats
  private stats = {
    totalFiles: 0,
    totalSize: 0,
    transferredBytes: 0,
    startTime: 0,
    completedFiles: 0,
    currentFileName: '',
    currentFileBytes: 0
  };

  // Callbacks
  private listeners = {
    state: (s: ConnectionState) => {},
    progress: (p: TransferProgress) => {},
    file: (b: Blob, m: FileMetadata) => {},
    log: (s: string) => {}
  };

  // --- INITIALIZATION ---
  init(roomId: string) {
    this.updateState('signaling');
    if(this.peerConnection) this.cleanup();
    this.worker = createWorker();
    
    signalingService.connect(roomId, 
      (data) => this.handleSignal(data), 
      () => this.startAnnouncing()
    );
  }

  // --- SENDER LOGIC ---
  async sendFiles(files: File[]) {
    if (this.connectionState !== 'connected') throw new Error("Not connected");
    
    this.queue = [...files];
    const totalSize = files.reduce((acc, f) => acc + f.size, 0);
    
    this.stats = {
        totalFiles: files.length,
        totalSize,
        transferredBytes: 0,
        startTime: Date.now(),
        completedFiles: 0,
        currentFileName: '',
        currentFileBytes: 0
    };

    // Send Batch Info
    this.sendControl({ type: 'batch-info', meta: { totalFiles: files.length, totalSize } });
    
    this.processQueue();
  }

  private async processQueue() {
    if (this.isSending || this.queue.length === 0) return;
    this.isSending = true;
    
    const file = this.queue.shift()!;
    this.stats.currentFileName = file.name;
    this.stats.currentFileBytes = 0;
    this.emitProgress();

    // 1. Send File Start (Reliable)
    this.sendControl({ type: 'file-start', meta: { name: file.name, size: file.size, type: file.type } });

    // 2. Pump Data (Unordered)
    await this.pumpFile(file);
    
    // 3. Send File End (Reliable)
    this.sendControl({ type: 'file-end' });

    // Wait for Ack before next file (Simple Handshake)
    await new Promise<void>(resolve => {
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
    });

    this.stats.completedFiles++;
    this.isSending = false;
    
    if (this.queue.length > 0) {
        this.processQueue();
    } else {
        deviceService.sendNotification('Transfer Complete');
        this.emitProgress(true);
    }
  }

  private pumpFile(file: File): Promise<void> {
      return new Promise((resolve, reject) => {
          let offset = 0;
          let chunkIndex = 0;
          let readsPending = 0;
          const MAX_READS = 20; // Prefetch limit

          // Worker Response Handler
          const onChunk = (e: MessageEvent) => {
              if (e.data.type === 'chunk_ready') {
                  const { buffer, eof } = e.data;
                  readsPending--;

                  // Wrap with Header (4 bytes index)
                  const packet = new Uint8Array(HEADER_SIZE + buffer.byteLength);
                  new DataView(packet.buffer).setUint32(0, chunkIndex, false); // Big Endian
                  packet.set(new Uint8Array(buffer), HEADER_SIZE);

                  // Round-robin send over data channels
                  try {
                      const ch = this.dataChannels[chunkIndex % this.dataChannels.length];
                      if (ch && ch.readyState === 'open') {
                          ch.send(packet);
                      } else {
                          // Fallback to control if data channel dead (rare)
                          this.controlChannel?.send(packet);
                      }
                  } catch (err) { console.error("Send failed", err); }

                  chunkIndex++;

                  if (eof) {
                      this.worker?.removeEventListener('message', onChunk);
                      resolve();
                  } else {
                      loadMore();
                  }
              }
          };

          this.worker?.addEventListener('message', onChunk);

          const loadMore = () => {
             // Backpressure check
             let totalBuffered = 0;
             this.dataChannels.forEach(c => totalBuffered += c.bufferedAmount);
             
             if (totalBuffered > MAX_BUFFERED_AMOUNT) {
                 setTimeout(loadMore, 10);
                 return;
             }

             while (readsPending < MAX_READS && offset < file.size) {
                 this.worker?.postMessage({ 
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

  // --- RECEIVER LOGIC ---
  private async handleMessage(data: any, isBinary: boolean) {
      // 1. Binary Data (Chunks)
      if (isBinary && data instanceof ArrayBuffer) {
          const view = new DataView(data);
          const index = view.getUint32(0, false);
          const chunk = data.slice(HEADER_SIZE);

          // If we have a store, save it.
          if (this.chunkStore) {
              await this.chunkStore.add(index, chunk);
              this.stats.currentFileBytes += chunk.byteLength;
              this.stats.transferredBytes += chunk.byteLength;
              this.throttleProgress();
          } else {
              // THE FIX: Buffer orphan chunks!
              // Data arrived before 'file-start'. Store it temporarily.
              this.pendingOrphanChunks.set(index, chunk);
          }
          return;
      }

      // 2. Control Messages (JSON)
      if (!isBinary) {
          if (data.type === 'batch-info') {
              this.stats = { ...this.stats, totalFiles: data.meta.totalFiles, totalSize: data.meta.totalSize, transferredBytes: 0, startTime: Date.now(), completedFiles: 0 };
          }
          else if (data.type === 'file-start') {
              this.currentMeta = data.meta;
              this.stats.currentFileName = data.meta.name;
              this.stats.currentFileBytes = 0;
              this.chunkStore = new ChunkStore(data.meta.size, data.meta.type);
              await this.chunkStore.init();

              // FLUSH ORPHANS: We now have the store, save any pending data.
              if (this.pendingOrphanChunks.size > 0) {
                  console.log(`Flushing ${this.pendingOrphanChunks.size} orphan chunks`);
                  for (const [idx, chunk] of this.pendingOrphanChunks) {
                      await this.chunkStore.add(idx, chunk);
                      this.stats.currentFileBytes += chunk.byteLength;
                      this.stats.transferredBytes += chunk.byteLength;
                  }
                  this.pendingOrphanChunks.clear();
              }
              this.emitProgress();
          }
          else if (data.type === 'file-end') {
              if (this.chunkStore && this.currentMeta) {
                  const blob = await this.chunkStore.finish();
                  this.listeners.file(blob, this.currentMeta);
                  this.stats.completedFiles++;
                  this.emitProgress();
                  
                  // Send ACK to let sender continue
                  this.sendControl({ type: 'ack-file' });
                  
                  this.chunkStore = null;
                  this.currentMeta = null;
              }
          }
      }
  }

  // --- NETWORKING CORE ---
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
      
      this.peerConnection.ondatachannel = (e) => {
          this.setupChannel(e.channel);
      };
  }

  private setupChannel(ch: RTCDataChannel) {
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'control') {
          this.controlChannel = ch;
      } else {
          this.dataChannels.push(ch);
      }
      
      ch.onmessage = (e) => {
          const isBinary = e.data instanceof ArrayBuffer;
          const data = isBinary ? e.data : JSON.parse(e.data);
          this.handleMessage(data, isBinary);
      };
  }

  private sendControl(msg: any) {
      if (this.controlChannel?.readyState === 'open') {
          this.controlChannel.send(JSON.stringify(msg));
      }
  }

  private async handleSignal(data: any) {
      if (data.senderId === this.myId) return;

      try {
          if (data.type === 'join') {
             if (this.connectionState === 'connected') return;
             if (this.myId > data.senderId) {
                 // I am the Initiator
                 this.setupPeer();
                 // Channel 0: Control (Ordered, Reliable)
                 this.setupChannel(this.peerConnection!.createDataChannel('control', { ordered: true }));
                 // Channel 1-3: Data (Unordered, Fast)
                 for(let i=0; i<3; i++) {
                     this.setupChannel(this.peerConnection!.createDataChannel(`data_${i}`, { ordered: false }));
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

  // --- UTILS ---
  private lastEmit = 0;
  private throttleProgress() {
      const now = Date.now();
      if (now - this.lastEmit > SYNC_INTERVAL_MS) {
          this.emitProgress();
          this.lastEmit = now;
      }
  }

  private emitProgress(forceComplete = false) {
      const elapsed = (Date.now() - this.stats.startTime) / 1000;
      const speed = elapsed > 0 ? this.stats.transferredBytes / elapsed : 0;
      const remaining = this.stats.totalSize - this.stats.transferredBytes;
      const eta = speed > 0 ? Math.ceil(remaining / speed) : 0;

      this.listeners.progress({
          fileName: this.stats.currentFileName,
          transferredBytes: this.stats.currentFileBytes,
          fileSize: 0,
          totalFiles: this.stats.totalFiles,
          currentFileIndex: this.stats.completedFiles + 1,
          totalBatchBytes: this.stats.totalSize,
          transferredBatchBytes: this.stats.transferredBytes,
          speed: `${(speed / (1024*1024)).toFixed(1)} MB/s`,
          eta: `${Math.floor(eta / 60)}m ${eta % 60}s`,
          isComplete: forceComplete || (this.stats.completedFiles === this.stats.totalFiles)
      });
  }

  private startAnnouncing() {
     const run = () => signalingService.sendSignal({ type: 'join', senderId: this.myId });
     run();
     setInterval(run, 2000);
  }

  private updateState(s: ConnectionState) { this.connectionState = s; this.listeners.state(s); }
  public cleanup() { 
      this.peerConnection?.close(); 
      this.peerConnection = null; 
      this.dataChannels = [];
      this.controlChannel = null;
      this.worker?.terminate();
      signalingService.disconnect();
  }

  public onStateChange(cb: any) { this.listeners.state = cb; }
  public onProgress(cb: any) { this.listeners.progress = cb; }
  public onFileReceived(cb: any) { this.listeners.file = cb; }
  public onLog(cb: any) { this.listeners.log = cb; }
}

export const p2pManager = new P2PManager();

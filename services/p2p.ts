
import { signalingService } from './signaling';
import { ConnectionState, FileMetadata, TransferProgress, BatchMetadata } from '../types';
import { deviceService } from './device';
import { openDB, IDBPDatabase } from 'idb';

// --- PERFORMANCE TUNING (Chaos Mode: Unordered + Pipeline) ---
const CHUNK_SIZE = 256 * 1024; // 256KB Payload
const HEADER_SIZE = 4; // 4 Bytes for Sequence Index (Uint32)
const PACKET_SIZE = CHUNK_SIZE + HEADER_SIZE; 

const MAX_BUFFERED_AMOUNT = 16 * 1024 * 1024; // Increased to 16MB for high throughput

// Aggressive Prefetching
const MAX_QUEUE_SIZE = 40; 

const ACK_TIMEOUT_MS = 60000;
const CONCURRENT_CHANNELS = 3; 

// RAM Threshold
const RAM_THRESHOLD = 150 * 1024 * 1024;

// Batch Write Size
const IDB_BATCH_SIZE = 50; 

// Sync Interval
const SYNC_INTERVAL_MS = 200;

const createWorker = () => new Worker(new URL('./workers/fileTransfer.worker.ts', import.meta.url), { type: 'module' });

// --- STORAGE ENGINE (Smart Reassembly) ---
class ChunkStore {
    private useDB: boolean;
    
    // RAM Storage: Stores objects { index, data } then sorts on finish
    private ramChunks: { index: number, data: ArrayBuffer }[] = [];
    
    // IDB Specific
    private dbName: string | null = null;
    private db: IDBPDatabase | null = null;
    private writeQueue: { index: number, data: ArrayBuffer }[] = []; 
    
    private fileName: string;
    private fileType: string;

    constructor(fileName: string, fileSize: number, fileType: string) {
        this.fileName = fileName;
        this.fileType = fileType;
        this.useDB = fileSize > RAM_THRESHOLD;
    }

    async init() {
        if (this.useDB) {
            this.dbName = `beamdrop_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
            this.db = await openDB(this.dbName, 1, {
                upgrade(db) {
                    // Critical: Use 'index' as keyPath to allow auto-sorting by IDB
                    db.createObjectStore('chunks', { keyPath: 'index' });
                },
            });
        }
    }

    async addChunk(index: number, chunk: ArrayBuffer) {
        if (this.useDB && this.db) {
            this.writeQueue.push({ index, data: chunk });
            if (this.writeQueue.length >= IDB_BATCH_SIZE) {
                await this.flushQueue();
            }
        } else {
            this.ramChunks.push({ index, data: chunk });
        }
    }

    private async flushQueue() {
        if (this.writeQueue.length === 0 || !this.db) return;
        const tx = this.db.transaction('chunks', 'readwrite');
        const store = tx.objectStore('chunks');
        
        // Batch add
        const promises = this.writeQueue.map(item => store.put(item)); // put handles updates/inserts
        this.writeQueue = []; 
        await Promise.all(promises);
        await tx.done;
    }

    async finish(): Promise<Blob> {
        if (this.useDB && this.db) {
            await this.flushQueue();
            const tx = this.db.transaction('chunks', 'readonly');
            const store = tx.objectStore('chunks');
            
            // IDB 'getAll' returns items sorted by key (index) automatically!
            const allChunks = await store.getAll(); 
            const blobs = allChunks.map(c => c.data);
            const blob = new Blob(blobs, { type: this.fileType });
            
            this.db.close();
            await window.indexedDB.deleteDatabase(this.dbName!);
            return blob;
        } else {
            // RAM Sort
            this.ramChunks.sort((a, b) => a.index - b.index);
            const blobs = this.ramChunks.map(c => c.data);
            const blob = new Blob(blobs, { type: this.fileType });
            this.ramChunks = []; 
            return blob;
        }
    }

    async cleanup() {
        this.ramChunks = [];
        this.writeQueue = [];
        if (this.db) {
            this.db.close();
            if (this.dbName) await window.indexedDB.deleteDatabase(this.dbName);
        }
    }
}

class TransferChannel {
    public id: number;
    public channel: RTCDataChannel;
    private manager: P2PManager;
    private worker: Worker;
    
    private isBusy = false;
    private fileQueue: File[] = [];
    private currentFile: File | null = null;
    
    private pendingReadRequests = 0;
    private ackResolver: (() => void) | null = null;
    
    private receivedSize = 0;
    private currentMeta: FileMetadata | null = null;
    private chunkStore: ChunkStore | null = null;
    
    constructor(id: number, channel: RTCDataChannel, manager: P2PManager) {
        this.id = id;
        this.channel = channel;
        this.manager = manager;
        this.worker = createWorker();
        this.setupEvents();
    }

    private setupEvents() {
        this.channel.binaryType = 'arraybuffer';
        this.channel.bufferedAmountLowThreshold = CHUNK_SIZE * 5; 

        this.channel.onopen = () => {
            console.log(`[Channel ${this.id}] Open (Unordered)`);
            this.manager.checkConnectionState();
            this.processQueue();
        };

        this.channel.onclose = () => {
            console.log(`[Channel ${this.id}] Closed`);
            this.cleanup();
        };
        
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
            this.manager.markSenderFileComplete(); 
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

        this.manager.notifyFileStart(file.name);
        this.channel.send(JSON.stringify({ type: 'file-start', metadata }));

        return new Promise<void>((resolve, reject) => {
            let fileOffset = 0;
            this.pendingReadRequests = 0;
            const worker = this.worker;

            const pump = () => {
                if (this.channel.readyState !== 'open') {
                    reject(new Error("Channel closed"));
                    return;
                }

                if (this.channel.bufferedAmount > MAX_BUFFERED_AMOUNT || this.pendingReadRequests >= MAX_QUEUE_SIZE) {
                    return; 
                }

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

            const messageHandler = async (e: MessageEvent) => {
                if (e.data.type === 'error') {
                    worker.removeEventListener('message', messageHandler);
                    reject(e.data.error);
                    return;
                }

                if (e.data.type === 'chunk_ready') {
                    const { buffer, eof, offset } = e.data;
                    this.pendingReadRequests--;

                    try {
                        // -----------------------------------------------------
                        // HEADER INJECTION (The Secret Sauce)
                        // We wrap the chunk with a 4-byte index so it can
                        // travel out-of-order and be reassembled later.
                        // -----------------------------------------------------
                        const chunkIndex = Math.floor((offset - buffer.byteLength) / CHUNK_SIZE);
                        
                        // Create a new buffer: Header (4 bytes) + Data
                        const packet = new Uint8Array(HEADER_SIZE + buffer.byteLength);
                        const view = new DataView(packet.buffer);
                        
                        // Write Index
                        view.setUint32(0, chunkIndex); 
                        
                        // Write Data
                        packet.set(new Uint8Array(buffer), HEADER_SIZE);

                        // Send the wrapped packet
                        this.channel.send(packet);
                        
                        // Sync logic remains same
                        // this.manager.updateProgress(buffer.byteLength); 

                        if (eof) {
                            worker.removeEventListener('message', messageHandler);
                            this.channel.onbufferedamountlow = null;
                            
                            await this.waitForDrain();
                            this.channel.send(JSON.stringify({ type: 'file-end' }));
                            await this.waitForAck();
                            
                            this.manager.markSenderFileComplete();
                            resolve();
                        } else {
                            pump();
                        }
                    } catch (err) {
                        worker.removeEventListener('message', messageHandler);
                        reject(err);
                    }
                }
            };

            worker.addEventListener('message', messageHandler);
            pump();
        });
    }

    private async waitForDrain(): Promise<void> {
        if (this.channel.bufferedAmount === 0) return;
        return new Promise(resolve => {
            const check = setInterval(() => {
                if (this.channel.bufferedAmount === 0 || this.channel.readyState !== 'open') {
                    clearInterval(check);
                    resolve();
                }
            }, 10);
        });
    }

    private waitForAck(): Promise<void> {
        return new Promise(resolve => {
            this.ackResolver = resolve;
            setTimeout(() => {
                if (this.ackResolver) {
                    this.ackResolver();
                    this.ackResolver = null;
                }
            }, ACK_TIMEOUT_MS);
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

    private async handleControlMessage(msg: any) {
        if (msg.type === 'batch-info') {
            this.manager.handleBatchInfo(msg.batchMeta);
        }
        else if (msg.type === 'file-start') {
            this.currentMeta = msg.metadata;
            this.receivedSize = 0;
            this.chunkStore = new ChunkStore(msg.metadata.name, msg.metadata.size, msg.metadata.type);
            await this.chunkStore.init();
            this.manager.notifyFileStart(msg.metadata.name);
        }
        else if (msg.type === 'progress-sync') {
            this.manager.syncProgress(msg.bytes, msg.fileName);
        }
        else if (msg.type === 'file-end') {
            if (this.currentMeta && this.chunkStore) {
                await this.finishFile(this.currentMeta);
                try {
                    this.channel.send(JSON.stringify({ type: 'ack-finish' }));
                } catch(e) {}
            }
        }
        else if (msg.type === 'ack-finish') {
            if (this.ackResolver) {
                this.ackResolver();
                this.ackResolver = null;
            }
        }
    }

    private async handleBinaryData(buffer: ArrayBuffer) {
        if (!this.currentMeta || !this.chunkStore) return;
        
        // -----------------------------------------------------
        // UNWRAP PACKET
        // Read header to find where this chunk belongs
        // -----------------------------------------------------
        const view = new DataView(buffer);
        const index = view.getUint32(0); // Read 4-byte header
        
        // Extract actual data (skip first 4 bytes)
        const data = buffer.slice(HEADER_SIZE);
        
        await this.chunkStore.addChunk(index, data);
        this.receivedSize += data.byteLength;
        
        this.manager.updateProgress(data.byteLength);
    }

    private async finishFile(meta: FileMetadata) {
        if (!this.chunkStore) return;
        const blob = await this.chunkStore.finish();
        this.manager.handleReceiverFileComplete(blob, meta);
        this.chunkStore = null;
        this.currentMeta = null;
        this.receivedSize = 0;
    }

    public cleanup() {
        if (this.channel) this.channel.close();
        if (this.worker) this.worker.terminate();
        if (this.chunkStore) this.chunkStore.cleanup();
        this.fileQueue = [];
        if (this.ackResolver) this.ackResolver();
    }
}

export class P2PManager {
  private peerConnection: RTCPeerConnection | null = null;
  public channels: TransferChannel[] = []; 
  
  private myId: string = Math.random().toString(36).substr(2, 9);
  private connectionState: ConnectionState = 'idle';
  
  private stateChangeCallback: ((state: ConnectionState) => void) | null = null;
  private progressCallback: ((progress: TransferProgress) => void) | null = null;
  private fileReceivedCallback: ((file: Blob, meta: FileMetadata) => void) | null = null;
  private logCallback: ((msg: string) => void) | null = null;

  private announceInterval: any = null;
  private iceCandidateQueue: RTCIceCandidateInit[] = [];

  private batchState = {
    totalFiles: 0,
    totalSize: 0,
    transferredBytes: 0,
    startTime: 0,
    completedFilesCount: 0,
    currentFileName: ''
  };
  
  private lastProgressEmit = 0;
  private lastSyncEmit = 0;

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
          currentFileName: 'Initializing...'
      };

      const batchMeta: BatchMetadata = { totalFiles: files.length, totalSize };
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
      if (this.batchState.transferredBytes > this.batchState.totalSize) {
          this.batchState.transferredBytes = this.batchState.totalSize;
      }

      const now = Date.now();
      if (now - this.lastProgressEmit > 50 || this.batchState.transferredBytes >= this.batchState.totalSize) {
          this.emitProgress();
          this.lastProgressEmit = now;
      }

      if (now - this.lastSyncEmit > SYNC_INTERVAL_MS) {
          this.sendSyncMessage();
          this.lastSyncEmit = now;
      }
  }

  private sendSyncMessage() {
      const activeChannel = this.channels.find(c => c.channel.readyState === 'open');
      if (activeChannel) {
          try {
            activeChannel.channel.send(JSON.stringify({
                type: 'progress-sync',
                bytes: this.batchState.transferredBytes,
                fileName: this.batchState.currentFileName
            }));
          } catch(e) {}
      }
  }

  public syncProgress(totalBytesReceived: number, currentFileName?: string) {
      this.batchState.transferredBytes = totalBytesReceived;
      if (currentFileName) this.batchState.currentFileName = currentFileName;
      
      if (this.batchState.transferredBytes > this.batchState.totalSize) {
          this.batchState.transferredBytes = this.batchState.totalSize;
      }
      
      this.emitProgress();
  }

  public markSenderFileComplete() {
      this.batchState.completedFilesCount++;
      if (this.batchState.completedFilesCount === this.batchState.totalFiles) {
          this.batchState.transferredBytes = this.batchState.totalSize;
          const msg = this.batchState.totalFiles === 1 
            ? "File Sent Successfully" 
            : `All ${this.batchState.totalFiles} Files Sent`;
          deviceService.sendNotification('Transfer Complete', msg);
      }
      this.emitProgress();
  }

  public handleReceiverFileComplete(blob: Blob, meta: FileMetadata) {
      this.batchState.completedFilesCount++;
      this.sendSyncMessage();
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

      const remainingBytes = this.batchState.totalSize - this.batchState.transferredBytes;
      let etaStr = '';
      if (remainingBytes <= 0) {
          etaStr = 'Done';
      } else if (speed > 0) {
          const etaSeconds = Math.ceil(remainingBytes / speed);
          if (etaSeconds < 60) {
              etaStr = `${etaSeconds}s left`;
          } else {
              const mins = Math.floor(etaSeconds / 60);
              const secs = etaSeconds % 60;
              etaStr = `${mins}m ${secs}s left`;
          }
      } else {
          etaStr = 'Calculating...';
      }

      let displayIndex = this.batchState.completedFilesCount + 1;
      if (displayIndex > this.batchState.totalFiles) displayIndex = this.batchState.totalFiles;
      
      const isComplete = this.batchState.completedFilesCount === this.batchState.totalFiles;

      this.progressCallback({
          fileName: isComplete ? 'Complete' : this.batchState.currentFileName,
          transferredBytes: 0, 
          fileSize: 0,
          totalFiles: this.batchState.totalFiles,
          currentFileIndex: displayIndex,
          totalBatchBytes: this.batchState.totalSize,
          transferredBatchBytes: this.batchState.transferredBytes,
          speed: isComplete ? 'Done' : speedStr,
          eta: isComplete ? '' : etaStr,
          isComplete: isComplete
      });
  }

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
                // IMPORTANT: ordered: false is the key to Unordered Delivery
                const dc = pc.createDataChannel(`beam_${i}`, { ordered: false });
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

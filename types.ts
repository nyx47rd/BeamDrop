
export interface FileMetadata {
  name: string;
  size: number;
  type: string;
}

export interface BatchMetadata {
  totalFiles: number;
  totalSize: number;
}

export interface ChunkData {
  type: 'batch-info' | 'file-start' | 'file-chunk' | 'file-end' | 'message';
  metadata?: FileMetadata;
  batchMeta?: BatchMetadata;
  data?: string; // Base64 encoded for simplicity in JSON, or ArrayBuffer handling
  chunkIndex?: number;
}

export type ConnectionState = 'idle' | 'signaling' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface TransferProgress {
  fileName: string; // Current file name
  transferredBytes: number; // Bytes of current file
  fileSize: number; // Size of current file
  
  // Batch details
  totalFiles: number;
  currentFileIndex: number; // 1-based index
  totalBatchBytes: number;
  transferredBatchBytes: number;
  
  speed: string; // e.g., "1.2 MB/s"
  eta: string; // e.g., "45s left"
  isComplete: boolean; // Is the ENTIRE batch complete?
}

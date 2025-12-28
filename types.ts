

export interface FileMetadata {
  name: string;
  size: number;
  type: string;
  totalChunks: number; // Critical for verify integrity
}

export interface BatchMetadata {
  totalFiles: number;
  totalSize: number;
}

export interface ProgressReport {
  transferredBytes: number;
  speed: number; // bytes per second
  eta: number; // seconds
  totalFiles: number;
  completedFiles: number;
}

export interface ChunkData {
  type: 'offer-batch' | 'accept-batch' | 'file-start' | 'ready-for-file' | 'file-chunk' | 'file-end' | 'ack-file' | 'progress-sync';
  metadata?: FileMetadata;
  batchMeta?: BatchMetadata;
  progressReport?: ProgressReport;
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

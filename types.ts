export interface FileMetadata {
  name: string;
  size: number;
  type: string;
}

export interface ChunkData {
  type: 'file-start' | 'file-chunk' | 'file-end' | 'message';
  metadata?: FileMetadata;
  data?: string; // Base64 encoded for simplicity in JSON, or ArrayBuffer handling
  chunkIndex?: number;
}

export type ConnectionState = 'idle' | 'signaling' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface TransferProgress {
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  speed: string; // e.g., "1.2 MB/s"
  isComplete: boolean;
}
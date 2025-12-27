import React, { useRef, useEffect, useState, memo } from 'react';
import { Plus, Download, X, Check, Archive, UploadCloud, Wifi, WifiOff } from 'lucide-react';
import { TransferProgress, ConnectionState } from '../types';
import JSZip from 'jszip';

interface Props {
  role: 'sender' | 'receiver' | null;
  connectionState: ConnectionState;
  progress: TransferProgress | null;
  onSendFiles: (files: File[]) => void;
  onDisconnect: () => void;
  receivedFiles: { blob: Blob; name: string }[];
}

// Helper: Format bytes to human readable string
const formatBytes = (bytes: number, decimals = 2) => {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
};

// --- ISOLATED COMPONENTS TO PREVENT RE-RENDERS ---

// 1. Progress Bar Component (Only re-renders on progress update)
const ProgressBar = memo(({ progress }: { progress: TransferProgress | null }) => {
  if (!progress) return null;
  
  const percent = Math.min(100, (progress.transferredBytes / progress.totalBytes) * 100);
  
  return (
    <div role="status" className="w-full shrink-0 bg-[#1c1c1e] rounded-[2rem] p-6 mb-6 border border-white/5 shadow-lg">
      <div className="flex justify-between items-center mb-4">
        <span className="text-sm font-medium text-white truncate max-w-[70%]">{progress.fileName}</span>
        <span className="text-xs font-mono text-[#737373]">{progress.speed}</span>
      </div>
      <div className="w-full bg-[#2c2c2e] h-1.5 rounded-full overflow-hidden mb-2">
        <div 
            className="bg-white h-full transition-all duration-200 ease-out"
            style={{ width: `${percent}%` }}
        />
      </div>
      <div className="flex justify-between items-center text-xs">
          <span className="text-[#737373]">
            {progress.isComplete ? 'Completed' : 'Transferring...'}
          </span>
          <span className="text-white font-medium">
            {Math.round(percent)}%
          </span>
      </div>
    </div>
  );
});

// 2. File List Item (Manages its own ObjectURL to prevent Memory Leaks)
const FileListItem = memo(({ file }: { file: { blob: Blob; name: string } }) => {
  const [downloadUrl, setDownloadUrl] = useState<string>('');

  useEffect(() => {
    // Create URL only once when component mounts
    const url = URL.createObjectURL(file.blob);
    setDownloadUrl(url);

    // CRITICAL: Revoke URL when component unmounts to free RAM
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file.blob]);

  return (
    <div role="listitem" className="w-full flex items-center justify-between p-4 bg-[#1c1c1e] rounded-2xl border border-white/5 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-3 overflow-hidden flex-1 mr-4">
            <div className="w-10 h-10 rounded-full bg-[#2c2c2e] flex items-center justify-center shrink-0">
                <Check className="w-5 h-5 text-green-400" aria-hidden="true" />
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="text-sm font-medium text-white truncate">{file.name}</span>
              <span className="text-xs text-neutral-500">{formatBytes(file.blob.size)}</span>
            </div>
        </div>
        {downloadUrl && (
          <a 
            href={downloadUrl} 
            download={file.name}
            aria-label={`Download ${file.name}`}
            className="p-3 text-white bg-white/5 hover:bg-white hover:text-black rounded-full transition-all shrink-0 active:scale-90"
          >
              <Download className="w-5 h-5" aria-hidden="true" />
          </a>
        )}
    </div>
  );
});

// 3. Header Component
const Header = memo(({ role, connectionState, onDisconnect }: { role: string | null, connectionState: ConnectionState, onDisconnect: () => void }) => {
    const isConnected = connectionState === 'connected';
    return (
      <div className="w-full flex justify-between items-start mb-6 shrink-0">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xl font-semibold text-white">
            {role === 'sender' ? 'Sender Mode' : 'Receiver Mode'}
          </h3>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border w-fit transition-colors duration-300 ${isConnected ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
             {isConnected ? <Wifi className="w-3.5 h-3.5 text-green-400" /> : <WifiOff className="w-3.5 h-3.5 text-red-400" />}
             <span className={`text-xs font-medium tracking-wide ${isConnected ? 'text-green-400' : 'text-red-400'}`}>
                {isConnected ? 'Connected' : 'Disconnected'}
             </span>
          </div>
        </div>
        <button 
            onClick={onDisconnect}
            aria-label="Disconnect and close"
            className="w-10 h-10 flex items-center justify-center bg-[#1c1c1e] rounded-full text-[#a3a3a3] hover:text-white hover:bg-[#2c2c2e] transition-colors"
        >
            <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
    );
});

export const TransferPanel: React.FC<Props> = ({ 
  role,
  connectionState,
  progress, 
  onSendFiles, 
  onDisconnect,
  receivedFiles
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll logic (Receiver only)
  useEffect(() => {
    if (role === 'receiver' && listRef.current) {
      requestAnimationFrame(() => {
          if (listRef.current) {
            listRef.current.scrollTo({
                top: listRef.current.scrollHeight,
                behavior: 'smooth'
            });
          }
      });
    }
  }, [receivedFiles.length, role]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onSendFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handleDownloadAllZip = async () => {
    if (receivedFiles.length === 0) return;
    try {
      const zip = new JSZip();
      receivedFiles.forEach((file) => {
        zip.file(file.name, file.blob);
      });
      const content = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `beamdrop_files_${Date.now()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); // Revoke after download
    } catch (err) {
      console.error("Failed to zip", err);
    }
  };

  return (
    <div className="w-full flex flex-col h-full py-4 relative">
      <Header role={role} connectionState={connectionState} onDisconnect={onDisconnect} />
      
      <ProgressBar progress={progress} />
      
      {role === 'sender' ? (
        <div className={`flex-1 flex flex-col items-center justify-center w-full min-h-0 transition-opacity duration-300 ${progress ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
            <button 
              onClick={() => connectionState === 'connected' && fileInputRef.current?.click()}
              disabled={connectionState !== 'connected'}
              className="w-full max-w-[280px] aspect-square bg-[#1c1c1e] hover:bg-[#2c2c2e] disabled:opacity-50 disabled:cursor-not-allowed border border-white/5 rounded-[3rem] flex flex-col items-center justify-center gap-6 transition-all duration-300 group active:scale-[0.97] shadow-2xl shadow-black/50"
            >
              <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" multiple />
              <div className="w-20 h-20 rounded-full bg-black flex items-center justify-center group-hover:scale-110 transition-transform duration-300 border border-white/5">
                  <Plus className="w-8 h-8 text-white" />
              </div>
              <span className="text-neutral-400 text-lg font-medium group-hover:text-white transition-colors">
                {connectionState === 'connected' ? 'Send Files' : 'Wait...'}
              </span>
            </button>
            <p className="mt-8 text-neutral-600 text-sm">
               {connectionState === 'connected' ? 'Select files to beam' : 'Waiting for connection...'}
            </p>
        </div>
      ) : (
        <div className="flex-1 flex flex-col w-full min-h-0">
            <div className="flex items-center justify-between mb-4 px-1 shrink-0">
               <span className="text-sm font-bold uppercase tracking-wider text-neutral-400">Files ({receivedFiles.length})</span>
               {receivedFiles.length > 0 && (
                 <button onClick={handleDownloadAllZip} className="flex items-center gap-2 bg-white text-black px-4 py-2 rounded-full text-xs font-bold hover:bg-neutral-200 transition-colors active:scale-95">
                  <Archive className="w-3.5 h-3.5" />
                  <span>Save All (ZIP)</span>
                </button>
               )}
            </div>
            {receivedFiles.length === 0 && !progress ? (
               <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 animate-pulse">
                  <UploadCloud className="w-16 h-16 mb-4 opacity-20" />
                  <p className="text-sm font-medium">Waiting for sender...</p>
               </div>
            ) : (
              <div ref={listRef} className="flex-1 overflow-y-auto pr-1 space-y-3 pb-4" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
                  {receivedFiles.map((file, idx) => (
                      <FileListItem key={`${file.name}-${idx}`} file={file} />
                  ))}
              </div>
            )}
        </div>
      )}
    </div>
  );
};
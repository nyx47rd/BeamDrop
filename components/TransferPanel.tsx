import React, { useRef, useEffect } from 'react';
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
  
  // Auto-scroll to bottom when new files arrive (Receiver only)
  useEffect(() => {
    if (role === 'receiver' && listRef.current) {
      listRef.current.scrollTo({
        top: listRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [receivedFiles, role]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onSendFiles(Array.from(e.target.files));
    }
  };

  const handleDownloadAllZip = async () => {
    if (receivedFiles.length === 0) return;

    try {
      const zip = new JSZip();
      
      // Add files to zip
      receivedFiles.forEach((file) => {
        zip.file(file.name, file.blob);
      });

      // Generate zip with STORE (no compression) for ultra-fast speed
      const content = await zip.generateAsync({ 
        type: "blob", 
        compression: "STORE" 
      });

      // Trigger download
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `beamdrop_files_${Date.now()}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to zip files", err);
      alert("Failed to create ZIP archive.");
    }
  };

  // --- Render Helpers ---

  const renderHeader = () => {
    const isConnected = connectionState === 'connected';
    
    return (
      <div className="w-full flex justify-between items-start mb-6 shrink-0">
        <div className="flex flex-col gap-1.5">
          <h3 className="text-xl font-semibold text-white">
            {role === 'sender' ? 'Sender Mode' : 'Receiver Mode'}
          </h3>
          
          {/* Live Connection Status Badge */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border w-fit transition-colors duration-300 ${isConnected ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
             {isConnected ? (
                <Wifi className="w-3.5 h-3.5 text-green-400" />
             ) : (
                <WifiOff className="w-3.5 h-3.5 text-red-400" />
             )}
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
  };

  const renderProgressBar = () => {
    if (!progress) return null;
    return (
      <div role="status" aria-label={`Transferring ${progress.fileName}`} className="w-full shrink-0 bg-[#1c1c1e] rounded-[2rem] p-6 mb-6 border border-white/5 animate-in fade-in slide-in-from-bottom-2">
        <div className="flex justify-between items-center mb-4">
          <span className="text-sm font-medium text-white truncate max-w-[70%]">{progress.fileName}</span>
          <span className="text-xs font-mono text-[#737373]">{progress.speed}</span>
        </div>
        
        <div className="w-full bg-[#2c2c2e] h-1.5 rounded-full overflow-hidden mb-2" role="progressbar" aria-valuenow={Math.round((progress.transferredBytes / progress.totalBytes) * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div 
              className="bg-white h-full transition-all duration-200 ease-out"
              style={{ width: `${Math.min(100, (progress.transferredBytes / progress.totalBytes) * 100)}%` }}
          />
        </div>
        
        <div className="flex justify-between items-center text-xs">
            <span className="text-[#737373]">
              {progress.isComplete ? 'Completed' : 'Transferring...'}
            </span>
            <span className="text-white font-medium">
              {Math.round(Math.min(100, (progress.transferredBytes / progress.totalBytes) * 100))}%
            </span>
        </div>
      </div>
    );
  };

  const renderSenderUI = () => (
    <div className={`flex-1 flex flex-col items-center justify-center w-full min-h-0 transition-opacity duration-300 ${progress ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
        <button 
          onClick={() => connectionState === 'connected' && fileInputRef.current?.click()}
          disabled={connectionState !== 'connected'}
          aria-label="Select files to send"
          className="w-full max-w-[280px] aspect-square bg-[#1c1c1e] hover:bg-[#2c2c2e] disabled:opacity-50 disabled:cursor-not-allowed border border-white/5 rounded-[3rem] flex flex-col items-center justify-center gap-6 transition-all duration-300 group active:scale-[0.97] shadow-2xl shadow-black/50"
        >
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            className="hidden" 
            multiple 
            aria-hidden="true"
          />
          <div className="w-20 h-20 rounded-full bg-black flex items-center justify-center group-hover:scale-110 transition-transform duration-300 border border-white/5">
              <Plus className="w-8 h-8 text-white" aria-hidden="true" />
          </div>
          <span className="text-neutral-400 text-lg font-medium group-hover:text-white transition-colors">
            {connectionState === 'connected' ? 'Send Files' : 'Wait...'}
          </span>
        </button>
        <p className="mt-8 text-neutral-600 text-sm">
           {connectionState === 'connected' ? 'Select files to beam to receiver' : 'Waiting for connection...'}
        </p>
    </div>
  );

  const renderReceiverUI = () => (
    <div className="flex-1 flex flex-col w-full min-h-0">
        {/* Actions Bar */}
        <div className="flex items-center justify-between mb-4 px-1">
           <span className="text-sm font-bold uppercase tracking-wider text-neutral-400">
             Files ({receivedFiles.length})
           </span>
           {receivedFiles.length > 0 && (
             <button
              onClick={handleDownloadAllZip}
              className="flex items-center gap-2 bg-white text-black px-4 py-2 rounded-full text-xs font-bold hover:bg-neutral-200 transition-colors active:scale-95"
            >
              <Archive className="w-3.5 h-3.5" />
              <span>Save All (ZIP)</span>
            </button>
           )}
        </div>

        {/* List Content */}
        {receivedFiles.length === 0 && !progress ? (
           <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 animate-pulse">
              <UploadCloud className="w-16 h-16 mb-4 opacity-20" />
              <p className="text-sm font-medium">Waiting for sender...</p>
           </div>
        ) : (
          <div 
            ref={listRef}
            className="flex-1 overflow-y-auto pr-1 space-y-3 pb-4"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            role="list"
            aria-label="Received files" 
          >
              {receivedFiles.map((file, idx) => (
                  <div key={idx} role="listitem" className="w-full flex items-center justify-between p-4 bg-[#1c1c1e] rounded-2xl border border-white/5 animate-in fade-in slide-in-from-bottom-4 duration-300 fill-mode-backwards" style={{ animationDelay: `${idx * 100}ms` }}>
                      <div className="flex items-center gap-3 overflow-hidden flex-1 mr-4">
                          <div className="w-10 h-10 rounded-full bg-[#2c2c2e] flex items-center justify-center shrink-0">
                              <Check className="w-5 h-5 text-green-400" aria-hidden="true" />
                          </div>
                          <div className="flex flex-col overflow-hidden">
                            <span className="text-sm font-medium text-white truncate">{file.name}</span>
                            <span className="text-xs text-neutral-500">{(file.blob.size / (1024*1024)).toFixed(2)} MB</span>
                          </div>
                      </div>
                      <a 
                        href={URL.createObjectURL(file.blob)} 
                        download={file.name}
                        aria-label={`Download ${file.name}`}
                        className="p-3 text-white bg-white/5 hover:bg-white hover:text-black rounded-full transition-all shrink-0 active:scale-90"
                      >
                          <Download className="w-5 h-5" aria-hidden="true" />
                      </a>
                  </div>
              ))}
          </div>
        )}
    </div>
  );

  return (
    <div className="w-full flex flex-col h-full py-4 relative">
      {renderHeader()}
      {renderProgressBar()}
      {role === 'sender' ? renderSenderUI() : renderReceiverUI()}
    </div>
  );
};
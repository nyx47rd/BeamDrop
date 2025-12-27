import React, { useRef, useEffect } from 'react';
import { Plus, Download, X, Check } from 'lucide-react';
import { TransferProgress } from '../types';

interface Props {
  progress: TransferProgress | null;
  onSendFiles: (files: File[]) => void;
  onDisconnect: () => void;
  receivedFiles: { blob: Blob; name: string }[];
}

export const TransferPanel: React.FC<Props> = ({ 
  progress, 
  onSendFiles, 
  onDisconnect,
  receivedFiles
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new files arrive
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTo({
        top: listRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [receivedFiles]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onSendFiles(Array.from(e.target.files));
    }
  };

  return (
    <div className="w-full flex flex-col h-full max-h-[80vh]">
      
      {/* Header / Disconnect */}
      <div className="w-full flex justify-end mb-8 shrink-0">
        <button 
            onClick={onDisconnect}
            aria-label="Disconnect and close"
            className="w-10 h-10 flex items-center justify-center bg-[#171717] rounded-full text-[#a3a3a3] hover:text-white hover:bg-[#262626] transition-colors"
        >
            <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {/* Active Transfer Card */}
      {progress && (
        <div role="status" aria-label={`Transferring ${progress.fileName}`} className="w-full shrink-0 bg-[#171717] rounded-[2rem] p-6 mb-6 border border-[#262626] animate-in fade-in slide-in-from-bottom-2">
          <div className="flex justify-between items-center mb-4">
            <span className="text-sm font-medium text-white truncate max-w-[70%]">{progress.fileName}</span>
            <span className="text-xs font-mono text-[#737373]">{progress.speed}</span>
          </div>
          
          <div className="w-full bg-[#262626] h-1.5 rounded-full overflow-hidden mb-2" role="progressbar" aria-valuenow={Math.round((progress.transferredBytes / progress.totalBytes) * 100)} aria-valuemin={0} aria-valuemax={100}>
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
      )}

      {/* Main Send Button Area - Centered when no progress */}
      {!progress && (
        <div className="flex-1 flex items-center justify-center mb-10 shrink-0">
            <button 
              onClick={() => fileInputRef.current?.click()}
              aria-label="Select files to send"
              className="w-[200px] h-[200px] bg-[#171717] hover:bg-[#202020] border border-[#262626] rounded-[2.5rem] flex flex-col items-center justify-center gap-4 transition-all duration-300 group active:scale-95"
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
                multiple 
                aria-hidden="true"
              />
              <div className="w-16 h-16 rounded-full bg-black flex items-center justify-center group-hover:scale-110 transition-transform">
                 <Plus className="w-8 h-8 text-white" aria-hidden="true" />
              </div>
              <span className="text-neutral-400 font-medium group-hover:text-white transition-colors">Send Files</span>
            </button>
        </div>
      )}

      {/* Received Files List */}
      {receivedFiles.length > 0 && (
          <div className="flex-1 min-h-0 w-full flex flex-col">
              <div 
                ref={listRef}
                className="flex-1 overflow-y-auto pr-1 space-y-3"
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                role="list"
                aria-label="Received files" 
              >
                  {receivedFiles.map((file, idx) => (
                      <div key={idx} role="listitem" className="w-full flex items-center justify-between p-4 bg-[#171717]/50 rounded-2xl border border-[#262626]/50 animate-in fade-in slide-in-from-bottom-2 duration-300">
                          <div className="flex items-center gap-3 overflow-hidden flex-1 mr-4">
                              <div className="w-8 h-8 rounded-full bg-[#262626] flex items-center justify-center shrink-0">
                                 <Check className="w-4 h-4 text-green-500" aria-hidden="true" />
                              </div>
                              <span className="text-sm text-neutral-300 truncate">{file.name}</span>
                          </div>
                          <a 
                            href={URL.createObjectURL(file.blob)} 
                            download={file.name}
                            aria-label={`Download ${file.name}`}
                            className="p-2 text-white hover:bg-white hover:text-black rounded-full transition-colors shrink-0"
                          >
                              <Download className="w-5 h-5" aria-hidden="true" />
                          </a>
                      </div>
                  ))}
              </div>
          </div>
      )}
    </div>
  );
};
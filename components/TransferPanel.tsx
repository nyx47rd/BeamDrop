import React, { useRef, useEffect, useState } from 'react';
import { Plus, Download, X, Check, Archive, Maximize2, Minimize2 } from 'lucide-react';
import { TransferProgress } from '../types';
import JSZip from 'jszip';

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
  
  // Expandable panel state
  const [isExpanded, setIsExpanded] = useState(false);
  const longPressTimerRef = useRef<number>(0);
  const [isPressing, setIsPressing] = useState(false);

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

  const handleDownloadAllZip = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering expansion logic
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

  // --- Long Press Logic ---
  const handlePointerDown = (e: React.PointerEvent) => {
    setIsPressing(true);
    longPressTimerRef.current = window.setTimeout(() => {
      setIsExpanded((prev) => !prev);
      // Optional: Add haptic feedback if available in browser (rarely supported but good practice)
      if (navigator.vibrate) navigator.vibrate(50);
      setIsPressing(false); 
    }, 500); // 500ms long press threshold
  };

  const handlePointerUp = () => {
    clearTimeout(longPressTimerRef.current);
    setIsPressing(false);
  };

  const handlePointerLeave = () => {
    clearTimeout(longPressTimerRef.current);
    setIsPressing(false);
  };

  return (
    <div className="w-full flex flex-col h-full py-4 relative">
      
      {/* Header / Disconnect */}
      <div className="w-full flex justify-between items-center mb-4 shrink-0 px-2">
        <h3 className="text-xl font-semibold text-white">Transfer</h3>
        <button 
            onClick={onDisconnect}
            aria-label="Disconnect and close"
            className="w-10 h-10 flex items-center justify-center bg-[#1c1c1e] rounded-full text-[#a3a3a3] hover:text-white hover:bg-[#2c2c2e] transition-colors z-20"
        >
            <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {/* Active Transfer Card */}
      {progress && (
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
      )}

      {/* Main Send Button Area - Perfectly Centered */}
      {!progress && (
        <div className={`flex-1 flex flex-col items-center justify-center w-full min-h-0 transition-opacity duration-300 ${isExpanded ? 'opacity-20 pointer-events-none' : 'opacity-100'}`}>
            <button 
              onClick={() => fileInputRef.current?.click()}
              aria-label="Select files to send"
              className="w-full max-w-[280px] aspect-square bg-[#1c1c1e] hover:bg-[#2c2c2e] border border-white/5 rounded-[3rem] flex flex-col items-center justify-center gap-6 transition-all duration-300 group active:scale-[0.97] shadow-2xl shadow-black/50"
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
              <span className="text-neutral-400 text-lg font-medium group-hover:text-white transition-colors">Send Files</span>
            </button>
            
            {receivedFiles.length === 0 && (
                <p className="mt-8 text-neutral-500 text-sm font-medium animate-pulse">
                    Waiting for files...
                </p>
            )}
        </div>
      )}

      {/* Received Files List - Expands via Long Press */}
      {receivedFiles.length > 0 && (
          <div 
            className={`
              w-full flex flex-col transition-all duration-500 cubic-bezier(0.32, 0.72, 0, 1)
              bg-black/95 backdrop-blur-xl border-t border-white/10 rounded-t-[2.5rem]
              ${isExpanded 
                ? 'fixed bottom-0 left-0 right-0 h-[85vh] z-50 px-4 pb-8 shadow-[0_-10px_40px_rgba(0,0,0,0.8)]' 
                : !progress ? 'h-1/3 min-h-[160px] border-t-0 bg-transparent backdrop-blur-none' : 'flex-1 border-t-0 bg-transparent backdrop-blur-none'
              }
            `}
          >
              {/* Header / Drag Handle */}
              <div 
                className={`
                   flex items-center justify-between py-4 select-none touch-none
                   ${isExpanded ? 'cursor-grab' : 'cursor-pointer'}
                `}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerLeave}
                onContextMenu={(e) => e.preventDefault()} // Prevent context menu on long press
              >
                 <div className="flex items-center gap-3">
                    <div className={`transition-transform duration-300 ${isPressing ? 'scale-90' : 'scale-100'}`}>
                        {isExpanded ? <Minimize2 className="w-4 h-4 text-neutral-500"/> : <Maximize2 className="w-4 h-4 text-neutral-500"/>}
                    </div>
                    <div>
                        <span className="text-sm font-bold uppercase tracking-wider text-neutral-400">Received ({receivedFiles.length})</span>
                        {!isExpanded && <p className="text-[10px] text-neutral-600 font-medium">Hold to expand</p>}
                    </div>
                 </div>

                 <button
                   onClick={handleDownloadAllZip}
                   className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-full text-xs font-medium transition-colors active:scale-95"
                 >
                    <Archive className="w-3.5 h-3.5" />
                    <span>Save All (ZIP)</span>
                 </button>
              </div>

              {/* List Content */}
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
                                <span className="text-xs text-neutral-500">Tap icon to save</span>
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
          </div>
      )}
      
      {/* Overlay when expanded to close by clicking outside */}
      {isExpanded && (
        <div 
            className="fixed inset-0 bg-black/60 z-40 backdrop-blur-sm animate-in fade-in" 
            onClick={() => setIsExpanded(false)}
        />
      )}
    </div>
  );
};
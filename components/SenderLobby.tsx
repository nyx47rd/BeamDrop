import React, { useState } from 'react';
import { Loader2, Copy, ArrowLeft, Check } from 'lucide-react';

interface Props {
  code: string;
  onBack: () => void;
  statusMessage?: string;
}

export const SenderLobby: React.FC<Props> = ({ code, onBack, statusMessage }) => {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full flex flex-col items-center animate-in fade-in slide-in-from-right-8 duration-500">
      <div className="w-full flex justify-start mb-8">
        <button 
          onClick={onBack}
          aria-label="Go back"
          className="p-2 -ml-2 text-neutral-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-6 h-6" aria-hidden="true" />
        </button>
      </div>

      <div className="text-center space-y-2 mb-12">
        <h2 className="text-2xl font-semibold text-white">Ready to Send</h2>
        <p className="text-neutral-400">Share this code with the receiver</p>
      </div>

      {/* Code Display Card */}
      <button 
        onClick={copyToClipboard}
        aria-label={copied ? "Copied" : "Copy code to clipboard"}
        className="relative w-full max-w-[340px] bg-[#1c1c1e] hover:bg-[#2c2c2e] border border-white/5 rounded-[2.5rem] py-16 flex flex-col items-center justify-center gap-6 group transition-all duration-300 active:scale-[0.98] mb-12 shadow-[0_0_50px_-20px_rgba(0,0,0,0.5)]"
      >
        <div className="flex items-center gap-8">
            <span className="text-6xl font-bold tracking-tight text-white font-mono group-hover:scale-105 transition-transform duration-300">
                {code.slice(0, 3)}
            </span>
            <span className="text-6xl font-bold tracking-tight text-white font-mono group-hover:scale-105 transition-transform duration-300">
                {code.slice(3)}
            </span>
        </div>
        
        <div className={`flex items-center gap-2 text-sm font-medium transition-colors bg-white/5 px-4 py-1.5 rounded-full ${copied ? 'text-green-400 bg-green-400/10' : 'text-neutral-400 group-hover:text-white'}`}>
          {copied ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
          <span>{copied ? 'Copied!' : 'Tap to copy'}</span>
        </div>
      </button>

      {/* Status Indicator */}
      <div role="status" className="flex flex-col items-center justify-center gap-2 text-neutral-400 bg-[#1c1c1e] border border-white/5 px-6 py-3 rounded-2xl min-w-[200px]">
        <div className="flex items-center gap-3">
            <Loader2 className="w-4 h-4 animate-spin text-white" aria-hidden="true" />
            <span className="text-sm font-medium">Waiting for receiver...</span>
        </div>
        {statusMessage && (
            <span className="text-xs text-neutral-500 animate-pulse">{statusMessage}</span>
        )}
      </div>
    </div>
  );
};
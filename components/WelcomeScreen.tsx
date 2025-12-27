import React from 'react';
import { Send, Download, Zap, Shield, Globe } from 'lucide-react';

interface Props {
  onSelectRole: (role: 'sender' | 'receiver') => void;
}

export const WelcomeScreen: React.FC<Props> = ({ onSelectRole }) => {
  return (
    <div className="flex flex-col items-center w-full max-w-md animate-in fade-in slide-in-from-bottom-8 duration-700">
      
      {/* Hero Section */}
      <div className="text-center mb-12 space-y-4">
        <div className="w-20 h-20 bg-white rounded-[2rem] mx-auto flex items-center justify-center mb-6 shadow-[0_0_40px_-10px_rgba(255,255,255,0.3)]">
          <Zap className="w-10 h-10 text-black fill-black" aria-hidden="true" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-white">BeamDrop</h1>
        <p className="text-neutral-400 text-lg leading-relaxed">
          Secure peer-to-peer file transfer. <br/>
          No servers. No limits.
        </p>
      </div>

      {/* Role Selection Cards */}
      <div className="grid grid-cols-2 gap-4 w-full mb-12">
        <button
          onClick={() => onSelectRole('sender')}
          className="group relative flex flex-col items-center justify-center p-6 h-40 bg-[#171717] hover:bg-[#202020] border border-[#262626] rounded-[2rem] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div className="w-12 h-12 rounded-full bg-black flex items-center justify-center mb-4 group-hover:bg-white group-hover:text-black transition-colors duration-300">
            <Send className="w-5 h-5" aria-hidden="true" />
          </div>
          <span className="font-semibold text-neutral-200">Send</span>
          <span className="text-xs text-neutral-400 mt-1">Create Code</span>
        </button>

        <button
          onClick={() => onSelectRole('receiver')}
          className="group relative flex flex-col items-center justify-center p-6 h-40 bg-[#171717] hover:bg-[#202020] border border-[#262626] rounded-[2rem] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div className="w-12 h-12 rounded-full bg-black flex items-center justify-center mb-4 group-hover:bg-white group-hover:text-black transition-colors duration-300">
            <Download className="w-5 h-5" aria-hidden="true" />
          </div>
          <span className="font-semibold text-neutral-200">Receive</span>
          <span className="text-xs text-neutral-400 mt-1">Enter Code</span>
        </button>
      </div>

      {/* Features / Footer */}
      <div className="flex justify-center gap-6 text-neutral-500 text-xs font-medium uppercase tracking-wider">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4" aria-hidden="true" />
          <span>Encrypted</span>
        </div>
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4" aria-hidden="true" />
          <span>P2P Direct</span>
        </div>
      </div>
    </div>
  );
};
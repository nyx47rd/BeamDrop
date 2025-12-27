import React, { useState } from 'react';
import { ArrowRight, ArrowLeft } from 'lucide-react';

interface Props {
  onConnect: (code: string) => void;
  onBack: () => void;
}

export const ReceiverLobby: React.FC<Props> = ({ onConnect, onBack }) => {
  const [code, setCode] = useState('');

  const handleConnect = () => {
    if (code.length === 6) {
      onConnect(code);
    }
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

      <div className="text-center space-y-2 mb-10">
        <h2 className="text-2xl font-semibold text-white">Receive Files</h2>
        <p className="text-neutral-400">Enter the 6-digit code from the sender</p>
      </div>

      {/* Input Area */}
      <div className="w-full mb-6">
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="000 000"
          aria-label="Enter 6-digit connection code"
          className="w-full bg-[#171717] border border-[#262626] text-center text-5xl font-bold font-mono text-white placeholder-neutral-600 rounded-[2rem] py-12 focus:outline-none focus:border-white/20 focus:bg-[#202020] transition-all duration-300 tracking-widest"
        />
      </div>

      {/* Action Button */}
      <button
        onClick={handleConnect}
        disabled={code.length !== 6}
        aria-label="Connect to sender"
        className="w-full h-16 bg-white text-black font-semibold text-lg rounded-[2rem] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-30 disabled:scale-100 transition-all duration-300 flex items-center justify-center gap-2"
      >
        <span>Connect</span>
        <ArrowRight className="w-5 h-5" aria-hidden="true" />
      </button>
    </div>
  );
};
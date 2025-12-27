import React, { useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';

interface Props {
  onConnect: (code: string) => void;
}

export const ConnectionPanel: React.FC<Props> = ({ onConnect }) => {
  const [code, setCode] = useState('');

  const handleConnect = () => {
    if (code.length === 6) {
      onConnect(code);
    }
  };

  const handleRandomCode = () => {
    const random = Math.floor(100000 + Math.random() * 900000).toString();
    setCode(random);
  };

  return (
    <div className="flex flex-col items-center w-full animate-in fade-in slide-in-from-bottom-4 duration-700">
      
      {/* Input Area */}
      <div className="w-full relative group mb-6">
        <input
          type="text"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          className="w-full bg-neutral-900/50 text-center text-5xl font-medium text-white placeholder-neutral-800 rounded-[2rem] py-12 focus:outline-none focus:bg-neutral-900 transition-all duration-300 tracking-widest"
        />
        <button 
            onClick={handleRandomCode}
            className="absolute right-6 top-1/2 -translate-y-1/2 p-3 text-neutral-600 hover:text-white transition-colors rounded-full hover:bg-white/10"
        >
            <RefreshCw className="w-5 h-5" />
        </button>
      </div>

      {/* Action Button */}
      <button
        onClick={handleConnect}
        disabled={code.length !== 6}
        className="w-full h-16 bg-white text-black font-semibold text-lg rounded-[2rem] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-30 disabled:scale-100 transition-all duration-300 flex items-center justify-center gap-2"
      >
        <span>Connect</span>
        <ArrowRight className="w-5 h-5" />
      </button>

      <p className="mt-8 text-neutral-700 text-xs font-medium tracking-wide">
        Enter same code on both devices
      </p>
    </div>
  );
};
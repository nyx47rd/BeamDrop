import React from 'react';
import { Send, Download, Zap, Shield, Globe, Wrench } from 'lucide-react';

interface Props {
  onSelectRole: (role: 'sender' | 'receiver') => void;
}

export const WelcomeScreen: React.FC<Props> = ({ onSelectRole }) => {

  // HELPER: Generates a 512x512 Transparent PNG with White Icon
  const generateAssets = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // CLEARED: Background is now transparent (No fillRect)

    // 2. Prepare SVG Image (Added explicit width/height for better browser rendering)
    const img = new Image();
    const svgData = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="white">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
      </svg>
    `;
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      ctx.clearRect(0, 0, 512, 512); // Ensure clean slate
      
      // 3. Draw Icon Centered
      ctx.save();
      ctx.translate(256, 256);
      ctx.scale(15, 15); // Scale up 15x to fill 512px
      ctx.translate(-12, -12); // Offset center
      ctx.drawImage(img, 0, 0);
      ctx.restore();

      // 4. Download
      const link = document.createElement('a');
      link.download = 'beamdrop-icon.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
      
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

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
      <div className="flex justify-center gap-6 text-neutral-500 text-xs font-medium uppercase tracking-wider mb-8">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4" aria-hidden="true" />
          <span>Encrypted</span>
        </div>
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4" aria-hidden="true" />
          <span>P2P Direct</span>
        </div>
      </div>

      {/* Temporary Developer Tool for PNG Generation */}
      <button 
        onClick={generateAssets}
        className="text-[10px] text-neutral-700 flex items-center gap-1 hover:text-white transition-colors border border-white/5 px-2 py-1 rounded bg-white/5"
      >
        <Wrench className="w-3 h-3" />
        Dev: Generate PNG Assets (Transparent)
      </button>

    </div>
  );
};
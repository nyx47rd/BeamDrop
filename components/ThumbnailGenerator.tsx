
import React from 'react';
import { Zap, FileStack, ShieldCheck, Wifi } from 'lucide-react';

export const ThumbnailGenerator: React.FC = () => {
  return (
    <div className="w-screen h-screen flex items-center justify-center bg-neutral-900 overflow-hidden">
      {/* 
         Standard Open Graph Image Size: 1200x630 
         We force this size to make taking the screenshot easy.
      */}
      <div 
        id="thumbnail-canvas"
        className="relative w-[1200px] h-[630px] bg-[#050505] overflow-hidden flex items-center justify-between px-24 shadow-2xl"
      >
        {/* --- BACKGROUND FX --- */}
        {/* Grid Pattern */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,black,transparent)]"></div>
        
        {/* Glow Orbs */}
        <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px]"></div>
        <div className="absolute bottom-[-20%] right-[-10%] w-[600px] h-[600px] bg-indigo-600/10 rounded-full blur-[120px]"></div>


        {/* --- LEFT: TYPOGRAPHY --- */}
        <div className="relative z-10 flex flex-col gap-6 max-w-[500px]">
           <div className="flex items-center gap-4 mb-2">
                <div className="w-16 h-16 bg-white rounded-[1.2rem] flex items-center justify-center shadow-lg shadow-white/10">
                    <Zap className="w-8 h-8 text-black fill-black" />
                </div>
                <div className="flex flex-col">
                    <h1 className="text-6xl font-bold text-white tracking-tighter leading-none">BeamDrop</h1>
                </div>
           </div>
           
           <h2 className="text-4xl font-medium text-neutral-400 tracking-tight leading-tight">
             Secure P2P <br/>
             <span className="text-white">File Transfer</span>
           </h2>

           <div className="h-px w-24 bg-gradient-to-r from-blue-500 to-transparent my-2"></div>

           <div className="flex flex-col gap-3 mt-2">
               <div className="flex items-center gap-3 text-neutral-300">
                   <ShieldCheck className="w-6 h-6 text-blue-400" />
                   <span className="text-xl font-medium">End-to-End Encrypted</span>
               </div>
               <div className="flex items-center gap-3 text-neutral-300">
                   <Wifi className="w-6 h-6 text-green-400" />
                   <span className="text-xl font-medium">No Servers. Unlimited Speed.</span>
               </div>
           </div>
        </div>


        {/* --- RIGHT: 3D UI MOCKUP --- */}
        <div className="relative z-10 transform perspective-[1000px] rotate-y-[-12deg] rotate-x-[5deg] scale-110 translate-x-10">
            {/* The Card */}
            <div className="w-[400px] bg-[#1c1c1e] rounded-[2.5rem] p-8 border border-white/10 shadow-[0_50px_100px_-20px_rgba(0,0,0,0.7)] relative overflow-hidden">
                
                {/* Glossy Reflection */}
                <div className="absolute top-0 right-0 w-[300px] h-[300px] bg-white/5 blur-[60px] rounded-full translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>

                {/* Header */}
                <div className="flex justify-between items-center mb-8">
                    <div className="flex flex-col">
                        <span className="text-white font-semibold text-lg">Receiving Files</span>
                        <div className="flex items-center gap-2 mt-1">
                             <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                             <span className="text-xs text-green-400 font-mono">Connected</span>
                        </div>
                    </div>
                </div>

                {/* Progress Bar (Mocked for Visuals) */}
                <div className="mb-8 relative">
                    <div className="flex justify-between text-white mb-2">
                        <div className="flex items-center gap-2">
                            <FileStack className="w-4 h-4 text-blue-400" />
                            <span className="font-medium">vacation_photos.zip</span>
                        </div>
                        <span className="font-mono font-bold">72%</span>
                    </div>
                    <div className="w-full h-3 bg-neutral-800 rounded-full overflow-hidden">
                        <div className="h-full w-[72%] bg-gradient-to-r from-blue-500 to-indigo-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]"></div>
                    </div>
                    <div className="flex justify-between mt-2 text-xs text-neutral-500 font-mono">
                         <span>1.4 GB / 2.0 GB</span>
                         <span>24 MB/s</span>
                    </div>
                </div>

                {/* File List Mock */}
                <div className="space-y-3">
                    <div className="flex items-center gap-4 p-4 bg-white/5 rounded-2xl border border-white/5">
                        <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                             <Zap className="w-5 h-5 fill-current" />
                        </div>
                        <div className="flex flex-col">
                            <span className="text-white text-sm font-medium">project_video.mp4</span>
                            <span className="text-neutral-500 text-xs">850 MB</span>
                        </div>
                    </div>
                    
                    {/* Faded item for depth */}
                    <div className="flex items-center gap-4 p-4 bg-white/5 rounded-2xl border border-white/5 opacity-50">
                        <div className="w-10 h-10 rounded-full bg-neutral-700 flex items-center justify-center text-neutral-400">
                             <FileStack className="w-5 h-5" />
                        </div>
                         <div className="flex flex-col">
                            <span className="text-white text-sm font-medium">design_assets.rar</span>
                            <span className="text-neutral-500 text-xs">Waiting...</span>
                        </div>
                    </div>
                </div>

            </div>
        </div>

      </div>
      
      {/* Instruction Overlay (Hidden in screenshot if cropped) */}
      <div className="absolute bottom-8 text-neutral-500 text-sm font-mono">
         Use your OS screenshot tool to capture the 1200x630 box above.
      </div>
    </div>
  );
};

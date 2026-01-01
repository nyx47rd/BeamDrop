
import React from 'react';
import { Zap, FileStack, ShieldCheck, Wifi } from 'lucide-react';

export const ThumbnailGenerator: React.FC = () => {
  return (
    <div className="w-screen h-screen flex items-center justify-center bg-neutral-900 overflow-hidden relative">
      
      {/* Scale Container: Ensures the 1200x630 box fits on any screen */}
      <div className="origin-center scale-[0.5] md:scale-[0.7] lg:scale-[0.9] xl:scale-100 transition-transform duration-300">
          
          <div 
            id="thumbnail-canvas"
            className="relative w-[1200px] h-[630px] bg-[#050505] overflow-hidden flex items-center justify-center gap-16 shadow-2xl border border-white/5"
          >
            {/* --- BACKGROUND FX --- */}
            {/* Grid Pattern */}
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,black,transparent)]"></div>
            
            {/* Glow Orbs (Centered) */}
            <div className="absolute top-[-10%] left-[20%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px]"></div>
            <div className="absolute bottom-[-10%] right-[20%] w-[600px] h-[600px] bg-indigo-600/10 rounded-full blur-[120px]"></div>


            {/* --- CONTENT CONTAINER (Compact Mode) --- */}
            {/* Moved from justify-between to a tight center cluster so cropping doesn't hide the UI */}
            
            {/* LEFT: TYPOGRAPHY (Pushed right slightly) */}
            <div className="relative z-10 flex flex-col gap-6 max-w-[450px] shrink-0">
               <div className="flex items-center gap-4 mb-2">
                    <div className="w-14 h-14 bg-white rounded-[1rem] flex items-center justify-center shadow-lg shadow-white/10">
                        <Zap className="w-7 h-7 text-black fill-black" />
                    </div>
                    <div className="flex flex-col">
                        <h1 className="text-5xl font-bold text-white tracking-tighter leading-none">BeamDrop</h1>
                    </div>
               </div>
               
               <h2 className="text-4xl font-medium text-neutral-400 tracking-tight leading-tight">
                 Secure P2P <br/>
                 <span className="text-white">File Transfer</span>
               </h2>

               <div className="h-px w-20 bg-gradient-to-r from-blue-500 to-transparent my-1"></div>

               <div className="flex flex-col gap-3 mt-1">
                   <div className="flex items-center gap-3 text-neutral-300">
                       <ShieldCheck className="w-5 h-5 text-blue-400" />
                       <span className="text-lg font-medium">End-to-End Encrypted</span>
                   </div>
                   <div className="flex items-center gap-3 text-neutral-300">
                       <Wifi className="w-5 h-5 text-green-400" />
                       <span className="text-lg font-medium">No Servers. Unlimited.</span>
                   </div>
               </div>
            </div>


            {/* RIGHT: 3D UI MOCKUP (Pulled Left significantly) */}
            <div className="relative z-10 transform perspective-[1000px] rotate-y-[-10deg] rotate-x-[4deg] scale-100 -translate-x-4">
                {/* The Card */}
                <div className="w-[380px] bg-[#1c1c1e] rounded-[2rem] p-6 border border-white/10 shadow-[0_40px_80px_-20px_rgba(0,0,0,0.8)] relative overflow-hidden">
                    
                    {/* Glossy Reflection */}
                    <div className="absolute top-0 right-0 w-[300px] h-[300px] bg-white/5 blur-[50px] rounded-full translate-x-1/2 -translate-y-1/2 pointer-events-none"></div>

                    {/* Header */}
                    <div className="flex justify-between items-center mb-6">
                        <div className="flex flex-col">
                            <span className="text-white font-semibold text-base">Receiving Files</span>
                            <div className="flex items-center gap-2 mt-1">
                                 <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
                                 <span className="text-[10px] text-green-400 font-mono">Connected</span>
                            </div>
                        </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="mb-6 relative">
                        <div className="flex justify-between text-white mb-2">
                            <div className="flex items-center gap-2">
                                <FileStack className="w-3.5 h-3.5 text-blue-400" />
                                <span className="font-medium text-sm">vacation_photos.zip</span>
                            </div>
                            <span className="font-mono font-bold text-sm">72%</span>
                        </div>
                        <div className="w-full h-2.5 bg-neutral-800 rounded-full overflow-hidden">
                            <div className="h-full w-[72%] bg-gradient-to-r from-blue-500 to-indigo-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]"></div>
                        </div>
                        <div className="flex justify-between mt-1.5 text-[10px] text-neutral-500 font-mono">
                             <span>1.4 GB / 2.0 GB</span>
                             <span>24 MB/s</span>
                        </div>
                    </div>

                    {/* File List Mock */}
                    <div className="space-y-2.5">
                        <div className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/5">
                            <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400">
                                 <Zap className="w-4 h-4 fill-current" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-white text-sm font-medium">project_video.mp4</span>
                                <span className="text-neutral-500 text-[10px]">850 MB</span>
                            </div>
                        </div>
                        
                        <div className="flex items-center gap-3 p-3 bg-white/5 rounded-xl border border-white/5 opacity-50">
                            <div className="w-8 h-8 rounded-full bg-neutral-700 flex items-center justify-center text-neutral-400">
                                 <FileStack className="w-4 h-4" />
                            </div>
                             <div className="flex flex-col">
                                <span className="text-white text-sm font-medium">design_assets.rar</span>
                                <span className="text-neutral-500 text-[10px]">Waiting...</span>
                            </div>
                        </div>
                    </div>

                </div>
            </div>

          </div>
      </div>
      
      {/* Instruction Overlay */}
      <div className="absolute bottom-8 text-neutral-500 text-sm font-mono text-center">
         <span className="text-white font-bold">Updated Layout:</span> Elements are now centered.<br/>
         Screenshot this and save as <span className="text-white">og-image.png</span>.
      </div>
    </div>
  );
};

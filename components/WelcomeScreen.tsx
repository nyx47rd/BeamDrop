
import React, { useState, useEffect } from 'react';
import { Send, Download, Zap, Smartphone, Monitor, Pencil, Check, User, AlertTriangle } from 'lucide-react';
import { deviceService } from '../services/device';
import { discoveryService, Peer } from '../services/discovery';

interface Props {
  onSelectRole: (role: 'sender' | 'receiver') => void;
  lanPeers?: Peer[];
  onConnectToPeer?: (peer: Peer) => void;
}

export const WelcomeScreen: React.FC<Props> = ({ onSelectRole, lanPeers = [], onConnectToPeer }) => {
  const [editingName, setEditingName] = useState(false);
  const [deviceName, setDeviceName] = useState('');
  const [bannerStatus, setBannerStatus] = useState<'checking' | 'ok' | 'error'>('checking');
  // Use a timestamp to force the browser to ignore the Service Worker cache for the check
  const [cacheBuster] = useState(Date.now());

  useEffect(() => {
    setDeviceName(deviceService.getDeviceName());
  }, []);

  const handleSaveName = () => {
    if (deviceName.trim()) {
      deviceService.setDeviceName(deviceName);
      discoveryService.updateMyName();
      setEditingName(false);
    }
  };

  return (
    <div className="flex flex-col items-center w-full max-w-md animate-in fade-in slide-in-from-bottom-8 duration-700 h-full">
      
      {/* Top Section: Header & Description */}
      <div className="text-center mb-8 space-y-4 w-full shrink-0">
        <div className="w-16 h-16 bg-white rounded-[1.5rem] mx-auto flex items-center justify-center mb-4 shadow-[0_0_30px_-10px_rgba(255,255,255,0.3)]">
          <Zap className="w-8 h-8 text-black fill-black" aria-hidden="true" />
        </div>
        <div>
            <h1 className="text-3xl font-bold tracking-tight text-white mb-2">BeamDrop</h1>
            <p className="text-neutral-400 text-sm max-w-[260px] mx-auto leading-relaxed">
              Secure, serverless peer-to-peer file transfer directly between devices.
            </p>
        </div>
      </div>

      {/* Main Actions */}
      <div className="grid grid-cols-2 gap-4 w-full mb-6 shrink-0">
        <button
          onClick={() => onSelectRole('sender')}
          className="group relative flex flex-col items-center justify-center p-6 h-32 bg-[#171717] hover:bg-[#202020] border border-[#262626] rounded-[2rem] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div className="w-10 h-10 rounded-full bg-black flex items-center justify-center mb-3 group-hover:bg-white group-hover:text-black transition-colors duration-300 border border-white/5">
            <Send className="w-4 h-4" aria-hidden="true" />
          </div>
          <span className="font-semibold text-neutral-200">Send</span>
        </button>

        <button
          onClick={() => onSelectRole('receiver')}
          className="group relative flex flex-col items-center justify-center p-6 h-32 bg-[#171717] hover:bg-[#202020] border border-[#262626] rounded-[2rem] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div className="w-10 h-10 rounded-full bg-black flex items-center justify-center mb-3 group-hover:bg-white group-hover:text-black transition-colors duration-300 border border-white/5">
            <Download className="w-4 h-4" aria-hidden="true" />
          </div>
          <span className="font-semibold text-neutral-200">Receive</span>
        </button>
      </div>

      {/* LAN / Nearby Devices List */}
      <div className="w-full flex-1 flex flex-col min-h-0 bg-[#1c1c1e] border border-white/5 rounded-[2rem] p-5 overflow-hidden relative">
          <div className="flex items-center justify-between mb-4 shrink-0">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-500">Nearby Devices</span>
              <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                  </span>
                  <span className="text-[10px] font-medium text-neutral-500">Scanning</span>
              </div>
          </div>

          {/* This Device (Editable) */}
          <div className="w-full flex items-center justify-between p-3 mb-4 bg-white/5 border border-white/10 rounded-2xl shrink-0">
             <div className="flex items-center gap-3 overflow-hidden flex-1">
                 <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center shrink-0">
                     <User className="w-5 h-5 text-indigo-400" />
                 </div>
                 <div className="flex flex-col overflow-hidden w-full">
                     {editingName ? (
                        <div className="flex items-center gap-2 w-full">
                            <input 
                                type="text" 
                                value={deviceName}
                                onChange={(e) => setDeviceName(e.target.value)}
                                className="bg-transparent border-b border-indigo-500 text-white text-sm focus:outline-none w-full pb-0.5"
                                autoFocus
                                onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                            />
                        </div>
                     ) : (
                        <div className="flex flex-col">
                             <span className="text-sm font-bold text-white truncate">{deviceName}</span>
                             <span className="text-[10px] text-neutral-500 font-medium">This Device (You)</span>
                        </div>
                     )}
                 </div>
             </div>
             <button 
                onClick={() => editingName ? handleSaveName() : setEditingName(true)}
                className="p-2 ml-2 text-neutral-400 hover:text-white hover:bg-white/10 rounded-full transition-colors"
             >
                {editingName ? <Check className="w-4 h-4 text-green-400" /> : <Pencil className="w-4 h-4" />}
             </button>
          </div>
          
          <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar pb-6">
              {lanPeers.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-neutral-600 space-y-3 pt-4">
                      <div className="w-12 h-12 rounded-full border border-dashed border-neutral-700 flex items-center justify-center">
                          <Smartphone className="w-5 h-5 opacity-30" />
                      </div>
                      <p className="text-xs text-center max-w-[200px] opacity-50">
                        Open BeamDrop on other devices<br/>to connect instantly.
                      </p>
                  </div>
              ) : (
                  lanPeers.map(peer => (
                      <button 
                        key={peer.id}
                        onClick={() => onConnectToPeer && onConnectToPeer(peer)}
                        className="w-full flex items-center gap-3 p-3 bg-black/40 hover:bg-black/60 border border-white/5 rounded-2xl transition-all group active:scale-[0.98] text-left"
                      >
                          <div className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center group-hover:bg-white/10 transition-colors">
                             <Monitor className="w-5 h-5 text-neutral-400 group-hover:text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                              <h4 className="text-sm font-medium text-white truncate">{peer.name}</h4>
                              <p className="text-xs text-neutral-500">Tap to connect</p>
                          </div>
                          <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center group-hover:bg-white group-hover:text-black transition-colors">
                              <Zap className="w-4 h-4" />
                          </div>
                      </button>
                  ))
              )}
          </div>

          {/* DEBUG: Hidden Image Loader to Verify File Existence */}
          <div className="absolute bottom-2 left-0 w-full flex justify-center pointer-events-none opacity-50">
            <div className="flex items-center gap-1.5 text-[10px] font-mono bg-black/80 px-2 py-1 rounded-full border border-white/10">
                <span>Img Check:</span>
                <span className={
                    bannerStatus === 'checking' ? 'text-yellow-500' :
                    bannerStatus === 'ok' ? 'text-green-500' : 'text-red-500 font-bold'
                }>
                    {bannerStatus === 'checking' ? '...' : bannerStatus === 'ok' ? 'OK' : 'MISSING (404)'}
                </span>
                {/* 
                  CRITICAL FIX: 
                  Added ?t=${cacheBuster} to bypass the Service Worker cache completely for this check.
                  If this works, the file exists on the server.
                */}
                <img 
                    src={`/banner.png?t=${cacheBuster}`}
                    alt="" 
                    className="w-0 h-0 opacity-0"
                    onLoad={() => setBannerStatus('ok')}
                    onError={() => setBannerStatus('error')}
                />
            </div>
          </div>
      </div>
    </div>
  );
};

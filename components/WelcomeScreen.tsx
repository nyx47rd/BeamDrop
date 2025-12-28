
import React, { useState, useEffect } from 'react';
import { Send, Download, Zap, Shield, Globe, Pencil, Check, Smartphone, Monitor } from 'lucide-react';
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
      
      {/* Top Section: Header & Device Name */}
      <div className="text-center mb-8 space-y-4 w-full">
        <div className="w-16 h-16 bg-white rounded-[1.5rem] mx-auto flex items-center justify-center mb-4 shadow-[0_0_30px_-10px_rgba(255,255,255,0.3)]">
          <Zap className="w-8 h-8 text-black fill-black" aria-hidden="true" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-white">BeamDrop</h1>
        
        {/* Editable Device Name */}
        <div className="flex items-center justify-center gap-2 mt-2 h-8">
            {editingName ? (
                <div className="flex items-center gap-2 bg-[#1c1c1e] rounded-full pl-4 pr-1 py-1 border border-white/10 animate-in zoom-in duration-200">
                    <input 
                        type="text" 
                        value={deviceName}
                        onChange={(e) => setDeviceName(e.target.value)}
                        className="bg-transparent border-none text-white text-sm focus:outline-none w-28 text-center"
                        autoFocus
                        onKeyDown={(e) => e.key === 'Enter' && handleSaveName()}
                    />
                    <button onClick={handleSaveName} className="p-1.5 bg-white rounded-full text-black hover:bg-gray-200">
                        <Check className="w-3 h-3" />
                    </button>
                </div>
            ) : (
                <button 
                    onClick={() => setEditingName(true)}
                    className="group flex items-center gap-2 text-neutral-400 hover:text-white transition-colors text-sm px-3 py-1 rounded-full hover:bg-white/5"
                >
                    <span className="max-w-[150px] truncate">{deviceName}</span>
                    <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
            )}
        </div>
      </div>

      {/* Main Actions */}
      <div className="grid grid-cols-2 gap-4 w-full mb-8 shrink-0">
        <button
          onClick={() => onSelectRole('sender')}
          className="group relative flex flex-col items-center justify-center p-6 h-36 bg-[#171717] hover:bg-[#202020] border border-[#262626] rounded-[2rem] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div className="w-10 h-10 rounded-full bg-black flex items-center justify-center mb-3 group-hover:bg-white group-hover:text-black transition-colors duration-300 border border-white/5">
            <Send className="w-4 h-4" aria-hidden="true" />
          </div>
          <span className="font-semibold text-neutral-200">Send</span>
          <span className="text-xs text-neutral-400 mt-1">Create Code</span>
        </button>

        <button
          onClick={() => onSelectRole('receiver')}
          className="group relative flex flex-col items-center justify-center p-6 h-36 bg-[#171717] hover:bg-[#202020] border border-[#262626] rounded-[2rem] transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
        >
          <div className="w-10 h-10 rounded-full bg-black flex items-center justify-center mb-3 group-hover:bg-white group-hover:text-black transition-colors duration-300 border border-white/5">
            <Download className="w-4 h-4" aria-hidden="true" />
          </div>
          <span className="font-semibold text-neutral-200">Receive</span>
          <span className="text-xs text-neutral-400 mt-1">Enter Code</span>
        </button>
      </div>

      {/* LAN / Nearby Devices List */}
      <div className="w-full flex-1 flex flex-col min-h-0 bg-[#1c1c1e] border border-white/5 rounded-[2rem] p-5 overflow-hidden">
          <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-500">Nearby Devices</span>
              <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                  </span>
                  <span className="text-[10px] font-medium text-neutral-500">Scanning</span>
              </div>
          </div>
          
          <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
              {lanPeers.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-neutral-600 space-y-3">
                      <div className="w-12 h-12 rounded-full border border-dashed border-neutral-700 flex items-center justify-center animate-pulse">
                          <Smartphone className="w-5 h-5 opacity-50" />
                      </div>
                      <p className="text-xs text-center max-w-[200px]">
                        Open BeamDrop on other devices to see them here.
                      </p>
                  </div>
              ) : (
                  lanPeers.map(peer => (
                      <button 
                        key={peer.id}
                        onClick={() => onConnectToPeer && onConnectToPeer(peer)}
                        className="w-full flex items-center gap-3 p-3 bg-black/40 hover:bg-black/60 border border-white/5 rounded-2xl transition-all group active:scale-[0.98] text-left"
                      >
                          <div className="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center group-hover:bg-indigo-500/20 group-hover:text-indigo-400 transition-colors">
                             <Monitor className="w-5 h-5" />
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
      </div>

    </div>
  );
};

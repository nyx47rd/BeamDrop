import React, { useState, useEffect } from 'react';
import { ConnectionPanel } from './components/ConnectionPanel';
import { TransferPanel } from './components/TransferPanel';
import { p2pManager } from './services/p2p';
import { ConnectionState, TransferProgress } from './types';
import { Loader2, XCircle } from 'lucide-react';

const App: React.FC = () => {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<{ blob: Blob; name: string }[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    // Setup listeners
    p2pManager.onStateChange((state) => {
      setConnectionState(state);
      if (state === 'connected') {
        setIsConnected(true);
        setErrorMsg(null);
      } else if (state === 'failed') {
        setErrorMsg("Connection failed");
      } else if (state === 'disconnected') {
        // Optional: Reset UI on disconnect
      }
    });

    p2pManager.onProgress((prog) => {
      setProgress(prog);
      if (prog.isComplete) {
        // Allow a brief moment to see 100% before clearing, 
        // but since we might be looping files, we handle that in the sender logic mostly.
        // This is mainly for the UI update.
        setTimeout(() => setProgress(null), 1000);
      }
    });

    p2pManager.onFileReceived((blob, meta) => {
      setReceivedFiles(prev => [...prev, { blob, name: meta.name }]);
    });

    return () => {
      p2pManager.cleanup();
    };
  }, []);

  const handleConnect = (code: string) => {
    setIsConnected(true);
    setErrorMsg(null);
    p2pManager.init(code);
  };

  const handleSendFiles = async (files: File[]) => {
    try {
      // Send files sequentially to ensure the data channel 
      // and receiver logic handle them correctly without interleaving.
      for (const file of files) {
        await p2pManager.sendFile(file);
      }
    } catch (e) {
      console.error(e);
      setErrorMsg("Failed to send files");
      setProgress(null);
    }
  };

  const handleDisconnect = () => {
    p2pManager.cleanup();
    setIsConnected(false);
    setConnectionState('idle');
    setProgress(null);
    setReceivedFiles([]);
    setErrorMsg(null);
  };

  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center p-6">
      
      <div className="w-full max-w-sm">
        {errorMsg && (
          <div className="mb-8 flex items-center justify-between bg-red-900/20 border border-red-900/50 text-red-400 px-4 py-3 rounded-2xl backdrop-blur-md">
            <span className="text-sm font-medium">{errorMsg}</span>
            <button onClick={() => setErrorMsg(null)}>
                <XCircle className="w-5 h-5 opacity-80" />
            </button>
          </div>
        )}

        {!isConnected ? (
          <ConnectionPanel onConnect={handleConnect} />
        ) : (
          <div className="animate-in fade-in zoom-in duration-500">
            {connectionState === 'connected' ? (
              <TransferPanel 
                progress={progress} 
                onSendFiles={handleSendFiles} 
                onDisconnect={handleDisconnect}
                receivedFiles={receivedFiles}
              />
            ) : (
              <div className="flex flex-col items-center justify-center py-20 space-y-6">
                 <Loader2 className="w-10 h-10 text-white animate-spin opacity-80" />
                 <p className="text-neutral-500 text-sm font-medium tracking-wide">Searching...</p>
                 <button 
                    onClick={handleDisconnect}
                    className="mt-8 text-neutral-600 text-xs hover:text-white transition-colors"
                 >
                    Cancel
                 </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
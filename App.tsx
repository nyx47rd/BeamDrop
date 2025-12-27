import React, { useState, useEffect } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { SenderLobby } from './components/SenderLobby';
import { ReceiverLobby } from './components/ReceiverLobby';
import { TransferPanel } from './components/TransferPanel';
import { p2pManager } from './services/p2p';
import { ConnectionState, TransferProgress } from './types';
import { XCircle, Loader2 } from 'lucide-react';

type AppMode = 'welcome' | 'sender' | 'receiver' | 'transfer';

const App: React.FC = () => {
  const [appMode, setAppMode] = useState<AppMode>('welcome');
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [generatedCode, setGeneratedCode] = useState<string>('');
  
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<{ blob: Blob; name: string }[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    // Setup listeners
    p2pManager.onStateChange((state) => {
      setConnectionState(state);
      
      if (state === 'connected') {
        setAppMode('transfer');
        setErrorMsg(null);
      } else if (state === 'failed') {
        setErrorMsg("Connection failed");
        // Don't auto-reset appMode immediately so user can see error, 
        // but typically we might want to let them retry.
      } else if (state === 'disconnected') {
        // Handle disconnect if needed
      }
    });

    p2pManager.onProgress((prog) => {
      setProgress(prog);
      if (prog.isComplete) {
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

  const handleSelectRole = (role: 'sender' | 'receiver') => {
    setErrorMsg(null);
    if (role === 'sender') {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      setGeneratedCode(code);
      p2pManager.init(code);
      setAppMode('sender');
    } else {
      setAppMode('receiver');
    }
  };

  const handleReceiverConnect = (code: string) => {
    setErrorMsg(null);
    p2pManager.init(code);
    // Stay in receiver mode (which will show loading) until 'connected' event fires
  };

  const handleSendFiles = async (files: File[]) => {
    try {
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
    setAppMode('welcome');
    setConnectionState('idle');
    setProgress(null);
    setReceivedFiles([]);
    setErrorMsg(null);
    setGeneratedCode('');
  };

  return (
    <main className="min-h-screen bg-black flex flex-col items-center justify-center p-6 font-sans">
      <div className="w-full max-w-sm relative">
        
        {errorMsg && (
          <div role="alert" className="absolute -top-24 left-0 w-full flex items-center justify-between bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2">
            <span className="text-sm font-medium">{errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} aria-label="Dismiss error">
                <XCircle className="w-5 h-5 opacity-80" />
            </button>
          </div>
        )}

        {appMode === 'welcome' && (
          <WelcomeScreen onSelectRole={handleSelectRole} />
        )}

        {appMode === 'sender' && (
          <SenderLobby code={generatedCode} onBack={handleDisconnect} />
        )}

        {appMode === 'receiver' && (
          // If we are connecting (and not yet connected), show loading state overlay on lobby
          connectionState === 'signaling' || connectionState === 'connecting' ? (
             <div role="status" className="flex flex-col items-center justify-center py-20 space-y-6 animate-in fade-in zoom-in">
                <Loader2 className="w-12 h-12 text-white animate-spin opacity-80" aria-hidden="true" />
                <p className="text-neutral-400 text-lg font-medium">Connecting to sender...</p>
                <button 
                  onClick={handleDisconnect}
                  className="mt-8 text-neutral-600 text-sm hover:text-white transition-colors"
                >
                  Cancel
                </button>
             </div>
          ) : (
            <ReceiverLobby onConnect={handleReceiverConnect} onBack={handleDisconnect} />
          )
        )}

        {appMode === 'transfer' && (
          <TransferPanel 
            progress={progress} 
            onSendFiles={handleSendFiles} 
            onDisconnect={handleDisconnect}
            receivedFiles={receivedFiles}
          />
        )}
      </div>
    </main>
  );
};

export default App;
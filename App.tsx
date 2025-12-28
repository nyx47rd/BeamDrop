import React, { useState, useEffect, Suspense, useCallback } from 'react';
import { WelcomeScreen } from './components/WelcomeScreen';
import { p2pManager } from './services/p2p';
import { deviceService } from './services/device';
import { ConnectionState, TransferProgress } from './types';
import { XCircle, Loader2 } from 'lucide-react';

// Lazy load heavy components
const SenderLobby = React.lazy(() => import('./components/SenderLobby').then(module => ({ default: module.SenderLobby })));
const ReceiverLobby = React.lazy(() => import('./components/ReceiverLobby').then(module => ({ default: module.ReceiverLobby })));
const TransferPanel = React.lazy(() => import('./components/TransferPanel').then(module => ({ default: module.TransferPanel })));

type AppMode = 'welcome' | 'sender' | 'receiver' | 'transfer';
type Role = 'sender' | 'receiver' | null;

const LoadingFallback = () => (
  <div className="flex flex-col items-center justify-center h-full w-full space-y-4 animate-in fade-in">
    <Loader2 className="w-8 h-8 text-white animate-spin opacity-50" />
  </div>
);

const App: React.FC = () => {
  // Initialize state based on current URL to prevent 404/redirect loops on refresh
  const getInitialMode = (): AppMode => {
    const path = window.location.pathname;
    if (path === '/send') return 'sender';
    if (path === '/receive') return 'receiver';
    return 'welcome';
  };

  const getInitialRole = (): Role => {
    const path = window.location.pathname;
    if (path === '/send') return 'sender';
    if (path === '/receive') return 'receiver';
    return null;
  };

  const [appMode, setAppMode] = useState<AppMode>(getInitialMode);
  const [activeRole, setActiveRole] = useState<Role>(getInitialRole);
  
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [connectionStatus, setConnectionStatus] = useState<string>('');
  const [generatedCode, setGeneratedCode] = useState<string>('');
  
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [receivedFiles, setReceivedFiles] = useState<{ blob: Blob; name: string }[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Initialize P2P if starting directly on /send
  useEffect(() => {
    if (appMode === 'sender' && !generatedCode) {
       // We need to init sender if they refreshed the page
       handleSelectRole('sender');
    }
    // Note: Receiver doesn't need auto-init as they need to input code
  }, []);

  // Handle Browser Back Button
  useEffect(() => {
    const handlePopState = () => {
      const path = window.location.pathname;
      if (path === '/' || path === '') {
        handleDisconnect();
      } else if (path === '/send') {
        if (appMode !== 'sender') handleSelectRole('sender');
      } else if (path === '/receive') {
        if (appMode !== 'receiver') setAppMode('receiver');
      }
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [appMode]);

  // SEO & UX: Dynamic Title and URL Management
  useEffect(() => {
    const baseTitle = "BeamDrop";
    let path = "/";
    let title = `${baseTitle} - Secure P2P File Transfer`;

    switch (appMode) {
      case 'sender':
        title = `Send Files - ${baseTitle}`;
        path = "/send";
        break;
      case 'receiver':
        title = `Receive Files - ${baseTitle}`;
        path = "/receive";
        break;
      case 'transfer':
        title = `Transferring... - ${baseTitle}`;
        path = "/transfer";
        break;
      default:
        path = "/";
        break;
    }

    document.title = title;
    
    // Update URL only if it changed to avoid history spam
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }, [appMode]);

  useEffect(() => {
    p2pManager.onStateChange((state) => {
      setConnectionState(state);
      
      if (state === 'connected') {
        setAppMode('transfer');
        setErrorMsg(null);
        deviceService.enableWakeLock();
      } else if (state === 'failed') {
        setErrorMsg("Connection failed");
      } else if (state === 'disconnected') {
        deviceService.disableWakeLock();
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

    p2pManager.onLog((msg) => {
      setConnectionStatus(msg);
    });

    return () => {
      p2pManager.cleanup();
    };
  }, []);

  const handleSelectRole = async (role: 'sender' | 'receiver') => {
    await deviceService.requestNotificationPermission();

    setErrorMsg(null);
    setConnectionStatus('');
    setActiveRole(role);
    
    if (role === 'sender') {
      // Reuse existing code if available (e.g. from previous session not fully cleared), else generate
      const code = generatedCode || Math.floor(100000 + Math.random() * 900000).toString();
      setGeneratedCode(code);
      p2pManager.init(code);
      setAppMode('sender');
    } else {
      setAppMode('receiver');
    }
  };

  const handleReceiverConnect = (code: string) => {
    setErrorMsg(null);
    setConnectionStatus('Initializing...');
    p2pManager.init(code);
  };

  const handleSendFiles = async (files: File[]) => {
    try {
      for (const file of files) {
        await p2pManager.sendFile(file);
      }
      
      if (files.length === 1) {
        deviceService.sendNotification('Transfer Complete', `File ${files[0].name} sent`);
      } else if (files.length > 1) {
        deviceService.sendNotification('Transfer Complete', `${files.length} files sent`);
      }

    } catch (e) {
      console.error(e);
      setErrorMsg("Failed to send files");
      setProgress(null);
    }
  };

  const handleDisconnect = useCallback(() => {
    p2pManager.cleanup();
    setAppMode('welcome');
    setActiveRole(null);
    setConnectionState('idle');
    setConnectionStatus('');
    setProgress(null);
    setReceivedFiles([]);
    setErrorMsg(null);
    setGeneratedCode('');
  }, []);

  const isTransfer = appMode === 'transfer';

  return (
    <main className="h-[100dvh] w-full bg-black font-sans overflow-hidden">
      <div className={`w-full h-full ${isTransfer ? 'overflow-hidden flex flex-col items-center justify-center' : 'overflow-y-auto'}`}>
        <div className={`w-full max-w-md mx-auto p-4 ${isTransfer ? 'h-full flex flex-col relative' : 'min-h-full flex flex-col justify-center relative'}`}>
          
          {errorMsg && (
            <div role="alert" className="absolute top-4 left-0 w-full z-50 flex items-center justify-between bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-2xl backdrop-blur-md animate-in fade-in slide-in-from-top-2">
              <span className="text-sm font-medium">{errorMsg}</span>
              <button onClick={() => setErrorMsg(null)} aria-label="Dismiss error">
                  <XCircle className="w-5 h-5 opacity-80" />
              </button>
            </div>
          )}

          <Suspense fallback={<LoadingFallback />}>
            {appMode === 'welcome' && (
              <WelcomeScreen onSelectRole={handleSelectRole} />
            )}

            {appMode === 'sender' && (
              <SenderLobby code={generatedCode} onBack={handleDisconnect} statusMessage={connectionStatus} />
            )}

            {appMode === 'receiver' && (
              connectionState === 'signaling' || connectionState === 'connecting' ? (
                <div role="status" className="flex flex-col items-center justify-center py-20 space-y-6 animate-in fade-in zoom-in flex-1">
                    <Loader2 className="w-12 h-12 text-white animate-spin opacity-80" aria-hidden="true" />
                    <div className="text-center space-y-2">
                      <p className="text-white text-lg font-medium">Connecting to sender...</p>
                      <p className="text-neutral-500 text-sm animate-pulse max-w-[250px] mx-auto min-h-[1.25rem]">
                        {connectionStatus}
                      </p>
                    </div>
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
                role={activeRole}
                connectionState={connectionState}
                progress={progress} 
                onSendFiles={handleSendFiles} 
                onDisconnect={handleDisconnect}
                receivedFiles={receivedFiles}
              />
            )}
          </Suspense>
        </div>
      </div>
    </main>
  );
};

export default App;
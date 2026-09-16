import { useState } from 'react';
import { useMeshAdmin } from './hooks/useMeshAdmin';
import { PairingModal } from './components/PairingModal';
import { DeviceTable } from './components/DeviceTable';
import { OllamaModelShelf } from './components/OllamaModelShelf';
import { Network, PlusCircle } from 'lucide-react';

export default function App() {
  const { devices, models, gpu, systemRam, ollama, revokeDevice } = useMeshAdmin();
  const [isPairingOpen, setPairingOpen] = useState(false);

  return (
      <div className="min-h-screen bg-slate-950 text-slate-50 p-8 font-sans">
        <div className="max-w-6xl mx-auto">
          <header className="flex justify-between items-center pb-8 border-b border-slate-800/80 mb-8">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-600/20 border border-indigo-500/30 rounded-xl text-indigo-400">
                <Network className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">EdgeAnalyzer Compute Mesh</h1>
                <p className="text-xs text-slate-400">Desktop MCP Daemon • {gpu?.name || 'RTX 3060'} Node</p>
              </div>
            </div>

            <button
                onClick={() => setPairingOpen(true)}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2.5 rounded-xl shadow-lg transition"
            >
              <PlusCircle className="w-4 h-4" />
              Pair New Device
            </button>
          </header>

          <OllamaModelShelf gpu={gpu} systemRam={systemRam} ollama={ollama} models={models} />
          <DeviceTable devices={devices} onRevoke={revokeDevice} />
        </div>

        <PairingModal isOpen={isPairingOpen} onClose={() => setPairingOpen(false)} />
      </div>
  );
}
import { useEffect, useState } from 'react';
import { useMeshAdmin } from './hooks/useMeshAdmin';
import { useAgentControlPlane } from './hooks/useAgentControlPlane';
import { PairingModal } from './components/PairingModal';
import { LinkNodeModal } from './components/LinkNodeModal';
import { DeviceTable } from './components/DeviceTable';
import { OllamaModelShelf } from './components/OllamaModelShelf';
import { AgentRegistryPanel } from './components/AgentRegistryPanel';
import { AgentRunConsole } from './components/AgentRunConsole';
import { AgentLaunchModal } from './components/AgentLaunchModal';
import type { RegisteredAgentDTO } from './types/agentTypes';
import {
  AlertTriangle,
  Bot,
  Link2,
  Network,
  PlusCircle,
  Wifi,
  WifiOff,
} from 'lucide-react';

type AdminTab = 'mesh' | 'agents';

export default function App() {
  const { devices, models, gpu, systemRam, ollama, revokeDevice, syncMeshRoster } = useMeshAdmin();
  const controlPlane = useAgentControlPlane();

  const [activeTab, setActiveTab] = useState<AdminTab>('mesh');
  const [inspectedAgentId, setInspectedAgentId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [launchModalAgent, setLaunchModalAgent] = useState<RegisteredAgentDTO | null>(null);
  const [isPairingOpen, setPairingOpen] = useState(false);
  const [isLinkOpen, setLinkOpen] = useState(false);

  // Sync selected agent into control plane hook for scoped live run updates
  useEffect(() => {
    controlPlane.setActiveAgentId(inspectedAgentId);
  }, [inspectedAgentId, controlPlane.setActiveAgentId]);

  const inspectedAgent = inspectedAgentId
      ? controlPlane.agents.find((a) => a.agentId === inspectedAgentId) ?? null
      : null;
  const inspectedAgentRuns = inspectedAgentId
      ? controlPlane.runsByAgent[inspectedAgentId] ?? []
      : [];
  const waitingRuns = controlPlane.waitingRuns;

  const handleOpenAgentRuns = (agent: RegisteredAgentDTO) => {
    setInspectedAgentId(agent.agentId);
    setSelectedRunId(null);
    setActiveTab('agents');
  };

  const handleLaunchRun = async (agentId: string, inputs: Record<string, unknown>) => {
    const started = await controlPlane.startRun(agentId, inputs);
    setInspectedAgentId(agentId);
    setSelectedRunId(started.runId);
    setActiveTab('agents');
  };

  const handleTakeOverInterrupt = () => {
    const targetRun = waitingRuns[0];
    if (!targetRun) return;
    setInspectedAgentId(targetRun.agentId);
    setSelectedRunId(targetRun.runId);
    setActiveTab('agents');
    controlPlane.loadRunEvents(targetRun.runId, 0);
  };

  const isViewingWaitingRun =
      activeTab === 'agents' &&
      waitingRuns.some(
          (r) =>
              r.agentId === inspectedAgentId &&
              (selectedRunId === r.runId ||
                  (selectedRunId === null && inspectedAgentRuns[0]?.runId === r.runId))
      );

  return (
      <div className="min-h-screen bg-slate-950 text-slate-50 p-6 md:p-8 font-sans">
        <div className="max-w-7xl mx-auto">
          <header className="flex flex-wrap justify-between items-center gap-4 pb-6 border-b border-slate-800/80 mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-600/20 border border-indigo-500/30 rounded-xl text-indigo-400">
                <Network className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight">
                  EdgeAnalyzer Compute Mesh
                </h1>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span>Desktop MCP Daemon • {gpu?.name || 'Local GPU'} Node</span>
                  <span className="text-slate-600">|</span>
                  <span
                      className={`inline-flex items-center gap-1 font-medium ${
                          controlPlane.wsConnected
                              ? 'text-emerald-400'
                              : 'text-amber-400'
                      }`}
                  >
                                    {controlPlane.wsConnected ? (
                                        <>
                                          <Wifi className="w-3 h-3" /> Live WS
                                        </>
                                    ) : (
                                        <>
                                          <WifiOff className="w-3 h-3" /> Polling
                                        </>
                                    )}
                                </span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5 flex-wrap">
              <button
                  onClick={syncMeshRoster}
                  className="px-3.5 py-2 text-xs font-semibold rounded-lg bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-700 transition-colors"
              >
                ⚡ Sync Mesh Roster
              </button>
              <button
                  onClick={() => setLinkOpen(true)}
                  className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium px-3.5 py-2 rounded-xl transition"
              >
                <Link2 className="w-4 h-4 text-indigo-400" />
                Link Desktop Node
              </button>
              <button
                  onClick={() => setPairingOpen(true)}
                  className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3.5 py-2 rounded-xl shadow-lg transition"
              >
                <PlusCircle className="w-4 h-4" />
                Pair New Device
              </button>
            </div>
          </header>

          {/* Primary Workspace Tabs */}
          <div className="flex items-center gap-2 mb-6">
            <button
                type="button"
                onClick={() => setActiveTab('mesh')}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition ${
                    activeTab === 'mesh'
                        ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/50'
                        : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
            >
              <Network className="w-4 h-4" />
              Compute Mesh
            </button>

            <button
                type="button"
                onClick={() => {
                  if (activeTab === 'agents') {
                    setInspectedAgentId(null);
                    setSelectedRunId(null);
                  } else {
                    setActiveTab('agents');
                  }
                }}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold border transition ${
                    activeTab === 'agents'
                        ? 'bg-indigo-600/20 text-indigo-300 border-indigo-500/50'
                        : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'
                }`}
            >
              <Bot className="w-4 h-4" />
              Agents Control Plane
              <span className="text-[11px] font-mono bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded">
                            {controlPlane.agents.filter((a) => a.validationStatus === 'READY').length}
                        </span>
              {waitingRuns.length > 0 && (
                  <span className="text-[10px] font-bold bg-amber-500 text-slate-950 px-1.5 py-0.5 rounded-full animate-pulse">
                                {waitingRuns.length} Action
                            </span>
              )}
            </button>
          </div>

          {/* Non-Intrusive Cross-Device Interrupt Takeover Banner */}
          {waitingRuns.length > 0 && !isViewingWaitingRun && (
              <div className="mb-6 p-3.5 rounded-xl bg-amber-950/40 border border-amber-500/50 flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2.5 text-amber-200 text-xs font-semibold">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                                Action Required: {waitingRuns[0].agentName || waitingRuns[0].agentId}{' '}
                    is waiting for input (origin: {waitingRuns[0].originClientId}).
                            </span>
                </div>
                <button
                    type="button"
                    onClick={handleTakeOverInterrupt}
                    className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold"
                >
                  Action Required — Take Over
                </button>
              </div>
          )}

          {activeTab === 'mesh' ? (
              <>
                <OllamaModelShelf
                    gpu={gpu}
                    systemRam={systemRam}
                    ollama={ollama}
                    models={models}
                />
                <DeviceTable devices={devices} onRevoke={revokeDevice} />
              </>
          ) : inspectedAgentId ? (
              <AgentRunConsole
                  agent={inspectedAgent}
                  agentId={inspectedAgentId}
                  runs={inspectedAgentRuns}
                  selectedRunId={selectedRunId}
                  onSelectRun={setSelectedRunId}
                  onBackToAgents={() => {
                    setInspectedAgentId(null);
                    setSelectedRunId(null);
                  }}
                  onRefreshRuns={() => controlPlane.refreshAgentRuns(inspectedAgentId)}
                  onRequestLaunch={
                    inspectedAgent ? () => setLaunchModalAgent(inspectedAgent) : undefined
                  }
                  eventsByRun={controlPlane.eventsByRun}
                  originClientId={controlPlane.originClientId}
                  onLoadRunEvents={controlPlane.loadRunEvents}
                  onResumeRun={controlPlane.resumeRun}
                  onCancelRun={controlPlane.cancelRun}
                  onFetchArtifact={controlPlane.fetchArtifactText}
              />
          ) : (
              <AgentRegistryPanel
                  agents={controlPlane.agents}
                  waitingRuns={waitingRuns}
                  onRegisterFolder={controlPlane.registerFolder}
                  onRevalidate={controlPlane.revalidateAgent}
                  onRemove={controlPlane.removeAgent}
                  onOpenAgentRuns={handleOpenAgentRuns}
                  onRequestLaunch={setLaunchModalAgent}
              />
          )}
        </div>

        <AgentLaunchModal
            agent={launchModalAgent}
            onClose={() => setLaunchModalAgent(null)}
            onLaunch={handleLaunchRun}
        />
        <PairingModal isOpen={isPairingOpen} onClose={() => setPairingOpen(false)} />
        <LinkNodeModal
            isOpen={isLinkOpen}
            onClose={() => setLinkOpen(false)}
            onSuccess={syncMeshRoster}
        />
      </div>
  );
}
import { useState } from 'react';
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    FolderPlus,
    History,
    Loader2,
    Play,
    RefreshCw,
    ShieldCheck,
    Trash2,
    X,
    XCircle,
} from 'lucide-react';
import type {
    AgentRunDTO,
    RegisteredAgentDTO,
    ValidationReport,
} from '../types/agentTypes';

interface Props {
    agents: RegisteredAgentDTO[];
    waitingRuns: AgentRunDTO[];
    onRegisterFolder: (
        folderPath: string
    ) => Promise<{ agent?: RegisteredAgentDTO; validationReport?: ValidationReport; error?: string }>;
    onRevalidate: (
        agentId: string
    ) => Promise<{ agent?: RegisteredAgentDTO; validationReport?: ValidationReport; error?: string }>;
    onRemove: (agentId: string) => Promise<boolean>;
    onOpenAgentRuns: (agent: RegisteredAgentDTO) => void;
    onRequestLaunch: (agent: RegisteredAgentDTO) => void;
}

export function AgentRegistryPanel({
                                       agents,
                                       waitingRuns,
                                       onRegisterFolder,
                                       onRevalidate,
                                       onRemove,
                                       onOpenAgentRuns,
                                       onRequestLaunch,
                                   }: Props) {
    const [folderInput, setFolderInput] = useState('');
    const [isValidating, setIsValidating] = useState(false);
    const [registerError, setRegisterError] = useState<string | null>(null);
    const [latestReport, setLatestReport] = useState<{
        label: string;
        report: ValidationReport;
    } | null>(null);

    const [expandedAgentIds, setExpandedAgentIds] = useState<Record<string, boolean>>({});
    const [busyAgentId, setBusyAgentId] = useState<string | null>(null);

    const handleRegister = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = folderInput.trim();
        if (!trimmed) return;

        setIsValidating(true);
        setRegisterError(null);
        try {
            const res = await onRegisterFolder(trimmed);
            if (res.error) {
                setRegisterError(res.error);
            }
            if (res.validationReport) {
                setLatestReport({
                    label: res.agent?.name || trimmed,
                    report: res.validationReport,
                });
                if (res.validationReport.passed) {
                    setFolderInput('');
                }
            }
        } catch (err: unknown) {
            setRegisterError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsValidating(false);
        }
    };

    const handleRevalidate = async (agent: RegisteredAgentDTO) => {
        setBusyAgentId(agent.agentId);
        setRegisterError(null);
        try {
            const res = await onRevalidate(agent.agentId);
            if (res.validationReport) {
                setLatestReport({
                    label: agent.name,
                    report: res.validationReport,
                });
            }
        } finally {
            setBusyAgentId(null);
        }
    };

    const handleRemove = async (agent: RegisteredAgentDTO) => {
        setBusyAgentId(agent.agentId);
        try {
            await onRemove(agent.agentId);
        } finally {
            setBusyAgentId(null);
        }
    };

    const renderGateChecklist = (report: ValidationReport) => (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 mt-3">
            {report.gates.map((g) => (
                <div
                    key={g.gate}
                    className={`p-2.5 rounded-lg border text-xs ${
                        g.passed
                            ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                            : 'bg-rose-950/30 border-rose-500/40 text-rose-200'
                    }`}
                >
                    <div className="flex items-center gap-1.5 font-semibold mb-1">
                        {g.passed ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        ) : (
                            <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        )}
                        <span className="truncate">
                            G{g.gate}: {g.name}
                        </span>
                    </div>
                    <p className="text-[11px] opacity-80 leading-snug break-words">{g.message}</p>
                </div>
            ))}
        </div>
    );

    return (
        <section>
            {/* Registration Bar */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 mb-6">
                <div className="flex items-center gap-2 mb-3">
                    <ShieldCheck className="w-4 h-4 text-indigo-400" />
                    <h2 className="text-sm font-bold text-slate-100">
                        Register Python Agent Folder (5-Gate Pre-Flight)
                    </h2>
                </div>

                <form onSubmit={handleRegister} className="flex flex-col sm:flex-row gap-3">
                    <input
                        type="text"
                        value={folderInput}
                        onChange={(e) => setFolderInput(e.target.value)}
                        placeholder="Absolute path to agent folder containing edge-agent.json (e.g. C:\path\to\agent)"
                        className="flex-1 bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
                    />
                    <button
                        type="submit"
                        disabled={isValidating || !folderInput.trim()}
                        className="flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition shrink-0"
                    >
                        {isValidating ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Validating Gates...
                            </>
                        ) : (
                            <>
                                <FolderPlus className="w-4 h-4" />
                                Validate &amp; Register Folder
                            </>
                        )}
                    </button>
                </form>

                {registerError && (
                    <div className="mt-3 p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs text-rose-200">
                        {registerError}
                    </div>
                )}

                {latestReport && (
                    <div className="mt-4 pt-3 border-t border-slate-800">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-300">
                                Pre-Flight Report:{' '}
                                <span className="text-sky-400">{latestReport.label}</span>
                            </span>
                            <button
                                type="button"
                                onClick={() => setLatestReport(null)}
                                className="text-slate-500 hover:text-slate-300"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        {renderGateChecklist(latestReport.report)}
                    </div>
                )}
            </div>

            {/* Registered Agent Cards */}
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Registered Agents ({agents.length})
                </h3>
                <span className="text-xs text-slate-500">
                    Select an agent to inspect its run history &amp; live console
                </span>
            </div>

            {agents.length === 0 ? (
                <div className="bg-slate-900/50 border border-dashed border-slate-800 rounded-2xl p-8 text-center text-sm text-slate-400">
                    No Python agents registered yet. Enter an agent folder path above to run the 5-gate pre-flight validator.
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {agents.map((agent) => {
                        const isReady = agent.validationStatus === 'READY';
                        const isBusy = busyAgentId === agent.agentId;
                        const isExpanded = !!expandedAgentIds[agent.agentId];
                        const agentWaitingCount = waitingRuns.filter(
                            (r) => r.agentId === agent.agentId
                        ).length;

                        return (
                            <div
                                key={agent.agentId}
                                className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 flex flex-col justify-between transition"
                            >
                                <div
                                    onClick={() => onOpenAgentRuns(agent)}
                                    className="cursor-pointer group"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h4 className="text-sm font-bold text-slate-100 group-hover:text-indigo-300 transition truncate">
                                                    {agent.name}
                                                </h4>
                                                <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                                                    v{agent.version}
                                                </span>
                                                <span
                                                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                                        isReady
                                                            ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                                            : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                                                    }`}
                                                >
                                                    {agent.validationStatus}
                                                </span>
                                                {agentWaitingCount > 0 && (
                                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                                                        <AlertTriangle className="w-3 h-3" />
                                                        {agentWaitingCount} Needs Input
                                                    </span>
                                                )}
                                            </div>
                                            {agent.manifest.description && (
                                                <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                                                    {agent.manifest.description}
                                                </p>
                                            )}
                                        </div>
                                    </div>

                                    <div className="mt-3 text-[11px] font-mono text-slate-500 space-y-0.5 break-all">
                                        <div>
                                            Entry: {agent.manifest.runtime.entrypoint || '(invalid)'}
                                        </div>
                                        <div>Path: {agent.folderPath}</div>
                                    </div>
                                </div>

                                <div className="mt-4 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2 flex-wrap">
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setExpandedAgentIds((prev) => ({
                                                ...prev,
                                                [agent.agentId]: !prev[agent.agentId],
                                            }))
                                        }
                                        className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
                                    >
                                        {isExpanded ? (
                                            <ChevronUp className="w-3.5 h-3.5" />
                                        ) : (
                                            <ChevronDown className="w-3.5 h-3.5" />
                                        )}
                                        5-Gate Report
                                    </button>

                                    <div className="flex items-center gap-2 flex-wrap">
                                        <button
                                            type="button"
                                            disabled={isBusy}
                                            onClick={() => handleRevalidate(agent)}
                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium disabled:opacity-50"
                                        >
                                            <RefreshCw
                                                className={`w-3.5 h-3.5 ${isBusy ? 'animate-spin' : ''}`}
                                            />
                                            Revalidate
                                        </button>

                                        <button
                                            type="button"
                                            disabled={isBusy}
                                            onClick={() => handleRemove(agent)}
                                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-950/60 text-rose-300 text-xs font-medium disabled:opacity-50"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                            Remove
                                        </button>

                                        <button
                                            type="button"
                                            onClick={() => onOpenAgentRuns(agent)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/35 text-indigo-300 border border-indigo-500/40 text-xs font-semibold transition"
                                        >
                                            <History className="w-3.5 h-3.5" />
                                            View Runs
                                        </button>

                                        <button
                                            type="button"
                                            disabled={!isReady}
                                            onClick={() => onRequestLaunch(agent)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold transition"
                                        >
                                            <Play className="w-3.5 h-3.5" />
                                            Launch Run
                                        </button>
                                    </div>
                                </div>

                                {isExpanded && renderGateChecklist(agent.validationReport)}
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );
}
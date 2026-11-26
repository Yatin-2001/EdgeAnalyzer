import { useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    ArrowLeft,
    Play,
    Check,
    CheckCircle2,
    Circle,
    Clock,
    Copy,
    Edit3,
    FileText,
    Laptop,
    Loader2,
    RefreshCw,
    Send,
    Smartphone,
    Square,
    Terminal,
    X,
    XCircle,
} from 'lucide-react';
import type {
    AgentArtifactMeta,
    AgentRunDTO,
    AgentRunEventDTO,
    AgentRunStatus,
    RegisteredAgentDTO
} from '../types/agentTypes';

interface Props {
    agent: RegisteredAgentDTO | null;
    agentId: string;
    runs: AgentRunDTO[];
    selectedRunId: string | null;
    onSelectRun: (runId: string) => void;
    onBackToAgents: () => void;
    onRefreshRuns: () => void;
    onRequestLaunch?: () => void;
    eventsByRun: Record<string, AgentRunEventDTO[]>;
    originClientId: string;
    onLoadRunEvents: (runId: string, afterSeq?: number) => Promise<AgentRunDTO | null>;
    onResumeRun: (
        runId: string,
        interruptId: string,
        resume: unknown
    ) => Promise<{ ok: boolean; error?: string }>;
    onCancelRun: (runId: string) => Promise<{ ok: boolean; cancelled?: boolean }>;
    onFetchArtifact: (runId: string, relPath: string) => Promise<string>;
}

interface TodoItem {
    content: string;
    status: string;
}

function statusBadgeStyle(status: AgentRunStatus): string {
    switch (status) {
        case 'RUNNING':
        case 'QUEUED':
            return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
        case 'WAITING_FOR_INPUT':
            return 'bg-amber-500/20 text-amber-300 border-amber-500/40 animate-pulse';
        case 'COMPLETED':
            return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
        case 'CANCELLED':
            return 'bg-slate-700/60 text-slate-300 border-slate-600';
        case 'FAILED':
            return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    }
}

function formatTime(epochMs: number): string {
    try {
        return new Date(epochMs).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
    } catch {
        return '';
    }
}

export function AgentRunConsole({
                                    agent,
                                    agentId,
                                    runs,
                                    selectedRunId,
                                    onSelectRun,
                                    onBackToAgents,
                                    onRefreshRuns,
                                    onRequestLaunch,
                                    eventsByRun,
                                    originClientId,
                                    onLoadRunEvents,
                                    onResumeRun,
                                    onCancelRun,
                                    onFetchArtifact,
                                }: Props) {
    const [showStderr, setShowStderr] = useState(true);
    const [isCancelling, setIsCancelling] = useState(false);

    // Interrupt response state
    const [userInputText, setUserInputText] = useState('');
    const [schemaFormValues, setSchemaFormValues] = useState<Record<string, string>>({});
    const [isEditingApproval, setIsEditingApproval] = useState(false);
    const [editedTasksText, setEditedTasksText] = useState('');
    const [approvalConstraints, setApprovalConstraints] = useState('');
    const [isSubmittingInterrupt, setIsSubmittingInterrupt] = useState(false);
    const [interruptError, setInterruptError] = useState<string | null>(null);

    // Artifact Drawer state
    const [activeArtifact, setActiveArtifact] = useState<{
        meta: AgentArtifactMeta;
        content: string;
        loading: boolean;
        error?: string;
    } | null>(null);
    const [copiedArtifact, setCopiedArtifact] = useState(false);

    const feedBottomRef = useRef<HTMLDivElement | null>(null);

    const selectedRun = useMemo(
        () => runs.find((r) => r.runId === selectedRunId) ?? runs[0] ?? null,
        [runs, selectedRunId]
    );

    const activeRunId = selectedRun?.runId ?? null;
    const rawEvents = useMemo(
        () => (activeRunId ? eventsByRun[activeRunId] ?? [] : []),
        [activeRunId, eventsByRun]
    );

    // Load historical events whenever a run is selected
    useEffect(() => {
        if (!activeRunId) return;
        const existing = eventsByRun[activeRunId];
        const afterSeq =
            existing && existing.length > 0 ? existing[existing.length - 1].seq : 0;
        onLoadRunEvents(activeRunId, afterSeq);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeRunId]);

    // Auto-scroll timeline on new events
    useEffect(() => {
        feedBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, [rawEvents.length]);

    // Reset interrupt editor fields when a new interrupt arrives
    const pendingInterrupt = selectedRun?.pendingInterrupt ?? null;
    const pendingInterruptId = selectedRun?.pendingInterruptId ?? null;

    useEffect(() => {
        setInterruptError(null);
        setUserInputText('');
        setApprovalConstraints('');
        setIsEditingApproval(false);
        setSchemaFormValues({});

        if (pendingInterrupt?.payload) {
            const p = pendingInterrupt.payload;
            if (Array.isArray(p.tasks)) {
                setEditedTasksText(p.tasks.map((t) => String(t)).join('\n'));
            } else if (Array.isArray(p.action_requests)) {
                setEditedTasksText(
                    p.action_requests
                        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
                        .join('\n')
                );
            } else {
                setEditedTasksText('');
            }
        }
    }, [pendingInterruptId, pendingInterrupt]);

    // Derive latest Todo list from todo_update events
    const latestTodos = useMemo<TodoItem[]>(() => {
        for (let i = rawEvents.length - 1; i >= 0; i--) {
            const ev = rawEvents[i];
            if (ev.event_type === 'todo_update' && Array.isArray(ev.payload.todos)) {
                return (ev.payload.todos as Array<Record<string, unknown>>).map((t) => ({
                    content: String(t.content ?? ''),
                    status: String(t.status ?? 'pending'),
                }));
            }
        }
        return [];
    }, [rawEvents]);

    // Merge artifacts from run metadata + live artifact events
    const artifacts = useMemo<AgentArtifactMeta[]>(() => {
        const map = new Map<string, AgentArtifactMeta>();
        for (const a of selectedRun?.artifacts ?? []) {
            if (a.path) map.set(a.path, a);
        }
        for (const ev of rawEvents) {
            if (ev.event_type === 'artifact' && typeof ev.payload.path === 'string') {
                map.set(ev.payload.path, {
                    path: ev.payload.path,
                    size_bytes: Number(ev.payload.size_bytes ?? 0),
                    mime: String(ev.payload.mime ?? 'text/plain'),
                });
            }
        }
        return Array.from(map.values());
    }, [selectedRun, rawEvents]);

    const visibleEvents = useMemo(
        () => rawEvents.filter((e) => showStderr || e.event_type !== 'stderr_log'),
        [rawEvents, showStderr]
    );

    const handleCancel = async () => {
        if (!selectedRun) return;
        setIsCancelling(true);
        try {
            await onCancelRun(selectedRun.runId);
        } finally {
            setIsCancelling(false);
        }
    };

    const submitInterruptDecision = async (resumeValue: unknown) => {
        if (!selectedRun || !pendingInterruptId) return;
        setIsSubmittingInterrupt(true);
        setInterruptError(null);
        try {
            const res = await onResumeRun(selectedRun.runId, pendingInterruptId, resumeValue);
            if (!res.ok) {
                setInterruptError(
                    res.error === 'INTERRUPT_ALREADY_RESOLVED'
                        ? 'This interrupt was already answered on another device.'
                        : res.error || 'Failed to resume run.'
                );
            }
        } catch (err: unknown) {
            setInterruptError(err instanceof Error ? err.message : String(err));
        } finally {
            setIsSubmittingInterrupt(false);
        }
    };

    const handleApprovalAction = (decision: 'approve' | 'edit' | 'reject') => {
        const payload = pendingInterrupt?.payload ?? {};
        const parsedTasks = editedTasksText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);

        if ('action_requests' in payload) {
            const actionRequests = Array.isArray(payload.action_requests)
                ? payload.action_requests
                : [];
            const resumeObj = {
                approved: decision !== 'reject',
                decisions: actionRequests.map(() => ({
                    type: decision,
                    ...(decision === 'edit' ? { edited_tasks: parsedTasks } : {}),
                    ...(approvalConstraints.trim()
                        ? { message: approvalConstraints.trim() }
                        : {}),
                })),
                ...(decision === 'edit' ? { tasks: parsedTasks } : {}),
                ...(approvalConstraints.trim()
                    ? { constraints: approvalConstraints.trim() }
                    : {}),
            };
            submitInterruptDecision(resumeObj);
            return;
        }

        const resumeObj: Record<string, unknown> = {
            approved: decision !== 'reject',
        };
        if (decision === 'edit') {
            resumeObj.tasks = parsedTasks;
        }
        if (approvalConstraints.trim()) {
            resumeObj.constraints = approvalConstraints.trim();
        }
        submitInterruptDecision(resumeObj);
    };

    const handleUserInputSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const schemaProps = (pendingInterrupt?.response_schema as {
            properties?: Record<string, { type?: string }>;
        } | null)?.properties;

        if (schemaProps && Object.keys(schemaProps).length > 0) {
            const structured: Record<string, unknown> = {};
            for (const [key, prop] of Object.entries(schemaProps)) {
                const raw = schemaFormValues[key] ?? '';
                if (prop.type === 'number' || prop.type === 'integer') {
                    structured[key] = Number(raw);
                } else if (prop.type === 'boolean') {
                    structured[key] = raw === 'true';
                } else {
                    structured[key] = raw;
                }
            }
            submitInterruptDecision(structured);
            return;
        }

        submitInterruptDecision(userInputText.trim());
    };

    const openArtifact = async (meta: AgentArtifactMeta) => {
        if (!selectedRun) return;
        setCopiedArtifact(false);
        setActiveArtifact({ meta, content: '', loading: true });
        try {
            const text = await onFetchArtifact(selectedRun.runId, meta.path);
            setActiveArtifact({ meta, content: text, loading: false });
        } catch (err: unknown) {
            setActiveArtifact({
                meta,
                content: '',
                loading: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    const copyArtifactContent = async () => {
        if (!activeArtifact?.content) return;
        try {
            await navigator.clipboard.writeText(activeArtifact.content);
            setCopiedArtifact(true);
            setTimeout(() => setCopiedArtifact(false), 1800);
        } catch {}
    };

    const isRunActive =
        selectedRun?.status === 'RUNNING' ||
        selectedRun?.status === 'QUEUED' ||
        selectedRun?.status === 'WAITING_FOR_INPUT';

    const schemaProperties = (pendingInterrupt?.response_schema as {
        properties?: Record<string, { type?: string; description?: string; title?: string }>;
    } | null)?.properties;

    return (
        <div className="space-y-4">
            {/* Per-Agent Navigation Header */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex items-start gap-4">
                <button
                    type="button"
                    onClick={onBackToAgents}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold border border-slate-700 transition shrink-0 mt-0.5"
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    All Agents
                </button>

                <div className="min-w-0 flex-1 text-left">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-base font-bold text-slate-100 truncate">
                            {agent?.name || agentId}
                        </h2>
                        {agent && (
                            <span className="text-[11px] font-mono text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded">
                                v{agent.version}
                            </span>
                        )}
                        {agent && (
                            <span
                                className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                                    agent.validationStatus === 'READY'
                                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                        : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                                }`}
                            >
                                {agent.validationStatus}
                            </span>
                        )}
                    </div>

                    <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                        {agent?.manifest.description || `Filtered run history for ${agentId}`}
                    </p>

                    <div className="flex items-center gap-2 mt-3">
                        <button
                            type="button"
                            onClick={onRefreshRuns}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
                        >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Refresh
                        </button>

                        {onRequestLaunch && agent && (
                            <button
                                type="button"
                                disabled={agent.validationStatus !== 'READY'}
                                onClick={onRequestLaunch}
                                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-xs font-semibold transition"
                            >
                                <Play className="w-3.5 h-3.5" />
                                New Run
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <section className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Left Sidebar: Recent Runs for THIS Agent Only */}
                <div className="lg:col-span-3 bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-col max-h-[720px]">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                            Recent Runs ({runs.length})
                        </h3>
                    </div>

                    {runs.length === 0 ? (
                        <div className="text-xs text-slate-500 py-8 text-center">
                            No runs yet for {agent?.name || agentId}. Click New Run above to launch it on the mesh.
                        </div>
                    ) : (
                        <div className="space-y-2 overflow-y-auto pr-1 flex-1">
                            {runs.map((run) => {
                                const isSelected = run.runId === selectedRun?.runId;
                                const isMobileOrigin = run.originClientId.startsWith('mobile:');
                                const label = String(
                                    run.inputs?.brief ||
                                    run.inputs?.prompt ||
                                    run.inputs?.query ||
                                    run.runId.slice(0, 16)
                                );
                                return (
                                    <button
                                        key={run.runId}
                                        type="button"
                                        onClick={() => onSelectRun(run.runId)}
                                        className={`w-full text-left p-3 rounded-xl border transition ${
                                            isSelected
                                                ? 'bg-slate-800/90 border-indigo-500/60'
                                                : 'bg-slate-950/60 border-slate-800/80 hover:border-slate-700'
                                        }`}
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-xs font-bold text-slate-100 truncate">
                                                {label}
                                            </span>
                                            <span
                                                className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${statusBadgeStyle(
                                                    run.status
                                                )}`}
                                            >
                                                {run.status === 'WAITING_FOR_INPUT'
                                                    ? 'INPUT'
                                                    : run.status}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between mt-1.5 text-[10px] text-slate-400 font-mono">
                                            <span className="flex items-center gap-1">
                                                {isMobileOrigin ? (
                                                    <Smartphone className="w-3 h-3 text-sky-400" />
                                                ) : (
                                                    <Laptop className="w-3 h-3 text-indigo-400" />
                                                )}
                                                {run.runId.slice(0, 14)}
                                            </span>
                                            <span>{formatTime(run.startedAtMs)}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Main Console Area */}
                <div className="lg:col-span-9 bg-slate-900 border border-slate-800 rounded-2xl p-5 flex flex-col min-h-[560px]">
                    {!selectedRun ? (
                        <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-sm">
                            <Terminal className="w-8 h-8 mb-2 opacity-40" />
                            Select or launch an agent run to inspect live mesh routing, todos, and artifacts.
                        </div>
                    ) : (
                        <>
                            {/* Run Header */}
                            <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-800">
                                <div>
                                    <div className="flex items-center gap-2.5 flex-wrap">
                                        <h3 className="text-base font-bold text-slate-100">
                                            {selectedRun.agentName || selectedRun.agentId}
                                        </h3>
                                        <span
                                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${statusBadgeStyle(
                                                selectedRun.status
                                            )}`}
                                        >
                                            {selectedRun.status}
                                        </span>
                                        <span className="text-[11px] font-mono text-slate-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                                            {selectedRun.originClientId.startsWith('mobile:')
                                                ? '📱 Mobile Origin'
                                                : '💻 Admin UI Origin'}
                                        </span>
                                    </div>
                                    <div className="text-[11px] font-mono text-slate-500 mt-1 flex flex-wrap gap-3">
                                        <span>Run: {selectedRun.runId}</span>
                                        <span>Trace: {selectedRun.traceId.slice(0, 16)}</span>
                                        {selectedRun.pid && <span>PID: {selectedRun.pid}</span>}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => onLoadRunEvents(selectedRun.runId, 0)}
                                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                        Replay
                                    </button>

                                    {isRunActive && (
                                        <button
                                            type="button"
                                            disabled={isCancelling}
                                            onClick={handleCancel}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold"
                                        >
                                            {isCancelling ? (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                                <Square className="w-3 h-3 fill-current" />
                                            )}
                                            Stop Run
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Inline Interrupt Action Card */}
                            {selectedRun.status === 'WAITING_FOR_INPUT' && pendingInterrupt && (
                                <div className="mt-4 p-4 rounded-xl bg-amber-950/35 border border-amber-500/50">
                                    <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                                        <div className="flex items-center gap-2 text-amber-300 font-bold text-sm">
                                            <AlertTriangle className="w-4 h-4 shrink-0" />
                                            {pendingInterrupt.kind === 'hitl_approval'
                                                ? 'Approval Required (HITL Interrupt)'
                                                : 'Agent Waiting for Input'}
                                        </div>
                                        {selectedRun.originClientId !== originClientId && (
                                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-amber-500/20 text-amber-200 border border-amber-500/40">
                                                Cross-Device Takeover ({selectedRun.originClientId})
                                            </span>
                                        )}
                                    </div>

                                    {pendingInterrupt.kind === 'hitl_approval' ? (
                                        <div className="space-y-3">
                                            <p className="text-xs text-slate-200">
                                                {String(
                                                    pendingInterrupt.payload.message ||
                                                    'Review the proposed actions below before continuing.'
                                                )}
                                                {pendingInterrupt.payload.score !== undefined && (
                                                    <span className="ml-2 text-amber-300 font-mono">
                                                        (Quality Score: {String(pendingInterrupt.payload.score)}/10)
                                                    </span>
                                                )}
                                            </p>

                                            {!isEditingApproval ? (
                                                <div className="bg-slate-950/80 border border-slate-800 rounded-lg p-3 space-y-1.5">
                                                    {editedTasksText
                                                        .split('\n')
                                                        .filter(Boolean)
                                                        .map((taskLine, i) => (
                                                            <div
                                                                key={i}
                                                                className="text-xs text-slate-300 font-mono flex gap-2"
                                                            >
                                                                <span className="text-amber-400">
                                                                    {i + 1}.
                                                                </span>
                                                                <span className="break-words">{taskLine}</span>
                                                            </div>
                                                        ))}
                                                </div>
                                            ) : (
                                                <div className="space-y-2">
                                                    <label className="block text-[11px] font-semibold text-amber-200">
                                                        Edit Tasks (one per line)
                                                    </label>
                                                    <textarea
                                                        rows={3}
                                                        value={editedTasksText}
                                                        onChange={(e) => setEditedTasksText(e.target.value)}
                                                        className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-amber-400"
                                                    />
                                                </div>
                                            )}

                                            <div>
                                                <input
                                                    type="text"
                                                    value={approvalConstraints}
                                                    onChange={(e) => setApprovalConstraints(e.target.value)}
                                                    placeholder="Optional constraints or reviewer feedback..."
                                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-400"
                                                />
                                            </div>

                                            <div className="flex items-center gap-2 flex-wrap">
                                                <button
                                                    type="button"
                                                    disabled={isSubmittingInterrupt}
                                                    onClick={() =>
                                                        handleApprovalAction(
                                                            isEditingApproval ? 'edit' : 'approve'
                                                        )
                                                    }
                                                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold disabled:opacity-50"
                                                >
                                                    <Check className="w-3.5 h-3.5" />
                                                    {isEditingApproval ? 'Approve with Edits' : 'Approve'}
                                                </button>

                                                <button
                                                    type="button"
                                                    disabled={isSubmittingInterrupt}
                                                    onClick={() => setIsEditingApproval((v) => !v)}
                                                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-semibold border border-slate-700"
                                                >
                                                    <Edit3 className="w-3.5 h-3.5" />
                                                    {isEditingApproval ? 'Preview' : 'Edit'}
                                                </button>

                                                <button
                                                    type="button"
                                                    disabled={isSubmittingInterrupt}
                                                    onClick={() => handleApprovalAction('reject')}
                                                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-rose-600/90 hover:bg-rose-500 text-white text-xs font-semibold disabled:opacity-50"
                                                >
                                                    <XCircle className="w-3.5 h-3.5" />
                                                    Reject
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <form onSubmit={handleUserInputSubmit} className="space-y-3">
                                            <p className="text-xs text-slate-200 whitespace-pre-wrap">
                                                {String(
                                                    pendingInterrupt.payload.prompt ||
                                                    pendingInterrupt.payload.message ||
                                                    JSON.stringify(pendingInterrupt.payload, null, 2)
                                                )}
                                            </p>

                                            {schemaProperties && Object.keys(schemaProperties).length > 0 ? (
                                                <div className="space-y-2.5">
                                                    {Object.entries(schemaProperties).map(([key, prop]) => (
                                                        <div key={key}>
                                                            <label className="block text-[11px] font-semibold text-amber-200 mb-1">
                                                                {prop.title || key}
                                                                {prop.description && (
                                                                    <span className="text-slate-400 font-normal ml-1.5">
                                                                        — {prop.description}
                                                                    </span>
                                                                )}
                                                            </label>
                                                            <input
                                                                type={
                                                                    prop.type === 'number' ||
                                                                    prop.type === 'integer'
                                                                        ? 'number'
                                                                        : 'text'
                                                                }
                                                                value={schemaFormValues[key] ?? ''}
                                                                onChange={(e) =>
                                                                    setSchemaFormValues((prev) => ({
                                                                        ...prev,
                                                                        [key]: e.target.value,
                                                                    }))
                                                                }
                                                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-amber-400"
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : (
                                                <textarea
                                                    rows={2}
                                                    value={userInputText}
                                                    onChange={(e) => setUserInputText(e.target.value)}
                                                    placeholder="Enter response to resume agent..."
                                                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-100 focus:outline-none focus:border-amber-400"
                                                />
                                            )}

                                            <button
                                                type="submit"
                                                disabled={isSubmittingInterrupt}
                                                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold disabled:opacity-50"
                                            >
                                                <Send className="w-3.5 h-3.5" />
                                                Submit &amp; Resume
                                            </button>
                                        </form>
                                    )}

                                    {interruptError && (
                                        <div className="mt-2 text-xs text-rose-300 bg-rose-950/60 border border-rose-500/40 rounded-lg px-3 py-1.5">
                                            {interruptError}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Error Notice */}
                            {selectedRun.errorMessage && selectedRun.status === 'FAILED' && (
                                <div className="mt-4 p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 text-xs text-rose-200 font-mono">
                                    Error: {selectedRun.errorMessage}
                                </div>
                            )}

                            {/* Main Split: Live Feed + Todos/Artifacts */}
                            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 mt-4 flex-1">
                                {/* Event Timeline */}
                                <div className="xl:col-span-8 flex flex-col bg-slate-950/70 border border-slate-800 rounded-xl p-3 max-h-[500px]">
                                    <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-800">
                                        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                                            Live Execution Stream ({visibleEvents.length})
                                        </span>
                                        <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={showStderr}
                                                onChange={(e) => setShowStderr(e.target.checked)}
                                                className="rounded border-slate-600 bg-slate-900"
                                            />
                                            Show stderr logs
                                        </label>
                                    </div>

                                    <div className="space-y-2 overflow-y-auto flex-1 pr-1 font-mono text-xs">
                                        {visibleEvents.length === 0 ? (
                                            <div className="text-slate-500 py-6 text-center">
                                                Waiting for events...
                                            </div>
                                        ) : (
                                            visibleEvents.map((ev) => (
                                                <EventRow key={ev.seq} event={ev} />
                                            ))
                                        )}
                                        <div ref={feedBottomRef} />
                                    </div>
                                </div>

                                {/* Side Panel: Live Todos + Artifacts */}
                                <div className="xl:col-span-4 space-y-4">
                                    {/* Live Todos */}
                                    <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
                                        <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2.5">
                                            Live Todos ({latestTodos.length})
                                        </h4>
                                        {latestTodos.length === 0 ? (
                                            <p className="text-xs text-slate-500">
                                                No todo updates emitted yet.
                                            </p>
                                        ) : (
                                            <div className="space-y-2">
                                                {latestTodos.map((t, idx) => {
                                                    const isDone = t.status === 'completed';
                                                    const isProg = t.status === 'in_progress';
                                                    return (
                                                        <div
                                                            key={idx}
                                                            className="flex items-start gap-2 text-xs"
                                                        >
                                                            {isDone ? (
                                                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                                                            ) : isProg ? (
                                                                <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                                                            ) : (
                                                                <Circle className="w-3.5 h-3.5 text-slate-600 shrink-0 mt-0.5" />
                                                            )}
                                                            <span
                                                                className={
                                                                    isDone
                                                                        ? 'text-slate-400 line-through'
                                                                        : 'text-slate-200'
                                                                }
                                                            >
                                                                {t.content}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    {/* Artifacts List */}
                                    <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
                                        <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2.5">
                                            Artifacts ({artifacts.length})
                                        </h4>
                                        {artifacts.length === 0 ? (
                                            <p className="text-xs text-slate-500">
                                                Generated .md / .json outputs appear here.
                                            </p>
                                        ) : (
                                            <div className="space-y-1.5">
                                                {artifacts.map((art) => (
                                                    <button
                                                        key={art.path}
                                                        type="button"
                                                        onClick={() => openArtifact(art)}
                                                        className="w-full flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-left transition"
                                                    >
                                                        <div className="flex items-center gap-2 min-w-0">
                                                            <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                                                            <span className="text-xs font-mono text-slate-200 truncate">
                                                                {art.path}
                                                            </span>
                                                        </div>
                                                        <span className="text-[10px] font-mono text-slate-500 shrink-0">
                                                            {art.size_bytes}B
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </>
                    )}
                </div>

                {/* Artifact Drawer Modal */}
                {activeArtifact && (
                    <div className="fixed inset-0 z-50 bg-black/75 flex justify-end">
                        <div className="w-full max-w-2xl bg-slate-900 border-l border-slate-700 h-full flex flex-col shadow-2xl">
                            <div className="flex items-center justify-between p-4 border-b border-slate-800">
                                <div className="min-w-0">
                                    <h3 className="text-sm font-bold text-slate-100 font-mono truncate">
                                        {activeArtifact.meta.path}
                                    </h3>
                                    <p className="text-[11px] text-slate-400">
                                        {activeArtifact.meta.mime} • {activeArtifact.meta.size_bytes} bytes
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={copyArtifactContent}
                                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
                                    >
                                        {copiedArtifact ? (
                                            <>
                                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                                Copied
                                            </>
                                        ) : (
                                            <>
                                                <Copy className="w-3.5 h-3.5" />
                                                Copy
                                            </>
                                        )}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setActiveArtifact(null)}
                                        className="p-1.5 text-slate-400 hover:text-slate-100"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>
                            </div>

                            <div className="flex-1 overflow-y-auto p-5 bg-slate-950">
                                {activeArtifact.loading ? (
                                    <div className="flex items-center gap-2 text-xs text-slate-400">
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Loading artifact...
                                    </div>
                                ) : activeArtifact.error ? (
                                    <div className="text-xs text-rose-300">{activeArtifact.error}</div>
                                ) : (
                                    <pre className="text-xs text-slate-200 font-mono whitespace-pre-wrap leading-relaxed break-words">
                                        {activeArtifact.content}
                                    </pre>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </section>
        </div>
    );
}

function EventRow({ event }: { event: AgentRunEventDTO }) {
    const time = formatTime(event.created_at_ms);
    const p = event.payload;

    if (event.event_type === 'route_decision') {
        const isMobile = String(p.resolved_tier || '') === 'thick_mobile';
        const nodeLabel = String(p.resolved_node_name || p.resolved_node_id || 'Node');
        const reqModel = String(p.requested_model || 'mesh/auto');
        const resModel = String(p.resolved_model || '');
        const reason = String(p.routing_reason || '');

        return (
            <div className="p-2 rounded-lg bg-indigo-950/35 border border-indigo-500/30 flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-slate-500">#{event.seq}</span>
                    <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${
                            isMobile
                                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                                : 'bg-sky-500/15 text-sky-300 border-sky-500/30'
                        }`}
                    >
                        {isMobile ? '📱' : '💻'} {nodeLabel} ({reqModel})
                    </span>
                    <span className="text-[11px] text-slate-300">
                        → {resModel} <span className="text-slate-500">[{reason}]</span>
                    </span>
                </div>
                <span className="text-[10px] text-slate-500">{time}</span>
            </div>
        );
    }

    if (event.event_type === 'stderr_log') {
        return (
            <div className="px-2 py-1 text-[11px] text-slate-500 flex justify-between gap-2">
                <span className="break-all">
                    <span className="text-slate-600 mr-1.5">[stderr]</span>
                    {String(p.line ?? '')}
                </span>
                <span className="shrink-0 text-[10px] text-slate-600">{time}</span>
            </div>
        );
    }

    if (event.event_type === 'interrupt') {
        return (
            <div className="p-2 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-200 flex justify-between gap-2">
                <span>
                    ⏸ Interrupt ({String(p.kind || 'input')}):{' '}
                    {String((p.payload as Record<string, unknown> | undefined)?.message || (p.payload as Record<string, unknown> | undefined)?.prompt || p.interruptId)}
                </span>
                <span className="shrink-0 text-[10px] text-amber-400/70">{time}</span>
            </div>
        );
    }

    if (event.event_type === 'interrupt_resolved') {
        return (
            <div className="p-2 rounded-lg bg-emerald-950/30 border border-emerald-500/30 text-emerald-300 flex justify-between gap-2">
                <span>
                    ▶ Resumed by {String(p.resolvedByClientId || 'client')}
                </span>
                <span className="shrink-0 text-[10px] text-emerald-400/70">{time}</span>
            </div>
        );
    }

    if (event.event_type === 'artifact') {
        return (
            <div className="p-2 rounded-lg bg-sky-950/30 border border-sky-500/30 text-sky-200 flex justify-between gap-2">
                <span>
                    📄 Artifact written: {String(p.path || '')} ({String(p.size_bytes ?? 0)}B)
                </span>
                <span className="shrink-0 text-[10px] text-sky-400/70">{time}</span>
            </div>
        );
    }

    if (event.event_type === 'status') {
        return (
            <div className="p-2 rounded-lg bg-slate-900 border border-slate-800 text-slate-300 flex justify-between gap-2">
                <span>
                    ● Status: <strong className="text-slate-100">{String(p.status || p.message || 'update')}</strong>
                    {p.final_answer ? ` — ${String(p.final_answer).slice(0, 180)}` : ''}
                    {p.error ? ` — ${String(p.error)}` : ''}
                </span>
                <span className="shrink-0 text-[10px] text-slate-500">{time}</span>
            </div>
        );
    }

    // node_step / todo_update fallback
    return (
        <div className="p-2 rounded-lg bg-slate-900/70 border border-slate-800/70 text-slate-300 flex justify-between gap-2">
            <span className="break-words">
                <span className="text-indigo-400 mr-1.5">
                    [{String(p.node || event.event_type)}]
                </span>
                {event.event_type === 'todo_update'
                    ? `Updated ${Array.isArray(p.todos) ? p.todos.length : 0} todo item(s)`
                    : String(p.summary || JSON.stringify(p))}
            </span>
            <span className="shrink-0 text-[10px] text-slate-500">{time}</span>
        </div>
    );
}
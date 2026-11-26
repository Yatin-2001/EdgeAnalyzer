import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    AgentRunDTO,
    AgentRunEventDTO,
    PendingInterruptInfo,
    RegisteredAgentDTO,
    ValidationReport,
} from '../types/agentTypes';

function getDaemonHttpBase(): string {
    if (typeof window === 'undefined') return 'http://127.0.0.1:8080';
    if (window.location.port === '5173' || window.location.port === '5174') {
        return `http://${window.location.hostname}:8080`;
    }
    return window.location.origin;
}

interface PendingRpc {
    resolve: (val: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export function useAgentControlPlane() {
    const httpBase = getDaemonHttpBase();

    const [agents, setAgents] = useState<RegisteredAgentDTO[]>([]);
    const [runsByAgent, setRunsByAgent] = useState<Record<string, AgentRunDTO[]>>({});
    const [waitingRuns, setWaitingRuns] = useState<AgentRunDTO[]>([]);
    const [eventsByRun, setEventsByRun] = useState<Record<string, AgentRunEventDTO[]>>({});
    const [wsConnected, setWsConnected] = useState(false);
    const [originClientId, setOriginClientId] = useState<string>('admin_ui:local');
    const [authToken, setAuthToken] = useState<string>('');
    const [lastBannerInterrupt, setLastBannerInterrupt] = useState<{
        runId: string;
        interrupt: PendingInterruptInfo;
    } | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const pendingRpcsRef = useRef<Map<string, PendingRpc>>(new Map());
    const authTokenRef = useRef<string>('');
    const originClientIdRef = useRef<string>('admin_ui:local');
    const activeAgentIdRef = useRef<string | null>(null);
    const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const buildHeaders = useCallback((extra?: Record<string, string>): Record<string, string> => {
        const headers: Record<string, string> = { ...extra };
        if (authTokenRef.current) {
            headers.Authorization = `Bearer ${authTokenRef.current}`;
        }
        return headers;
    }, []);

    const refreshCatalog = useCallback(async () => {
        try {
            const res = await fetch(`${httpBase}/api/v1/agents`, { headers: buildHeaders() });
            if (res.ok) {
                const data = (await res.json()) as { agents?: RegisteredAgentDTO[] };
                if (Array.isArray(data.agents)) setAgents(data.agents);
            }
        } catch {}
    }, [httpBase, buildHeaders]);

    const refreshWaitingRuns = useCallback(async () => {
        try {
            const res = await fetch(
                `${httpBase}/api/v1/agents/runs?limit=20&status=WAITING_FOR_INPUT`,
                { headers: buildHeaders() }
            );
            if (res.ok) {
                const data = (await res.json()) as { runs?: AgentRunDTO[] };
                if (Array.isArray(data.runs)) setWaitingRuns(data.runs);
            }
        } catch {}
    }, [httpBase, buildHeaders]);

    const refreshAgentRuns = useCallback(
        async (agentId: string, limit = 30) => {
            if (!agentId) return;
            try {
                const qs = new URLSearchParams({
                    limit: String(limit),
                    agentId,
                });
                const res = await fetch(`${httpBase}/api/v1/agents/runs?${qs.toString()}`, {
                    headers: buildHeaders(),
                });
                if (res.ok) {
                    const data = (await res.json()) as { runs?: AgentRunDTO[] };
                    if (Array.isArray(data.runs)) {
                        setRunsByAgent((prev) => ({
                            ...prev,
                            [agentId]: data.runs!,
                        }));
                    }
                }
            } catch {}
        },
        [httpBase, buildHeaders]
    );

    const setActiveAgentId = useCallback(
        (agentId: string | null) => {
            activeAgentIdRef.current = agentId;
            if (agentId) {
                refreshAgentRuns(agentId);
            }
        },
        [refreshAgentRuns]
    );

    const upsertRunInState = useCallback((run: AgentRunDTO) => {
        setRunsByAgent((prev) => {
            const existing = prev[run.agentId] ?? [];
            const idx = existing.findIndex((r) => r.runId === run.runId);
            const nextList =
                idx === -1
                    ? [run, ...existing]
                    : existing.map((r, i) => (i === idx ? run : r));
            return { ...prev, [run.agentId]: nextList };
        });

        setWaitingRuns((prev) => {
            const filtered = prev.filter((r) => r.runId !== run.runId);
            return run.status === 'WAITING_FOR_INPUT' ? [run, ...filtered] : filtered;
        });
    }, []);

    const loadRunEvents = useCallback(
        async (runId: string, afterSeq = 0): Promise<AgentRunDTO | null> => {
            try {
                const res = await fetch(
                    `${httpBase}/api/v1/agents/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}`,
                    { headers: buildHeaders() }
                );
                if (!res.ok) return null;
                const data = (await res.json()) as {
                    run: AgentRunDTO;
                    events: AgentRunEventDTO[];
                };

                if (data.run) {
                    upsertRunInState(data.run);
                }

                if (Array.isArray(data.events) && data.events.length > 0) {
                    setEventsByRun((prev) => {
                        const existing = prev[runId] ?? [];
                        const bySeq = new Map<number, AgentRunEventDTO>();
                        for (const e of existing) bySeq.set(e.seq, e);
                        for (const e of data.events) bySeq.set(e.seq, e);
                        const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
                        return { ...prev, [runId]: merged };
                    });
                } else {
                    setEventsByRun((prev) => (prev[runId] ? prev : { ...prev, [runId]: [] }));
                }

                return data.run ?? null;
            } catch {
                return null;
            }
        },
        [httpBase, buildHeaders, upsertRunInState]
    );

    const sendWsRpc = useCallback(
        <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
            return new Promise((resolve, reject) => {
                const ws = wsRef.current;
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    reject(new Error('Admin WebSocket not connected'));
                    return;
                }
                const id = `rpc_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
                const timer = setTimeout(() => {
                    pendingRpcsRef.current.delete(id);
                    reject(new Error(`RPC ${method} timed out`));
                }, 15000);

                pendingRpcsRef.current.set(id, {
                    resolve: resolve as (val: unknown) => void,
                    reject,
                    timer,
                });

                ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
            });
        },
        []
    );

    // Connect loopback WebSocket using ephemeral token from GET /api/v1/admin/ws-token
    useEffect(() => {
        let disposed = false;

        const connect = async () => {
            if (disposed) return;
            try {
                const tokenRes = await fetch(`${httpBase}/api/v1/admin/ws-token`);
                if (!tokenRes.ok) {
                    throw new Error(`ws-token HTTP ${tokenRes.status}`);
                }
                const issued = (await tokenRes.json()) as {
                    token: string;
                    sessionId: string;
                    originClientId: string;
                };
                if (disposed) return;

                authTokenRef.current = issued.token;
                originClientIdRef.current = issued.originClientId;
                setAuthToken(issued.token);
                setOriginClientId(issued.originClientId);

                await Promise.all([
                    refreshCatalog(),
                    refreshWaitingRuns(),
                    ...(activeAgentIdRef.current
                        ? [refreshAgentRuns(activeAgentIdRef.current)]
                        : []),
                ]);

                const wsBase = httpBase.replace(/^http/i, 'ws');
                const ws = new WebSocket(
                    `${wsBase}/mcp?token=${encodeURIComponent(issued.token)}`
                );
                wsRef.current = ws;

                ws.onopen = () => {
                    if (disposed) {
                        ws.close();
                        return;
                    }
                    setWsConnected(true);
                    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
                    heartbeatTimerRef.current = setInterval(() => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
                        }
                    }, 10000);
                };

                ws.onmessage = (evt) => {
                    try {
                        const msg = JSON.parse(String(evt.data));

                        if (msg.id && pendingRpcsRef.current.has(String(msg.id))) {
                            const pending = pendingRpcsRef.current.get(String(msg.id))!;
                            pendingRpcsRef.current.delete(String(msg.id));
                            clearTimeout(pending.timer);
                            if (msg.error) {
                                pending.reject(
                                    new Error(msg.error.message || 'WebSocket RPC error')
                                );
                            } else {
                                pending.resolve(msg.result);
                            }
                            return;
                        }

                        if (
                            msg.method === 'agent.catalog_updated' &&
                            Array.isArray(msg.params?.agents)
                        ) {
                            setAgents(msg.params.agents as RegisteredAgentDTO[]);
                            return;
                        }

                        if (msg.method === 'agent.run_event' && msg.params?.runId) {
                            const eventDto = msg.params as AgentRunEventDTO;
                            setEventsByRun((prev) => {
                                const list = prev[eventDto.runId] ?? [];
                                if (list.some((e) => e.seq === eventDto.seq)) return prev;
                                const next = [...list, eventDto].sort((a, b) => a.seq - b.seq);
                                return { ...prev, [eventDto.runId]: next };
                            });

                            if (
                                eventDto.event_type === 'status' ||
                                eventDto.event_type === 'artifact'
                            ) {
                                refreshWaitingRuns();
                                if (activeAgentIdRef.current) {
                                    refreshAgentRuns(activeAgentIdRef.current);
                                }
                            }
                            return;
                        }

                        if (msg.method === 'agent.run_interrupt' && msg.params?.runId) {
                            const p = msg.params as {
                                runId: string;
                                interruptId: string;
                                kind: 'hitl_approval' | 'user_input';
                                payload: Record<string, unknown>;
                                response_schema?: Record<string, unknown> | null;
                                priorityTargetClientId?: string;
                            };
                            const info: PendingInterruptInfo = {
                                interruptId: p.interruptId,
                                kind: p.kind,
                                payload: p.payload,
                                response_schema: p.response_schema ?? null,
                                priorityTargetClientId: p.priorityTargetClientId,
                            };

                            setRunsByAgent((prev) => {
                                const next: Record<string, AgentRunDTO[]> = {};
                                for (const [aid, list] of Object.entries(prev)) {
                                    next[aid] = list.map((r) =>
                                        r.runId === p.runId
                                            ? {
                                                ...r,
                                                status: 'WAITING_FOR_INPUT',
                                                pendingInterruptId: p.interruptId,
                                                pendingInterrupt: info,
                                            }
                                            : r
                                    );
                                }
                                return next;
                            });
                            setLastBannerInterrupt({ runId: p.runId, interrupt: info });
                            refreshWaitingRuns();
                            if (activeAgentIdRef.current) {
                                refreshAgentRuns(activeAgentIdRef.current);
                            }
                            return;
                        }

                        if (msg.method === 'agent.run_resumed' && msg.params?.runId) {
                            const p = msg.params as { runId: string; interruptId: string };
                            setRunsByAgent((prev) => {
                                const next: Record<string, AgentRunDTO[]> = {};
                                for (const [aid, list] of Object.entries(prev)) {
                                    next[aid] = list.map((r) =>
                                        r.runId === p.runId
                                            ? {
                                                ...r,
                                                status: 'RUNNING',
                                                pendingInterruptId: null,
                                                pendingInterrupt: null,
                                            }
                                            : r
                                    );
                                }
                                return next;
                            });
                            setWaitingRuns((prev) => prev.filter((r) => r.runId !== p.runId));
                            setLastBannerInterrupt((prev) =>
                                prev?.runId === p.runId ? null : prev
                            );
                            return;
                        }
                    } catch {}
                };

                ws.onclose = () => {
                    setWsConnected(false);
                    if (heartbeatTimerRef.current) {
                        clearInterval(heartbeatTimerRef.current);
                        heartbeatTimerRef.current = null;
                    }
                    if (!disposed) {
                        reconnectTimerRef.current = setTimeout(connect, 3000);
                    }
                };

                ws.onerror = () => {
                    ws.close();
                };
            } catch {
                setWsConnected(false);
                await Promise.all([refreshCatalog(), refreshWaitingRuns()]);
                if (!disposed) {
                    reconnectTimerRef.current = setTimeout(connect, 4000);
                }
            }
        };

        connect();

        return () => {
            disposed = true;
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
            wsRef.current?.close();
            for (const pending of pendingRpcsRef.current.values()) {
                clearTimeout(pending.timer);
            }
            pendingRpcsRef.current.clear();
        };
    }, [httpBase, refreshCatalog, refreshWaitingRuns, refreshAgentRuns]);

    // =========================================================================
    // Registry Actions
    // =========================================================================

    const registerFolder = useCallback(
        async (
            folderPath: string
        ): Promise<{
            agent?: RegisteredAgentDTO;
            validationReport?: ValidationReport;
            error?: string;
        }> => {
            const res = await fetch(`${httpBase}/api/v1/agents/register`, {
                method: 'POST',
                headers: buildHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ folderPath }),
            });
            const data = (await res.json().catch(() => ({}))) as {
                agent?: RegisteredAgentDTO;
                validationReport?: ValidationReport;
                error?: string;
            };
            await refreshCatalog();
            if (!res.ok && !data.validationReport) {
                return { error: data.error || `Registration failed (HTTP ${res.status})` };
            }
            return data;
        },
        [httpBase, buildHeaders, refreshCatalog]
    );

    const revalidateAgent = useCallback(
        async (
            agentId: string
        ): Promise<{
            agent?: RegisteredAgentDTO;
            validationReport?: ValidationReport;
            error?: string;
        }> => {
            const res = await fetch(
                `${httpBase}/api/v1/agents/${encodeURIComponent(agentId)}/revalidate`,
                { method: 'POST', headers: buildHeaders() }
            );
            const data = (await res.json().catch(() => ({}))) as {
                agent?: RegisteredAgentDTO;
                validationReport?: ValidationReport;
                error?: string;
            };
            await refreshCatalog();
            return data;
        },
        [httpBase, buildHeaders, refreshCatalog]
    );

    const removeAgent = useCallback(
        async (agentId: string): Promise<boolean> => {
            const res = await fetch(
                `${httpBase}/api/v1/agents/${encodeURIComponent(agentId)}`,
                { method: 'DELETE', headers: buildHeaders() }
            );
            await Promise.all([refreshCatalog(), refreshWaitingRuns()]);
            return res.ok;
        },
        [httpBase, buildHeaders, refreshCatalog, refreshWaitingRuns]
    );

    // =========================================================================
    // Run Lifecycle Actions (WS RPC with REST fallback)
    // =========================================================================

    const startRun = useCallback(
        async (
            agentId: string,
            inputs: Record<string, unknown>
        ): Promise<{ runId: string; traceId: string; sessionId: string }> => {
            let started: { runId: string; traceId: string; sessionId: string };
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                started = await sendWsRpc<{ runId: string; traceId: string; sessionId: string }>(
                    'agent.run_start',
                    {
                        agentId,
                        inputs,
                        originClientId: originClientIdRef.current,
                    }
                );
            } else {
                const res = await fetch(`${httpBase}/api/v1/agents/runs`, {
                    method: 'POST',
                    headers: buildHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        agentId,
                        inputs,
                        originClientId: originClientIdRef.current,
                    }),
                });
                const data = (await res.json()) as {
                    runId?: string;
                    traceId?: string;
                    sessionId?: string;
                    error?: string;
                };
                if (!res.ok || !data.runId) {
                    throw new Error(data.error || `Failed to launch run (HTTP ${res.status})`);
                }
                started = {
                    runId: data.runId,
                    traceId: data.traceId || '',
                    sessionId: data.sessionId || '',
                };
            }

            activeAgentIdRef.current = agentId;
            await refreshAgentRuns(agentId);
            await loadRunEvents(started.runId, 0);
            return started;
        },
        [httpBase, buildHeaders, sendWsRpc, refreshAgentRuns, loadRunEvents]
    );

    const resumeRun = useCallback(
        async (
            runId: string,
            interruptId: string,
            resume: unknown
        ): Promise<{ ok: boolean; error?: string }> => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                return await sendWsRpc<{ ok: boolean; error?: string }>('agent.run_resume', {
                    runId,
                    interruptId,
                    resume,
                });
            }
            const res = await fetch(
                `${httpBase}/api/v1/agents/runs/${encodeURIComponent(runId)}/resume`,
                {
                    method: 'POST',
                    headers: buildHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ interruptId, resume }),
                }
            );
            return (await res.json()) as { ok: boolean; error?: string };
        },
        [httpBase, buildHeaders, sendWsRpc]
    );

    const cancelRun = useCallback(
        async (runId: string): Promise<{ ok: boolean; cancelled?: boolean }> => {
            let result: { ok: boolean; cancelled?: boolean };
            if (wsRef.current?.readyState === WebSocket.OPEN) {
                result = await sendWsRpc<{ ok: boolean; cancelled?: boolean }>(
                    'agent.run_cancel',
                    { runId }
                );
            } else {
                const res = await fetch(
                    `${httpBase}/api/v1/agents/runs/${encodeURIComponent(runId)}/cancel`,
                    { method: 'POST', headers: buildHeaders() }
                );
                result = (await res.json()) as { ok: boolean; cancelled?: boolean };
            }
            await refreshWaitingRuns();
            if (activeAgentIdRef.current) {
                await refreshAgentRuns(activeAgentIdRef.current);
            }
            return result;
        },
        [httpBase, buildHeaders, sendWsRpc, refreshWaitingRuns, refreshAgentRuns]
    );

    const fetchArtifactText = useCallback(
        async (runId: string, relPath: string): Promise<string> => {
            const encodedPath = relPath
                .split('/')
                .map((seg) => encodeURIComponent(seg))
                .join('/');
            const res = await fetch(
                `${httpBase}/api/v1/agents/runs/${encodeURIComponent(runId)}/artifacts/${encodedPath}`,
                { headers: buildHeaders() }
            );
            if (!res.ok) {
                throw new Error(`Failed to load artifact (HTTP ${res.status})`);
            }
            return await res.text();
        },
        [httpBase, buildHeaders]
    );

    return {
        agents,
        runsByAgent,
        waitingRuns,
        eventsByRun,
        wsConnected,
        originClientId,
        authToken,
        lastBannerInterrupt,
        dismissBannerInterrupt: () => setLastBannerInterrupt(null),
        setActiveAgentId,
        refreshCatalog,
        refreshAgentRuns,
        refreshWaitingRuns,
        loadRunEvents,
        registerFolder,
        revalidateAgent,
        removeAgent,
        startRun,
        resumeRun,
        cancelRun,
        fetchArtifactText,
    };
}
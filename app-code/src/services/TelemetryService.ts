import {
    insertTelemetrySpan,
    getUnsyncedTelemetrySpans,
    getUnsyncedSpanCount,
    markTelemetrySpansSynced,
    getTelemetrySpansBySession,
    getTelemetrySessionSummaries,
    getTelemetrySpansForSession,
    pruneTelemetrySpans,
    TelemetrySpanRecord,
    TelemetrySessionSummary,
    ObservationType,
} from '../database/repository';
import { MeshIdentityService } from './MeshIdentityService';

export interface TraceContext {
    session_id: string;
    trace_id: string;
    parent_span_id?: string;
    initiator_device_id: string;
    target_device_id: string;
    timestamp_sent_ms: number;
    // Phase 5 Multi-Agent Extensibility:
    agent_role?: string;
    delegation_depth?: number;
}

export interface ActiveSpanHandle {
    spanId: string;
    traceId: string;
    sessionId: string;
    parentSpanId: string | null;
    name: string;
    observationType: ObservationType;
    targetDevice: string;
    startTimeMs: number;
    attributes: Record<string, any>;
}

export interface RemoteDesktopTaskSpans {
    queue_span_id: string;
    inference_span_id: string;
    parent_span_id: string;
    target_device: string;
    model: string;
    queue_wait_ms: number;
    ttft_ms: number;
    generation_duration_ms: number;
    tokens_per_sec: number;
    prompt_tokens: number;
    completion_tokens: number;
    vram_used_mb?: number;
}

export class TelemetryService {
    private static instance: TelemetryService;
    private isFlushing = false;
    private lastSyncedAt: number | null = null;
    private desktopCollectorReady = false;
    private activeSessionId: string = 'default_session';
    private listeners = new Set<() => void>();

    // Callback injected by MeshClientService to avoid circular dependency
    private syncTransportFn:
        | ((spans: TelemetrySpanRecord[]) => Promise<string[]>)
        | null = null;

    private constructor() {
        // Run retention & FIFO pruning on startup
        pruneTelemetrySpans().catch(() => {});
    }

    public static getInstance(): TelemetryService {
        if (!TelemetryService.instance) {
            TelemetryService.instance = new TelemetryService();
        }
        return TelemetryService.instance;
    }

    public registerSyncTransport(
        fn: (spans: TelemetrySpanRecord[]) => Promise<string[]>
    ): void {
        this.syncTransportFn = fn;
    }

    public subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private notify(): void {
        this.listeners.forEach((fn) => fn());
    }

    public setActiveSessionId(sessionId: string): void {
        if (this.activeSessionId === sessionId) return;
        this.activeSessionId = sessionId;
        this.notify();
    }

    public getActiveSessionId(): string {
        return this.activeSessionId;
    }

    public setDesktopCollectorStatus(ready: boolean): void {
        const changed = this.desktopCollectorReady !== ready;
        this.desktopCollectorReady = ready;
        if (changed) this.notify();
    }

    public isDesktopCollectorReady(): boolean {
        return this.desktopCollectorReady;
    }

    public getLastSyncedAt(): number | null {
        return this.lastSyncedAt;
    }

    /**
     * Generates a 32-char time-sortable lowercase hex trace_id (UUIDv7-style for OTLP)
     */
    public static generateTraceId(): string {
        const timeHex = Date.now().toString(16).padStart(12, '0');
        let randHex = '';
        for (let i = 0; i < 20; i++) {
            randHex += Math.floor(Math.random() * 16).toString(16);
        }
        return (timeHex + randHex).toLowerCase();
    }

    /**
     * Generates a 16-char time-sortable lowercase hex span_id (W3C/OTLP standard)
     */
    public static generateSpanId(): string {
        const timeHex = (Date.now() & 0xffffffff).toString(16).padStart(8, '0');
        let randHex = '';
        for (let i = 0; i < 8; i++) {
            randHex += Math.floor(Math.random() * 16).toString(16);
        }
        return (timeHex + randHex).toLowerCase();
    }

    public async createTurnTraceContext(
        sessionId: string,
        targetDeviceId: string,
        agentRole: string = 'orchestrator'
    ): Promise<TraceContext> {
        this.activeSessionId = sessionId;
        let initiatorId = 'local_mobile';
        try {
            const id = await MeshIdentityService.getInstance().getOrCreateIdentity();
            initiatorId = id.node_id;
        } catch {}

        return {
            session_id: sessionId,
            trace_id: TelemetryService.generateTraceId(),
            initiator_device_id: initiatorId,
            target_device_id: targetDeviceId,
            timestamp_sent_ms: Date.now(),
            agent_role: agentRole,
            delegation_depth: 0,
        };
    }

    public startSpan(params: {
        traceId: string;
        sessionId: string;
        parentSpanId?: string | null;
        name: string;
        observationType: ObservationType;
        targetDevice?: string;
        attributes?: Record<string, any>;
    }): ActiveSpanHandle {
        return {
            spanId: TelemetryService.generateSpanId(),
            traceId: params.traceId,
            sessionId: params.sessionId,
            parentSpanId: params.parentSpanId ?? null,
            name: params.name,
            observationType: params.observationType,
            targetDevice: params.targetDevice || 'local_snapdragon',
            startTimeMs: Date.now(),
            attributes: { ...(params.attributes || {}) },
        };
    }

    public async endSpan(
        handle: ActiveSpanHandle,
        result: {
            status?: 'OK' | 'ERROR';
            errorMessage?: string | null;
            ttftMs?: number | null;
            promptTokens?: number | null;
            completionTokens?: number | null;
            tokPerSec?: number | null;
            extraAttributes?: Record<string, any>;
            alreadySyncedToServer?: boolean;
        } = {}
    ): Promise<TelemetrySpanRecord> {
        const now = Date.now();
        const durationMs = Math.max(1, now - handle.startTimeMs);
        const mergedAttrs = {
            ...handle.attributes,
            ...(result.extraAttributes || {}),
        };

        const record: TelemetrySpanRecord = {
            span_id: handle.spanId,
            trace_id: handle.traceId,
            session_id: handle.sessionId,
            parent_span_id: handle.parentSpanId,
            name: handle.name,
            observation_type: handle.observationType,
            target_device: handle.targetDevice,
            duration_ms: durationMs,
            ttft_ms: result.ttftMs ?? null,
            prompt_tokens: result.promptTokens ?? null,
            completion_tokens: result.completionTokens ?? null,
            tok_per_sec: result.tokPerSec ?? null,
            status: result.status || 'OK',
            error_message: result.errorMessage ?? null,
            attributes_json: JSON.stringify(mergedAttrs),
            synced_to_server: result.alreadySyncedToServer ? 1 : 0,
            created_at: now,
        };

        await insertTelemetrySpan(record);
        this.notify();

        // Opportunistically flush outbox if Desktop collector is online
        if (this.desktopCollectorReady && !result.alreadySyncedToServer) {
            this.flushOutbox().catch(() => {});
        }

        return record;
    }

    /**
     * Ingests the coupled `desktop.queue_wait` and `desktop.ollama_inference` spans
     * returned in `mcp.task_completed` into the phone's local SQLite database so the
     * on-device Waterfall Inspector renders the full tree offline.
     * Marked with `synced_to_server = 1` because the Desktop Daemon already pushed them to Langfuse.
     */
    public async ingestRemoteDesktopSpans(
        traceId: string,
        sessionId: string,
        spans: RemoteDesktopTaskSpans
    ): Promise<void> {
        const now = Date.now();
        const dequeuedAt = now - Math.max(0, spans.generation_duration_ms);

        const queueSpan: TelemetrySpanRecord = {
            span_id: spans.queue_span_id,
            trace_id: traceId,
            session_id: sessionId,
            parent_span_id: spans.parent_span_id || null,
            name: 'desktop.queue_wait',
            observation_type: 'span',
            target_device: spans.target_device || 'desktop_supernode',
            duration_ms: Math.max(0, spans.queue_wait_ms || 0),
            ttft_ms: null,
            prompt_tokens: null,
            completion_tokens: null,
            tok_per_sec: null,
            status: 'OK',
            error_message: null,
            attributes_json: JSON.stringify({
                'remote.queue_wait_ms': spans.queue_wait_ms,
                'remote.worker_device_id': spans.target_device,
            }),
            synced_to_server: 1,
            created_at: dequeuedAt,
        };

        const inferenceSpan: TelemetrySpanRecord = {
            span_id: spans.inference_span_id,
            trace_id: traceId,
            session_id: sessionId,
            parent_span_id: spans.queue_span_id,
            name: 'desktop.ollama_inference',
            observation_type: 'generation',
            target_device: spans.target_device || 'desktop_supernode',
            duration_ms: Math.max(1, spans.generation_duration_ms || 1),
            ttft_ms: spans.ttft_ms ?? null,
            prompt_tokens: spans.prompt_tokens ?? null,
            completion_tokens: spans.completion_tokens ?? null,
            tok_per_sec: spans.tokens_per_sec ?? null,
            status: 'OK',
            error_message: null,
            attributes_json: JSON.stringify({
                'gen_ai.system': 'ollama',
                'gen_ai.request.model': spans.model,
                'gen_ai.usage.prompt_tokens': spans.prompt_tokens,
                'gen_ai.usage.completion_tokens': spans.completion_tokens,
                'performance.ttft_ms': spans.ttft_ms,
                'performance.tok_per_sec': spans.tokens_per_sec,
                'hardware.vram_used_mb': spans.vram_used_mb || 0,
                'remote.queue_wait_ms': spans.queue_wait_ms,
            }),
            synced_to_server: 1,
            created_at: now,
        };

        await insertTelemetrySpan(queueSpan);
        await insertTelemetrySpan(inferenceSpan);
        this.notify();
    }

    /**
     * Flushes unsynced local spans in batches of 50 to the Desktop Supernode
     */
    public async flushOutbox(): Promise<{ flushedCount: number }> {
        if (this.isFlushing || !this.syncTransportFn) {
            return { flushedCount: 0 };
        }

        this.isFlushing = true;
        let totalFlushed = 0;
        const prevReady = this.desktopCollectorReady;

        try {
            while (true) {
                const batch = await getUnsyncedTelemetrySpans(50);
                if (batch.length === 0) break;

                const ackedIds = await this.syncTransportFn(batch);
                if (!ackedIds || ackedIds.length === 0) break;

                await markTelemetrySpansSynced(ackedIds);
                totalFlushed += ackedIds.length;
                this.lastSyncedAt = Date.now();
                this.desktopCollectorReady = true;

                if (batch.length < 50) break;
            }
        } catch {
            // Desktop offline or unreachable; spans remain safely in SQLite WAL outbox
        } finally {
            this.isFlushing = false;
            if (totalFlushed > 0 || prevReady !== this.desktopCollectorReady) {
                this.notify();
            }
        }

        return { flushedCount: totalFlushed };
    }

    public async getInspectorData(sessionId?: string | null): Promise<{
        unsyncedCount: number;
        desktopReady: boolean;
        lastSyncedAt: number | null;
        spans: TelemetrySpanRecord[];
    }> {
        const [unsyncedCount, spans] = await Promise.all([
            getUnsyncedSpanCount(),
            getTelemetrySpansBySession(sessionId || this.activeSessionId, 150),
        ]);

        return {
            unsyncedCount,
            desktopReady: this.desktopCollectorReady,
            lastSyncedAt: this.lastSyncedAt,
            spans,
        };
    }

    public async getSessionSummaries(): Promise<{
        unsyncedCount: number;
        desktopReady: boolean;
        lastSyncedAt: number | null;
        activeSessionId: string;
        sessions: TelemetrySessionSummary[];
    }> {
        const [unsyncedCount, sessions] = await Promise.all([
            getUnsyncedSpanCount(),
            getTelemetrySessionSummaries(50),
        ]);

        return {
            unsyncedCount,
            desktopReady: this.desktopCollectorReady,
            lastSyncedAt: this.lastSyncedAt,
            activeSessionId: this.activeSessionId,
            sessions,
        };
    }

    public async getSessionTraceDetail(sessionId: string): Promise<{
        unsyncedCount: number;
        desktopReady: boolean;
        spans: TelemetrySpanRecord[];
    }> {
        const [unsyncedCount, spans] = await Promise.all([
            getUnsyncedSpanCount(),
            getTelemetrySpansForSession(sessionId, 500),
        ]);

        return {
            unsyncedCount,
            desktopReady: this.desktopCollectorReady,
            spans,
        };
    }
}
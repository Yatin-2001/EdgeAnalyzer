import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { OllamaBridge } from '../mcp/OllamaBridge.js';
import { LangfuseOtlpForwarder, type UnifiedTelemetrySpan } from '../telemetry/LangfuseOtlpForwarder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type TaskStatus =
    | 'QUEUED'
    | 'PROCESSING'
    | 'AWAITING_TOOL'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';

export interface SubmitTaskInput {
    task_id?: string;
    request_id?: string | number;
    session_id: string;
    trace_id: string;
    parent_span_id: string;
    client_device_id: string;
    connection_id: string;
    priority?: number; // 0: Batch/Synthesis, 1: Standard, 2: Tool Resume
    model: string;
    messages: Array<{ role: string; content: string; images?: string[] }>;
    n_predict?: number;
}

interface QueuedTaskRow {
    task_id: string;
    session_id: string;
    trace_id: string;
    parent_span_id: string;
    client_device_id: string;
    connection_id: string;
    priority: number;
    status: TaskStatus;
    model: string;
    payload_json: string;
    enqueued_at_ms: number;
    dequeued_at_ms: number | null;
    completed_at_ms: number | null;
    error_message: string | null;
}

export class DesktopTaskQueue extends EventEmitter {
    private static instance: DesktopTaskQueue;
    private db: DatabaseSync;
    private ollama = OllamaBridge.getInstance();
    private forwarder = LangfuseOtlpForwarder.getInstance();
    private connectionSockets = new Map<string, WebSocket>();
    private activeAbortControllers = new Map<string, AbortController>();
    private isProcessing = false;
    private localNodeId = 'desktop_supernode';

    private constructor() {
        super();
        const dbDir = path.resolve(__dirname, '../../db');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = path.join(dbDir, 'desktop_queue.db');
        this.db = new DatabaseSync(dbPath);

        // 1. Initialize WAL Mode & Schema per specification
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS task_queue (
                task_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                trace_id TEXT NOT NULL,
                parent_span_id TEXT NOT NULL,
                client_device_id TEXT NOT NULL,
                connection_id TEXT NOT NULL,

                priority INTEGER DEFAULT 1,
                status TEXT NOT NULL,

                model TEXT NOT NULL,
                payload_json TEXT NOT NULL,

                enqueued_at_ms INTEGER NOT NULL,
                dequeued_at_ms INTEGER,
                completed_at_ms INTEGER,

                error_message TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_task_scheduler
                ON task_queue (status, priority DESC, enqueued_at_ms ASC);
            CREATE INDEX IF NOT EXISTS idx_task_lookup
                ON task_queue (task_id, trace_id);
        `);

        // 2. Startup Orphan Detection
        this.recoverOrphanedTasks();

        // 3. Terminal Purge Cron (Every 10 minutes, delete COMPLETED/CANCELLED older than 24h)
        setInterval(() => {
            this.purgeOldTerminalTasks();
        }, 10 * 60 * 1000);
    }

    public static getInstance(): DesktopTaskQueue {
        if (!DesktopTaskQueue.instance) {
            DesktopTaskQueue.instance = new DesktopTaskQueue();
        }
        return DesktopTaskQueue.instance;
    }

    public setLocalNodeId(nodeId: string): void {
        this.localNodeId = nodeId;
    }

    public registerConnection(connectionId: string, ws: WebSocket): void {
        this.connectionSockets.set(connectionId, ws);
    }

    public unregisterConnection(connectionId: string): void {
        this.connectionSockets.delete(connectionId);
        // Cancel any QUEUED tasks tied to this dropped WebSocket connection
        try {
            const stmt = this.db.prepare(`
                UPDATE task_queue
                SET status = 'CANCELLED', completed_at_ms = ?, error_message = 'Client connection closed'
                WHERE connection_id = ? AND status = 'QUEUED'
            `);
            stmt.run(Date.now(), connectionId);
        } catch {}
    }

    private recoverOrphanedTasks(): void {
        try {
            const now = Date.now();
            const stmt = this.db.prepare(`
                UPDATE task_queue
                SET status = 'FAILED',
                    completed_at_ms = ?,
                    error_message = 'Worker restarted during execution'
                WHERE status = 'PROCESSING'
            `);
            const res = stmt.run(now);
            if (res.changes && res.changes > 0) {
                console.warn(`[DesktopTaskQueue] ⚠️ Marked ${res.changes} orphaned PROCESSING task(s) as FAILED on startup.`);
            }
        } catch (err) {
            console.error('[DesktopTaskQueue] Orphan recovery error:', err);
        }
    }

    private purgeOldTerminalTasks(): void {
        try {
            const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
            const stmt = this.db.prepare(`
                DELETE FROM task_queue
                WHERE status IN ('COMPLETED', 'CANCELLED', 'FAILED')
                  AND completed_at_ms < ?
            `);
            const res = stmt.run(cutoff24h);
            if (res.changes && res.changes > 0) {
                console.log(`[DesktopTaskQueue] 🧹 Purged ${res.changes} terminal task(s) older than 24h.`);
            }
        } catch {}
    }

    private static generateUuidV7TaskId(): string {
        const hexTime = Date.now().toString(16).padStart(12, '0');
        const rand = Math.floor(Math.random() * 0xffffff)
            .toString(16)
            .padStart(6, '0');
        return `task_${hexTime}_${rand}`;
    }

    public getQueueDepth(): number {
        const row = this.db
            .prepare(`SELECT COUNT(*) as cnt FROM task_queue WHERE status IN ('QUEUED', 'PROCESSING')`)
            .get() as { cnt: number };
        return row?.cnt || 0;
    }

    /**
     * Step 1: Enqueue a new task (or Priority-2 Resume) and return immediate ACK metadata
     */
    public enqueueTask(input: SubmitTaskInput): {
        task_id: string;
        status: 'QUEUED';
        queue_position: number;
        estimated_wait_ms: number;
    } {
        const now = Date.now();
        const taskId = input.task_id || DesktopTaskQueue.generateUuidV7TaskId();
        const priority = input.priority ?? 1;
        const payloadJson = JSON.stringify({
            messages: input.messages,
            n_predict: input.n_predict,
            request_id: input.request_id,
        });

        const existing = this.db
            .prepare(`SELECT task_id FROM task_queue WHERE task_id = ?`)
            .get(taskId) as { task_id: string } | undefined;

        if (existing) {
            // Tool Result Resumption: Promote existing AWAITING_TOOL row back to QUEUED with Priority 2
            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = 'QUEUED',
                        priority = ?,
                        parent_span_id = ?,
                        connection_id = ?,
                        payload_json = ?,
                        enqueued_at_ms = ?,
                        dequeued_at_ms = NULL,
                        completed_at_ms = NULL,
                        error_message = NULL
                    WHERE task_id = ?
                `)
                .run(priority, input.parent_span_id, input.connection_id, payloadJson, now, taskId);
        } else {
            this.db
                .prepare(`
                    INSERT INTO task_queue (
                        task_id, session_id, trace_id, parent_span_id,
                        client_device_id, connection_id, priority, status,
                        model, payload_json, enqueued_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)
                `)
                .run(
                    taskId,
                    input.session_id || 'default_session',
                    input.trace_id || `tr_${now.toString(16)}`,
                    input.parent_span_id || 'span_root',
                    input.client_device_id || 'mobile_client',
                    input.connection_id,
                    priority,
                    input.model,
                    payloadJson,
                    now
                );
        }

        const queueDepth = this.getQueueDepth();
        const estimatedWaitMs = queueDepth <= 1 ? 50 : (queueDepth - 1) * 1200;

        // Kick the single-concurrency worker loop asynchronously
        setImmediate(() => {
            this.processQueueLoop().catch((err) =>
                console.error('[DesktopTaskQueue] Consumer loop error:', err)
            );
        });

        return {
            task_id: taskId,
            status: 'QUEUED',
            queue_position: queueDepth,
            estimated_wait_ms: estimatedWaitMs,
        };
    }

    public cancelTask(taskId: string): boolean {
        const now = Date.now();
        const res = this.db
            .prepare(`
                UPDATE task_queue
                SET status = 'CANCELLED', completed_at_ms = ?, error_message = 'Cancelled by client'
                WHERE task_id = ? AND status IN ('QUEUED', 'AWAITING_TOOL')
            `)
            .run(now, taskId);

        const activeController = this.activeAbortControllers.get(taskId);
        if (activeController) {
            activeController.abort();
            this.activeAbortControllers.delete(taskId);
            return true;
        }
        return (res.changes ?? 0) > 0;
    }

    /**
     * Atomic Dequeue using BEGIN IMMEDIATE transaction per specification
     */
    private claimNextQueuedTask(): { task: QueuedTaskRow; initialDepth: number } | null {
        const initialDepth = this.getQueueDepth();
        const now = Date.now();

        this.db.exec('BEGIN IMMEDIATE');
        try {
            const candidate = this.db
                .prepare(`
                    SELECT *
                    FROM task_queue
                    WHERE status = 'QUEUED'
                    ORDER BY priority DESC, enqueued_at_ms ASC
                    LIMIT 1
                `)
                .get() as unknown as QueuedTaskRow | undefined;

            if (!candidate) {
                this.db.exec('COMMIT');
                return null;
            }

            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = 'PROCESSING', dequeued_at_ms = ?
                    WHERE task_id = ?
                `)
                .run(now, candidate.task_id);

            this.db.exec('COMMIT');
            candidate.status = 'PROCESSING';
            candidate.dequeued_at_ms = now;
            return { task: candidate, initialDepth };
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    private sendWsFrame(connectionId: string, payload: Record<string, any>): void {
        const ws = this.connectionSockets.get(connectionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    /**
     * Concurrency = 1 Consumer Loop
     */
    private async processQueueLoop(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            while (true) {
                const claimed = this.claimNextQueuedTask();
                if (!claimed) break;

                const { task, initialDepth } = claimed;
                const dequeuedAtMs = task.dequeued_at_ms || Date.now();
                const queueWaitMs = Math.max(0, dequeuedAtMs - task.enqueued_at_ms);

                let parsedPayload: {
                    messages: Array<{ role: string; content: string; images?: string[] }>;
                    n_predict?: number;
                    request_id?: string | number;
                } = { messages: [] };

                try {
                    parsedPayload = JSON.parse(task.payload_json);
                } catch {}

                const reqId = parsedPayload.request_id;
                const queueSpanId = LangfuseOtlpForwarder.generateHexSpanId();
                const inferenceSpanId = LangfuseOtlpForwarder.generateHexSpanId();

                // Emit Step 2: mcp.task_started
                const startedParams = {
                    task_id: task.task_id,
                    trace_id: task.trace_id,
                    queue_wait_ms: queueWaitMs,
                };
                this.sendWsFrame(task.connection_id, {
                    jsonrpc: '2.0',
                    method: 'mcp.task_started',
                    params: startedParams,
                });
                this.emit(`task:${task.task_id}:started`, startedParams);

                const abortController = new AbortController();
                this.activeAbortControllers.set(task.task_id, abortController);

                try {
                    const metrics = await this.ollama.streamChat(
                        task.model,
                        parsedPayload.messages || [],
                        (tokenChunk: string) => {
                            // Emit both new mcp.token_chunk and legacy mcp.stream_chunk for seamless compatibility
                            this.sendWsFrame(task.connection_id, {
                                jsonrpc: '2.0',
                                method: 'mcp.token_chunk',
                                params: {
                                    task_id: task.task_id,
                                    id: reqId,
                                    token: tokenChunk,
                                    chunk: tokenChunk,
                                },
                            });
                            this.emit(`task:${task.task_id}:token`, tokenChunk);
                        },
                        {
                            nPredict: parsedPayload.n_predict || (task.priority === 0 ? 2048 : 512),
                            signal: abortController.signal,
                        }
                    );

                    this.activeAbortControllers.delete(task.task_id);
                    const completedAtMs = Date.now();

                    // Transition to AWAITING_TOOL if model emitted a tool call, else COMPLETED
                    const nextStatus: TaskStatus = metrics.emittedToolCall ? 'AWAITING_TOOL' : 'COMPLETED';
                    this.db
                        .prepare(`
                            UPDATE task_queue
                            SET status = ?, completed_at_ms = ?
                            WHERE task_id = ?
                        `)
                        .run(nextStatus, completedAtMs, task.task_id);

                    // Construct the 2 coupled Desktop Telemetry Spans
                    const queueWaitSpan: UnifiedTelemetrySpan = {
                        span_id: queueSpanId,
                        trace_id: task.trace_id,
                        session_id: task.session_id,
                        parent_span_id: task.parent_span_id,
                        name: 'desktop.queue_wait',
                        observation_type: 'span',
                        target_device: this.localNodeId,
                        duration_ms: queueWaitMs,
                        status: 'OK',
                        attributes_json: JSON.stringify({
                            'queue.initial_depth': initialDepth,
                            'queue.priority': task.priority,
                            'queue.task_id': task.task_id,
                            'client.device_id': task.client_device_id,
                        }),
                        created_at: dequeuedAtMs,
                    };

                    const inferenceSpan: UnifiedTelemetrySpan = {
                        span_id: inferenceSpanId,
                        trace_id: task.trace_id,
                        session_id: task.session_id,
                        parent_span_id: queueSpanId,
                        name: 'desktop.ollama_inference',
                        observation_type: 'generation',
                        target_device: this.localNodeId,
                        duration_ms: metrics.generationDurationMs,
                        ttft_ms: metrics.ttftMs,
                        prompt_tokens: metrics.promptTokens,
                        completion_tokens: metrics.completionTokens,
                        tok_per_sec: metrics.tokensPerSec,
                        status: 'OK',
                        attributes_json: JSON.stringify({
                            'gen_ai.system': 'ollama',
                            'gen_ai.request.model': task.model,
                            'gen_ai.prompt': parsedPayload.messages,
                            'gen_ai.completion': metrics.fullText,
                            'gen_ai.usage.prompt_tokens': metrics.promptTokens,
                            'gen_ai.usage.completion_tokens': metrics.completionTokens,
                            'performance.ttft_ms': metrics.ttftMs,
                            'performance.tok_per_sec': metrics.tokensPerSec,
                            'hardware.vram_used_mb': metrics.vramUsedMb,
                            'remote.worker_device_id': this.localNodeId,
                            'remote.queue_wait_ms': queueWaitMs,
                            'agent.emitted_tool_call': metrics.emittedToolCall,
                        }),
                        created_at: completedAtMs,
                    };

                    // Persist & forward both spans to local Langfuse container
                    await this.forwarder.ingestSpans([queueWaitSpan, inferenceSpan]);

                    // Emit Step 3: mcp.task_completed (with spans metadata for client SQLite outbox)
                    const completionPayload = {
                        task_id: task.task_id,
                        trace_id: task.trace_id,
                        session_id: task.session_id,
                        status: nextStatus,
                        emitted_tool_call: metrics.emittedToolCall,
                        spans: {
                            queue_span_id: queueSpanId,
                            inference_span_id: inferenceSpanId,
                            parent_span_id: task.parent_span_id,
                            target_device: this.localNodeId,
                            model: task.model,
                            queue_wait_ms: queueWaitMs,
                            ttft_ms: metrics.ttftMs,
                            generation_duration_ms: metrics.generationDurationMs,
                            tokens_per_sec: metrics.tokensPerSec,
                            prompt_tokens: metrics.promptTokens,
                            completion_tokens: metrics.completionTokens,
                            vram_used_mb: metrics.vramUsedMb,
                        },
                    };

                    this.sendWsFrame(task.connection_id, {
                        jsonrpc: '2.0',
                        id: reqId,
                        method: 'mcp.task_completed',
                        params: completionPayload,
                        result: {
                            status: 'completed',
                            task_status: nextStatus,
                            task_id: task.task_id,
                            spans: completionPayload.spans,
                        },
                    });

                    this.emit(`task:${task.task_id}:completed`, completionPayload);
                } catch (err: any) {
                    this.activeAbortControllers.delete(task.task_id);
                    const failedAtMs = Date.now();
                    const isAborted = err?.name === 'AbortError';
                    const finalStatus: TaskStatus = isAborted ? 'CANCELLED' : 'FAILED';
                    const errMsg = err?.message || 'Ollama inference failure';

                    this.db
                        .prepare(`
                            UPDATE task_queue
                            SET status = ?, completed_at_ms = ?, error_message = ?
                            WHERE task_id = ?
                        `)
                        .run(finalStatus, failedAtMs, errMsg, task.task_id);

                    this.sendWsFrame(task.connection_id, {
                        jsonrpc: '2.0',
                        id: reqId,
                        method: 'mcp.task_failed',
                        params: {
                            task_id: task.task_id,
                            trace_id: task.trace_id,
                            status: finalStatus,
                            error: errMsg,
                        },
                        error: { code: -32000, message: errMsg },
                    });

                    this.emit(`task:${task.task_id}:failed`, new Error(errMsg));
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    public getRecentTasks(limit = 25): QueuedTaskRow[] {
        return this.db
            .prepare(`SELECT * FROM task_queue ORDER BY enqueued_at_ms DESC LIMIT ?`)
            .all(limit) as unknown as QueuedTaskRow[];
    }
}
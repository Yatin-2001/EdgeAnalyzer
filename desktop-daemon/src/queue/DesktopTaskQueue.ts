import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { WebSocket } from 'ws';
import { DesktopDb } from '../db/DesktopDb.js';
import { OllamaBridge } from '../mcp/OllamaBridge.js';
import { LangfuseOtlpForwarder } from '../telemetry/LangfuseOtlpForwarder.js';
import type { UnifiedTelemetrySpan } from '../telemetry/LangfuseOtlpForwarder.js';

export type TaskStatus =
    | 'QUEUED'
    | 'PROCESSING'
    | 'AWAITING_TOOL'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';

export type TaskSourceType = 'mcp_mobile' | 'openai_gateway';

export interface SubmitTaskInput {
    task_id?: string | undefined;
    request_id?: string | number | undefined;
    session_id: string;
    trace_id: string;
    parent_span_id: string;
    client_device_id: string;
    connection_id: string;
    priority?: number | undefined;
    model: string;
    messages: Array<{ role: string; content: string; images?: string[] }>;
    n_predict?: number | undefined;
}

export interface OpenAITaskEnqueueInput {
    run_id?: string | null | undefined;
    session_id: string;
    trace_id: string;
    parent_span_id?: string | null | undefined;
    client_device_id?: string | null | undefined;
    requested_model: string;
    resolved_node_id: string;
    resolved_model: string;
    routing_reason: string;
    priority?: number | undefined;
    estimated_tokens: number;
    payload_json: string;
}

export interface OpenAITaskRunContext {
    taskId: string;
    dequeuedAtMs: number;
    queueWaitMs: number;
    initialDepth: number;
    queueSpanId: string;
}

export interface QueuedTaskRow {
    task_id: string;
    source_type: TaskSourceType;
    run_id: string | null;
    session_id: string;
    trace_id: string;
    parent_span_id: string | null;
    client_device_id: string | null;
    connection_id: string | null;
    requested_model: string;
    resolved_node_id: string | null;
    resolved_model: string | null;
    routing_reason: string | null;
    priority: number;
    status: TaskStatus;
    estimated_tokens: number;
    payload_json: string;
    enqueued_at_ms: number;
    dequeued_at_ms: number | null;
    completed_at_ms: number | null;
    error_message: string | null;
}

interface PendingOpenAIHandler<T = unknown> {
    executor: (ctx: OpenAITaskRunContext) => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    abortController: AbortController;
}

export class DesktopTaskQueue extends EventEmitter {
    private static instance: DesktopTaskQueue;
    private db: DatabaseSync;
    private ollama = OllamaBridge.getInstance();
    private forwarder = LangfuseOtlpForwarder.getInstance();
    private connectionSockets = new Map<string, WebSocket>();
    private activeAbortControllers = new Map<string, AbortController>();
    private openAIHandlers = new Map<string, PendingOpenAIHandler<unknown>>();
    private isProcessing = false;
    private localNodeId = 'desktop_supernode';

    private constructor() {
        super();
        this.db = DesktopDb.getInstance().getDb();

        // Terminal Purge Cron (Every 10 minutes, delete terminal rows older than 24h)
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

    public getLocalNodeId(): string {
        return this.localNodeId;
    }

    public registerConnection(connectionId: string, ws: WebSocket): void {
        this.connectionSockets.set(connectionId, ws);
    }

    public unregisterConnection(connectionId: string): void {
        this.connectionSockets.delete(connectionId);
        try {
            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = 'CANCELLED', completed_at_ms = ?, error_message = 'Client connection closed'
                    WHERE connection_id = ? AND status = 'QUEUED'
                `)
                .run(Date.now(), connectionId);
        } catch {}
    }

    private purgeOldTerminalTasks(): void {
        try {
            const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
            const res = this.db
                .prepare(`
                    DELETE FROM task_queue
                    WHERE status IN ('COMPLETED', 'CANCELLED', 'FAILED')
                      AND completed_at_ms < ?
                `)
                .run(cutoff24h);
            if (res.changes && Number(res.changes) > 0) {
                console.log(`[DesktopTaskQueue] 🧹 Purged ${res.changes} terminal task(s) older than 24h.`);
            }
        } catch {}
    }

    /**
     * Local GPU queue depth (counts only tasks targeting this daemon's local Ollama GPU)
     */
    public getQueueDepth(): number {
        const row = this.db
            .prepare(`
                SELECT COUNT(*) as cnt
                FROM task_queue
                WHERE status IN ('QUEUED', 'PROCESSING')
                  AND (resolved_node_id IS NULL OR resolved_node_id = ?)
            `)
            .get(this.localNodeId) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
    }

    /**
     * MVP 3 Mobile MCP Enqueue (source_type = 'mcp_mobile')
     */
    public enqueueTask(input: SubmitTaskInput): {
        task_id: string;
        status: 'QUEUED';
        queue_position: number;
        estimated_wait_ms: number;
    } {
        const now = Date.now();
        const taskId = input.task_id || DesktopDb.generateUuidV7('task');
        const priority = input.priority ?? 1;
        const payloadJson = JSON.stringify({
            messages: input.messages,
            n_predict: input.n_predict,
            request_id: input.request_id,
        });
        const estimatedTokens = Math.ceil(JSON.stringify(input.messages).length / 3.8);

        const existing = this.db
            .prepare(`SELECT task_id FROM task_queue WHERE task_id = ?`)
            .get(taskId) as { task_id: string } | undefined;

        if (existing) {
            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = 'QUEUED',
                        priority = ?,
                        parent_span_id = ?,
                        connection_id = ?,
                        payload_json = ?,
                        estimated_tokens = ?,
                        enqueued_at_ms = ?,
                        dequeued_at_ms = NULL,
                        completed_at_ms = NULL,
                        error_message = NULL
                    WHERE task_id = ?
                `)
                .run(
                    priority,
                    input.parent_span_id,
                    input.connection_id,
                    payloadJson,
                    estimatedTokens,
                    now,
                    taskId
                );
        } else {
            this.db
                .prepare(`
                    INSERT INTO task_queue (
                        task_id, source_type, run_id, session_id, trace_id, parent_span_id,
                        client_device_id, connection_id, requested_model, resolved_node_id,
                        resolved_model, routing_reason, priority, status, estimated_tokens,
                        payload_json, enqueued_at_ms
                    ) VALUES (?, 'mcp_mobile', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'direct_mcp', ?, 'QUEUED', ?, ?, ?)
                `)
                .run(
                    taskId,
                    input.session_id || 'default_session',
                    input.trace_id || `tr_${now.toString(16)}`,
                    input.parent_span_id || 'span_root',
                    input.client_device_id || 'mobile_client',
                    input.connection_id,
                    input.model,
                    this.localNodeId,
                    input.model,
                    priority,
                    estimatedTokens,
                    payloadJson,
                    now
                );
        }

        const queueDepth = this.getQueueDepth();
        const estimatedWaitMs = queueDepth <= 1 ? 50 : (queueDepth - 1) * 1200;

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

    /**
     * MVP 4 OpenAI Gateway Local Execution (source_type = 'openai_gateway', serialized Concurrency = 1)
     */
    public enqueueLocalOpenAITask<T>(
        input: OpenAITaskEnqueueInput,
        executor: (ctx: OpenAITaskRunContext) => Promise<T>,
        externalSignal?: AbortSignal
    ): { taskId: string; promise: Promise<T> } {
        const now = Date.now();
        const taskId = DesktopDb.generateUuidV7('task');
        const priority = input.priority ?? 1;

        this.db
            .prepare(`
                INSERT INTO task_queue (
                    task_id, source_type, run_id, session_id, trace_id, parent_span_id,
                    client_device_id, connection_id, requested_model, resolved_node_id,
                    resolved_model, routing_reason, priority, status, estimated_tokens,
                    payload_json, enqueued_at_ms
                ) VALUES (?, 'openai_gateway', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)
            `)
            .run(
                taskId,
                input.run_id ?? null,
                input.session_id,
                input.trace_id,
                input.parent_span_id ?? null,
                input.client_device_id ?? null,
                input.requested_model,
                input.resolved_node_id,
                input.resolved_model,
                input.routing_reason,
                priority,
                input.estimated_tokens,
                input.payload_json,
                now
            );

        const abortController = new AbortController();

        const promise = new Promise<T>((resolve, reject) => {
            this.openAIHandlers.set(taskId, {
                executor: executor as (ctx: OpenAITaskRunContext) => Promise<unknown>,
                resolve: resolve as (val: unknown) => void,
                reject,
                abortController,
            });

            if (externalSignal) {
                const onAbort = () => {
                    this.cancelTask(taskId);
                    reject(new Error('Client disconnected'));
                };
                if (externalSignal.aborted) {
                    onAbort();
                    return;
                }
                externalSignal.addEventListener('abort', onAbort, { once: true });
            }

            setImmediate(() => {
                this.processQueueLoop().catch((err) =>
                    console.error('[DesktopTaskQueue] Consumer loop error:', err)
                );
            });
        });

        return { taskId, promise };
    }

    /**
     * Records a remote OpenAI Gateway task (routed to Mobile Worker or Federated Sibling Desktop)
     * in task_queue without blocking the local RTX 3060 GPU queue.
     */
    public recordRemoteTaskStart(input: OpenAITaskEnqueueInput): string {
        const now = Date.now();
        const taskId = DesktopDb.generateUuidV7('task');
        this.db
            .prepare(`
                INSERT INTO task_queue (
                    task_id, source_type, run_id, session_id, trace_id, parent_span_id,
                    client_device_id, connection_id, requested_model, resolved_node_id,
                    resolved_model, routing_reason, priority, status, estimated_tokens,
                    payload_json, enqueued_at_ms, dequeued_at_ms
                ) VALUES (?, 'openai_gateway', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'PROCESSING', ?, ?, ?, ?)
            `)
            .run(
                taskId,
                input.run_id ?? null,
                input.session_id,
                input.trace_id,
                input.parent_span_id ?? null,
                input.client_device_id ?? null,
                input.requested_model,
                input.resolved_node_id,
                input.resolved_model,
                input.routing_reason,
                input.priority ?? 1,
                input.estimated_tokens,
                input.payload_json,
                now,
                now
            );
        return taskId;
    }

    public finishRemoteTask(
        taskId: string,
        status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
        errorMessage?: string
    ): void {
        try {
            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = ?, completed_at_ms = ?, error_message = ?
                    WHERE task_id = ?
                `)
                .run(status, Date.now(), errorMessage ?? null, taskId);
        } catch {}
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

        const handler = this.openAIHandlers.get(taskId);
        if (handler) {
            handler.abortController.abort();
            this.openAIHandlers.delete(taskId);
        }

        const activeController = this.activeAbortControllers.get(taskId);
        if (activeController) {
            activeController.abort();
            this.activeAbortControllers.delete(taskId);
            return true;
        }
        return Number(res.changes ?? 0) > 0;
    }

    /**
     * Atomic Dequeue using BEGIN IMMEDIATE transaction (Local GPU tasks only)
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
                      AND (resolved_node_id IS NULL OR resolved_node_id = ?)
                    ORDER BY priority DESC, enqueued_at_ms ASC
                    LIMIT 1
                `)
                .get(this.localNodeId) as unknown as QueuedTaskRow | undefined;

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

    private sendWsFrame(connectionId: string | null, payload: Record<string, unknown>): void {
        if (!connectionId) return;
        const ws = this.connectionSockets.get(connectionId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    /**
     * Unified Concurrency = 1 GPU Consumer Loop
     */
    private async processQueueLoop(): Promise<void> {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            while (true) {
                const claimed = this.claimNextQueuedTask();
                if (!claimed) break;

                const { task, initialDepth } = claimed;
                const dequeuedAtMs = task.dequeued_at_ms ?? Date.now();
                const queueWaitMs = Math.max(0, dequeuedAtMs - task.enqueued_at_ms);

                if (task.source_type === 'openai_gateway') {
                    await this.executeOpenAIGatewayTask(task, dequeuedAtMs, queueWaitMs, initialDepth);
                } else {
                    await this.executeMcpMobileTask(task, dequeuedAtMs, queueWaitMs, initialDepth);
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    private async executeOpenAIGatewayTask(
        task: QueuedTaskRow,
        dequeuedAtMs: number,
        queueWaitMs: number,
        initialDepth: number
    ): Promise<void> {
        const handler = this.openAIHandlers.get(task.task_id);
        this.openAIHandlers.delete(task.task_id);

        if (!handler) {
            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = 'CANCELLED', completed_at_ms = ?, error_message = 'No active HTTP caller'
                    WHERE task_id = ?
                `)
                .run(Date.now(), task.task_id);
            return;
        }

        const queueSpanId = LangfuseOtlpForwarder.generateHexSpanId();
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
                'queue.source_type': 'openai_gateway',
                'mesh.routing_reason': task.routing_reason,
            }),
            created_at: dequeuedAtMs,
        };

        this.forwarder.ingestSpans([queueWaitSpan]).catch(() => {});
        this.activeAbortControllers.set(task.task_id, handler.abortController);

        try {
            const result = await handler.executor({
                taskId: task.task_id,
                dequeuedAtMs,
                queueWaitMs,
                initialDepth,
                queueSpanId,
            });
            this.activeAbortControllers.delete(task.task_id);

            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = 'COMPLETED', completed_at_ms = ?
                    WHERE task_id = ?
                `)
                .run(Date.now(), task.task_id);

            handler.resolve(result);
        } catch (err: unknown) {
            this.activeAbortControllers.delete(task.task_id);
            const errorObj = err as Error | undefined;
            const isAborted = errorObj?.name === 'AbortError' || handler.abortController.signal.aborted;
            const finalStatus: TaskStatus = isAborted ? 'CANCELLED' : 'FAILED';
            const errMsg = errorObj?.message || 'OpenAI gateway execution failed';

            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = ?, completed_at_ms = ?, error_message = ?
                    WHERE task_id = ?
                `)
                .run(finalStatus, Date.now(), errMsg, task.task_id);

            handler.reject(err);
        }
    }

    private async executeMcpMobileTask(
        task: QueuedTaskRow,
        dequeuedAtMs: number,
        queueWaitMs: number,
        initialDepth: number
    ): Promise<void> {
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
        const targetModel = task.resolved_model || task.requested_model;

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
                targetModel,
                parsedPayload.messages ?? [],
                (tokenChunk: string) => {
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
                    nPredict: parsedPayload.n_predict ?? (task.priority === 0 ? 2048 : 512),
                    signal: abortController.signal,
                }
            );

            this.activeAbortControllers.delete(task.task_id);
            const completedAtMs = Date.now();
            const nextStatus: TaskStatus = metrics.emittedToolCall ? 'AWAITING_TOOL' : 'COMPLETED';

            this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = ?, completed_at_ms = ?
                    WHERE task_id = ?
                `)
                .run(nextStatus, completedAtMs, task.task_id);

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
                    'queue.source_type': 'mcp_mobile',
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
                    'gen_ai.request.model': targetModel,
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

            await this.forwarder.ingestSpans([queueWaitSpan, inferenceSpan]);

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
                    model: targetModel,
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
        } catch (err: unknown) {
            this.activeAbortControllers.delete(task.task_id);
            const failedAtMs = Date.now();
            const errorObj = err as Error | undefined;
            const isAborted = errorObj?.name === 'AbortError';
            const finalStatus: TaskStatus = isAborted ? 'CANCELLED' : 'FAILED';
            const errMsg = errorObj?.message || 'Ollama inference failure';

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

    public getRecentTasks(limit = 25): QueuedTaskRow[] {
        return this.db
            .prepare(`SELECT * FROM task_queue ORDER BY enqueued_at_ms DESC LIMIT ?`)
            .all(limit) as unknown as QueuedTaskRow[];
    }
}
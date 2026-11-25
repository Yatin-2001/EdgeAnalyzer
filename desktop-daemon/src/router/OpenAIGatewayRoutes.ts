import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, Router } from 'express';
import { DesktopDb } from '../db/DesktopDb.js';
import { DeviceStore } from '../mesh/DeviceStore.js';
import { OllamaBridge } from '../mcp/OllamaBridge.js';
import type { OpenAIChatRequest, OpenAIStreamChunk } from '../mcp/OllamaBridge.js';
import { DesktopTaskQueue } from '../queue/DesktopTaskQueue.js';
import { LangfuseOtlpForwarder } from '../telemetry/LangfuseOtlpForwarder.js';
import type { UnifiedTelemetrySpan } from '../telemetry/LangfuseOtlpForwarder.js';
import { ClusterStateService } from './ClusterStateService.js';
import type { ClusterNodeState } from './ClusterStateService.js';
import { HybridMeshRouter } from './HybridMeshRouter.js';
import type { AgentRoleHint, RoutingDecision } from './HybridMeshRouter.js';
import { MobileWorkerAdapter } from './MobileWorkerAdapter.js';
import { AgentRunManager } from '../agents/AgentRunManager.js';


export interface EphemeralRunTokenMeta {
    runId: string;
    traceId: string;
    sessionId: string;
    expiresAtMs: number;
}

export interface EphemeralAdminTokenMeta {
    sessionId: string;
    originClientId: string;
    expiresAtMs: number;
}

/**
 * Shared token registry for loopback Admin UI WebSockets, static dev admin key,
 * and Milestone B ephemeral Python agent run tokens (`edge_run_<runId>_<hmac>`).
 */
export class AuthTokenRegistry {
    private static instance: AuthTokenRegistry;
    private adminTokens = new Map<string, EphemeralAdminTokenMeta>();
    private runTokens = new Map<string, EphemeralRunTokenMeta>();
    private readonly staticAdminKey: string;

    private constructor() {
        this.staticAdminKey = process.env.EDGE_ADMIN_KEY || 'edge-local-admin-key';
    }

    public static getInstance(): AuthTokenRegistry {
        if (!AuthTokenRegistry.instance) {
            AuthTokenRegistry.instance = new AuthTokenRegistry();
        }
        return AuthTokenRegistry.instance;
    }

    public getStaticAdminKey(): string {
        return this.staticAdminKey;
    }

    public issueAdminToken(): { token: string; sessionId: string; originClientId: string } {
        const sessionId = crypto.randomBytes(6).toString('hex');
        const token = `edge_admin_${crypto.randomBytes(16).toString('hex')}`;
        const originClientId = `admin_ui:${sessionId}`;
        this.adminTokens.set(token, {
            sessionId,
            originClientId,
            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
        return { token, sessionId, originClientId };
    }

    public validateAdminToken(token: string): EphemeralAdminTokenMeta | null {
        const meta = this.adminTokens.get(token);
        if (!meta) return null;
        if (Date.now() > meta.expiresAtMs) {
            this.adminTokens.delete(token);
            return null;
        }
        return meta;
    }

    public issueRunToken(runId: string, traceId: string, sessionId: string, ttlMs = 3600000): string {
        const hmac = crypto
            .createHmac('sha256', this.staticAdminKey)
            .update(`${runId}:${traceId}:${Date.now()}`)
            .digest('hex')
            .slice(0, 16);
        const token = `edge_run_${runId}_${hmac}`;
        this.runTokens.set(token, {
            runId,
            traceId,
            sessionId,
            expiresAtMs: Date.now() + ttlMs,
        });
        return token;
    }

    public revokeRunToken(token: string): void {
        this.runTokens.delete(token);
    }

    public validateRunToken(token: string): EphemeralRunTokenMeta | null {
        const meta = this.runTokens.get(token);
        if (!meta) return null;
        if (Date.now() > meta.expiresAtMs) {
            this.runTokens.delete(token);
            return null;
        }
        return meta;
    }

    public isValidStaticAdminKey(token: string): boolean {
        return token.length > 0 && token === this.staticAdminKey;
    }
}

function getHeaderStr(req: Request, name: string): string | undefined {
    const raw = req.headers[name.toLowerCase()];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
    if (Array.isArray(raw) && raw[0] && raw[0].trim().length > 0) return raw[0].trim();
    return undefined;
}

function isLoopbackRemoteAddress(rawAddr: string | undefined): boolean {
    if (!rawAddr) return false;
    return rawAddr === '127.0.0.1' || rawAddr === '::1' || rawAddr === '::ffff:127.0.0.1';
}

function parseAgentRoleHeader(raw: string | undefined): AgentRoleHint | undefined {
    if (!raw) return undefined;
    const lower = raw.toLowerCase();
    if (lower === 'supervisor' || lower === 'worker' || lower === 'fast' || lower === 'vision') {
        return lower;
    }
    return undefined;
}

export function createOpenAIGatewayRouter(): Router {
    const router = express.Router();
    const deviceStore = DeviceStore.getInstance();
    const tokenRegistry = AuthTokenRegistry.getInstance();
    const cluster = ClusterStateService.getInstance();
    const meshRouter = HybridMeshRouter.getInstance();
    const taskQueue = DesktopTaskQueue.getInstance();
    const ollama = OllamaBridge.getInstance();
    const forwarder = LangfuseOtlpForwarder.getInstance();
    const db = DesktopDb.getInstance().getDb();

    // 1. Loopback-only Admin WebSocket Token Endpoint (ignores X-Forwarded-For)
    router.get('/api/v1/admin/ws-token', (req: Request, res: Response) => {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
            return res.status(403).json({
                error: 'FORBIDDEN_NON_LOOPBACK',
                message: 'Admin WS tokens are issued strictly to loopback clients.',
            });
        }
        const issued = tokenRegistry.issueAdminToken();
        return res.json(issued);
    });

    // 2. Cluster Nodes Inspection Endpoint
    router.get('/api/v1/mesh/cluster', (_req: Request, res: Response) => {
        return res.json({
            localNodeId: cluster.getLocalNodeId(),
            nodes: cluster.getGossipSnapshot(),
        });
    });

    // Shared Bearer Authentication for /v1/*
    const authenticateOpenAI = (
        req: Request
    ): {
        ok: boolean;
        clientId: string;
        runMeta?: EphemeralRunTokenMeta;
    } => {
        const authHeader = getHeaderStr(req, 'authorization');
        const bearer = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? '';

        if (!bearer) {
            return { ok: false, clientId: '' };
        }

        const runMeta = tokenRegistry.validateRunToken(bearer);
        if (runMeta) {
            return { ok: true, clientId: `agent_run:${runMeta.runId}`, runMeta };
        }

        const adminMeta = tokenRegistry.validateAdminToken(bearer);
        if (adminMeta) {
            return { ok: true, clientId: adminMeta.originClientId };
        }

        if (tokenRegistry.isValidStaticAdminKey(bearer)) {
            return { ok: true, clientId: 'admin_key' };
        }

        const pairedDev = deviceStore.getByToken(bearer);
        if (pairedDev) {
            return { ok: true, clientId: `device:${pairedDev.deviceId}` };
        }

        return { ok: false, clientId: '' };
    };

    // 3. GET /v1/models (OpenAI Compatible Model Catalog)
    router.get('/v1/models', (req: Request, res: Response) => {
        const auth = authenticateOpenAI(req);
        if (!auth.ok) {
            return res.status(401).json({
                error: { message: 'Invalid or missing Bearer token', type: 'authentication_error' },
            });
        }

        const created = Math.floor(Date.now() / 1000);
        const modelIds = new Set<string>([
            'mesh/auto',
            'mesh/supervisor',
            'mesh/heavy',
            'mesh/worker',
            'mesh/fast',
        ]);

        const nodes = cluster.getAllNodes().filter((n) => n.status !== 'offline');
        for (const node of nodes) {
            modelIds.add(`mesh/node:${node.nodeId}`);
            for (const m of node.availableModels) {
                modelIds.add(m);
                modelIds.add(`mesh/model:${m}`);
            }
        }

        return res.json({
            object: 'list',
            data: Array.from(modelIds).map((id) => ({
                id,
                object: 'model',
                created,
                owned_by: id.startsWith('mesh/') ? 'edgeanalyzer-mesh' : 'local-node',
            })),
        });
    });

    // 4. POST /v1/chat/completions (Hybrid OpenAI Gateway + Pre-Stream Failover)
    router.post('/v1/chat/completions', async (req: Request, res: Response) => {
        const auth = authenticateOpenAI(req);
        if (!auth.ok) {
            return res.status(401).json({
                error: { message: 'Invalid or missing Bearer token', type: 'authentication_error' },
            });
        }

        const body = req.body as OpenAIChatRequest | undefined;
        if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
            return res.status(400).json({
                error: { message: 'messages[] array is required', type: 'invalid_request_error' },
            });
        }

        const isStreaming = body.stream === true;
        const hopCount = parseInt(getHeaderStr(req, 'x-edge-hop-count') || '0', 10) || 0;

        // Trace & Run Correlation (Headers take precedence, else derived from ephemeral run token)
        const runId = getHeaderStr(req, 'x-edge-run-id') ?? auth.runMeta?.runId;
        const traceId =
            getHeaderStr(req, 'x-edge-trace-id') ??
            auth.runMeta?.traceId ??
            crypto.randomBytes(16).toString('hex');
        const sessionId =
            getHeaderStr(req, 'x-edge-session-id') ??
            auth.runMeta?.sessionId ??
            `openai_${Date.now()}`;
        const parentSpanId = getHeaderStr(req, 'x-edge-parent-span-id') ?? null;

        const agentRole = parseAgentRoleHeader(getHeaderStr(req, 'x-edge-agent-role'));
        const structuredHeader = getHeaderStr(req, 'x-edge-requires-structured-output');
        const requiresStructuredOutput =
            structuredHeader !== undefined ? structuredHeader.toLowerCase() === 'true' : undefined;

        const abortController = new AbortController();
        res.on('close', () => {
            if (!res.writableEnded) {
                abortController.abort();
            }
        });

        let firstChunkSent = false;
        const triedNodeIds = new Set<string>();
        const localNodeId = cluster.getLocalNodeId();

        const emitSseChunk = (chunk: OpenAIStreamChunk): void => {
            if (!firstChunkSent) {
                firstChunkSent = true;
                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders?.();
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        const emitRouteTelemetry = (decision: RoutingDecision, reasonOverride?: string): string => {
            const routeSpanId = LangfuseOtlpForwarder.generateHexSpanId();
            const effectiveReason = reasonOverride ?? decision.routingReason;

            const routeSpan: UnifiedTelemetrySpan = {
                span_id: routeSpanId,
                trace_id: traceId,
                session_id: sessionId,
                parent_span_id: parentSpanId,
                name: 'mesh.route_decision',
                observation_type: 'span',
                target_device: localNodeId,
                duration_ms: Math.max(1, Math.round(decision.routingLatencyMs)),
                status: 'OK',
                attributes_json: JSON.stringify({
                    'mesh.requested_model': body.model,
                    'mesh.resolved_node_id': decision.node.nodeId,
                    'mesh.resolved_node_name': decision.node.nodeName,
                    'mesh.resolved_model': decision.resolvedModel,
                    'mesh.routing_reason': effectiveReason,
                    'mesh.estimated_tokens': decision.estimatedInputTokens,
                    'mesh.required_ctx': decision.requiredCtx,
                    'mesh.score': decision.score,
                    'mesh.hop_count': hopCount,
                }),
                created_at: Date.now(),
            };

            forwarder.ingestSpans([routeSpan]).catch(() => {});

            if (runId) {
                try {
                    AgentRunManager.getInstance().appendEvent(runId, 'route_decision', {
                        requested_model: body.model,
                        resolved_node_id: decision.node.nodeId,
                        resolved_node_name: decision.node.nodeName,
                        resolved_tier: decision.node.tier,
                        resolved_model: decision.resolvedModel,
                        routing_reason: effectiveReason,
                        estimated_tokens: decision.estimatedInputTokens,
                    });
                } catch {}
            }

            return routeSpanId;
        };

        const maxAttempts = 3;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            let decision: RoutingDecision;
            try {
                decision = meshRouter.selectRoute(body, {
                    agentRole,
                    sessionId,
                    requiresStructuredOutput,
                    hopCount,
                    excludeNodeIds: triedNodeIds,
                });
            } catch (routeErr: unknown) {
                const msg = routeErr instanceof Error ? routeErr.message : 'No eligible node';
                return res.status(503).json({
                    error: { message: msg, type: 'service_unavailable' },
                });
            }

            const effectiveReason = attempt > 0 ? 'pre_stream_failover' : decision.routingReason;
            const routeSpanId = emitRouteTelemetry(decision, effectiveReason);
            triedNodeIds.add(decision.node.nodeId);

            try {
                // ========================================================
                // TARGET A: Local Desktop Ollama (Serialized Concurrency = 1)
                // ========================================================
                if (decision.node.nodeId === localNodeId) {
                    const { promise } = taskQueue.enqueueLocalOpenAITask(
                        {
                            run_id: runId ?? null,
                            session_id: sessionId,
                            trace_id: traceId,
                            parent_span_id: routeSpanId,
                            client_device_id: auth.clientId,
                            requested_model: body.model,
                            resolved_node_id: localNodeId,
                            resolved_model: decision.resolvedModel,
                            routing_reason: effectiveReason,
                            priority: runId ? 2 : 1,
                            estimated_tokens: decision.estimatedInputTokens,
                            payload_json: JSON.stringify({ model: body.model, stream: isStreaming }),
                        },
                        async (ctx) => {
                            const effectiveNumCtx =
                                decision.requiredCtx <= 4096 ? 4096 : decision.node.nCtx;

                            const execResult = await ollama.executeOpenAIChat({
                                resolvedModel: decision.resolvedModel,
                                request: body,
                                numCtx: effectiveNumCtx,
                                signal: abortController.signal,
                                ...(isStreaming ? { onStreamChunk: emitSseChunk } : {}),
                            });

                            cluster.recordNodeTtft(localNodeId, execResult.ttftMs);

                            const genSpan: UnifiedTelemetrySpan = {
                                span_id: LangfuseOtlpForwarder.generateHexSpanId(),
                                trace_id: traceId,
                                session_id: sessionId,
                                parent_span_id: ctx.queueSpanId,
                                name: 'desktop.ollama_inference',
                                observation_type: 'generation',
                                target_device: localNodeId,
                                duration_ms: execResult.generationDurationMs,
                                ttft_ms: execResult.ttftMs,
                                prompt_tokens: execResult.usage.prompt_tokens,
                                completion_tokens: execResult.usage.completion_tokens,
                                tok_per_sec: execResult.tokensPerSec,
                                status: 'OK',
                                attributes_json: JSON.stringify({
                                    'gen_ai.system': 'ollama',
                                    'gen_ai.request.model': execResult.model,
                                    'gen_ai.prompt': body.messages,
                                    'gen_ai.completion':
                                        execResult.fullText ||
                                        JSON.stringify(execResult.toolCalls),
                                    'hardware.vram_used_mb': execResult.vramUsedMb,
                                    'remote.queue_wait_ms': ctx.queueWaitMs,
                                    'mesh.routing_reason': effectiveReason,
                                }),
                                created_at: Date.now(),
                            };
                            forwarder.ingestSpans([genSpan]).catch(() => {});
                            return execResult;
                        },
                        abortController.signal
                    );

                    const result = await promise;

                    if (isStreaming) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                        return;
                    }

                    return res.json({
                        id: result.completionId,
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: result.model,
                        choices: [
                            {
                                index: 0,
                                message: {
                                    role: 'assistant',
                                    content: result.fullText || null,
                                    ...(result.reasoningText
                                        ? { reasoning_content: result.reasoningText }
                                        : {}),
                                    ...(result.toolCalls.length > 0
                                        ? { tool_calls: result.toolCalls }
                                        : {}),
                                },
                                finish_reason: result.finishReason,
                            },
                        ],
                        usage: result.usage,
                    });
                }

                // ========================================================
                // TARGET B: Mobile Compute Worker (Port 8765 /v1/edge/chat)
                // ========================================================
                if (decision.node.tier === 'thick_mobile') {
                    const remoteTaskId = taskQueue.recordRemoteTaskStart({
                        run_id: runId ?? null,
                        session_id: sessionId,
                        trace_id: traceId,
                        parent_span_id: routeSpanId,
                        client_device_id: auth.clientId,
                        requested_model: body.model,
                        resolved_node_id: decision.node.nodeId,
                        resolved_model: decision.resolvedModel,
                        routing_reason: effectiveReason,
                        priority: runId ? 2 : 1,
                        estimated_tokens: decision.estimatedInputTokens,
                        payload_json: JSON.stringify({ model: body.model, stream: isStreaming }),
                    });

                    try {
                        const result = await MobileWorkerAdapter.execute({
                            node: decision.node,
                            resolvedModel: decision.resolvedModel,
                            request: body,
                            traceContext: {
                                session_id: sessionId,
                                trace_id: traceId,
                                parent_span_id: routeSpanId,
                                initiator_device_id: localNodeId,
                                target_device_id: decision.node.nodeId,
                                timestamp_sent_ms: Date.now(),
                            },
                            signal: abortController.signal,
                            onStatus: (statusEvt) => {
                                if (runId) {
                                    try {
                                        AgentRunManager.getInstance().appendEvent(
                                            runId,
                                            'status',
                                            statusEvt as Record<string, unknown>
                                        );
                                    } catch {}
                                }
                            },
                            ...(isStreaming ? { onStreamChunk: emitSseChunk } : {}),
                        });

                        taskQueue.finishRemoteTask(remoteTaskId, 'COMPLETED');
                        cluster.recordNodeTtft(decision.node.nodeId, result.ttftMs);

                        const mobileGenSpan: UnifiedTelemetrySpan = {
                            span_id: LangfuseOtlpForwarder.generateHexSpanId(),
                            trace_id: traceId,
                            session_id: sessionId,
                            parent_span_id: routeSpanId,
                            name: 'mobile.worker_inference',
                            observation_type: 'generation',
                            target_device: decision.node.nodeId,
                            duration_ms: result.generationDurationMs,
                            ttft_ms: result.ttftMs,
                            prompt_tokens: result.usage.prompt_tokens,
                            completion_tokens: result.usage.completion_tokens,
                            tok_per_sec: result.tokensPerSec,
                            status: 'OK',
                            attributes_json: JSON.stringify({
                                'gen_ai.system': 'llama.rn.mobile_worker',
                                'gen_ai.request.model': result.model,
                                'gen_ai.prompt': body.messages,
                                'gen_ai.completion':
                                    result.fullText || JSON.stringify(result.toolCalls),
                                'remote.worker_device_id': decision.node.nodeId,
                                'mesh.routing_reason': effectiveReason,
                            }),
                            created_at: Date.now(),
                        };
                        forwarder.ingestSpans([mobileGenSpan]).catch(() => {});

                        if (isStreaming) {
                            res.write('data: [DONE]\n\n');
                            res.end();
                            return;
                        }

                        return res.json({
                            id: result.completionId,
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: result.model,
                            choices: [
                                {
                                    index: 0,
                                    message: {
                                        role: 'assistant',
                                        content: result.fullText || null,
                                        ...(result.reasoningText
                                            ? { reasoning_content: result.reasoningText }
                                            : {}),
                                        ...(result.toolCalls.length > 0
                                            ? { tool_calls: result.toolCalls }
                                            : {}),
                                    },
                                    finish_reason: result.finishReason,
                                },
                            ],
                            usage: result.usage,
                        });
                    } catch (mobileErr) {
                        const errMsg =
                            mobileErr instanceof Error ? mobileErr.message : String(mobileErr);
                        taskQueue.finishRemoteTask(remoteTaskId, 'FAILED', errMsg);
                        throw mobileErr;
                    }
                }

                // ========================================================
                // TARGET C: Federated Sibling Desktop Supernode (Hop Guard = 1)
                // ========================================================
                await forwardToSiblingDesktop({
                    node: decision.node,
                    localNodeId,
                    body,
                    isStreaming,
                    traceId,
                    sessionId,
                    parentSpanId: routeSpanId,
                    runId,
                    signal: abortController.signal,
                    res,
                    onFirstByte: () => {
                        firstChunkSent = true;
                    },
                });
                return;
            } catch (execErr: unknown) {
                const errMsg = execErr instanceof Error ? execErr.message : String(execErr);

                // Mid-stream failure: NEVER retry—emit clean SSE error & close
                if (firstChunkSent) {
                    if (isStreaming && !res.writableEnded) {
                        res.write(
                            `event: error\ndata: ${JSON.stringify({
                                error: { message: errMsg, type: 'stream_error' },
                            })}\n\n`
                        );
                        res.end();
                    }
                    return;
                }

                // Pre-stream failure: retry next eligible local node unless pinned or hop-guarded
                const canFailover =
                    !decision.isPinned &&
                    hopCount < 1 &&
                    !abortController.signal.aborted &&
                    attempt < maxAttempts - 1;

                if (canFailover) {
                    console.warn(
                        `[OpenAIGateway] ⚠️ Pre-stream failover from ${decision.node.nodeName} (${decision.node.nodeId}): ${errMsg}`
                    );
                    continue;
                }

                if (!res.headersSent) {
                    return res.status(502).json({
                        error: { message: errMsg, type: 'upstream_error' },
                    });
                }
                return;
            }
        }

        if (!res.headersSent) {
            return res.status(503).json({
                error: { message: 'All eligible local mesh nodes failed', type: 'service_unavailable' },
            });
        }
    });

    return router;
}

async function forwardToSiblingDesktop(params: {
    node: ClusterNodeState;
    localNodeId: string;
    body: OpenAIChatRequest;
    isStreaming: boolean;
    traceId: string;
    sessionId: string;
    parentSpanId: string;
    runId?: string | undefined;
    signal: AbortSignal;
    res: Response;
    onFirstByte: () => void;
}): Promise<void> {
    const {
        node,
        localNodeId,
        body,
        isStreaming,
        traceId,
        sessionId,
        parentSpanId,
        runId,
        signal,
        res,
        onFirstByte,
    } = params;

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${node.authToken || AuthTokenRegistry.getInstance().getStaticAdminKey()}`,
        'x-edge-forwarded-by': localNodeId,
        'x-edge-hop-count': '1',
        'x-edge-trace-id': traceId,
        'x-edge-session-id': sessionId,
        'x-edge-parent-span-id': parentSpanId,
    };
    if (runId) headers['x-edge-run-id'] = runId;

    const upstream = await fetch(`${node.endpointUrl.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        throw new Error(`Sibling desktop ${node.nodeName} returned HTTP ${upstream.status}: ${errText}`);
    }

    if (!isStreaming) {
        const json = await upstream.json();
        onFirstByte();
        res.status(200).json(json);
        return;
    }

    if (!upstream.body) {
        throw new Error(`Sibling desktop ${node.nodeName} returned empty SSE body`);
    }

    const reader = upstream.body.getReader();
    let headersWritten = false;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!headersWritten) {
            headersWritten = true;
            onFirstByte();
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders?.();
        }
        res.write(Buffer.from(value));
    }
    res.end();
}
import { WebSocket } from 'ws';
import { DesktopTaskQueue } from '../queue/DesktopTaskQueue.js';
import { LangfuseOtlpForwarder } from '../telemetry/LangfuseOtlpForwarder.js';
import { AgentRunManager } from '../agents/AgentRunManager.js';

export class MCPProtocol {
    private taskQueue = DesktopTaskQueue.getInstance();
    private telemetryForwarder = LangfuseOtlpForwarder.getInstance();
    private agentRuns = AgentRunManager.getInstance();

    public async handleMessage(
        ws: WebSocket,
        rawMessage: string,
        context: { deviceId?: string; connectionId?: string } = {}
    ): Promise<void> {
        let req: any;
        try {
            req = JSON.parse(rawMessage);
        } catch {
            return;
        }

        const { id, method, params } = req;
        const connectionId = context.connectionId || 'ws_default';
        const clientDeviceId =
            params?.trace_context?.initiator_device_id ||
            params?.client_device_id ||
            context.deviceId ||
            'mobile_client';

        // =====================================================================
        // MVP 4: Agent Control Plane WebSocket RPCs (Shared by Mobile & Admin UI)
        // =====================================================================

        if (method === 'agent.run_start') {
            const agentId = typeof params?.agentId === 'string' ? params.agentId : '';
            const inputs =
                params?.inputs && typeof params.inputs === 'object' ? params.inputs : {};
            const originClientId =
                typeof params?.originClientId === 'string' && params.originClientId.trim()
                    ? params.originClientId.trim()
                    : context.deviceId?.startsWith('admin_ui:')
                        ? context.deviceId
                        : `mobile:${clientDeviceId}`;

            if (!agentId) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32602, message: 'agentId is required' },
                        })
                    );
                }
                return;
            }

            try {
                const started = await this.agentRuns.startRun({
                    agentId,
                    inputs,
                    originClientId,
                });
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            result: started,
                        })
                    );
                }
            } catch (err: any) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32000, message: err?.message || 'Failed to start agent run' },
                        })
                    );
                }
            }
            return;
        }

        if (method === 'agent.run_resume') {
            const runId = typeof params?.runId === 'string' ? params.runId : '';
            const interruptId = typeof params?.interruptId === 'string' ? params.interruptId : '';
            const resume = params?.resume;
            const resolvedByClientId = context.deviceId?.startsWith('admin_ui:')
                ? context.deviceId
                : `mobile:${clientDeviceId}`;

            if (!runId || !interruptId) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32602, message: 'runId and interruptId are required' },
                        })
                    );
                }
                return;
            }

            const result = this.agentRuns.resumeRun({
                runId,
                interruptId,
                resume,
                resolvedByClientId,
            });
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        result,
                    })
                );
            }
            return;
        }

        if (method === 'agent.run_cancel') {
            const runId = typeof params?.runId === 'string' ? params.runId : '';
            if (!runId) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32602, message: 'runId is required' },
                        })
                    );
                }
                return;
            }

            const result = await this.agentRuns.cancelRun(runId);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        result,
                    })
                );
            }
            return;
        }

        // =====================================================================
        // MVP 3: Queued Inference & Telemetry Sync RPCs
        // =====================================================================

        // 1. Primary Queued Task Submission & Priority-2 Tool Resumption
        if (method === 'mcp.submit_task' || method === 'mcp.resume_task' || method === 'mcp.stream_chat') {
            const model = params?.model;
            const messages = params?.messages;

            if (!model || !Array.isArray(messages)) {
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32602, message: 'Invalid params: model and messages required' },
                    })
                );
                return;
            }

            const traceCtx = params?.trace_context || {};
            const sessionId = params?.session_id || traceCtx.session_id || `session_${Date.now()}`;
            const traceId = params?.trace_id || traceCtx.trace_id || `tr_${Date.now().toString(16)}`;
            const parentSpanId =
                params?.parent_span_id || traceCtx.parent_span_id || `span_client_${Date.now().toString(16)}`;

            const priority =
                method === 'mcp.resume_task'
                    ? 2
                    : typeof params?.priority === 'number'
                        ? params.priority
                        : 1;

            const ack = this.taskQueue.enqueueTask({
                task_id: params?.task_id,
                request_id: id,
                session_id: sessionId,
                trace_id: traceId,
                parent_span_id: parentSpanId,
                client_device_id: clientDeviceId,
                connection_id: connectionId,
                priority,
                model,
                messages,
                n_predict: params?.n_predict,
            });

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'mcp.task_queued',
                        params: {
                            ...ack,
                            request_id: id,
                            trace_id: traceId,
                        },
                    })
                );
            }
            return;
        }

        // 2. Task Cancellation
        if (method === 'mcp.cancel_task') {
            const taskId = params?.task_id;
            const cancelled = taskId ? this.taskQueue.cancelTask(taskId) : false;
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        result: { task_id: taskId, cancelled },
                    })
                );
            }
            return;
        }

        // 3. Mobile Outbox Telemetry Batch Sync over WebSocket
        if (method === 'mcp.telemetry_sync') {
            const spans = params?.spans;
            if (!Array.isArray(spans)) {
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        error: { code: -32602, message: 'spans array required' },
                    })
                );
                return;
            }

            try {
                const syncedIds = await this.telemetryForwarder.ingestSpans(spans);
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            method: 'mcp.telemetry_sync_ack',
                            result: {
                                status: 'ACK',
                                synced_span_ids: syncedIds,
                            },
                        })
                    );
                }
            } catch (err: any) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(
                        JSON.stringify({
                            jsonrpc: '2.0',
                            id,
                            error: { code: -32000, message: err.message || 'Telemetry sync failed' },
                        })
                    );
                }
            }
            return;
        }
    }
}
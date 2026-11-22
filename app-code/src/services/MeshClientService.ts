import {
    getAllTrustedPeers,
    upsertMeshPeer,
    upsertMeshNodeConfig,
    deleteMeshPeer,
    MeshPeerRecord,
    DeviceTier,
    TelemetrySpanRecord,
} from '../database/repository';
import { MeshIdentityService } from './MeshIdentityService';
import {
    TelemetryService,
    TraceContext,
    RemoteDesktopTaskSpans,
} from './TelemetryService';
import ModelFile from '../../modules/model-file/src/ModelFileModule';

export interface MeshNodeEndpoint {
    nodeId: string;
    nodeName: string;
    deviceTier: DeviceTier;
    ip: string;
    port: number;
    sharedToken: string;
    isOnline: boolean;
    latencyMs: number;
    queueDepth?: number;
    models: Array<{ name: string; parameterSize: string; sizeBytes: number }>;
}

export interface UnifiedComputeTarget {
    nodeId: string;
    modelName: string;
    displayName: string;
    deviceTier: DeviceTier;
}

export interface MeshStreamOptions {
    traceContext?: TraceContext;
    taskId?: string;
    priority?: number; // 0: Synthesis/Batch, 1: Standard, 2: Tool Resume
    nPredict?: number;
    onQueueUpdate?: (info: { taskId: string; queuePosition: number; estimatedWaitMs: number }) => void;
    onTaskStarted?: (info: { taskId: string; queueWaitMs: number }) => void;
}

export interface MeshStreamResult {
    taskId?: string;
    taskStatus?: string;
    emittedToolCall?: boolean;
    spans?: RemoteDesktopTaskSpans;
    ttftMs?: number;
    durationMs?: number;
    tokenCount?: number;
}

export class MeshClientService {
    private static instance: MeshClientService;
    private activeNodes: Map<string, MeshNodeEndpoint> = new Map();
    private persistentWs: WebSocket | null = null;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private activeWsNodeId: string | null = null;
    private isHealingSubnet = false;
    private lastSubnetSweepAt = 0;
    private telemetry = TelemetryService.getInstance();

    private selectedTarget: UnifiedComputeTarget = {
        nodeId: 'local_engine',
        modelName: 'On-Device GGUF',
        displayName: '📱 Local: Snapdragon (Direct)',
        deviceTier: 'thick_mobile',
    };

    private listeners = new Set<() => void>();

    private constructor() {
        // Register outbox batch sync transport with TelemetryService
        this.telemetry.registerSyncTransport((spans) => this.syncTelemetryBatchToDesktop(spans));
    }

    public static getInstance(): MeshClientService {
        if (!MeshClientService.instance) {
            MeshClientService.instance = new MeshClientService();
        }
        return MeshClientService.instance;
    }

    public subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        fn();
        return () => this.listeners.delete(fn);
    }

    private notify(): void {
        this.listeners.forEach((fn) => fn());
    }

    public getSelectedTarget(): UnifiedComputeTarget {
        return this.selectedTarget;
    }

    public setSelectedTarget(target: UnifiedComputeTarget): void {
        this.selectedTarget = target;
        this.ensurePersistentConnection();
        this.notify();
    }

    public getActiveNodes(): MeshNodeEndpoint[] {
        return Array.from(this.activeNodes.values());
    }

    public async deletePeer(nodeId: string): Promise<void> {
        await deleteMeshPeer(nodeId);
        this.activeNodes.delete(nodeId);
        if (this.selectedTarget.nodeId === nodeId) {
            this.setSelectedTarget({
                nodeId: 'local_engine',
                modelName: 'On-Device GGUF',
                displayName: '📱 Local: Snapdragon (Direct)',
                deviceTier: 'thick_mobile',
            });
        }
        this.notify();
    }

    /**
     * Flushes mobile SQLite outbox spans to any online Desktop Supernode
     */
    private async syncTelemetryBatchToDesktop(spans: TelemetrySpanRecord[]): Promise<string[]> {
        const desktopNode = Array.from(this.activeNodes.values()).find(
            (n) => n.deviceTier === 'thick_desktop' && n.isOnline
        );
        if (!desktopNode) return [];

        const res = await fetch(`http://${desktopNode.ip}:${desktopNode.port}/api/mesh/telemetry/sync`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${desktopNode.sharedToken}`,
            },
            body: JSON.stringify({ spans }),
        });

        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data.synced_span_ids) ? data.synced_span_ids : [];
    }

    public async pairWithNode(ip: string, port: number, pin: string): Promise<void> {
        const identityService = MeshIdentityService.getInstance();
        const identity = await identityService.getOrCreateIdentity();

        const cleanIp = ip.trim().replace(/^https?:\/\//i, '').replace(/:\d+$/, '');
        const targetPort = port || 8080;
        const url = `http://${cleanIp}:${targetPort}/api/mesh/pair`;

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pin: pin.trim(),
                    deviceId: identity.node_id,
                    deviceName: identity.node_name,
                    deviceTier: identity.node_tier,
                }),
            });
        } catch (netErr: any) {
            throw new Error(`Cannot reach [${url}]: ${netErr?.message || String(netErr)}`);
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `PAIRING_FAILED (HTTP ${res.status})`);
        }

        const data = await res.json();
        const token = data.meshToken;

        const peerNodeId = data.peerNodeId || `node_${cleanIp.replace(/\./g, '_')}`;
        const peerName = data.peerName || (targetPort === 8080 ? 'Desktop PC' : 'Mobile Worker');
        const peerTier: DeviceTier = targetPort === 8080 ? 'thick_desktop' : 'thick_mobile';

        await upsertMeshPeer(peerNodeId, peerName, peerTier, token, cleanIp, targetPort);

        if (Array.isArray(data.knownPeers)) {
            for (const peer of data.knownPeers) {
                if (peer.deviceId && peer.deviceId !== identity.node_id) {
                    const designatedPort =
                        peer.deviceTier === 'thick_mobile' && (!peer.network?.port || peer.network.port === 8082)
                            ? 8765
                            : (peer.network?.port || 8080);

                    await upsertMeshPeer(
                        peer.deviceId,
                        peer.deviceName || 'Mesh Peer',
                        peer.deviceTier || 'thick_mobile',
                        peer.meshToken || token,
                        peer.network?.ip || cleanIp,
                        designatedPort
                    );
                }
            }
        }

        if (data.clusterSecret) {
            await upsertMeshNodeConfig(
                identity.node_id,
                identity.node_name,
                identity.node_tier,
                identity.is_worker_enabled === 1,
                data.clusterSecret
            );
        }

        await this.scanAndSyncPeers();
    }

    public async scanAndSyncPeers(): Promise<void> {
        try {
            const identity = await MeshIdentityService.getInstance().getOrCreateIdentity();
            try {
                await ModelFile.setWorkerNodeIdentity?.(identity.node_id, identity.node_name);
            } catch {}

            const peers = await getAllTrustedPeers();

            const desktopPeer = peers.find((p) => p.device_tier === 'thick_desktop');
            if (desktopPeer) {
                try {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 2000);
                    const clusterRes = await fetch(
                        `http://${desktopPeer.last_known_ip}:${desktopPeer.last_known_port}/api/mesh/cluster/peers`,
                        { signal: controller.signal }
                    );
                    clearTimeout(timeout);
                    if (clusterRes.ok) {
                        const clusterData = await clusterRes.json();
                        if (Array.isArray(clusterData.peers)) {
                            for (const cp of clusterData.peers) {
                                if (cp.nodeId !== identity.node_id) {
                                    await upsertMeshPeer(
                                        cp.nodeId,
                                        cp.nodeName,
                                        cp.deviceTier,
                                        cp.sharedToken,
                                        cp.ip,
                                        (cp.deviceTier === 'thick_mobile' && (!cp.port || cp.port === 8082)) ? 8765 : (cp.port || 8080)
                                    );
                                }
                            }
                        }
                    }
                } catch {}
            }

            const updatedPeers = await getAllTrustedPeers();
            if (!updatedPeers || updatedPeers.length === 0) return;

            const unreachablePeers: MeshPeerRecord[] = [];
            let anyDesktopCollectorOnline = false;

            await Promise.all(
                updatedPeers.map(async (peer) => {
                    const start = Date.now();
                    const targetPort =
                        (peer.device_tier === 'thick_mobile' && (!peer.last_known_port || peer.last_known_port === 8082))
                            ? 8765
                            : (peer.last_known_port || 8080);

                    try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 2200);

                        const res = await fetch(`http://${peer.last_known_ip}:${targetPort}/api/mesh/telemetry`, {
                            signal: controller.signal,
                        });
                        clearTimeout(timeout);

                        if (res.ok) {
                            const data = await res.json();
                            const latencyMs = Date.now() - start;

                            const models = (data.models || []).map((m: any) => ({
                                name: m.name,
                                parameterSize: m.details?.parameter_size || m.parameter_size || 'Unknown',
                                sizeBytes: m.size || 0,
                            }));

                            this.activeNodes.set(peer.node_id, {
                                nodeId: peer.node_id,
                                nodeName: data.nodeName || peer.node_name,
                                deviceTier: peer.device_tier,
                                ip: peer.last_known_ip,
                                port: targetPort,
                                sharedToken: peer.shared_token,
                                isOnline: true,
                                latencyMs,
                                queueDepth: data.queue?.depth || 0,
                                models,
                            });

                            if (peer.device_tier === 'thick_desktop' && data.telemetry?.status === 'ready') {
                                anyDesktopCollectorOnline = true;
                            }
                        } else {
                            this.markOffline(peer, targetPort);
                            unreachablePeers.push(peer);
                        }
                    } catch {
                        this.markOffline(peer, targetPort);
                        unreachablePeers.push(peer);
                    }
                })
            );

            this.telemetry.setDesktopCollectorStatus(anyDesktopCollectorOnline);
            if (anyDesktopCollectorOnline) {
                this.telemetry.flushOutbox().catch(() => {});
            }

            this.ensurePersistentConnection();
            this.notify();

            if (
                unreachablePeers.length > 0 &&
                !this.isHealingSubnet &&
                Date.now() - this.lastSubnetSweepAt > 30000
            ) {
                this.healUnreachablePeers(unreachablePeers, identity.node_id).catch(() => {});
            }
        } catch (err) {
            console.warn('[MeshClientService] scanAndSyncPeers error:', err);
        }
    }

    private async healUnreachablePeers(
        offlinePeers: MeshPeerRecord[],
        selfNodeId: string
    ): Promise<void> {
        this.isHealingSubnet = true;
        this.lastSubnetSweepAt = Date.now();

        try {
            let localIp = '';
            try {
                localIp = (await ModelFile.getLocalIpAddress?.()) || '';
            } catch {}

            if (!localIp) {
                const onlineNode = Array.from(this.activeNodes.values()).find((n) => n.isOnline);
                if (onlineNode) localIp = onlineNode.ip;
            }

            const octets = localIp.split('.');
            if (octets.length !== 4) return;

            const subnetPrefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
            const selfHost = parseInt(octets[3], 10);

            const portsToProbe = Array.from(
                new Set(
                    offlinePeers.map((p) =>
                        p.device_tier === 'thick_mobile' ? 8765 : (p.last_known_port || 8080)
                    )
                )
            );

            let healedAny = false;
            const candidateHosts: number[] = [];
            for (let i = 1; i <= 254; i++) {
                if (i !== selfHost) candidateHosts.push(i);
            }

            const BATCH_SIZE = 32;
            for (let i = 0; i < candidateHosts.length; i += BATCH_SIZE) {
                const batch = candidateHosts.slice(i, i + BATCH_SIZE);

                await Promise.all(
                    batch.map(async (hostNum) => {
                        const candidateIp = `${subnetPrefix}.${hostNum}`;
                        for (const port of portsToProbe) {
                            try {
                                const controller = new AbortController();
                                const timer = setTimeout(() => controller.abort(), 450);
                                const res = await fetch(`http://${candidateIp}:${port}/api/mesh/telemetry`, {
                                    signal: controller.signal,
                                });
                                clearTimeout(timer);

                                if (!res.ok) continue;
                                const data = await res.json();
                                if (data.nodeId && data.nodeId === selfNodeId) continue;

                                const matchedPeer = offlinePeers.find(
                                    (p) =>
                                        (data.nodeId && p.node_id === data.nodeId) ||
                                        (data.nodeName && p.node_name === data.nodeName) ||
                                        (port === 8080 &&
                                            p.device_tier === 'thick_desktop' &&
                                            offlinePeers.filter((x) => x.device_tier === 'thick_desktop').length === 1)
                                );

                                if (matchedPeer && matchedPeer.last_known_ip !== candidateIp) {
                                    await upsertMeshPeer(
                                        matchedPeer.node_id,
                                        data.nodeName || matchedPeer.node_name,
                                        matchedPeer.device_tier,
                                        matchedPeer.shared_token,
                                        candidateIp,
                                        port
                                    );
                                    healedAny = true;
                                }
                            } catch {}
                        }
                    })
                );

                if (healedAny) break;
            }

            if (healedAny) {
                await this.scanAndSyncPeers();
            }
        } finally {
            this.isHealingSubnet = false;
        }
    }

    private markOffline(peer: MeshPeerRecord, port: number): void {
        const existing = this.activeNodes.get(peer.node_id);
        if (existing) {
            existing.isOnline = false;
        } else {
            this.activeNodes.set(peer.node_id, {
                nodeId: peer.node_id,
                nodeName: peer.node_name,
                deviceTier: peer.device_tier,
                ip: peer.last_known_ip,
                port,
                sharedToken: peer.shared_token,
                isOnline: false,
                latencyMs: 0,
                models: [],
            });
        }
    }

    private ensurePersistentConnection(): void {
        const targetNode =
            this.selectedTarget.nodeId !== 'local_engine'
                ? this.activeNodes.get(this.selectedTarget.nodeId)
                : Array.from(this.activeNodes.values()).find((n) => n.deviceTier === 'thick_desktop' && n.isOnline);

        if (!targetNode || !targetNode.isOnline || targetNode.deviceTier !== 'thick_desktop') {
            this.teardownPersistentWs();
            return;
        }

        if (this.persistentWs && this.activeWsNodeId === targetNode.nodeId) {
            if (this.persistentWs.readyState === WebSocket.OPEN || this.persistentWs.readyState === WebSocket.CONNECTING) {
                return;
            }
        }

        this.teardownPersistentWs();
        this.activeWsNodeId = targetNode.nodeId;

        try {
            const url = `ws://${targetNode.ip}:${targetNode.port}/mcp?token=${encodeURIComponent(targetNode.sharedToken)}`;
            const ws = new WebSocket(url);

            ws.onopen = () => {
                this.persistentWs = ws;
                this.startHeartbeat(ws);
            };

            ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data.toString());

                    // Trigger background outbox flush when Desktop heartbeat confirms Langfuse collector is ready
                    if (msg.type === 'pong' && msg.telemetry?.status === 'ready') {
                        this.telemetry.setDesktopCollectorStatus(true);
                        this.telemetry.flushOutbox().catch(() => {});
                        return;
                    }

                    const identity = await MeshIdentityService.getInstance().getOrCreateIdentity();

                    if (msg.method === 'mcp.peer_joined' && msg.params) {
                        const p = msg.params;
                        if (p.nodeId !== identity.node_id) {
                            await upsertMeshPeer(
                                p.nodeId,
                                p.nodeName,
                                p.deviceTier,
                                p.sharedToken,
                                p.ip,
                                (p.deviceTier === 'thick_mobile' && (!p.port || p.port === 8082)) ? 8765 : (p.port || 8080)
                            );
                            await this.scanAndSyncPeers();
                        }
                    } else if (msg.method === 'mcp.peer_sync' && Array.isArray(msg.params?.peers)) {
                        for (const p of msg.params.peers) {
                            if (p.nodeId !== identity.node_id) {
                                await upsertMeshPeer(
                                    p.nodeId,
                                    p.nodeName,
                                    p.deviceTier,
                                    p.sharedToken,
                                    p.ip,
                                    (p.deviceTier === 'thick_mobile' && (!p.port || p.port === 8082)) ? 8765 : (p.port || 8080)
                                );
                            }
                        }
                        await this.scanAndSyncPeers();
                    }
                } catch {}
            };

            ws.onclose = () => {
                if (this.activeWsNodeId === targetNode.nodeId) {
                    this.teardownPersistentWs();
                }
            };

            ws.onerror = () => {
                if (this.activeWsNodeId === targetNode.nodeId) {
                    this.teardownPersistentWs();
                }
            };
        } catch (e) {
            console.warn('[MeshClientService] WS connection failed:', e);
        }
    }

    private startHeartbeat(ws: WebSocket): void {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            }
        }, 5000);
    }

    private teardownPersistentWs(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.persistentWs) {
            try {
                this.persistentWs.close();
            } catch {}
            this.persistentWs = null;
        }
        this.activeWsNodeId = null;
    }

    public async streamChat(
        messages: Array<{ role: string; content: string }>,
        onToken: (tok: string) => void,
        options: MeshStreamOptions = {}
    ): Promise<MeshStreamResult> {
        const target = this.selectedTarget;
        if (target.nodeId === 'local_engine') {
            throw new Error('Local engine must be evaluated through LLMService.');
        }

        const node = this.activeNodes.get(target.nodeId);
        if (!node || !node.isOnline) {
            throw new Error(`Target node "${target.displayName}" is offline.`);
        }

        if (node.deviceTier === 'thick_desktop') {
            return await this.streamFromDesktop(node, target.modelName, messages, onToken, options);
        }

        if (node.deviceTier === 'thick_mobile') {
            return await this.streamFromMobileWorker(node, messages, onToken, options);
        }

        return {};
    }

    private streamFromDesktop(
        node: MeshNodeEndpoint,
        model: string,
        messages: Array<{ role: string; content: string }>,
        onToken: (tok: string) => void,
        options: MeshStreamOptions = {}
    ): Promise<MeshStreamResult> {
        return new Promise((resolve, reject) => {
            const isPersistent =
                this.persistentWs !== null && this.persistentWs.readyState === WebSocket.OPEN;

            const socket: WebSocket = isPersistent
                ? this.persistentWs!
                : new WebSocket(`ws://${node.ip}:${node.port}/mcp?token=${encodeURIComponent(node.sharedToken)}`);

            const reqId = `req_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            let assignedTaskId = options.taskId || '';
            let hasReceivedAckOrChunk = false;

            const cleanup = () => {
                if (!isPersistent) {
                    try {
                        socket.close();
                    } catch {}
                }
            };

            const timeout = setTimeout(() => {
                if (!hasReceivedAckOrChunk) {
                    socket.removeEventListener('message', handleMessage);
                    cleanup();
                    this.streamFromDesktopHttp(node, model, messages, onToken, options)
                        .then(resolve)
                        .catch(reject);
                }
            }, 6000);

            const handleMessage = (event: WebSocketMessageEvent) => {
                try {
                    const res = JSON.parse(event.data.toString());

                    // Step 1 ACK: mcp.task_queued
                    if (
                        res.method === 'mcp.task_queued' &&
                        (res.params?.request_id === reqId ||
                            (assignedTaskId && res.params?.task_id === assignedTaskId))
                    ) {
                        hasReceivedAckOrChunk = true;
                        clearTimeout(timeout);
                        assignedTaskId = res.params.task_id;
                        options.onQueueUpdate?.({
                            taskId: assignedTaskId,
                            queuePosition: res.params.queue_position || 1,
                            estimatedWaitMs: res.params.estimated_wait_ms || 50,
                        });
                        return;
                    }

                    // Step 2: mcp.task_started
                    if (
                        res.method === 'mcp.task_started' &&
                        assignedTaskId &&
                        res.params?.task_id === assignedTaskId
                    ) {
                        hasReceivedAckOrChunk = true;
                        clearTimeout(timeout);
                        options.onTaskStarted?.({
                            taskId: assignedTaskId,
                            queueWaitMs: res.params.queue_wait_ms || 0,
                        });
                        return;
                    }

                    // Step 2b: Token Stream (supports both mcp.token_chunk and legacy mcp.stream_chunk)
                    if (
                        (res.method === 'mcp.token_chunk' || res.method === 'mcp.stream_chunk') &&
                        ((assignedTaskId && res.params?.task_id === assignedTaskId) ||
                            res.params?.id === reqId)
                    ) {
                        hasReceivedAckOrChunk = true;
                        clearTimeout(timeout);
                        const tok = res.params.token ?? res.params.chunk;
                        if (tok) onToken(tok);
                        return;
                    }

                    // Step 3: mcp.task_completed
                    if (
                        (res.method === 'mcp.task_completed' &&
                            ((assignedTaskId && res.params?.task_id === assignedTaskId) ||
                                res.id === reqId)) ||
                        (res.id === reqId && res.result?.status === 'completed')
                    ) {
                        clearTimeout(timeout);
                        socket.removeEventListener('message', handleMessage);
                        cleanup();

                        const payload = res.params || res.result || {};
                        const spans: RemoteDesktopTaskSpans | undefined = payload.spans;

                        if (spans && options.traceContext) {
                            this.telemetry
                                .ingestRemoteDesktopSpans(
                                    options.traceContext.trace_id,
                                    options.traceContext.session_id,
                                    spans
                                )
                                .catch(() => {});
                        }

                        resolve({
                            taskId: payload.task_id || assignedTaskId,
                            taskStatus: payload.status || payload.task_status || 'COMPLETED',
                            emittedToolCall: payload.emitted_tool_call,
                            spans,
                            ttftMs: spans?.ttft_ms,
                            durationMs: spans?.generation_duration_ms,
                            tokenCount: spans?.completion_tokens,
                        });
                        return;
                    }

                    // Error / Failed frame
                    if (
                        (res.method === 'mcp.task_failed' &&
                            assignedTaskId &&
                            res.params?.task_id === assignedTaskId) ||
                        (res.id === reqId && res.error)
                    ) {
                        clearTimeout(timeout);
                        socket.removeEventListener('message', handleMessage);
                        cleanup();
                        reject(new Error(res.params?.error || res.error?.message || 'Ollama Task Error'));
                    }
                } catch {}
            };

            const sendPayload = () => {
                socket.addEventListener('message', handleMessage);
                const rpcMethod =
                    options.priority === 2 && options.taskId ? 'mcp.resume_task' : 'mcp.submit_task';

                socket.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: reqId,
                        method: rpcMethod,
                        params: {
                            task_id: options.taskId,
                            session_id: options.traceContext?.session_id,
                            trace_id: options.traceContext?.trace_id,
                            parent_span_id: options.traceContext?.parent_span_id,
                            priority: options.priority ?? 1,
                            n_predict: options.nPredict,
                            model,
                            messages,
                            trace_context: options.traceContext,
                        },
                    })
                );
            };

            if (socket.readyState === WebSocket.OPEN) {
                sendPayload();
            } else {
                socket.onopen = sendPayload;
                socket.onerror = () => {
                    clearTimeout(timeout);
                    cleanup();
                    this.streamFromDesktopHttp(node, model, messages, onToken, options)
                        .then(resolve)
                        .catch(reject);
                };
                socket.onclose = (e) => {
                    if (!hasReceivedAckOrChunk) {
                        clearTimeout(timeout);
                        cleanup();
                        reject(
                            new Error(
                                `WebSocket closed (${e.code}): ${e.reason || 'Authentication or server error'}`
                            )
                        );
                    }
                };
            }
        });
    }

    private async streamFromDesktopHttp(
        node: MeshNodeEndpoint,
        model: string,
        messages: Array<{ role: string; content: string }>,
        onToken: (tok: string) => void,
        options: MeshStreamOptions = {}
    ): Promise<MeshStreamResult> {
        const res = await fetch(`http://${node.ip}:${node.port}/api/mesh/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${node.sharedToken}`,
            },
            body: JSON.stringify({
                model,
                messages,
                task_id: options.taskId,
                priority: options.priority ?? 1,
                n_predict: options.nPredict,
                trace_context: options.traceContext,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Desktop HTTP stream returned ${res.status}`);
        }

        let resultMeta: MeshStreamResult = {};
        const reader = (res as any).body?.getReader ? (res as any).body.getReader() : null;
        if (reader) {
            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const text = decoder.decode(value);
                const lines = text.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ') && !line.includes('[DONE]')) {
                        try {
                            const data = JSON.parse(line.substring(6));
                            if (data.token) onToken(data.token);
                            if (data.type === 'trace_metrics' && data.spans) {
                                resultMeta = {
                                    taskId: data.task_id,
                                    taskStatus: data.status,
                                    spans: data.spans,
                                    ttftMs: data.spans.ttft_ms,
                                    durationMs: data.spans.generation_duration_ms,
                                    tokenCount: data.spans.completion_tokens,
                                };
                                if (options.traceContext) {
                                    this.telemetry
                                        .ingestRemoteDesktopSpans(
                                            options.traceContext.trace_id,
                                            options.traceContext.session_id,
                                            data.spans
                                        )
                                        .catch(() => {});
                                }
                            }
                            if (data.error) throw new Error(data.error);
                        } catch {}
                    }
                }
            }
        }
        return resultMeta;
    }

    private streamFromMobileWorker(
        node: MeshNodeEndpoint,
        messages: Array<{ role: string; content: string }>,
        onToken: (tok: string) => void,
        options: MeshStreamOptions = {}
    ): Promise<MeshStreamResult> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = `http://${node.ip}:${node.port}/api/mesh/inference`;

            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/json');

            const startTimeMs = Date.now();
            let firstTokenMs = 0;
            let tokenCount = 0;
            let processedLength = 0;
            let buffer = '';
            let isResolved = false;

            const finishSuccess = () => {
                if (isResolved) return;
                isResolved = true;
                const durationMs = Math.max(1, Date.now() - startTimeMs);
                resolve({
                    ttftMs: firstTokenMs || Math.min(durationMs, 120),
                    durationMs,
                    tokenCount,
                });
            };

            const processBuffer = () => {
                if (xhr.responseText.length <= processedLength) return;

                const newChunk = xhr.responseText.slice(processedLength);
                processedLength = xhr.responseText.length;
                buffer += newChunk;

                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

                    const dataStr = trimmed.slice(6).trim();
                    if (dataStr === '[DONE]') {
                        finishSuccess();
                        return;
                    }

                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.token) {
                            if (firstTokenMs === 0) {
                                firstTokenMs = Date.now() - startTimeMs;
                            }
                            tokenCount++;
                            onToken(parsed.token);
                        } else if (parsed.error) {
                            if (!isResolved) {
                                isResolved = true;
                                reject(new Error(parsed.error));
                            }
                        }
                    } catch {}
                }
            };

            xhr.onprogress = () => {
                processBuffer();
            };

            xhr.onload = () => {
                processBuffer();
                if (!isResolved) {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        finishSuccess();
                    } else {
                        isResolved = true;
                        reject(new Error(`Worker responded with HTTP ${xhr.status}`));
                    }
                }
            };

            xhr.onerror = () => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error(`Network error while communicating with Mobile Worker at ${node.ip}:${node.port}`));
                }
            };

            xhr.ontimeout = () => {
                if (!isResolved) {
                    isResolved = true;
                    reject(new Error('Inference request to Mobile Worker timed out.'));
                }
            };

            const fallbackPrompt =
                messages.length === 1
                    ? messages[0].content
                    : messages.map((m) => `${m.role}: ${m.content}`).join('\n');

            xhr.send(
                JSON.stringify({
                    messages,
                    prompt: fallbackPrompt,
                    trace_context: options.traceContext,
                })
            );
        });
    }
}
import * as SecureStore from 'expo-secure-store';
import {
    getAllTrustedPeers,
    upsertMeshPeer,
    upsertMeshNodeConfig,
    MeshPeerRecord,
    DeviceTier,
} from '../database/repository';
import { MeshIdentityService } from './MeshIdentityService';

export interface MeshNodeEndpoint {
    nodeId: string;
    nodeName: string;
    deviceTier: DeviceTier;
    ip: string;
    port: number;
    sharedToken: string;
    isOnline: boolean;
    latencyMs: number;
    models: Array<{ name: string; parameterSize: string; sizeBytes: number }>;
}

export interface UnifiedComputeTarget {
    nodeId: string;
    modelName: string;
    displayName: string;
    deviceTier: DeviceTier;
}

export class MeshClientService {
    private static instance: MeshClientService;
    private activeNodes: Map<string, MeshNodeEndpoint> = new Map();
    private persistentWs: WebSocket | null = null;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private activeWsNodeId: string | null = null;

    private selectedTarget: UnifiedComputeTarget = {
        nodeId: 'local_engine',
        modelName: 'On-Device GGUF',
        displayName: '📱 Local: Snapdragon (Direct)',
        deviceTier: 'thick_mobile',
    };

    private listeners = new Set<() => void>();

    private constructor() {}

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

    public async pairWithNode(ip: string, port: number, pin: string): Promise<void> {
        const identityService = MeshIdentityService.getInstance();
        const identity = await identityService.getOrCreateIdentity();

        const res = await fetch(`http://${ip}:${port}/api/mesh/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pin,
                deviceId: identity.node_id,
                deviceName: identity.node_name,
                deviceTier: identity.node_tier,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `PAIRING_FAILED (HTTP ${res.status})`);
        }

        const data = await res.json();
        const token = data.meshToken;

        const peerNodeId = data.peerNodeId || `node_${ip.replace(/\./g, '_')}`;
        const peerName = data.peerName || (port === 8080 ? 'Desktop PC' : 'Mobile Worker');
        const peerTier: DeviceTier = port === 8080 ? 'thick_desktop' : 'thick_mobile';

        await upsertMeshPeer(peerNodeId, peerName, peerTier, token, ip, port);

        if (Array.isArray(data.knownPeers)) {
            for (const peer of data.knownPeers) {
                if (peer.deviceId && peer.deviceId !== identity.node_id) {
                    await upsertMeshPeer(
                        peer.deviceId,
                        peer.deviceName || 'Mesh Peer',
                        peer.deviceTier || 'thick_mobile',
                        peer.meshToken || token,
                        peer.network?.ip || ip,
                        peer.network?.port || 8082
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
            const peers = await getAllTrustedPeers();
            if (!peers || peers.length === 0) return;

            await Promise.all(
                peers.map(async (peer) => {
                    const start = Date.now();
                    try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 2500);

                        const res = await fetch(`http://${peer.last_known_ip}:${peer.last_known_port}/api/mesh/telemetry`, {
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
                                port: peer.last_known_port,
                                sharedToken: peer.shared_token,
                                isOnline: true,
                                latencyMs,
                                models,
                            });
                        } else {
                            this.markOffline(peer);
                        }
                    } catch {
                        this.markOffline(peer);
                    }
                })
            );

            this.ensurePersistentConnection();
            this.notify();
        } catch (err) {
            console.warn('[MeshClientService] scanAndSyncPeers error:', err);
        }
    }

    private markOffline(peer: MeshPeerRecord): void {
        const existing = this.activeNodes.get(peer.node_id);
        if (existing) {
            existing.isOnline = false;
        } else {
            this.activeNodes.set(peer.node_id, {
                nodeId: peer.node_id,
                nodeName: peer.node_name,
                deviceTier: peer.device_tier,
                ip: peer.last_known_ip,
                port: peer.last_known_port,
                sharedToken: peer.shared_token,
                isOnline: false,
                latencyMs: 0,
                models: [],
            });
        }
    }

    /**
     * Maintains persistent authenticated WebSocket connection with the active node
     */
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

            ws.onmessage = (_e) => {
                // Heartbeat pong received
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
        onToken: (tok: string) => void
    ): Promise<void> {
        const target = this.selectedTarget;
        if (target.nodeId === 'local_engine') {
            throw new Error('Local engine must be evaluated through LLMService.');
        }

        const node = this.activeNodes.get(target.nodeId);
        if (!node || !node.isOnline) {
            throw new Error(`Target node "${target.displayName}" is offline.`);
        }

        if (node.deviceTier === 'thick_desktop') {
            await this.streamFromDesktop(node, target.modelName, messages, onToken);
            return;
        }

        if (node.deviceTier === 'thick_mobile') {
            const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
            await this.streamFromMobileWorker(node, prompt, onToken);
            return;
        }
    }

    private streamFromDesktop(
        node: MeshNodeEndpoint,
        model: string,
        messages: Array<{ role: string; content: string }>,
        onToken: (tok: string) => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const isPersistent =
                this.persistentWs !== null && this.persistentWs.readyState === WebSocket.OPEN;

            // Strongly typed as non-null WebSocket
            const socket: WebSocket = isPersistent
                ? this.persistentWs!
                : new WebSocket(`ws://${node.ip}:${node.port}/mcp?token=${encodeURIComponent(node.sharedToken)}`);

            const id = Date.now();
            let hasReceivedChunk = false;

            const cleanup = () => {
                if (!isPersistent) {
                    try {
                        socket.close();
                    } catch {}
                }
            };

            const timeout = setTimeout(() => {
                if (!hasReceivedChunk) {
                    cleanup();
                    // Fall back to HTTP SSE stream if WebSocket stalls
                    this.streamFromDesktopHttp(node, model, messages, onToken)
                        .then(resolve)
                        .catch(reject);
                }
            }, 5000);

            const handleMessage = (event: WebSocketMessageEvent) => {
                try {
                    const res = JSON.parse(event.data.toString());
                    if (res.method === 'mcp.stream_chunk' && res.params?.id === id) {
                        hasReceivedChunk = true;
                        clearTimeout(timeout);
                        onToken(res.params.chunk);
                    } else if (res.id === id && res.result?.status === 'completed') {
                        clearTimeout(timeout);
                        socket.removeEventListener('message', handleMessage);
                        cleanup();
                        resolve();
                    } else if (res.id === id && res.error) {
                        clearTimeout(timeout);
                        socket.removeEventListener('message', handleMessage);
                        cleanup();
                        reject(new Error(res.error.message || 'Ollama Error'));
                    }
                } catch {}
            };

            const sendPayload = () => {
                socket.addEventListener('message', handleMessage);
                socket.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        method: 'mcp.stream_chat',
                        params: { model, messages },
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
                    this.streamFromDesktopHttp(node, model, messages, onToken)
                        .then(resolve)
                        .catch(reject);
                };
                socket.onclose = (e) => {
                    if (!hasReceivedChunk) {
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
        onToken: (tok: string) => void
    ): Promise<void> {
        const res = await fetch(`http://${node.ip}:${node.port}/api/mesh/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${node.sharedToken}`,
            },
            body: JSON.stringify({ model, messages }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Desktop HTTP stream returned ${res.status}`);
        }

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
                            if (data.error) throw new Error(data.error);
                        } catch {}
                    }
                }
            }
        }
    }

    private async streamFromMobileWorker(
        node: MeshNodeEndpoint,
        prompt: string,
        onToken: (tok: string) => void
    ): Promise<void> {
        const res = await fetch(`http://${node.ip}:${node.port}/api/mesh/inference`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
        });

        if (!res.ok || !res.body) {
            throw new Error(`Worker responded with status: ${res.status}`);
        }

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
                        } catch {}
                    }
                }
            }
        }
    }
}
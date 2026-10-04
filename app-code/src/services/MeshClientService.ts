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
                    const designatedPort =
                        peer.deviceTier === 'thick_mobile' && (!peer.network?.port || peer.network.port === 8082)
                            ? 8765
                            : (peer.network?.port || 8080);

                    await upsertMeshPeer(
                        peer.deviceId,
                        peer.deviceName || 'Mesh Peer',
                        peer.deviceTier || 'thick_mobile',
                        peer.meshToken || token,
                        peer.network?.ip || ip,
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
            const peers = await getAllTrustedPeers();

            // 1. Pull full cluster roster from any reachable desktop node
            const desktopPeer = peers.find((p) => p.device_tier === 'thick_desktop');
            if (desktopPeer) {
                try {
                    const clusterRes = await fetch(
                        `http://${desktopPeer.last_known_ip}:${desktopPeer.last_known_port}/api/mesh/cluster/peers`
                    );
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
                } catch {
                    // Desktop unreachable; continue probing peers locally
                }
            }

            // 2. Refresh local trusted peer list from SQLite
            const updatedPeers = await getAllTrustedPeers();
            if (!updatedPeers || updatedPeers.length === 0) return;

            // 3. Probe all known peers across the network
            await Promise.all(
                updatedPeers.map(async (peer) => {
                    const start = Date.now();
                    const targetPort =
                        (peer.device_tier === 'thick_mobile' && (!peer.last_known_port || peer.last_known_port === 8082))
                            ? 8765
                            : (peer.last_known_port || 8080);

                    try {
                        const controller = new AbortController();
                        const timeout = setTimeout(() => controller.abort(), 2500);

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
                                models,
                            });
                        } else {
                            this.markOffline(peer, targetPort);
                        }
                    } catch {
                        this.markOffline(peer, targetPort);
                    }
                })
            );

            this.ensurePersistentConnection();
            this.notify();
        } catch (err) {
            console.warn('[MeshClientService] scanAndSyncPeers error:', err);
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

            // Ingest peer sync & peer join notifications pushed from Desktop
            ws.onmessage = async (event) => {
                try {
                    const msg = JSON.parse(event.data.toString());
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
                } catch {
                    // Ignore ping/pong or malformed messages
                }
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

    private streamFromMobileWorker(
        node: MeshNodeEndpoint,
        prompt: string,
        onToken: (tok: string) => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            const url = `http://${node.ip}:${node.port}/api/mesh/inference`;

            xhr.open('POST', url);
            xhr.setRequestHeader('Content-Type', 'application/json');

            let processedLength = 0;
            let buffer = '';
            let isResolved = false;

            const processBuffer = () => {
                if (xhr.responseText.length <= processedLength) return;

                const newChunk = xhr.responseText.slice(processedLength);
                processedLength = xhr.responseText.length;
                buffer += newChunk;

                const lines = buffer.split('\n');
                // Keep the trailing incomplete fragment in the buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data: ')) continue;

                    const dataStr = trimmed.slice(6).trim();
                    if (dataStr === '[DONE]') {
                        if (!isResolved) {
                            isResolved = true;
                            resolve();
                        }
                        return;
                    }

                    try {
                        const parsed = JSON.parse(dataStr);
                        if (parsed.token) {
                            onToken(parsed.token);
                        } else if (parsed.error) {
                            if (!isResolved) {
                                isResolved = true;
                                reject(new Error(parsed.error));
                            }
                        }
                    } catch {
                        // Ignore partial JSON chunks
                    }
                }
            };

            xhr.onprogress = () => {
                processBuffer();
            };

            xhr.onload = () => {
                processBuffer();
                if (!isResolved) {
                    isResolved = true;
                    if (xhr.status >= 200 && xhr.status < 300) {
                        resolve();
                    } else {
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

            xhr.send(JSON.stringify({ prompt }));
        });
    }
}
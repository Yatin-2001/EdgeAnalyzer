import os from 'node:os';
import { DeviceStore } from '../mesh/DeviceStore.js';
import { OllamaBridge } from '../mcp/OllamaBridge.js';
import { SystemTelemetry } from '../mesh/SystemTelemetry.js';
import { DesktopTaskQueue } from '../queue/DesktopTaskQueue.js';

export type NodeTier = 'thick_desktop' | 'thick_mobile' | 'thin';
export type ThermalState = 'nominal' | 'fair' | 'serious' | 'critical';

export interface ClusterNodeCapabilities {
    supportsTools: boolean;
    supportsStructuredOutput: boolean;
    supportsVision: boolean;
}

export interface ClusterNodeState {
    nodeId: string;
    nodeName: string;
    tier: NodeTier;
    endpointUrl: string;
    authToken?: string | undefined;
    status: 'online' | 'degraded' | 'offline';
    activeModel: string;
    availableModels: string[];
    nCtx: number;
    supportsTools: boolean;
    capabilities: ClusterNodeCapabilities;
    queueDepth: number;
    vramFreeMb?: number | undefined;
    avgTtftMs: number;
    thermalState: ThermalState;
    batteryPct?: number | undefined;
    lastSeenMs: number;
}

const VISION_MODEL_REGEX = /(llava|qwen2(\.5)?-?vl|smolvlm|vision|moondream|minicpm-v|bakllava|gemma3)/i;

export class ClusterStateService {
    private static instance: ClusterStateService;
    private nodes = new Map<string, ClusterNodeState>();
    private ttftEmaMap = new Map<string, number>();

    private localNodeId = 'desktop_supernode';
    private localNodeName = `Desktop (${os.hostname()})`;
    private localEndpointUrl = '[http://127.0.0.1:8080](http://127.0.0.1:8080)';
    private localDefaultCtx = parseInt(process.env.DESKTOP_DEFAULT_CTX || '8192', 10);

    private deviceStore = DeviceStore.getInstance();
    private ollama = OllamaBridge.getInstance();
    private telemetry = SystemTelemetry.getInstance();
    private taskQueue = DesktopTaskQueue.getInstance();

    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private mobileProbeTimer: ReturnType<typeof setInterval> | null = null;

    private constructor() {}

    public static getInstance(): ClusterStateService {
        if (!ClusterStateService.instance) {
            ClusterStateService.instance = new ClusterStateService();
        }
        return ClusterStateService.instance;
    }

    public initialize(localNodeId: string, localNodeName: string, localEndpointUrl: string): void {
        this.localNodeId = localNodeId;
        this.localNodeName = localNodeName;
        this.localEndpointUrl = localEndpointUrl;

        // Seed immediate local state before first async probe finishes
        this.nodes.set(localNodeId, {
            nodeId: localNodeId,
            nodeName: localNodeName,
            tier: 'thick_desktop',
            endpointUrl: localEndpointUrl,
            status: 'online',
            activeModel: '',
            availableModels: [],
            nCtx: this.localDefaultCtx,
            supportsTools: true,
            capabilities: {
                supportsTools: true,
                supportsStructuredOutput: true,
                supportsVision: false,
            },
            queueDepth: 0,
            avgTtftMs: 180,
            thermalState: 'nominal',
            lastSeenMs: Date.now(),
        });

        this.refreshLocalNode().catch(() => {});
        this.probePairedWorkers().catch(() => {});

        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = setInterval(() => {
            this.refreshLocalNode().catch(() => {});
            this.markStaleNodesOffline();
        }, 3000);

        if (this.mobileProbeTimer) clearInterval(this.mobileProbeTimer);
        this.mobileProbeTimer = setInterval(() => {
            this.probePairedWorkers().catch(() => {});
        }, 5000);
    }

    public getLocalNodeId(): string {
        return this.localNodeId;
    }

    public getNode(nodeId: string): ClusterNodeState | undefined {
        return this.nodes.get(nodeId);
    }

    public getAllNodes(): ClusterNodeState[] {
        return Array.from(this.nodes.values());
    }

    public getGossipSnapshot(): ClusterNodeState[] {
        // Strip local auth tokens when gossiping cluster state to sibling daemons
        return Array.from(this.nodes.values()).map((n) => {
            const { authToken: _omit, ...safeNode } = n;
            return safeNode;
        });
    }

    public recordNodeTtft(nodeId: string, ttftMs: number): void {
        if (!Number.isFinite(ttftMs) || ttftMs <= 0) return;
        const prev = this.ttftEmaMap.get(nodeId);
        const next = prev === undefined ? ttftMs : Math.round(prev * 0.7 + ttftMs * 0.3);
        this.ttftEmaMap.set(nodeId, next);
        const node = this.nodes.get(nodeId);
        if (node) {
            node.avgTtftMs = next;
        }
    }

    public updateMobileHeartbeat(
        deviceId: string,
        telemetry: {
            activeModel?: string | null;
            queueDepth?: number;
            nCtx?: number;
            thermalState?: ThermalState;
            batteryPct?: number;
            capabilities?: Partial<ClusterNodeCapabilities>;
        }
    ): void {
        const existing = this.nodes.get(deviceId);
        if (!existing) return;

        existing.lastSeenMs = Date.now();
        existing.status = 'online';
        if (telemetry.activeModel !== undefined) {
            existing.activeModel = telemetry.activeModel ?? '';
        }
        if (telemetry.queueDepth !== undefined) {
            existing.queueDepth = telemetry.queueDepth;
        }
        if (telemetry.nCtx !== undefined) {
            existing.nCtx = telemetry.nCtx;
        }
        if (telemetry.thermalState !== undefined) {
            existing.thermalState = telemetry.thermalState;
        }
        if (telemetry.batteryPct !== undefined) {
            existing.batteryPct = telemetry.batteryPct;
        }
        if (telemetry.capabilities) {
            existing.capabilities = {
                ...existing.capabilities,
                ...telemetry.capabilities,
            };
            existing.supportsTools = existing.capabilities.supportsTools;
        }
    }

    /**
     * Merges remote cluster state received via `mesh.cluster_gossip` from sibling desktop daemons.
     */
    public mergeGossipNodes(incoming: ClusterNodeState[]): void {
        if (!Array.isArray(incoming)) return;

        for (const remote of incoming) {
            if (!remote.nodeId || remote.nodeId === this.localNodeId) continue;

            const existing = this.nodes.get(remote.nodeId);
            if (existing && existing.lastSeenMs > remote.lastSeenMs) {
                continue;
            }

            // Preserve locally stored auth token if we paired directly with that node
            const paired = this.deviceStore.get(remote.nodeId);
            const mergedAuthToken = existing?.authToken ?? paired?.meshToken;
            const caps: ClusterNodeCapabilities = remote.capabilities ?? {
                supportsTools: remote.supportsTools ?? true,
                supportsStructuredOutput: remote.tier === 'thick_desktop',
                supportsVision: remote.availableModels?.some((m) => VISION_MODEL_REGEX.test(m)) ?? false,
            };

            this.nodes.set(remote.nodeId, {
                ...remote,
                authToken: mergedAuthToken,
                supportsTools: caps.supportsTools,
                capabilities: caps,
            });
        }
    }

    public async refreshLocalNode(): Promise<void> {
        const [models, ollamaTel, gpuStats] = await Promise.all([
            this.ollama.listModels(),
            this.ollama.getTelemetry(),
            this.telemetry.getGpuStats(),
        ]);

        const availableModels = models.map((m) => m.name);
        const activeModel =
            ollamaTel.activeModel ||
            process.env.DESKTOP_SUPERVISOR_MODEL ||
            availableModels[0] ||
            '';
        const supportsVision = availableModels.some((m) => VISION_MODEL_REGEX.test(m));
        const queueDepth = this.taskQueue.getQueueDepth();
        const avgTtftMs = this.ttftEmaMap.get(this.localNodeId) ?? 180;

        this.nodes.set(this.localNodeId, {
            nodeId: this.localNodeId,
            nodeName: this.localNodeName,
            tier: 'thick_desktop',
            endpointUrl: this.localEndpointUrl,
            status: availableModels.length > 0 ? 'online' : 'degraded',
            activeModel,
            availableModels,
            nCtx: this.localDefaultCtx,
            supportsTools: true,
            capabilities: {
                supportsTools: true,
                supportsStructuredOutput: true,
                supportsVision,
            },
            queueDepth,
            vramFreeMb: gpuStats?.freeMB,
            avgTtftMs,
            thermalState: 'nominal',
            lastSeenMs: Date.now(),
        });
    }

    /**
     * Actively probes paired thick_mobile (port 8765) and sibling thick_desktop nodes via /api/mesh/telemetry
     */
    public async probePairedWorkers(): Promise<void> {
        const paired = this.deviceStore
            .getAll()
            .filter((d) => !d.isRevoked && d.deviceTier !== 'thin' && d.deviceId !== this.localNodeId);

        await Promise.all(
            paired.map(async (dev) => {
                const port =
                    dev.deviceTier === 'thick_mobile' && (!dev.network.port || dev.network.port === 8082)
                        ? 8765
                        : dev.network.port || (dev.deviceTier === 'thick_desktop' ? 8080 : 8765);
                const endpointUrl = `http://${dev.network.ip}:${port}`;

                try {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 1600);
                    const res = await fetch(`${endpointUrl}/api/mesh/telemetry`, {
                        signal: controller.signal,
                    });
                    clearTimeout(timer);

                    if (!res.ok) {
                        this.markNodeOffline(dev.deviceId, dev.deviceName, dev.deviceTier, endpointUrl, dev.meshToken);
                        return;
                    }

                    const data = (await res.json()) as {
                        nodeName?: string;
                        status?: string;
                        activeModel?: string | null;
                        models?: Array<{
                            name: string;
                            modality?: string;
                            size?: number;
                            isLoaded?: boolean;
                        }>;
                        nCtx?: number;
                        queueDepth?: number;
                        queue?: { depth?: number };
                        thermalState?: ThermalState;
                        batteryPct?: number;
                        gpu?: { freeMB?: number };
                        capabilities?: Partial<ClusterNodeCapabilities>;
                    };

                    const rawModels = data.models ?? [];
                    const availableModels = Array.from(
                        new Set(rawModels.map((m) => m.name).filter(Boolean))
                    );
                    const activeModel =
                        data.activeModel && data.activeModel !== 'No Model Loaded'
                            ? data.activeModel
                            : '';
                    if (activeModel && !availableModels.includes(activeModel)) {
                        availableModels.unshift(activeModel);
                    }

                    const hasAnyModel = activeModel.length > 0 || availableModels.length > 0;

                    const inferredVision =
                        rawModels.some(
                            (m) => m.modality === 'vision' || VISION_MODEL_REGEX.test(m.name)
                        ) || VISION_MODEL_REGEX.test(activeModel);

                    const capabilities: ClusterNodeCapabilities = {
                        supportsTools: data.capabilities?.supportsTools ?? hasAnyModel,
                        supportsStructuredOutput:
                            data.capabilities?.supportsStructuredOutput ??
                            (dev.deviceTier === 'thick_desktop' || hasAnyModel),
                        supportsVision: data.capabilities?.supportsVision || inferredVision,
                    };

                    const queueDepth = data.queueDepth ?? data.queue?.depth ?? 0;
                    const defaultCtx = dev.deviceTier === 'thick_desktop' ? 8192 : 4096;
                    const resolvedStatus: 'online' | 'degraded' | 'offline' =
                        dev.deviceTier === 'thick_mobile' && !hasAnyModel ? 'degraded' : 'online';

                    this.nodes.set(dev.deviceId, {
                        nodeId: dev.deviceId,
                        nodeName: data.nodeName || dev.deviceName,
                        tier: dev.deviceTier,
                        endpointUrl,
                        authToken: dev.meshToken,
                        status: resolvedStatus,
                        activeModel,
                        availableModels,
                        nCtx: data.nCtx ?? dev.capabilities?.maxContextTokens ?? defaultCtx,
                        supportsTools: capabilities.supportsTools,
                        capabilities,
                        queueDepth,
                        vramFreeMb: data.gpu?.freeMB,
                        avgTtftMs:
                            this.ttftEmaMap.get(dev.deviceId) ??
                            (dev.deviceTier === 'thick_mobile' ? 240 : 200),
                        thermalState: data.thermalState ?? 'nominal',
                        batteryPct: data.batteryPct,
                        lastSeenMs: Date.now(),
                    });
                } catch {
                    this.markNodeOffline(dev.deviceId, dev.deviceName, dev.deviceTier, endpointUrl, dev.meshToken);
                }
            })
        );
    }

    private markNodeOffline(
        nodeId: string,
        nodeName: string,
        tier: NodeTier,
        endpointUrl: string,
        authToken: string
    ): void {
        const existing = this.nodes.get(nodeId);
        if (existing) {
            existing.status = 'offline';
        } else {
            this.nodes.set(nodeId, {
                nodeId,
                nodeName,
                tier,
                endpointUrl,
                authToken,
                status: 'offline',
                activeModel: '',
                availableModels: [],
                nCtx: tier === 'thick_desktop' ? 8192 : 4096,
                supportsTools: true,
                capabilities: {
                    supportsTools: true,
                    supportsStructuredOutput: tier === 'thick_desktop',
                    supportsVision: false,
                },
                queueDepth: 0,
                avgTtftMs: 250,
                thermalState: 'nominal',
                lastSeenMs: 0,
            });
        }
    }

    private markStaleNodesOffline(): void {
        const now = Date.now();
        for (const [nodeId, node] of this.nodes.entries()) {
            if (nodeId === this.localNodeId) continue;
            if (node.status !== 'offline' && now - node.lastSeenMs > 20000) {
                node.status = 'offline';
            }
        }
    }
}
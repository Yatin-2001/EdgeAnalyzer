import crypto from 'node:crypto';
import { ClusterStateService } from './ClusterStateService.js';
import type { ClusterNodeState } from './ClusterStateService.js';
import type { OpenAIChatRequest, OpenAIToolDefinition } from '../mcp/OllamaBridge.js';

export type RoutingReason =
    | 'explicit_alias'
    | 'subagent_fanout'
    | 'ctx_escalation'
    | 'work_steal'
    | 'pinned_node'
    | 'pre_stream_failover';

export type AgentRoleHint = 'supervisor' | 'worker' | 'fast' | 'vision';

export interface RouteRequestHints {
    agentRole?: AgentRoleHint | undefined;
    sessionId?: string | undefined;
    requiresStructuredOutput?: boolean | undefined;
    hopCount: number;
    excludeNodeIds?: Set<string> | undefined;
}

export interface RoutingDecision {
    node: ClusterNodeState;
    resolvedModel: string;
    routingReason: RoutingReason;
    estimatedInputTokens: number;
    requiredCtx: number;
    score: number;
    candidateCount: number;
    routingLatencyMs: number;
    isPinned: boolean;
}

interface AffinityEntry {
    nodeId: string;
    expiresAtMs: number;
}

const SUPERVISOR_TOOL_NAMES = new Set([
    'task',
    'write_todos',
    'start_additional_research',
]);

const VISION_MODEL_REGEX = /(llava|qwen2(\.5)?-?vl|smolvlm|vision|moondream|minicpm-v|bakllava|gemma3)/i;

export class HybridMeshRouter {
    private static instance: HybridMeshRouter;
    private cluster = ClusterStateService.getInstance();
    private affinityCache = new Map<string, AffinityEntry>();
    private static readonly MAX_AFFINITY_ENTRIES = 50;
    private static readonly AFFINITY_TTL_MS = 10 * 60 * 1000;

    private constructor() {}

    public static getInstance(): HybridMeshRouter {
        if (!HybridMeshRouter.instance) {
            HybridMeshRouter.instance = new HybridMeshRouter();
        }
        return HybridMeshRouter.instance;
    }

    public selectRoute(request: OpenAIChatRequest, hints: RouteRequestHints): RoutingDecision {
        const t0 = performance.now();

        // 0. Token Budget Estimation
        const payloadLength =
            JSON.stringify(request.messages ?? []).length +
            JSON.stringify(request.tools ?? []).length;
        const estimatedInputTokens = Math.ceil(payloadLength / 3.8);
        const maxOut = request.max_completion_tokens ?? request.max_tokens ?? 1024;
        const requiredCtx = estimatedInputTokens + maxOut;

        // Requirement flags (headers + structural payload inspection)
        const requiresVision =
            hints.agentRole === 'vision' || this.hasImageUrlContent(request);
        const requiresTools = Array.isArray(request.tools) && request.tools.length > 0;
        const requiresStructuredOutput =
            hints.requiresStructuredOutput === true ||
            request.response_format?.type === 'json_schema' ||
            request.response_format?.type === 'json_object';

        const localNodeId = this.cluster.getLocalNodeId();
        const excluded = hints.excludeNodeIds ?? new Set<string>();

        // Base online pool (apply hop-count loop guard: hopCount >= 1 must stay local)
        let basePool = this.cluster.getAllNodes().filter((n) => {
            if (n.status === 'offline') return false;
            if (excluded.has(n.nodeId)) return false;
            if (hints.hopCount >= 1 && n.nodeId !== localNodeId) return false;
            if (n.tier === 'thin') return false;
            return true;
        });

        // Hard capability + context admission gate helper
        const passesHardGates = (n: ClusterNodeState): boolean => {
            if (n.nCtx < requiredCtx) return false;
            if (requiresVision && !n.capabilities.supportsVision) return false;
            if (requiresTools && !n.capabilities.supportsTools) return false;
            if (requiresStructuredOutput && !n.capabilities.supportsStructuredOutput) return false;
            return true;
        };

        const requestedModel = (request.model || 'mesh/auto').trim();
        let candidates: ClusterNodeState[] = [];
        let routingReason: RoutingReason = 'explicit_alias';
        let exactModelOverride: string | undefined;
        let isPinned = false;

        // ============================================================
        // STAGE 1: Explicit Model Alias Resolution (Overrides mesh/auto)
        // ============================================================
        if (requestedModel.startsWith('mesh/node:')) {
            isPinned = true;
            const pinnedId = requestedModel.slice('mesh/node:'.length).trim();
            const pinnedNode = basePool.find((n) => n.nodeId === pinnedId);
            if (!pinnedNode) {
                throw new Error(`Pinned node "${pinnedId}" is offline or unreachable.`);
            }
            if (!passesHardGates(pinnedNode)) {
                throw new Error(
                    `Pinned node "${pinnedId}" failed admission gates (requiredCtx=${requiredCtx}, nodeCtx=${pinnedNode.nCtx}).`
                );
            }
            candidates = [pinnedNode];
            routingReason = 'pinned_node';
        } else if (requestedModel.startsWith('mesh/model:')) {
            exactModelOverride = requestedModel.slice('mesh/model:'.length).trim();
            candidates = basePool.filter(
                (n) =>
                    passesHardGates(n) &&
                    (n.availableModels.includes(exactModelOverride!) ||
                        n.activeModel === exactModelOverride)
            );
            routingReason = 'explicit_alias';
        } else if (requestedModel === 'mesh/supervisor' || requestedModel === 'mesh/heavy') {
            candidates = basePool.filter(
                (n) => n.tier === 'thick_desktop' && passesHardGates(n)
            );
            routingReason = 'explicit_alias';
        } else if (requestedModel === 'mesh/worker' || requestedModel === 'mesh/fast') {
            const eligibleMobiles = basePool.filter(
                (n) => n.tier === 'thick_mobile' && n.status === 'online' && passesHardGates(n)
            );
            const idleMobiles = eligibleMobiles.filter((n) => n.queueDepth === 0);

            if (idleMobiles.length > 0) {
                candidates = idleMobiles;
                routingReason = 'explicit_alias';
            } else if (eligibleMobiles.length > 0) {
                // All eligible mobiles are busy: allow work-stealing onto an idle thick_desktop
                const idleDesktops = basePool.filter(
                    (n) => n.tier === 'thick_desktop' && n.queueDepth === 0 && passesHardGates(n)
                );
                if (idleDesktops.length > 0) {
                    candidates = idleDesktops;
                    routingReason = 'work_steal';
                } else {
                    candidates = eligibleMobiles;
                    routingReason = 'explicit_alias';
                }
            } else {
                // No mobile passed context/capability admission: escalate to thick_desktop
                const anyMobileOnline = basePool.some(
                    (n) => n.tier === 'thick_mobile' && n.status === 'online'
                );
                candidates = basePool.filter(
                    (n) => n.tier === 'thick_desktop' && passesHardGates(n)
                );
                routingReason = anyMobileOnline ? 'ctx_escalation' : 'work_steal';
            }
        } else if (requestedModel === 'mesh/auto') {
            // ============================================================
            // STAGE 2: mesh/auto Structural + Header Classifier
            // ============================================================
            const eligibleAll = basePool.filter(passesHardGates);
            const isSupervisorByHeader = hints.agentRole === 'supervisor';
            const isWorkerByHeader = hints.agentRole === 'worker' || hints.agentRole === 'fast';
            const isSupervisorByPayload =
                requiresStructuredOutput || this.hasOrchestrationTools(request.tools);

            if (isSupervisorByHeader || (!isWorkerByHeader && isSupervisorByPayload)) {
                candidates = eligibleAll.filter((n) => n.tier === 'thick_desktop');
                routingReason = isSupervisorByHeader ? 'explicit_alias' : 'subagent_fanout';
                if (candidates.length === 0) {
                    candidates = eligibleAll;
                }
            } else if (requiresVision) {
                const visionDesktops = eligibleAll.filter((n) => n.tier === 'thick_desktop');
                candidates = visionDesktops.length > 0 ? visionDesktops : eligibleAll;
                routingReason = 'explicit_alias';
            } else {
                // Leaf Worker path: prefer thick_mobile for parallel subagent fan-out
                const eligibleMobiles = eligibleAll.filter(
                    (n) => n.tier === 'thick_mobile' && n.status === 'online'
                );
                const idleMobiles = eligibleMobiles.filter((n) => n.queueDepth === 0);

                if (idleMobiles.length > 0) {
                    candidates = idleMobiles;
                    routingReason = 'subagent_fanout';
                } else {
                    const anyMobileOnline = basePool.some(
                        (n) => n.tier === 'thick_mobile' && n.status === 'online'
                    );
                    const desktops = eligibleAll.filter((n) => n.tier === 'thick_desktop');

                    if (eligibleMobiles.length === 0 && desktops.length > 0) {
                        candidates = desktops;
                        routingReason = anyMobileOnline ? 'ctx_escalation' : 'subagent_fanout';
                    } else if (desktops.some((d) => d.queueDepth === 0)) {
                        candidates = desktops.filter((d) => d.queueDepth === 0);
                        routingReason = 'work_steal';
                    } else {
                        candidates = eligibleAll;
                        routingReason = 'subagent_fanout';
                    }
                }
            }
        } else {
            // Non-mesh/* exact Ollama/model name
            exactModelOverride = requestedModel;
            candidates = basePool.filter(
                (n) =>
                    passesHardGates(n) &&
                    (n.availableModels.includes(requestedModel) || n.activeModel === requestedModel)
            );
            // Fallback to local desktop if model wasn't yet cached in listModels
            if (candidates.length === 0) {
                const localNode = basePool.find(
                    (n) => n.nodeId === localNodeId && passesHardGates(n)
                );
                if (localNode) candidates = [localNode];
            }
            routingReason = 'explicit_alias';
        }

        if (candidates.length === 0) {
            throw new Error(
                `No eligible local mesh node available for model="${requestedModel}" (requiredCtx=${requiredCtx}, tools=${requiresTools}, structured=${requiresStructuredOutput}, vision=${requiresVision}).`
            );
        }

        // ============================================================
        // STAGE 3: Capacity, Thermal & KV-Cache Affinity Scoring
        // ============================================================
        const affinityKey = this.computeAffinityKey(request, hints.sessionId);
        const preferredNodeId = this.getAffinityNode(affinityKey);

        let bestNode = candidates[0]!;
        let bestScore = -Infinity;

        for (const node of candidates) {
            const affinityBonus =
                preferredNodeId !== undefined &&
                node.nodeId === preferredNodeId &&
                node.queueDepth === 0
                    ? 15
                    : 0;

            const thermalPenalty = this.computeThermalPenalty(node);
            const score =
                affinityBonus - 30 * node.queueDepth - 0.05 * node.avgTtftMs - thermalPenalty;

            if (score > bestScore) {
                bestScore = score;
                bestNode = node;
            }
        }

        // Record affinity for subsequent turns
        if (affinityKey) {
            this.recordAffinity(affinityKey, bestNode.nodeId);
        }

        const resolvedModel = this.resolveModelForNode(bestNode, exactModelOverride, requiresVision);
        if (!resolvedModel) {
            throw new Error(`Selected node "${bestNode.nodeName}" has no active or available models.`);
        }

        return {
            node: bestNode,
            resolvedModel,
            routingReason,
            estimatedInputTokens,
            requiredCtx,
            score: parseFloat(bestScore.toFixed(2)),
            candidateCount: candidates.length,
            routingLatencyMs: parseFloat((performance.now() - t0).toFixed(2)),
            isPinned,
        };
    }

    private resolveModelForNode(
        node: ClusterNodeState,
        exactOverride: string | undefined,
        requiresVision: boolean
    ): string {
        if (exactOverride) return exactOverride;
        if (requiresVision) {
            const visionMod = node.availableModels.find((m) => VISION_MODEL_REGEX.test(m));
            if (visionMod) return visionMod;
        }
        return node.activeModel || node.availableModels[0] || '';
    }

    private computeThermalPenalty(node: ClusterNodeState): number {
        if (node.batteryPct !== undefined && node.batteryPct < 15) return 1000;
        switch (node.thermalState) {
            case 'critical':
                return 1000;
            case 'serious':
                return 50;
            case 'fair':
                return 10;
            case 'nominal':
            default:
                return 0;
        }
    }

    private hasImageUrlContent(request: OpenAIChatRequest): boolean {
        for (const msg of request.messages ?? []) {
            if (Array.isArray(msg.content)) {
                if (msg.content.some((p) => p.type === 'image_url')) {
                    return true;
                }
            }
        }
        return false;
    }

    private hasOrchestrationTools(tools: OpenAIToolDefinition[] | undefined): boolean {
        if (!Array.isArray(tools) || tools.length === 0) return false;
        for (const t of tools) {
            const name = t.function?.name?.toLowerCase() ?? '';
            if (SUPERVISOR_TOOL_NAMES.has(name)) return true;
            if (t.function?.parameters && this.getJsonDepth(t.function.parameters, 0) > 2) {
                return true;
            }
        }
        return false;
    }

    private getJsonDepth(value: unknown, depth: number): number {
        if (depth > 3) return depth;
        if (value === null || typeof value !== 'object') return depth;
        if (Array.isArray(value)) {
            let max = depth + 1;
            for (const item of value) {
                const d = this.getJsonDepth(item, depth + 1);
                if (d > max) max = d;
            }
            return max;
        }
        const record = value as Record<string, unknown>;
        // Measure nested JSON Schema properties/items depth rather than flat wrapper keys
        const nestedKeys = ['properties', 'items', 'additionalProperties', 'anyOf', 'oneOf'];
        let max = depth;
        for (const [k, v] of Object.entries(record)) {
            if (nestedKeys.includes(k)) {
                const d = this.getJsonDepth(v, depth + 1);
                if (d > max) max = d;
            } else if (v && typeof v === 'object') {
                const d = this.getJsonDepth(v, depth);
                if (d > max) max = d;
            }
        }
        return max;
    }

    private computeAffinityKey(request: OpenAIChatRequest, sessionId?: string): string | null {
        const firstSystem = request.messages?.find(
            (m) => m.role === 'system' || m.role === 'developer'
        );
        const sysText =
            typeof firstSystem?.content === 'string'
                ? firstSystem.content
                : Array.isArray(firstSystem?.content)
                    ? firstSystem.content.map((p) => p.text ?? '').join('')
                    : '';

        if (sessionId && sysText) {
            const sysHash = crypto.createHash('sha256').update(sysText).digest('hex').slice(0, 12);
            return `${sessionId}:${sysHash}`;
        }
        if (sessionId) return `sess:${sessionId}`;
        if (sysText) {
            return `sys:${crypto.createHash('sha256').update(sysText).digest('hex').slice(0, 12)}`;
        }
        return null;
    }

    private getAffinityNode(key: string | null): string | undefined {
        if (!key) return undefined;
        const entry = this.affinityCache.get(key);
        if (!entry) return undefined;
        if (Date.now() > entry.expiresAtMs) {
            this.affinityCache.delete(key);
            return undefined;
        }
        // Touch LRU order
        this.affinityCache.delete(key);
        this.affinityCache.set(key, entry);
        return entry.nodeId;
    }

    private recordAffinity(key: string, nodeId: string): void {
        if (this.affinityCache.has(key)) {
            this.affinityCache.delete(key);
        } else if (this.affinityCache.size >= HybridMeshRouter.MAX_AFFINITY_ENTRIES) {
            const oldestKey = this.affinityCache.keys().next().value;
            if (oldestKey !== undefined) {
                this.affinityCache.delete(oldestKey);
            }
        }
        this.affinityCache.set(key, {
            nodeId,
            expiresAtMs: Date.now() + HybridMeshRouter.AFFINITY_TTL_MS,
        });
    }
}
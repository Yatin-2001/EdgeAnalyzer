import React, { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    RefreshControl,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { MeshClientService } from '../../services/MeshClientService';
import type { AgentRunDTO, AgentRunStatus, RegisteredAgentDTO } from '../../types/agentTypes';

interface Props {
    onBack: () => void;
    onSelectAgentToLaunch: (agent: RegisteredAgentDTO) => void;
    onOpenRun: (run: AgentRunDTO, agent?: RegisteredAgentDTO) => void;
}

function getStatusColor(status: AgentRunStatus): string {
    switch (status) {
        case 'RUNNING':
        case 'QUEUED':
            return '#38BDF8';
        case 'WAITING_FOR_INPUT':
            return '#F59E0B';
        case 'COMPLETED':
            return '#10B981';
        case 'FAILED':
            return '#EF4444';
        case 'CANCELLED':
            return '#94A3B8';
    }
}

export const AgentsHubScreen: React.FC<Props> = ({
                                                     onBack,
                                                     onSelectAgentToLaunch,
                                                     onOpenRun,
                                                 }) => {
    const mesh = MeshClientService.getInstance();

    // Level 1: Agents catalog + global paused-run alert banner
    const [agents, setAgents] = useState<RegisteredAgentDTO[]>([]);
    const [waitingRuns, setWaitingRuns] = useState<AgentRunDTO[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [desktopName, setDesktopName] = useState<string | null>(null);

    // Level 2: Selected agent's dedicated runs view
    const [selectedAgent, setSelectedAgent] = useState<RegisteredAgentDTO | null>(null);
    const [agentRuns, setAgentRuns] = useState<AgentRunDTO[]>([]);
    const [loadingAgentRuns, setLoadingAgentRuns] = useState(false);

    const loadAgentRuns = useCallback(
        async (agentId: string, silent = false) => {
            if (!silent) setLoadingAgentRuns(true);
            try {
                const list = await mesh.listAgentRuns(25, { agentId });
                setAgentRuns(list);
            } catch {
                if (!silent) setAgentRuns([]);
            } finally {
                if (!silent) setLoadingAgentRuns(false);
            }
        },
        [mesh]
    );

    const loadHubData = useCallback(
        async (isRefresh = false) => {
            if (isRefresh) setRefreshing(true);
            else setLoading(true);
            setError(null);

            try {
                let desktop = mesh.getControlPlaneDesktopNode();
                if (!desktop) {
                    await mesh.scanAndSyncPeers();
                    desktop = mesh.getControlPlaneDesktopNode();
                }

                if (!desktop) {
                    setDesktopName(null);
                    setAgents([]);
                    setWaitingRuns([]);
                    setError(
                        'No online Desktop Daemon detected on your LAN. Pair or wake your PC daemon first.'
                    );
                    return;
                }

                setDesktopName(`${desktop.nodeName} (${desktop.ip})`);
                const [readyAgents, paused] = await Promise.all([
                    mesh.listRegisteredAgents(true),
                    mesh.listAgentRuns(20, { status: 'WAITING_FOR_INPUT' }),
                ]);
                setAgents(readyAgents);
                setWaitingRuns(paused);

                if (selectedAgent) {
                    await loadAgentRuns(selectedAgent.agentId, true);
                }
            } catch (err: any) {
                setError(err?.message || String(err));
            } finally {
                setLoading(false);
                setRefreshing(false);
            }
        },
        [mesh, selectedAgent, loadAgentRuns]
    );

    useEffect(() => {
        loadHubData(false);
    }, []);

    useEffect(() => {
        if (selectedAgent) {
            loadAgentRuns(selectedAgent.agentId, false);
        } else {
            setAgentRuns([]);
        }
    }, [selectedAgent, loadAgentRuns]);

    useEffect(() => {
        const unsub = mesh.subscribeAgentEvents((evt) => {
            if (evt.method === 'agent.catalog_updated') {
                const ready = (evt.params.agents || []).filter(
                    (a) => a.validationStatus === 'READY'
                );
                setAgents(ready);
            } else if (
                evt.method === 'agent.run_interrupt' ||
                evt.method === 'agent.run_resumed' ||
                (evt.method === 'agent.run_event' && evt.params.event_type === 'status')
            ) {
                mesh.listAgentRuns(20, { status: 'WAITING_FOR_INPUT' })
                    .then(setWaitingRuns)
                    .catch(() => {});
                if (selectedAgent) {
                    loadAgentRuns(selectedAgent.agentId, true);
                }
            }
        });

        return () => unsub();
    }, [mesh, selectedAgent, loadAgentRuns]);

    const findAgentForRun = (run: AgentRunDTO): RegisteredAgentDTO | undefined =>
        agents.find((a) => a.agentId === run.agentId);

    // =========================================================================
    // LEVEL 2: SELECTED AGENT — NEW RUN + FILTERED RECENT RUNS
    // =========================================================================
    if (selectedAgent) {
        return (
            <View style={styles.container}>
                <View style={styles.header}>
                    <TouchableOpacity
                        onPress={() => setSelectedAgent(null)}
                        style={styles.iconBtn}
                    >
                        <Ionicons name="arrow-back" size={22} color="#F8FAFC" />
                    </TouchableOpacity>
                    <View style={styles.headerCenter}>
                        <Text style={styles.headerTitle} numberOfLines={1}>
                            {selectedAgent.name}
                        </Text>
                        <Text style={styles.headerSub} numberOfLines={1}>
                            v{selectedAgent.version} • Per-Agent Run History
                        </Text>
                    </View>
                    <TouchableOpacity
                        onPress={() => loadAgentRuns(selectedAgent.agentId, false)}
                        style={styles.iconBtn}
                    >
                        <Ionicons name="refresh" size={20} color="#94A3B8" />
                    </TouchableOpacity>
                </View>

                <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    refreshControl={
                        <RefreshControl
                            refreshing={loadingAgentRuns}
                            onRefresh={() => loadAgentRuns(selectedAgent.agentId, false)}
                            tintColor="#6366F1"
                        />
                    }
                >
                    <View style={styles.agentHeroCard}>
                        {!!selectedAgent.manifest.description && (
                            <Text style={styles.agentDesc}>
                                {selectedAgent.manifest.description}
                            </Text>
                        )}
                        <TouchableOpacity
                            style={styles.newRunBtn}
                            onPress={() => onSelectAgentToLaunch(selectedAgent)}
                            activeOpacity={0.85}
                        >
                            <Ionicons name="play" size={16} color="#FFFFFF" />
                            <Text style={styles.newRunBtnText}>New Run</Text>
                        </TouchableOpacity>
                    </View>

                    <Text style={styles.sectionLabel}>
                        RECENT RUNS ({agentRuns.length})
                    </Text>

                    {loadingAgentRuns && agentRuns.length === 0 ? (
                        <View style={styles.centerBox}>
                            <ActivityIndicator size="large" color="#6366F1" />
                            <Text style={styles.centerText}>Loading runs...</Text>
                        </View>
                    ) : agentRuns.length === 0 ? (
                        <View style={styles.emptyCard}>
                            <Text style={styles.emptyText}>
                                No runs yet for {selectedAgent.name}. Tap New Run above to launch it on the mesh.
                            </Text>
                        </View>
                    ) : (
                        agentRuns.map((run) => {
                            const color = getStatusColor(run.status);
                            const isMobile = run.originClientId.startsWith('mobile:');
                            return (
                                <TouchableOpacity
                                    key={run.runId}
                                    style={styles.runRow}
                                    onPress={() => onOpenRun(run, selectedAgent)}
                                    activeOpacity={0.8}
                                >
                                    <View style={styles.runRowLeft}>
                                        <View
                                            style={[styles.statusDot, { backgroundColor: color }]}
                                        />
                                        <View style={{ flex: 1 }}>
                                            <Text style={styles.runAgentName} numberOfLines={1}>
                                                {String(
                                                    run.inputs?.brief ||
                                                    run.inputs?.prompt ||
                                                    run.inputs?.query ||
                                                    run.runId.slice(0, 18)
                                                )}
                                            </Text>
                                            <Text style={styles.runMeta} numberOfLines={1}>
                                                {isMobile ? '📱 Mobile' : '💻 Desktop'} •{' '}
                                                {new Date(run.startedAtMs).toLocaleTimeString([], {
                                                    hour: '2-digit',
                                                    minute: '2-digit',
                                                })}
                                                {run.artifacts.length > 0
                                                    ? ` • ${run.artifacts.length} file(s)`
                                                    : ''}
                                            </Text>
                                        </View>
                                    </View>
                                    <View
                                        style={[
                                            styles.statusBadge,
                                            {
                                                borderColor: `${color}66`,
                                                backgroundColor: `${color}20`,
                                            },
                                        ]}
                                    >
                                        <Text style={[styles.statusBadgeText, { color }]}>
                                            {run.status === 'WAITING_FOR_INPUT'
                                                ? 'INPUT'
                                                : run.status}
                                        </Text>
                                    </View>
                                </TouchableOpacity>
                            );
                        })
                    )}
                </ScrollView>
            </View>
        );
    }

    // =========================================================================
    // LEVEL 1: AGENTS TAB (CLEAN AGENT CARDS + PAUSED INTERRUPT BANNER ONLY)
    // =========================================================================
    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
                    <Ionicons name="arrow-back" size={22} color="#F8FAFC" />
                </TouchableOpacity>
                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle}>🤖 Mesh Agents</Text>
                    <Text style={styles.headerSub} numberOfLines={1}>
                        {desktopName ? `Control Plane • ${desktopName}` : 'Disconnected'}
                    </Text>
                </View>
                <TouchableOpacity onPress={() => loadHubData(true)} style={styles.iconBtn}>
                    <Ionicons name="refresh" size={20} color="#94A3B8" />
                </TouchableOpacity>
            </View>

            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => loadHubData(true)}
                        tintColor="#6366F1"
                    />
                }
            >
                {/* Keep paused-run banner visible so cross-device interrupts are always 1-tap reachable */}
                {waitingRuns.length > 0 && (
                    <View style={styles.needsInputSection}>
                        {waitingRuns.map((run) => (
                            <TouchableOpacity
                                key={run.runId}
                                style={styles.needsInputBanner}
                                onPress={() => onOpenRun(run, findAgentForRun(run))}
                                activeOpacity={0.85}
                            >
                                <View style={styles.needsInputIcon}>
                                    <Ionicons name="alert-circle" size={22} color="#0F172A" />
                                </View>
                                <View style={styles.needsInputBody}>
                                    <Text style={styles.needsInputTitle}>
                                        Needs Your Input — {run.agentName || run.agentId}
                                    </Text>
                                    <Text style={styles.needsInputSub} numberOfLines={2}>
                                        {String(
                                            run.pendingInterrupt?.payload?.message ||
                                            run.pendingInterrupt?.payload?.prompt ||
                                            'Tap to answer or approve this paused agent run.'
                                        )}
                                    </Text>
                                </View>
                                <Ionicons name="chevron-forward" size={18} color="#FDE68A" />
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {loading ? (
                    <View style={styles.centerBox}>
                        <ActivityIndicator size="large" color="#6366F1" />
                        <Text style={styles.centerText}>Fetching READY agents from Desktop...</Text>
                    </View>
                ) : error ? (
                    <View style={styles.errorCard}>
                        <Ionicons name="cloud-offline-outline" size={28} color="#F87171" />
                        <Text style={styles.errorText}>{error}</Text>
                        <TouchableOpacity
                            style={styles.retryBtn}
                            onPress={() => loadHubData(true)}
                        >
                            <Text style={styles.retryBtnText}>Retry Mesh Scan</Text>
                        </TouchableOpacity>
                    </View>
                ) : (
                    <>
                        <Text style={styles.sectionLabel}>
                            READY AGENTS ({agents.length})
                        </Text>

                        {agents.length === 0 ? (
                            <View style={styles.emptyCard}>
                                <Text style={styles.emptyText}>
                                    No READY agents registered on Desktop yet. Register a Python agent folder in the Desktop Admin UI first.
                                </Text>
                            </View>
                        ) : (
                            agents.map((agent) => (
                                <TouchableOpacity
                                    key={agent.agentId}
                                    style={styles.agentCard}
                                    onPress={() => setSelectedAgent(agent)}
                                    activeOpacity={0.8}
                                >
                                    <View style={styles.agentCardTop}>
                                        <View style={styles.agentTitleRow}>
                                            <Text style={styles.agentName}>{agent.name}</Text>
                                            <View style={styles.versionPill}>
                                                <Text style={styles.versionText}>
                                                    v{agent.version}
                                                </Text>
                                            </View>
                                        </View>
                                        <View style={styles.readyBadge}>
                                            <Text style={styles.readyBadgeText}>READY</Text>
                                        </View>
                                    </View>

                                    {!!agent.manifest.description && (
                                        <Text style={styles.agentDesc} numberOfLines={2}>
                                            {agent.manifest.description}
                                        </Text>
                                    )}

                                    <View style={styles.agentFooter}>
                                        <Text style={styles.agentMeta}>
                                            Tap to view runs
                                        </Text>
                                        <TouchableOpacity
                                            style={styles.launchPill}
                                            onPress={() => onSelectAgentToLaunch(agent)}
                                        >
                                            <Ionicons name="play" size={12} color="#FFFFFF" />
                                            <Text style={styles.launchPillText}>New Run</Text>
                                        </TouchableOpacity>
                                    </View>
                                </TouchableOpacity>
                            ))
                        )}
                    </>
                )}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0F172A' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#1E293B',
        backgroundColor: '#0F172A',
    },
    iconBtn: {
        width: 38,
        height: 38,
        borderRadius: 10,
        backgroundColor: '#1E293B',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerCenter: { flex: 1, marginHorizontal: 12 },
    headerTitle: { color: '#F8FAFC', fontSize: 17, fontWeight: '700' },
    headerSub: { color: '#94A3B8', fontSize: 12, marginTop: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: 16, paddingBottom: 40 },
    needsInputSection: { marginBottom: 18, gap: 10 },
    needsInputBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#78350F',
        borderWidth: 1,
        borderColor: '#F59E0B',
        borderRadius: 14,
        padding: 12,
        gap: 10,
    },
    needsInputIcon: {
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: '#F59E0B',
        alignItems: 'center',
        justifyContent: 'center',
    },
    needsInputBody: { flex: 1 },
    needsInputTitle: { color: '#FEF3C7', fontSize: 13, fontWeight: '700' },
    needsInputSub: { color: '#FDE68A', fontSize: 12, marginTop: 2 },
    sectionLabel: {
        color: '#94A3B8',
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.8,
        marginBottom: 10,
    },
    centerBox: { alignItems: 'center', paddingVertical: 48, gap: 12 },
    centerText: { color: '#94A3B8', fontSize: 13 },
    errorCard: {
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#EF444455',
        borderRadius: 14,
        padding: 20,
        alignItems: 'center',
        gap: 10,
    },
    errorText: { color: '#FCA5A5', fontSize: 13, textAlign: 'center' },
    retryBtn: {
        backgroundColor: '#6366F1',
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 10,
        marginTop: 4,
    },
    retryBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
    emptyCard: {
        backgroundColor: '#1E293B80',
        borderWidth: 1,
        borderColor: '#334155',
        borderStyle: 'dashed',
        borderRadius: 14,
        padding: 18,
    },
    emptyText: { color: '#94A3B8', fontSize: 13, textAlign: 'center', lineHeight: 19 },
    agentHeroCard: {
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
        borderRadius: 14,
        padding: 14,
        marginBottom: 18,
        gap: 12,
    },
    newRunBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#4F46E5',
        paddingVertical: 11,
        borderRadius: 12,
    },
    newRunBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
    agentCard: {
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
        borderRadius: 14,
        padding: 14,
        marginBottom: 12,
    },
    agentCardTop: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
    },
    agentTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
    agentName: { color: '#F8FAFC', fontSize: 15, fontWeight: '700', flexShrink: 1 },
    versionPill: {
        backgroundColor: '#0F172A',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 6,
    },
    versionText: { color: '#94A3B8', fontSize: 11, fontFamily: 'monospace' },
    readyBadge: {
        backgroundColor: '#10B98122',
        borderWidth: 1,
        borderColor: '#10B98166',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 10,
    },
    readyBadgeText: { color: '#34D399', fontSize: 10, fontWeight: '700' },
    agentDesc: { color: '#CBD5E1', fontSize: 12, marginTop: 6, lineHeight: 18 },
    agentFooter: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 12,
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: '#33415580',
    },
    agentMeta: { color: '#94A3B8', fontSize: 12 },
    launchPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        backgroundColor: '#4F46E5',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 10,
    },
    launchPillText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
    runRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
        gap: 10,
    },
    runRowLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
    statusDot: { width: 9, height: 9, borderRadius: 5 },
    runAgentName: { color: '#F8FAFC', fontSize: 13, fontWeight: '600' },
    runMeta: { color: '#94A3B8', fontSize: 11, marginTop: 2 },
    statusBadge: {
        borderWidth: 1,
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 8,
    },
    statusBadgeText: { fontSize: 10, fontWeight: '700' },
});
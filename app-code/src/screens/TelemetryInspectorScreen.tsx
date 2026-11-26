import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    FlatList,
    ScrollView,
    StyleSheet,
    ActivityIndicator,
    StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TelemetryService } from '../services/TelemetryService';
import {
    TelemetrySessionSummary,
    TelemetrySessionSource,
    TelemetrySpanRecord,
} from '../database/repository';

interface Props {
    onBack: () => void;
    initialSessionId?: string | null;
    initialTraceId?: string | null;
}

interface TraceTurnGroup {
    traceId: string;
    queryPreview: string;
    targetNode: string;
    totalDurationMs: number;
    ttftMs: number | null;
    tokPerSec: number | null;
    totalTokens: number;
    hasError: boolean;
    unsyncedCount: number;
    createdAt: number;
    spans: TelemetrySpanRecord[];
}

type FilterOption = 'all' | 'chat' | 'mindspace' | 'studio';

function formatRelativeTime(epochMs: number): string {
    const diffSec = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    return `${diffDay}d ago`;
}

function getSourceBadge(source: TelemetrySessionSource): { label: string; color: string; bg: string } {
    switch (source) {
        case 'chat':
            return { label: 'Chat', color: '#38BDF8', bg: '#0284C725' };
        case 'mindspace':
            return { label: 'MindSpace', color: '#A78BFA', bg: '#7C3AED25' };
        case 'studio':
            return { label: 'Studio', color: '#34D399', bg: '#05966925' };
        default:
            return { label: 'Mesh', color: '#94A3B8', bg: '#33415550' };
    }
}

function getSpanBarColor(span: TelemetrySpanRecord): string {
    if (span.status === 'ERROR') return '#EF4444';
    if (span.name === 'desktop.queue_wait') return '#F59E0B';
    if (span.observation_type === 'generation') return '#10B981';
    if (span.observation_type === 'tool') return '#A855F7';
    if (span.observation_type === 'retriever') return '#3B82F6';
    return '#06B6D4';
}

export const TelemetryInspectorScreen: React.FC<Props> = ({ onBack, initialSessionId = null, initialTraceId = null, }) => {
    const insets = useSafeAreaInsets();
    const telemetry = TelemetryService.getInstance();

    // Shared sync status state
    const [unsyncedCount, setUnsyncedCount] = useState(0);
    const [desktopReady, setDesktopReady] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [activeSessionId, setActiveSessionId] = useState<string>('');

    // Level 1: Sessions list state
    const [sessions, setSessions] = useState<TelemetrySessionSummary[]>([]);
    const [filter, setFilter] = useState<FilterOption>('all');
    const [isLoadingSessions, setIsLoadingSessions] = useState(true);

    // Level 2: Selected session waterfall state
    const [selectedSession, setSelectedSession] = useState<TelemetrySessionSummary | null>(null);
    const [turns, setTurns] = useState<TraceTurnGroup[]>([]);
    const [isLoadingTurns, setIsLoadingTurns] = useState(false);
    const [expandedSpanIds, setExpandedSpanIds] = useState<Record<string, boolean>>({});

    const [activeTraceFilter, setActiveTraceFilter] = useState<string | null>(initialTraceId);

    useEffect(() => {
        setActiveTraceFilter(initialTraceId);
    }, [initialTraceId]);

    const loadSessions = useCallback(async () => {
        try {
            const data = await telemetry.getSessionSummaries();
            setUnsyncedCount(data.unsyncedCount);
            setDesktopReady(data.desktopReady);
            setActiveSessionId(data.activeSessionId);
            setSessions(data.sessions);

            if (initialSessionId && !selectedSession) {
                const match = data.sessions.find((s) => s.session_id === initialSessionId);
                if (match) {
                    setSelectedSession(match);
                }
            }
        } finally {
            setIsLoadingSessions(false);
        }
    }, [initialSessionId, selectedSession]);

    const loadSessionDetail = useCallback(
        async (session: TelemetrySessionSummary, silent: boolean = false) => {
            if (!silent) {
                setIsLoadingTurns(true);
            }
            try {
                const data = await telemetry.getSessionTraceDetail(session.session_id);
                setUnsyncedCount(data.unsyncedCount);
                setDesktopReady(data.desktopReady);

                const traceMap = new Map<string, TelemetrySpanRecord[]>();
                for (const span of data.spans) {
                    const list = traceMap.get(span.trace_id) || [];
                    list.push(span);
                    traceMap.set(span.trace_id, list);
                }

                const grouped: TraceTurnGroup[] = [];
                traceMap.forEach((spanList, traceId) => {
                    const sorted = [...spanList].sort((a, b) => a.created_at - b.created_at);
                    const rootSpan =
                        sorted.find((s) => s.name === 'client.turn_orchestration') ||
                        sorted[sorted.length - 1];
                    const genSpans = sorted.filter((s) => s.observation_type === 'generation');

                    let queryPreview = '';
                    let targetNode = '';
                    try {
                        const rootAttrs = JSON.parse(rootSpan?.attributes_json || '{}');
                        queryPreview = rootAttrs['user.query_preview'] || '';
                        targetNode = rootAttrs['target.compute_node'] || '';
                    } catch {}

                    if (!queryPreview) {
                        const retrieverSpan = sorted.find((s) => s.observation_type === 'retriever');
                        if (retrieverSpan) {
                            try {
                                const rAttrs = JSON.parse(retrieverSpan.attributes_json || '{}');
                                queryPreview = rAttrs['rag.query'] || '';
                            } catch {}
                        }
                    }

                    const firstTtft =
                        genSpans.find((g) => g.ttft_ms && g.ttft_ms > 0)?.ttft_ms ||
                        rootSpan?.ttft_ms ||
                        null;

                    const validTokSpans = genSpans.filter((g) => g.tok_per_sec && g.tok_per_sec > 0);
                    const avgTokPerSec =
                        validTokSpans.length > 0
                            ? parseFloat(
                                (
                                    validTokSpans.reduce((acc, g) => acc + (g.tok_per_sec || 0), 0) /
                                    validTokSpans.length
                                ).toFixed(1)
                            )
                            : rootSpan?.tok_per_sec || null;

                    const totalTokens = genSpans.reduce(
                        (acc, g) => acc + (g.completion_tokens || 0),
                        0
                    );

                    const nonRootSpans = sorted.filter((s) => s.name !== 'client.turn_orchestration');
                    const computedTotalMs =
                        rootSpan?.duration_ms ||
                        nonRootSpans.reduce((acc, s) => acc + s.duration_ms, 0);

                    grouped.push({
                        traceId,
                        queryPreview: queryPreview || `Trace ${traceId.substring(0, 10)}`,
                        targetNode: targetNode || rootSpan?.target_device || 'local',
                        totalDurationMs: Math.max(1, computedTotalMs),
                        ttftMs: firstTtft,
                        tokPerSec: avgTokPerSec,
                        totalTokens,
                        hasError: sorted.some((s) => s.status === 'ERROR'),
                        unsyncedCount: sorted.filter((s) => s.synced_to_server === 0).length,
                        createdAt: rootSpan?.created_at || sorted[sorted.length - 1]?.created_at || Date.now(),
                        spans: nonRootSpans.length > 0 ? nonRootSpans : sorted,
                    });
                });

                grouped.sort((a, b) => b.createdAt - a.createdAt);
                setTurns(grouped);
            } catch (err) {
                console.warn('[TelemetryInspectorScreen] loadSessionDetail error:', err);
            } finally {
                if (!silent) {
                    setIsLoadingTurns(false);
                }
            }
        },
        []
    );

    useEffect(() => {
        loadSessions();
        const unsub = telemetry.subscribe(() => {
            loadSessions();
            if (selectedSession) {
                loadSessionDetail(selectedSession, true);
            }
        });
        return unsub;
    }, [selectedSession]);

    useEffect(() => {
        if (selectedSession) {
            setExpandedSpanIds({});
            loadSessionDetail(selectedSession);
        }
    }, [selectedSession, loadSessionDetail]);

    const handleManualSync = async () => {
        setIsSyncing(true);
        try {
            await telemetry.flushOutbox();
            await loadSessions();
            if (selectedSession) {
                await loadSessionDetail(selectedSession, true);
            }
        } finally {
            setIsSyncing(false);
        }
    };

    const toggleSpanExpand = (spanId: string) => {
        setExpandedSpanIds((prev) => ({ ...prev, [spanId]: !prev[spanId] }));
    };

    const filteredSessions = sessions.filter((s) => {
        if (filter === 'all') return true;
        return s.source === filter;
    });

    const displayedTurns = activeTraceFilter
        ? turns.filter((t) => t.traceId === activeTraceFilter)
        : turns;

    const renderSpanSubline = (span: TelemetrySpanRecord): string => {
        try {
            const attrs = JSON.parse(span.attributes_json || '{}');
            if (span.observation_type === 'tool') {
                return `Args: ${attrs['tool.args'] || '{}'}`;
            }
            if (span.name === 'desktop.queue_wait') {
                return `Priority ${attrs['queue.priority'] ?? 1} • Depth ${attrs['queue.initial_depth'] ?? 1}`;
            }
            if (span.observation_type === 'generation') {
                const model = attrs['gen_ai.request.model'] || 'LLM';
                const vram = attrs['hardware.vram_used_mb'] ? ` • ${attrs['hardware.vram_used_mb']}MB VRAM` : '';
                return `${model} • ${span.completion_tokens || 0} tok (${span.tok_per_sec || 0} t/s)${vram}`;
            }
            if (span.observation_type === 'retriever') {
                return `Scope: ${attrs['rag.scope'] || 'hybrid'} • Top-K: ${attrs['rag.top_k_chunks'] ?? 0}`;
            }
            if (attrs['vision.module']) {
                return `${attrs['vision.module']} • ${attrs['vision.text_length_chars'] || 0} chars`;
            }
        } catch {}
        return span.target_device;
    };

    const renderExpandedDetails = (span: TelemetrySpanRecord) => {
        let attrs: Record<string, any> = {};
        try {
            attrs = JSON.parse(span.attributes_json || '{}');
        } catch {}

        const detailRows: Array<{ label: string; value: string }> = [
            { label: 'Device', value: span.target_device },
            { label: 'Type', value: span.observation_type.toUpperCase() },
            { label: 'Sync', value: span.synced_to_server === 1 ? 'Synced to Langfuse' : 'Pending Outbox' },
        ];

        if (span.ttft_ms) detailRows.push({ label: 'TTFT', value: `${span.ttft_ms}ms` });
        if (span.prompt_tokens) detailRows.push({ label: 'Prompt Tokens', value: String(span.prompt_tokens) });
        if (span.completion_tokens) detailRows.push({ label: 'Output Tokens', value: String(span.completion_tokens) });
        if (span.tok_per_sec) detailRows.push({ label: 'Speed', value: `${span.tok_per_sec} tok/s` });
        if (attrs['hardware.vram_used_mb']) {
            detailRows.push({ label: 'GPU VRAM', value: `${attrs['hardware.vram_used_mb']} MB` });
        }
        if (attrs['queue.priority'] !== undefined) {
            detailRows.push({ label: 'Queue Priority', value: String(attrs['queue.priority']) });
        }
        if (attrs['tool.args']) {
            detailRows.push({ label: 'Tool Args', value: String(attrs['tool.args']) });
        }
        if (attrs['tool.output']) {
            detailRows.push({ label: 'Tool Output', value: String(attrs['tool.output']).substring(0, 220) });
        }
        if (attrs['gen_ai.completion']) {
            detailRows.push({
                label: 'Completion',
                value: String(attrs['gen_ai.completion']).substring(0, 260),
            });
        }
        if (span.error_message) {
            detailRows.push({ label: 'Error', value: span.error_message });
        }

        return (
            <View style={styles.expandedBox}>
                {detailRows.map((row) => (
                    <View key={row.label} style={styles.detailRow}>
                        <Text style={styles.detailLabel}>{row.label}:</Text>
                        <Text style={styles.detailValue}>{row.value}</Text>
                    </View>
                ))}
            </View>
        );
    };

    return (
        <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
            <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

            {/* Top Header */}
            <View style={styles.header}>
                <TouchableOpacity
                    style={styles.backBtn}
                    onPress={() => {
                        if (selectedSession) {
                            setSelectedSession(null);
                        } else {
                            onBack();
                        }
                    }}
                >
                    <Text style={styles.backBtnText}>
                        {selectedSession ? '‹ Sessions' : '‹ Back'}
                    </Text>
                </TouchableOpacity>

                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle} numberOfLines={1}>
                        {selectedSession ? selectedSession.title : 'Telemetry Inspector'}
                    </Text>
                    <Text style={styles.headerSubtitle} numberOfLines={1}>
                        {selectedSession
                            ? `${turns.length} turn(s) • ${selectedSession.session_id.substring(0, 20)}`
                            : `${sessions.length} traced conversation(s)`}
                    </Text>
                </View>

                <TouchableOpacity
                    style={[styles.syncBtn, isSyncing && styles.syncBtnDisabled]}
                    onPress={handleManualSync}
                    disabled={isSyncing}
                >
                    {isSyncing ? (
                        <ActivityIndicator size="small" color="#F8FAFC" />
                    ) : (
                        <Text style={styles.syncBtnText}>Sync</Text>
                    )}
                </TouchableOpacity>
            </View>

            {/* Outbox / Langfuse Sync Status Strip */}
            <View style={styles.syncStrip}>
                <View style={styles.syncLeft}>
                    <View
                        style={[
                            styles.statusDot,
                            unsyncedCount === 0 && desktopReady ? styles.dotGreen : styles.dotAmber,
                        ]}
                    />
                    <Text style={styles.syncStripText} numberOfLines={1}>
                        {unsyncedCount === 0
                            ? desktopReady
                                ? 'Langfuse Connected • All spans synced'
                                : 'All local spans synced • Desktop idle'
                            : `Offline Outbox • ${unsyncedCount} span(s) queued`}
                    </Text>
                </View>
                <Text style={styles.syncStripHint}>Tap span to inspect</Text>
            </View>

            {activeTraceFilter && (
                <View style={styles.traceFilterBar}>
                    <Text style={styles.traceFilterText} numberOfLines={1}>
                        🔍 Trace Filter: {activeTraceFilter}
                    </Text>
                    <TouchableOpacity onPress={() => setActiveTraceFilter(null)}>
                        <Text style={styles.traceFilterClear}>Clear</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* LEVEL 1: Multi-Conversation Sessions List */}
            {!selectedSession ? (
                <View style={styles.body}>
                    {/* Filter Pills */}
                    <View style={styles.filterRow}>
                        {(['all', 'chat', 'mindspace', 'studio'] as FilterOption[]).map((opt) => {
                            const isActive = filter === opt;
                            const label =
                                opt === 'all'
                                    ? 'All'
                                    : opt === 'chat'
                                        ? 'Chat'
                                        : opt === 'mindspace'
                                            ? 'MindSpace'
                                            : 'Studio';
                            return (
                                <TouchableOpacity
                                    key={opt}
                                    style={[styles.filterPill, isActive && styles.filterPillActive]}
                                    onPress={() => setFilter(opt)}
                                >
                                    <Text
                                        style={[
                                            styles.filterPillText,
                                            isActive && styles.filterPillTextActive,
                                        ]}
                                    >
                                        {label}
                                    </Text>
                                </TouchableOpacity>
                            );
                        })}
                    </View>

                    {isLoadingSessions ? (
                        <View style={styles.centerEmpty}>
                            <ActivityIndicator size="large" color="#38BDF8" />
                        </View>
                    ) : (
                        <FlatList
                            data={filteredSessions}
                            keyExtractor={(item) => item.session_id}
                            contentContainerStyle={styles.listContent}
                            ListEmptyComponent={
                                <View style={styles.centerEmpty}>
                                    <Text style={styles.emptyTitle}>No Traced Conversations Yet</Text>
                                    <Text style={styles.emptyDesc}>
                                        Send a prompt in Chat, MindSpace, or Studio to start capturing distributed waterfall spans.
                                    </Text>
                                </View>
                            }
                            renderItem={({ item }) => {
                                const badge = getSourceBadge(item.source);
                                const isCurrent = item.session_id === activeSessionId;
                                return (
                                    <TouchableOpacity
                                        style={[
                                            styles.sessionCard,
                                            isCurrent && styles.sessionCardActive,
                                        ]}
                                        onPress={() => setSelectedSession(item)}
                                        activeOpacity={0.75}
                                    >
                                        <View style={styles.sessionTopRow}>
                                            <View style={styles.sessionTitleRow}>
                                                <View style={[styles.sourceBadge, { backgroundColor: badge.bg }]}>
                                                    <Text style={[styles.sourceBadgeText, { color: badge.color }]}>
                                                        {badge.label}
                                                    </Text>
                                                </View>
                                                <Text style={styles.sessionTitle} numberOfLines={1}>
                                                    {item.title}
                                                </Text>
                                            </View>
                                            <Text style={styles.sessionTime}>
                                                {formatRelativeTime(item.last_activity_at)}
                                            </Text>
                                        </View>

                                        <View style={styles.sessionMetaRow}>
                                            <Text style={styles.sessionStat}>
                                                {item.turn_count} {item.turn_count === 1 ? 'turn' : 'turns'} • {item.span_count} spans
                                            </Text>
                                            <Text style={styles.sessionMetrics}>
                                                {item.avg_ttft_ms ? `TTFT ${item.avg_ttft_ms}ms` : 'TTFT —'}
                                                {item.avg_tok_per_sec ? ` • ${item.avg_tok_per_sec} t/s` : ''}
                                            </Text>
                                        </View>

                                        {(item.unsynced_count > 0 || isCurrent) && (
                                            <View style={styles.sessionFooterRow}>
                                                {isCurrent && (
                                                    <Text style={styles.activeTag}>● Active Chat</Text>
                                                )}
                                                {item.unsynced_count > 0 && (
                                                    <Text style={styles.unsyncedTag}>
                                                        ⏳ {item.unsynced_count} queued
                                                    </Text>
                                                )}
                                            </View>
                                        )}
                                    </TouchableOpacity>
                                );
                            }}
                        />
                    )}
                </View>
            ) : (
                /* LEVEL 2: Conversation Turn-by-Turn Waterfall View */
                <View style={styles.body}>
                    {isLoadingTurns ? (
                        <View style={styles.centerEmpty}>
                            <ActivityIndicator size="large" color="#38BDF8" />
                        </View>
                    ) : (
                        <ScrollView contentContainerStyle={styles.listContent}>
                            {/* Color Legend */}
                            <View style={styles.legendRow}>
                                <View style={styles.legendItem}>
                                    <View style={[styles.legendDot, { backgroundColor: '#3B82F6' }]} />
                                    <Text style={styles.legendText}>RAG</Text>
                                </View>
                                <View style={styles.legendItem}>
                                    <View style={[styles.legendDot, { backgroundColor: '#F59E0B' }]} />
                                    <Text style={styles.legendText}>Queue</Text>
                                </View>
                                <View style={styles.legendItem}>
                                    <View style={[styles.legendDot, { backgroundColor: '#10B981' }]} />
                                    <Text style={styles.legendText}>LLM</Text>
                                </View>
                                <View style={styles.legendItem}>
                                    <View style={[styles.legendDot, { backgroundColor: '#A855F7' }]} />
                                    <Text style={styles.legendText}>Tool</Text>
                                </View>
                            </View>

                            {displayedTurns.length === 0 ? (
                                    <View style={styles.centerEmpty}>
                                        <Text style={styles.emptyTitle}>No Matching Spans Found</Text>
                                        {activeTraceFilter && (
                                            <Text style={styles.emptyDesc}>
                                                Trace {activeTraceFilter.substring(0, 14)} has no spans in local mobile SQLite (agent gateway spans live on Desktop / Langfuse).
                                            </Text>
                                        )}
                                    </View>
                            ) : (
                                displayedTurns.map((turn, turnIndex) => {
                                    const turnNumber = displayedTurns.length - turnIndex;
                                    return (
                                        <View key={turn.traceId} style={styles.turnCard}>
                                            {/* Turn Header */}
                                            <View style={styles.turnHeader}>
                                                <View style={styles.turnTitleRow}>
                                                    <Text style={styles.turnIndexBadge}>#{turnNumber}</Text>
                                                    <Text style={styles.turnQuery} numberOfLines={2}>
                                                        {turn.queryPreview}
                                                    </Text>
                                                </View>
                                                <Text style={styles.turnTime}>
                                                    {formatRelativeTime(turn.createdAt)}
                                                </Text>
                                            </View>

                                            {/* Turn Aggregate Chips */}
                                            <View style={styles.turnStatsBar}>
                                                <Text style={styles.turnStatChip}>
                                                    ⏱ {turn.totalDurationMs}ms
                                                </Text>
                                                {turn.ttftMs !== null && (
                                                    <Text style={styles.turnStatChip}>
                                                        ⚡ TTFT {turn.ttftMs}ms
                                                    </Text>
                                                )}
                                                {turn.tokPerSec !== null && (
                                                    <Text style={styles.turnStatChip}>
                                                        🚀 {turn.tokPerSec} t/s
                                                    </Text>
                                                )}
                                                {turn.totalTokens > 0 && (
                                                    <Text style={styles.turnStatChip}>
                                                        🔤 {turn.totalTokens} tok
                                                    </Text>
                                                )}
                                            </View>

                                            {/* Proportional Span Waterfall */}
                                            <View style={styles.spanList}>
                                                {turn.spans.map((span) => {
                                                    const isExpanded = !!expandedSpanIds[span.span_id];
                                                    const deviceIcon = span.target_device.includes('desktop')
                                                        ? '💻'
                                                        : '📱';
                                                    const barColor = getSpanBarColor(span);
                                                    const barPct = Math.max(
                                                        4,
                                                        Math.min(
                                                            100,
                                                            Math.round(
                                                                (span.duration_ms /
                                                                    Math.max(turn.totalDurationMs, 1)) *
                                                                100
                                                            )
                                                        )
                                                    );

                                                    return (
                                                        <TouchableOpacity
                                                            key={span.span_id}
                                                            style={styles.spanItem}
                                                            onPress={() => toggleSpanExpand(span.span_id)}
                                                            activeOpacity={0.75}
                                                        >
                                                            <View style={styles.spanTopRow}>
                                                                <Text style={styles.spanName} numberOfLines={1}>
                                                                    {deviceIcon} {span.name}
                                                                </Text>
                                                                <View style={styles.spanRight}>
                                                                    <Text style={styles.spanDuration}>
                                                                        {span.duration_ms}ms
                                                                    </Text>
                                                                    <Text
                                                                        style={[
                                                                            styles.spanStatus,
                                                                            span.status === 'OK'
                                                                                ? styles.statusOk
                                                                                : styles.statusErr,
                                                                        ]}
                                                                    >
                                                                        {span.status}
                                                                    </Text>
                                                                </View>
                                                            </View>

                                                            {/* Proportional Latency Bar */}
                                                            <View style={styles.barTrack}>
                                                                <View
                                                                    style={[
                                                                        styles.barFill,
                                                                        {
                                                                            width: `${barPct}%`,
                                                                            backgroundColor: barColor,
                                                                        },
                                                                    ]}
                                                                />
                                                            </View>

                                                            <Text style={styles.spanSubline} numberOfLines={1}>
                                                                {renderSpanSubline(span)}
                                                            </Text>

                                                            {isExpanded && renderExpandedDetails(span)}
                                                        </TouchableOpacity>
                                                    );
                                                })}
                                            </View>
                                        </View>
                                    );
                                })
                            )}
                        </ScrollView>
                    )}
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    screen: {
        flex: 1,
        backgroundColor: '#0F172A',
    },
    header: {
        height: 54,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#1E293B',
    },
    backBtn: {
        paddingVertical: 6,
        paddingHorizontal: 6,
        minWidth: 72,
    },
    backBtnText: {
        color: '#38BDF8',
        fontSize: 15,
        fontWeight: '600',
    },
    headerCenter: {
        flex: 1,
        alignItems: 'center',
        marginHorizontal: 6,
    },
    headerTitle: {
        color: '#F8FAFC',
        fontSize: 15,
        fontWeight: '700',
    },
    headerSubtitle: {
        color: '#64748B',
        fontSize: 10,
        marginTop: 1,
    },
    syncBtn: {
        backgroundColor: '#2563EB',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 7,
        minWidth: 56,
        alignItems: 'center',
    },
    syncBtnDisabled: {
        opacity: 0.6,
    },
    syncBtnText: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '700',
    },
    syncStrip: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 14,
        paddingVertical: 8,
        backgroundColor: '#1E293B',
        borderBottomWidth: 1,
        borderBottomColor: '#334155',
    },
    syncLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    statusDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    dotGreen: { backgroundColor: '#10B981' },
    dotAmber: { backgroundColor: '#F59E0B' },
    syncStripText: {
        color: '#E2E8F0',
        fontSize: 11,
        fontWeight: '600',
        flex: 1,
    },
    syncStripHint: {
        color: '#64748B',
        fontSize: 10,
    },
    body: {
        flex: 1,
    },
    filterRow: {
        flexDirection: 'row',
        paddingHorizontal: 14,
        paddingVertical: 10,
        gap: 8,
    },
    filterPill: {
        paddingHorizontal: 12,
        paddingVertical: 5,
        borderRadius: 14,
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
    },
    filterPillActive: {
        backgroundColor: '#0284C725',
        borderColor: '#38BDF8',
    },
    filterPillText: {
        color: '#94A3B8',
        fontSize: 12,
        fontWeight: '600',
    },
    filterPillTextActive: {
        color: '#38BDF8',
        fontWeight: '700',
    },
    listContent: {
        paddingHorizontal: 14,
        paddingBottom: 24,
    },
    centerEmpty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
        marginTop: 40,
    },
    emptyTitle: {
        color: '#F8FAFC',
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 6,
    },
    emptyDesc: {
        color: '#64748B',
        fontSize: 12,
        textAlign: 'center',
        lineHeight: 18,
    },
    sessionCard: {
        backgroundColor: '#1E293B',
        borderRadius: 10,
        padding: 12,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#334155',
    },
    sessionCardActive: {
        borderColor: '#38BDF8',
    },
    sessionTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
    },
    sessionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flex: 1,
    },
    sourceBadge: {
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 5,
    },
    sourceBadgeText: {
        fontSize: 10,
        fontWeight: '700',
    },
    sessionTitle: {
        color: '#F8FAFC',
        fontSize: 14,
        fontWeight: '700',
        flex: 1,
    },
    sessionTime: {
        color: '#64748B',
        fontSize: 11,
    },
    sessionMetaRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginTop: 8,
    },
    sessionStat: {
        color: '#94A3B8',
        fontSize: 11,
    },
    sessionMetrics: {
        color: '#38BDF8',
        fontSize: 11,
        fontFamily: 'monospace',
        fontWeight: '600',
    },
    sessionFooterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginTop: 6,
        paddingTop: 6,
        borderTopWidth: 1,
        borderTopColor: '#33415560',
    },
    activeTag: {
        color: '#10B981',
        fontSize: 10,
        fontWeight: '700',
    },
    unsyncedTag: {
        color: '#F59E0B',
        fontSize: 10,
        fontWeight: '700',
    },
    legendRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        paddingVertical: 10,
        marginBottom: 4,
    },
    legendItem: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    legendDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
    },
    legendText: {
        color: '#94A3B8',
        fontSize: 11,
        fontWeight: '600',
    },
    turnCard: {
        backgroundColor: '#1E293B',
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#334155',
    },
    turnHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 8,
    },
    turnTitleRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        flex: 1,
    },
    turnIndexBadge: {
        color: '#38BDF8',
        backgroundColor: '#0284C725',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        fontSize: 10,
        fontWeight: '700',
        fontFamily: 'monospace',
    },
    turnQuery: {
        color: '#F8FAFC',
        fontSize: 13,
        fontWeight: '700',
        flex: 1,
        lineHeight: 18,
    },
    turnTime: {
        color: '#64748B',
        fontSize: 10,
    },
    turnStatsBar: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        marginTop: 8,
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#334155',
    },
    turnStatChip: {
        backgroundColor: '#0F172A',
        color: '#CBD5E1',
        fontSize: 10,
        fontFamily: 'monospace',
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 5,
        overflow: 'hidden',
    },
    spanList: {
        marginTop: 8,
        gap: 8,
    },
    spanItem: {
        backgroundColor: '#0F172A',
        borderRadius: 8,
        padding: 9,
        borderWidth: 1,
        borderColor: '#1E293B',
    },
    spanTopRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 8,
    },
    spanName: {
        color: '#F8FAFC',
        fontSize: 12,
        fontWeight: '600',
        fontFamily: 'monospace',
        flex: 1,
    },
    spanRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    spanDuration: {
        color: '#FBBF24',
        fontSize: 11,
        fontFamily: 'monospace',
        fontWeight: '700',
    },
    spanStatus: {
        fontSize: 10,
        fontFamily: 'monospace',
        fontWeight: '700',
    },
    statusOk: { color: '#10B981' },
    statusErr: { color: '#EF4444' },
    barTrack: {
        height: 4,
        backgroundColor: '#1E293B',
        borderRadius: 2,
        marginTop: 6,
        marginBottom: 5,
        overflow: 'hidden',
    },
    barFill: {
        height: 4,
        borderRadius: 2,
    },
    spanSubline: {
        color: '#94A3B8',
        fontSize: 10,
        fontFamily: 'monospace',
    },
    expandedBox: {
        marginTop: 8,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: '#1E293B',
        gap: 4,
    },
    detailRow: {
        flexDirection: 'row',
        gap: 6,
    },
    detailLabel: {
        color: '#64748B',
        fontSize: 10,
        fontWeight: '700',
        width: 88,
    },
    detailValue: {
        color: '#CBD5E1',
        fontSize: 10,
        fontFamily: 'monospace',
        flex: 1,
    },
    traceFilterBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#0284C720',
        borderBottomWidth: 1,
        borderBottomColor: '#38BDF840',
        paddingHorizontal: 14,
        paddingVertical: 7,
        gap: 10,
    },
    traceFilterText: {
        color: '#38BDF8',
        fontSize: 11,
        fontFamily: 'monospace',
        flex: 1,
    },
    traceFilterClear: {
        color: '#F8FAFC',
        fontSize: 11,
        fontWeight: '700',
        backgroundColor: '#334155',
        paddingHorizontal: 8,
        paddingVertical: 3,
        borderRadius: 6,
    },
});
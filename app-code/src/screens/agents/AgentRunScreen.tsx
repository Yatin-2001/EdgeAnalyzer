import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    AppState,
    Keyboard,
    KeyboardAvoidingView,
    Modal,
    Platform,
    ScrollView,
    StatusBar,
    StyleSheet,
    Switch,
    Text,
    TextInput,
    TouchableOpacity,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { MeshClientService } from '../../services/MeshClientService';
import type {
    AgentArtifactMeta,
    AgentInputField,
    AgentRunDTO,
    AgentRunEventDTO,
    AgentRunStatus,
    PendingInterruptInfo,
    RegisteredAgentDTO,
} from '../../types/agentTypes';

interface Props {
    agent?: RegisteredAgentDTO;
    initialRun?: AgentRunDTO;
    onBack: () => void;
    onInspectTrace?: (traceId: string) => void;
}

interface TodoItem {
    content: string;
    status: string;
}

function buildInitialInputs(fields: AgentInputField[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (const f of fields) {
        if (f.default !== undefined) out[f.key] = f.default;
        else if (f.type === 'boolean') out[f.key] = false;
        else if (f.type === 'number') out[f.key] = f.min ?? 0;
        else if (f.type === 'select') out[f.key] = f.options?.[0] ?? '';
        else out[f.key] = '';
    }
    return out;
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

export const AgentRunScreen: React.FC<Props> = ({
                                                    agent,
                                                    initialRun,
                                                    onBack,
                                                    onInspectTrace,
                                                }) => {
    const mesh = MeshClientService.getInstance();

    const insets = useSafeAreaInsets();
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
        const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
        const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
        const showSub = Keyboard.addListener(showEvent, (e) => {
            setKeyboardHeight(e.endCoordinates?.height ?? 0);
        });
        const hideSub = Keyboard.addListener(hideEvent, () => {
            setKeyboardHeight(0);
        });
        return () => {
            showSub.remove();
            hideSub.remove();
        };
    }, []);

    // Active run state (null = Pre-Run Configuration View)
    const [run, setRun] = useState<AgentRunDTO | null>(initialRun ?? null);
    const [events, setEvents] = useState<AgentRunEventDTO[]>([]);
    const [localOriginId, setLocalOriginId] = useState<string>('');
    const [showStderr, setShowStderr] = useState(false);

    // Pre-Run Form State
    const [formValues, setFormValues] = useState<Record<string, any>>(() =>
        buildInitialInputs(agent?.manifest?.inputs ?? [])
    );
    const [isLaunching, setIsLaunching] = useState(false);
    const [isCancelling, setIsCancelling] = useState(false);

    // Interrupt Modal State
    const [interruptModalOpen, setInterruptModalOpen] = useState(false);
    const [userInputText, setUserInputText] = useState('');
    const [schemaValues, setSchemaValues] = useState<Record<string, string>>({});
    const [isEditingApproval, setIsEditingApproval] = useState(false);
    const [editedTasksText, setEditedTasksText] = useState('');
    const [approvalConstraints, setApprovalConstraints] = useState('');
    const [isResuming, setIsResuming] = useState(false);
    const [interruptError, setInterruptError] = useState<string | null>(null);

    // Artifact Reader State
    const [artifactViewer, setArtifactViewer] = useState<{
        meta: AgentArtifactMeta;
        content: string;
        loading: boolean;
        error?: string;
    } | null>(null);

    const lastSeqRef = useRef<number>(0);
    const activeRunIdRef = useRef<string | null>(initialRun?.runId ?? null);
    const localOriginRef = useRef<string>('');
    const scrollRef = useRef<ScrollView | null>(null);

    useEffect(() => {
        activeRunIdRef.current = run?.runId ?? null;
    }, [run?.runId]);

    useEffect(() => {
        mesh.getLocalOriginClientId()
            .then((id) => {
                setLocalOriginId(id);
                localOriginRef.current = id;
            })
            .catch(() => {});
    }, [mesh]);

    const hydrateInterruptFields = useCallback((info: PendingInterruptInfo | null) => {
        setInterruptError(null);
        setUserInputText('');
        setApprovalConstraints('');
        setIsEditingApproval(false);
        setSchemaValues({});
        if (!info?.payload) {
            setEditedTasksText('');
            return;
        }
        const p = info.payload;
        if (Array.isArray(p.tasks)) {
            setEditedTasksText(p.tasks.map((t: any) => String(t)).join('\n'));
        } else if (Array.isArray(p.action_requests)) {
            setEditedTasksText(
                p.action_requests
                    .map((a: any) => (typeof a === 'string' ? a : JSON.stringify(a)))
                    .join('\n')
            );
        } else {
            setEditedTasksText('');
        }
    }, []);

    // Catch-up replay via GET /api/v1/agents/runs/:runId/events?afterSeq=<lastSeq>
    const syncRunFromServer = useCallback(
        async (runId: string, reset = false) => {
            try {
                const afterSeq = reset ? 0 : lastSeqRef.current;
                const data = await mesh.getAgentRunEvents(runId, afterSeq);
                if (data.run) {
                    setRun(data.run);
                    if (
                        data.run.status === 'WAITING_FOR_INPUT' &&
                        data.run.pendingInterrupt
                    ) {
                        hydrateInterruptFields(data.run.pendingInterrupt);
                    } else if (data.run.status !== 'WAITING_FOR_INPUT') {
                        setInterruptModalOpen(false);
                    }
                }
                if (Array.isArray(data.events) && data.events.length > 0) {
                    setEvents((prev) => {
                        const base = reset ? [] : prev;
                        const bySeq = new Map<number, AgentRunEventDTO>();
                        for (const e of base) bySeq.set(e.seq, e);
                        for (const e of data.events) bySeq.set(e.seq, e);
                        const merged = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
                        if (merged.length > 0) {
                            lastSeqRef.current = merged[merged.length - 1].seq;
                        }
                        return merged;
                    });
                }
            } catch {}
        },
        [mesh, hydrateInterruptFields]
    );

    // Initial replay if opening an existing run (e.g., from "Needs Your Input" banner)
    useEffect(() => {
        if (!initialRun?.runId) return;
        lastSeqRef.current = 0;
        syncRunFromServer(initialRun.runId, true).then(() => {
            if (initialRun.status === 'WAITING_FOR_INPUT' && initialRun.pendingInterrupt) {
                hydrateInterruptFields(initialRun.pendingInterrupt);
                setInterruptModalOpen(true);
            }
        });
    }, [initialRun, syncRunFromServer, hydrateInterruptFields]);

    // Foreground / AppState catch-up replay (?afterSeq=<lastSeq>)
    useEffect(() => {
        const sub = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'active' && activeRunIdRef.current) {
                syncRunFromServer(activeRunIdRef.current, false);
            }
        });
        return () => sub.remove();
    }, [syncRunFromServer]);

    // Live WebSocket stream subscription
    useEffect(() => {
        const unsub = mesh.subscribeAgentEvents((evt) => {
            const currentId = activeRunIdRef.current;
            if (!currentId) return;

            if (evt.method === 'agent.run_event' && evt.params.runId === currentId) {
                const incoming = evt.params;
                setEvents((prev) => {
                    if (prev.some((e) => e.seq === incoming.seq)) return prev;
                    const next = [...prev, incoming].sort((a, b) => a.seq - b.seq);
                    lastSeqRef.current = next[next.length - 1].seq;
                    return next;
                });

                if (incoming.event_type === 'status' || incoming.event_type === 'artifact') {
                    syncRunFromServer(currentId, false);
                }
                return;
            }

            if (evt.method === 'agent.run_interrupt' && evt.params.runId === currentId) {
                const p = evt.params;
                const info: PendingInterruptInfo = {
                    interruptId: p.interruptId,
                    kind: p.kind,
                    payload: p.payload,
                    response_schema: p.response_schema ?? null,
                    priorityTargetClientId: p.priorityTargetClientId,
                };
                setRun((prev) =>
                    prev
                        ? {
                            ...prev,
                            status: 'WAITING_FOR_INPUT',
                            pendingInterruptId: p.interruptId,
                            pendingInterrupt: info,
                        }
                        : prev
                );
                hydrateInterruptFields(info);

                // Auto-open modal only when priorityTargetClientId matches this phone
                if (
                    p.priorityTargetClientId &&
                    p.priorityTargetClientId === localOriginRef.current
                ) {
                    setInterruptModalOpen(true);
                }
                return;
            }

            if (evt.method === 'agent.run_resumed' && evt.params.runId === currentId) {
                // Auto-dismiss modal immediately (even when answered on Desktop Admin UI)
                setInterruptModalOpen(false);
                setInterruptError(null);
                setRun((prev) =>
                    prev
                        ? {
                            ...prev,
                            status: 'RUNNING',
                            pendingInterruptId: null,
                            pendingInterrupt: null,
                        }
                        : prev
                );
            }
        });

        return () => unsub();
    }, [mesh, syncRunFromServer, hydrateInterruptFields]);

    // Derived live Todos
    const latestTodos = useMemo<TodoItem[]>(() => {
        for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            if (ev.event_type === 'todo_update' && Array.isArray(ev.payload.todos)) {
                return ev.payload.todos.map((t: any) => ({
                    content: String(t.content ?? ''),
                    status: String(t.status ?? 'pending'),
                }));
            }
        }
        return [];
    }, [events]);

    // Derived Artifacts
    const artifacts = useMemo<AgentArtifactMeta[]>(() => {
        const map = new Map<string, AgentArtifactMeta>();
        for (const a of run?.artifacts ?? []) {
            if (a.path) map.set(a.path, a);
        }
        for (const ev of events) {
            if (ev.event_type === 'artifact' && typeof ev.payload.path === 'string') {
                map.set(ev.payload.path, {
                    path: ev.payload.path,
                    size_bytes: Number(ev.payload.size_bytes ?? 0),
                    mime: String(ev.payload.mime ?? 'text/plain'),
                });
            }
        }
        return Array.from(map.values());
    }, [run, events]);

    const visibleEvents = useMemo(
        () => events.filter((e) => showStderr || e.event_type !== 'stderr_log'),
        [events, showStderr]
    );

    const handleLaunch = async () => {
        if (!agent) return;
        for (const field of agent.manifest.inputs ?? []) {
            if (field.required) {
                const v = formValues[field.key];
                if (v === undefined || v === null || String(v).trim() === '') {
                    Alert.alert('Missing Input', `"${field.label}" is required.`);
                    return;
                }
            }
        }

        setIsLaunching(true);
        try {
            const started = await mesh.startAgentRun(agent.agentId, formValues);
            lastSeqRef.current = 0;
            activeRunIdRef.current = started.runId;
            setEvents([]);
            setRun({
                runId: started.runId,
                agentId: agent.agentId,
                agentName: agent.name,
                traceId: started.traceId,
                sessionId: started.sessionId,
                originClientId: localOriginRef.current || 'mobile:local',
                pid: null,
                status: 'RUNNING',
                inputs: formValues,
                pendingInterruptId: null,
                pendingInterrupt: null,
                artifacts: [],
                startedAtMs: Date.now(),
                completedAtMs: null,
                errorMessage: null,
            });
            await syncRunFromServer(started.runId, true);
        } catch (err: any) {
            Alert.alert('Launch Failed', err?.message || String(err));
        } finally {
            setIsLaunching(false);
        }
    };

    const handleCancel = async () => {
        if (!run) return;
        setIsCancelling(true);
        try {
            await mesh.cancelAgentRun(run.runId);
            await syncRunFromServer(run.runId, false);
        } catch (err: any) {
            Alert.alert('Cancel Failed', err?.message || String(err));
        } finally {
            setIsCancelling(false);
        }
    };

    const submitResume = async (resumeValue: unknown) => {
        if (!run || !run.pendingInterruptId) return;
        setIsResuming(true);
        setInterruptError(null);
        try {
            const res = await mesh.resumeAgentRun(run.runId, run.pendingInterruptId, resumeValue);
            if (!res.ok) {
                if (res.error === 'INTERRUPT_ALREADY_RESOLVED') {
                    setInterruptModalOpen(false);
                    Alert.alert(
                        'Already Answered',
                        'This interrupt was already resolved on another device.'
                    );
                    syncRunFromServer(run.runId, false);
                } else {
                    setInterruptError(res.error || 'Failed to resume run.');
                }
            } else {
                setInterruptModalOpen(false);
            }
        } catch (err: any) {
            setInterruptError(err?.message || String(err));
        } finally {
            setIsResuming(false);
        }
    };

    const handleApprovalDecision = (decision: 'approve' | 'edit' | 'reject') => {
        const payload = run?.pendingInterrupt?.payload ?? {};
        const parsedTasks = editedTasksText
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);

        if ('action_requests' in payload) {
            const actionRequests = Array.isArray(payload.action_requests)
                ? payload.action_requests
                : [];
            submitResume({
                approved: decision !== 'reject',
                decisions: actionRequests.map(() => ({
                    type: decision,
                    ...(decision === 'edit' ? { edited_tasks: parsedTasks } : {}),
                    ...(approvalConstraints.trim()
                        ? { message: approvalConstraints.trim() }
                        : {}),
                })),
                ...(decision === 'edit' ? { tasks: parsedTasks } : {}),
                ...(approvalConstraints.trim()
                    ? { constraints: approvalConstraints.trim() }
                    : {}),
            });
            return;
        }

        submitResume({
            approved: decision !== 'reject',
            ...(decision === 'edit' ? { tasks: parsedTasks } : {}),
            ...(approvalConstraints.trim() ? { constraints: approvalConstraints.trim() } : {}),
        });
    };

    const handleUserInputSubmit = () => {
        const schemaProps = run?.pendingInterrupt?.response_schema?.properties as
            | Record<string, { type?: string }>
            | undefined;

        if (schemaProps && Object.keys(schemaProps).length > 0) {
            const structured: Record<string, any> = {};
            for (const [k, prop] of Object.entries(schemaProps)) {
                const raw = schemaValues[k] ?? '';
                if (prop.type === 'number' || prop.type === 'integer') structured[k] = Number(raw);
                else if (prop.type === 'boolean') structured[k] = raw === 'true';
                else structured[k] = raw;
            }
            submitResume(structured);
            return;
        }
        submitResume(userInputText.trim());
    };

    const openArtifact = async (meta: AgentArtifactMeta) => {
        if (!run) return;
        setArtifactViewer({ meta, content: '', loading: true });
        try {
            const text = await mesh.fetchAgentArtifactText(run.runId, meta.path);
            setArtifactViewer({ meta, content: text, loading: false });
        } catch (err: any) {
            setArtifactViewer({
                meta,
                content: '',
                loading: false,
                error: err?.message || String(err),
            });
        }
    };

    const title = run?.agentName || agent?.name || run?.agentId || 'Agent Run';
    const isRunActive =
        run?.status === 'RUNNING' ||
        run?.status === 'QUEUED' ||
        run?.status === 'WAITING_FOR_INPUT';

    // =========================================================================
    // VIEW 1: PRE-RUN DYNAMIC INPUT FORM
    // =========================================================================
    if (!run) {
        const fields = agent?.manifest?.inputs ?? [];
        return (
            <KeyboardAvoidingView
                style={styles.container}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <View style={styles.header}>
                    <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
                        <Ionicons name="arrow-back" size={22} color="#F8FAFC" />
                    </TouchableOpacity>
                    <View style={styles.headerCenter}>
                        <Text style={styles.headerTitle} numberOfLines={1}>
                            {title}
                        </Text>
                        <Text style={styles.headerSub}>
                            v{agent?.version || '0.0.0'} • Configure Inputs
                        </Text>
                    </View>
                </View>

                <ScrollView
                    style={styles.scroll}
                    contentContainerStyle={styles.scrollContent}
                    keyboardShouldPersistTaps="handled"
                >
                    {!!agent?.manifest?.description && (
                        <Text style={styles.descText}>{agent.manifest.description}</Text>
                    )}

                    {fields.length === 0 ? (
                        <View style={styles.card}>
                            <Text style={styles.mutedText}>
                                No parameters required. Tap Run on Mesh to execute immediately.
                            </Text>
                        </View>
                    ) : (
                        fields.map((field) => {
                            const val = formValues[field.key];
                            return (
                                <View key={field.key} style={styles.fieldBlock}>
                                    <Text style={styles.fieldLabel}>
                                        {field.label}
                                        {field.required ? ' *' : ''}
                                    </Text>

                                    {field.type === 'textarea' && (
                                        <TextInput
                                            style={[styles.input, styles.textarea]}
                                            multiline
                                            textAlignVertical="top"
                                            value={String(val ?? '')}
                                            placeholder={field.placeholder || `Enter ${field.label}`}
                                            placeholderTextColor="#64748B"
                                            onChangeText={(txt) =>
                                                setFormValues((p) => ({ ...p, [field.key]: txt }))
                                            }
                                        />
                                    )}

                                    {field.type === 'string' && (
                                        <TextInput
                                            style={styles.input}
                                            value={String(val ?? '')}
                                            placeholder={field.placeholder || `Enter ${field.label}`}
                                            placeholderTextColor="#64748B"
                                            onChangeText={(txt) =>
                                                setFormValues((p) => ({ ...p, [field.key]: txt }))
                                            }
                                        />
                                    )}

                                    {field.type === 'number' && (
                                        <View style={styles.stepperRow}>
                                            <TouchableOpacity
                                                style={styles.stepperBtn}
                                                onPress={() =>
                                                    setFormValues((p) => {
                                                        const cur = Number(p[field.key] ?? 0);
                                                        const next = cur - 1;
                                                        return {
                                                            ...p,
                                                            [field.key]:
                                                                field.min !== undefined
                                                                    ? Math.max(field.min, next)
                                                                    : next,
                                                        };
                                                    })
                                                }
                                            >
                                                <Ionicons name="remove" size={18} color="#F8FAFC" />
                                            </TouchableOpacity>
                                            <TextInput
                                                style={styles.stepperInput}
                                                keyboardType="numeric"
                                                value={String(val ?? 0)}
                                                onChangeText={(txt) => {
                                                    const n = Number(txt);
                                                    setFormValues((p) => ({
                                                        ...p,
                                                        [field.key]: Number.isNaN(n) ? 0 : n,
                                                    }));
                                                }}
                                            />
                                            <TouchableOpacity
                                                style={styles.stepperBtn}
                                                onPress={() =>
                                                    setFormValues((p) => {
                                                        const cur = Number(p[field.key] ?? 0);
                                                        const next = cur + 1;
                                                        return {
                                                            ...p,
                                                            [field.key]:
                                                                field.max !== undefined
                                                                    ? Math.min(field.max, next)
                                                                    : next,
                                                        };
                                                    })
                                                }
                                            >
                                                <Ionicons name="add" size={18} color="#F8FAFC" />
                                            </TouchableOpacity>
                                        </View>
                                    )}

                                    {field.type === 'boolean' && (
                                        <View style={styles.switchRow}>
                                            <Text style={styles.mutedText}>
                                                {Boolean(val) ? 'Enabled' : 'Disabled'}
                                            </Text>
                                            <Switch
                                                value={Boolean(val)}
                                                onValueChange={(v) =>
                                                    setFormValues((p) => ({ ...p, [field.key]: v }))
                                                }
                                                trackColor={{ false: '#334155', true: '#4F46E5' }}
                                                thumbColor="#F8FAFC"
                                            />
                                        </View>
                                    )}

                                    {field.type === 'select' && (
                                        <View style={styles.selectWrap}>
                                            {(field.options ?? []).map((opt) => {
                                                const active = String(val) === opt;
                                                return (
                                                    <TouchableOpacity
                                                        key={opt}
                                                        style={[
                                                            styles.selectChip,
                                                            active && styles.selectChipActive,
                                                        ]}
                                                        onPress={() =>
                                                            setFormValues((p) => ({
                                                                ...p,
                                                                [field.key]: opt,
                                                            }))
                                                        }
                                                    >
                                                        <Text
                                                            style={[
                                                                styles.selectChipText,
                                                                active && styles.selectChipTextActive,
                                                            ]}
                                                        >
                                                            {opt}
                                                        </Text>
                                                    </TouchableOpacity>
                                                );
                                            })}
                                        </View>
                                    )}
                                </View>
                            );
                        })
                    )}

                    <TouchableOpacity
                        style={[styles.primaryBtn, isLaunching && { opacity: 0.6 }]}
                        onPress={handleLaunch}
                        disabled={isLaunching}
                    >
                        {isLaunching ? (
                            <ActivityIndicator size="small" color="#FFFFFF" />
                        ) : (
                            <Ionicons name="rocket-outline" size={18} color="#FFFFFF" />
                        )}
                        <Text style={styles.primaryBtnText}>
                            {isLaunching ? 'Launching on Mesh...' : 'Run on Mesh'}
                        </Text>
                    </TouchableOpacity>
                </ScrollView>
            </KeyboardAvoidingView>
        );
    }

    // =========================================================================
    // VIEW 2: LIVE EXECUTION, INTERRUPTS & ARTIFACTS
    // =========================================================================
    const statusColor = getStatusColor(run.status);
    const pendingInterrupt = run.pendingInterrupt;
    const schemaProps = pendingInterrupt?.response_schema?.properties as
        | Record<string, { type?: string; title?: string; description?: string }>
        | undefined;

    return (
        <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={onBack} style={styles.iconBtn}>
                    <Ionicons name="arrow-back" size={22} color="#F8FAFC" />
                </TouchableOpacity>
                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle} numberOfLines={1}>
                        {title}
                    </Text>
                    <View style={styles.headerMetaRow}>
                        <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                        <Text style={[styles.statusLabel, { color: statusColor }]}>
                            {run.status}
                        </Text>
                        <Text style={styles.headerSub}> • {run.runId.slice(0, 12)}</Text>
                    </View>
                </View>

                {onInspectTrace && (
                    <TouchableOpacity
                        style={styles.traceBtn}
                        onPress={() => onInspectTrace(run.traceId)}
                    >
                        <Ionicons name="analytics-outline" size={16} color="#38BDF8" />
                        <Text style={styles.traceBtnText}>Trace</Text>
                    </TouchableOpacity>
                )}

                {isRunActive && (
                    <TouchableOpacity
                        style={[styles.stopBtn, isCancelling && { opacity: 0.5 }]}
                        disabled={isCancelling}
                        onPress={handleCancel}
                    >
                        <Ionicons name="stop" size={14} color="#FFFFFF" />
                        <Text style={styles.stopBtnText}>Stop</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* Tap-to-Answer Banner whenever run is paused for input */}
            {run.status === 'WAITING_FOR_INPUT' && pendingInterrupt && (
                <TouchableOpacity
                    style={styles.actionBanner}
                    onPress={() => setInterruptModalOpen(true)}
                >
                    <Ionicons name="alert-circle" size={20} color="#FDE68A" />
                    <View style={{ flex: 1 }}>
                        <Text style={styles.actionBannerTitle}>
                            Action Required — Tap to Answer
                        </Text>
                        <Text style={styles.actionBannerSub} numberOfLines={1}>
                            {String(
                                pendingInterrupt.payload?.message ||
                                pendingInterrupt.payload?.prompt ||
                                'Agent is paused waiting for your decision.'
                            )}
                        </Text>
                    </View>
                    <Ionicons name="open-outline" size={18} color="#FDE68A" />
                </TouchableOpacity>
            )}

            <ScrollView
                ref={scrollRef}
                style={styles.scroll}
                contentContainerStyle={styles.scrollContent}
                onContentSizeChange={() =>
                    scrollRef.current?.scrollToEnd({ animated: true })
                }
            >
                {/* Live Todo Checklist */}
                {latestTodos.length > 0 && (
                    <View style={styles.card}>
                        <Text style={styles.cardHeader}>LIVE TODOS ({latestTodos.length})</Text>
                        {latestTodos.map((t, idx) => {
                            const done = t.status === 'completed';
                            const prog = t.status === 'in_progress';
                            return (
                                <View key={idx} style={styles.todoRow}>
                                    <Ionicons
                                        name={
                                            done
                                                ? 'checkmark-circle'
                                                : prog
                                                    ? 'time-outline'
                                                    : 'ellipse-outline'
                                        }
                                        size={16}
                                        color={done ? '#10B981' : prog ? '#F59E0B' : '#64748B'}
                                    />
                                    <Text
                                        style={[
                                            styles.todoText,
                                            done && styles.todoTextDone,
                                        ]}
                                    >
                                        {t.content}
                                    </Text>
                                </View>
                            );
                        })}
                    </View>
                )}

                {/* Artifacts List */}
                {artifacts.length > 0 && (
                    <View style={styles.card}>
                        <Text style={styles.cardHeader}>ARTIFACTS ({artifacts.length})</Text>
                        {artifacts.map((art) => (
                            <TouchableOpacity
                                key={art.path}
                                style={styles.artifactRow}
                                onPress={() => openArtifact(art)}
                            >
                                <Ionicons name="document-text-outline" size={18} color="#38BDF8" />
                                <Text style={styles.artifactName} numberOfLines={1}>
                                    {art.path}
                                </Text>
                                <Text style={styles.artifactSize}>{art.size_bytes}B</Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {/* Error Card */}
                {run.status === 'FAILED' && !!run.errorMessage && (
                    <View style={[styles.card, { borderColor: '#EF444488' }]}>
                        <Text style={{ color: '#FCA5A5', fontSize: 12, fontFamily: 'monospace' }}>
                            Error: {run.errorMessage}
                        </Text>
                    </View>
                )}

                {/* Event Feed */}
                <View style={styles.feedHeaderRow}>
                    <Text style={styles.cardHeader}>
                        EXECUTION STREAM ({visibleEvents.length})
                    </Text>
                    <TouchableOpacity onPress={() => setShowStderr((v) => !v)}>
                        <Text style={styles.toggleStderrText}>
                            {showStderr ? 'Hide stderr' : 'Show stderr'}
                        </Text>
                    </TouchableOpacity>
                </View>

                {visibleEvents.length === 0 ? (
                    <View style={styles.card}>
                        <Text style={styles.mutedText}>Waiting for agent events...</Text>
                    </View>
                ) : (
                    visibleEvents.map((ev) => {
                        const p = ev.payload || {};
                        if (ev.event_type === 'route_decision') {
                            const isMobile = String(p.resolved_tier || '') === 'thick_mobile';
                            return (
                                <View key={ev.seq} style={styles.routeBadgeCard}>
                                    <Text style={styles.routeBadgeText}>
                                        {isMobile ? '📱' : '💻'}{' '}
                                        {String(p.resolved_node_name || p.resolved_node_id)} (
                                        {String(p.requested_model || 'mesh/auto')})
                                    </Text>
                                    <Text style={styles.routeSubText}>
                                        → {String(p.resolved_model || '')} [
                                        {String(p.routing_reason || '')}]
                                    </Text>
                                </View>
                            );
                        }

                        if (ev.event_type === 'stderr_log') {
                            return (
                                <Text key={ev.seq} style={styles.stderrLine}>
                                    [stderr] {String(p.line ?? '')}
                                </Text>
                            );
                        }

                        let body = '';
                        if (ev.event_type === 'status') {
                            body = `Status: ${p.status || p.message || 'update'}${
                                p.final_answer ? `\n${String(p.final_answer)}` : ''
                            }`;
                        } else if (ev.event_type === 'interrupt') {
                            body = `⏸ Paused (${p.kind || 'input'}): ${
                                p.payload?.message || p.payload?.prompt || p.interruptId
                            }`;
                        } else if (ev.event_type === 'interrupt_resolved') {
                            body = `▶ Resumed by ${p.resolvedByClientId || 'client'}`;
                        } else if (ev.event_type === 'artifact') {
                            body = `📄 Artifact created: ${p.path}`;
                        } else if (ev.event_type === 'todo_update') {
                            body = `Updated ${Array.isArray(p.todos) ? p.todos.length : 0} todo item(s)`;
                        } else {
                            body = `[${p.node || ev.event_type}] ${p.summary || JSON.stringify(p)}`;
                        }

                        return (
                            <View key={ev.seq} style={styles.eventCard}>
                                <Text style={styles.eventBody}>{body}</Text>
                            </View>
                        );
                    })
                )}
            </ScrollView>

            {/* Interrupt Modal (Auto-opens on origin phone, auto-dismisses on agent.run_resumed) */}
            {/* Interrupt Modal (only mounted when open; lifts cleanly above Android keyboard) */}
            {interruptModalOpen && !!pendingInterrupt && (
                <Modal
                    visible={true}
                    transparent={true}
                    animationType="slide"
                    statusBarTranslucent={true}
                    onRequestClose={() => setInterruptModalOpen(false)}
                >
                    <View
                        style={[
                            styles.modalBackdrop,
                            { paddingBottom: keyboardHeight },
                        ]}
                    >
                        <View
                            style={[
                                styles.modalSheet,
                                {
                                    maxHeight: '85%',
                                    paddingBottom:
                                        keyboardHeight > 0
                                            ? 16
                                            : Math.max(insets.bottom, 24),
                                },
                            ]}
                        >
                            <View style={styles.modalHeader}>
                                <Text style={styles.modalTitle}>
                                    {pendingInterrupt.kind === 'hitl_approval'
                                        ? '⚠️ Approval Required'
                                        : '💬 Agent Input Needed'}
                                </Text>
                                <TouchableOpacity onPress={() => setInterruptModalOpen(false)}>
                                    <Ionicons name="close" size={22} color="#94A3B8" />
                                </TouchableOpacity>
                            </View>

                            <ScrollView
                                style={{ maxHeight: 340 }}
                                keyboardShouldPersistTaps="handled"
                            >
                                {pendingInterrupt.kind === 'hitl_approval' ? (
                                    <View style={{ gap: 10 }}>
                                        <Text style={styles.modalPrompt}>
                                            {String(
                                                pendingInterrupt.payload?.message ||
                                                'Review and approve the pending agent action.'
                                            )}
                                        </Text>

                                        {!isEditingApproval ? (
                                            <View style={styles.taskPreviewBox}>
                                                {editedTasksText
                                                    .split('\n')
                                                    .filter(Boolean)
                                                    .map((line, i) => (
                                                        <Text key={i} style={styles.taskLine}>
                                                            {i + 1}. {line}
                                                        </Text>
                                                    ))}
                                            </View>
                                        ) : (
                                            <TextInput
                                                style={[styles.input, styles.textarea]}
                                                multiline
                                                value={editedTasksText}
                                                onChangeText={setEditedTasksText}
                                                placeholder="One task per line..."
                                                placeholderTextColor="#64748B"
                                            />
                                        )}

                                        <TextInput
                                            style={styles.input}
                                            value={approvalConstraints}
                                            onChangeText={setApprovalConstraints}
                                            placeholder="Optional constraints or feedback..."
                                            placeholderTextColor="#64748B"
                                        />

                                        <View style={styles.modalBtnRow}>
                                            <TouchableOpacity
                                                style={[styles.modalBtn, { backgroundColor: '#10B981' }]}
                                                disabled={isResuming}
                                                onPress={() =>
                                                    handleApprovalDecision(
                                                        isEditingApproval ? 'edit' : 'approve'
                                                    )
                                                }
                                            >
                                                <Text style={styles.modalBtnText}>
                                                    {isEditingApproval ? 'Save & Approve' : 'Approve'}
                                                </Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={[styles.modalBtn, { backgroundColor: '#334155' }]}
                                                disabled={isResuming}
                                                onPress={() => setIsEditingApproval((v) => !v)}
                                            >
                                                <Text style={styles.modalBtnText}>
                                                    {isEditingApproval ? 'Preview' : 'Edit'}
                                                </Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={[styles.modalBtn, { backgroundColor: '#EF4444' }]}
                                                disabled={isResuming}
                                                onPress={() => handleApprovalDecision('reject')}
                                            >
                                                <Text style={styles.modalBtnText}>Reject</Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ) : (
                                    <View style={{ gap: 10 }}>
                                        <Text style={styles.modalPrompt}>
                                            {String(
                                                pendingInterrupt.payload?.prompt ||
                                                pendingInterrupt.payload?.message ||
                                                JSON.stringify(pendingInterrupt.payload ?? {})
                                            )}
                                        </Text>

                                        {schemaProps && Object.keys(schemaProps).length > 0 ? (
                                            Object.entries(schemaProps).map(([key, prop]) => (
                                                <View key={key}>
                                                    <Text style={styles.fieldLabel}>
                                                        {prop.title || key}
                                                    </Text>
                                                    <TextInput
                                                        style={styles.input}
                                                        keyboardType={
                                                            prop.type === 'number' ||
                                                            prop.type === 'integer'
                                                                ? 'numeric'
                                                                : 'default'
                                                        }
                                                        value={schemaValues[key] ?? ''}
                                                        placeholder={prop.description || key}
                                                        placeholderTextColor="#64748B"
                                                        onChangeText={(txt) =>
                                                            setSchemaValues((p) => ({
                                                                ...p,
                                                                [key]: txt,
                                                            }))
                                                        }
                                                    />
                                                </View>
                                            ))
                                        ) : (
                                            <TextInput
                                                style={[styles.input, styles.textarea]}
                                                multiline
                                                value={userInputText}
                                                onChangeText={setUserInputText}
                                                placeholder="Type your response..."
                                                placeholderTextColor="#64748B"
                                            />
                                        )}

                                        <TouchableOpacity
                                            style={styles.primaryBtn}
                                            disabled={isResuming}
                                            onPress={handleUserInputSubmit}
                                        >
                                            <Text style={styles.primaryBtnText}>
                                                {isResuming ? 'Submitting...' : 'Submit & Resume'}
                                            </Text>
                                        </TouchableOpacity>
                                    </View>
                                )}

                                {!!interruptError && (
                                    <Text style={styles.interruptErrorText}>{interruptError}</Text>
                                )}
                            </ScrollView>
                        </View>
                    </View>
                </Modal>
            )}

            {/* In-App Artifact Reader Modal (only mounted when an artifact is tapped) */}
            {artifactViewer && (
                <Modal
                    visible={true}
                    animationType="slide"
                    statusBarTranslucent={true}
                    onRequestClose={() => setArtifactViewer(null)}
                >
                    <View
                        style={[
                            styles.container,
                            {
                                paddingTop: insets.top || StatusBar.currentHeight || 36,
                                paddingBottom: insets.bottom,
                            },
                        ]}
                    >
                        <View style={styles.header}>
                            <TouchableOpacity
                                onPress={() => setArtifactViewer(null)}
                                style={styles.iconBtn}
                            >
                                <Ionicons name="close" size={22} color="#F8FAFC" />
                            </TouchableOpacity>
                            <View style={styles.headerCenter}>
                                <Text style={styles.headerTitle} numberOfLines={1}>
                                    {artifactViewer.meta.path}
                                </Text>
                                <Text style={styles.headerSub}>
                                    {artifactViewer.meta.mime} • {artifactViewer.meta.size_bytes}B
                                </Text>
                            </View>
                            {!!artifactViewer.content && (
                                <TouchableOpacity
                                    style={styles.iconBtn}
                                    onPress={() => {
                                        Clipboard.setStringAsync(artifactViewer.content);
                                        Alert.alert('Copied', 'Artifact content copied to clipboard.');
                                    }}
                                >
                                    <Ionicons name="copy-outline" size={18} color="#38BDF8" />
                                </TouchableOpacity>
                            )}
                        </View>

                        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
                            {artifactViewer.loading ? (
                                <ActivityIndicator size="large" color="#6366F1" />
                            ) : artifactViewer.error ? (
                                <Text style={{ color: '#FCA5A5' }}>{artifactViewer.error}</Text>
                            ) : (
                                <Text style={styles.artifactContentText} selectable>
                                    {artifactViewer.content}
                                </Text>
                            )}
                        </ScrollView>
                    </View>
                </Modal>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0F172A' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 11,
        borderBottomWidth: 1,
        borderBottomColor: '#1E293B',
        gap: 8,
    },
    iconBtn: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: '#1E293B',
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerCenter: { flex: 1 },
    headerTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
    headerSub: { color: '#94A3B8', fontSize: 11 },
    headerMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
    statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 5 },
    statusLabel: { fontSize: 11, fontWeight: '700' },
    traceBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: '#0EA5E922',
        borderWidth: 1,
        borderColor: '#38BDF855',
        paddingHorizontal: 9,
        paddingVertical: 6,
        borderRadius: 9,
    },
    traceBtnText: { color: '#38BDF8', fontSize: 11, fontWeight: '700' },
    stopBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        backgroundColor: '#DC2626',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 9,
    },
    stopBtnText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
    actionBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        backgroundColor: '#78350F',
        borderBottomWidth: 1,
        borderBottomColor: '#F59E0B',
        paddingHorizontal: 14,
        paddingVertical: 10,
    },
    actionBannerTitle: { color: '#FEF3C7', fontSize: 13, fontWeight: '700' },
    actionBannerSub: { color: '#FDE68A', fontSize: 11, marginTop: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: 14, paddingBottom: 42 },
    descText: { color: '#CBD5E1', fontSize: 13, lineHeight: 19, marginBottom: 16 },
    fieldBlock: { marginBottom: 16 },
    fieldLabel: { color: '#E2E8F0', fontSize: 12, fontWeight: '700', marginBottom: 6 },
    input: {
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
        borderRadius: 12,
        paddingHorizontal: 12,
        paddingVertical: 10,
        color: '#F8FAFC',
        fontSize: 14,
    },
    textarea: { minHeight: 88, textAlignVertical: 'top' },
    stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    stepperBtn: {
        width: 40,
        height: 40,
        borderRadius: 10,
        backgroundColor: '#334155',
        alignItems: 'center',
        justifyContent: 'center',
    },
    stepperInput: {
        flex: 1,
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
        borderRadius: 10,
        paddingVertical: 8,
        textAlign: 'center',
        color: '#F8FAFC',
        fontSize: 15,
        fontWeight: '700',
    },
    switchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#1E293B',
        borderRadius: 12,
        paddingHorizontal: 14,
        paddingVertical: 8,
    },
    selectWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    selectChip: {
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
    },
    selectChipActive: { backgroundColor: '#4F46E533', borderColor: '#6366F1' },
    selectChipText: { color: '#CBD5E1', fontSize: 12, fontWeight: '600' },
    selectChipTextActive: { color: '#A5B4FC' },
    primaryBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: '#4F46E5',
        paddingVertical: 13,
        borderRadius: 14,
        marginTop: 8,
    },
    primaryBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    card: {
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#334155',
        borderRadius: 12,
        padding: 12,
        marginBottom: 12,
    },
    cardHeader: {
        color: '#94A3B8',
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.7,
        marginBottom: 8,
    },
    mutedText: { color: '#94A3B8', fontSize: 12 },
    todoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
    todoText: { color: '#E2E8F0', fontSize: 12, flex: 1 },
    todoTextDone: { color: '#64748B', textDecorationLine: 'line-through' },
    artifactRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: '#0F172A',
        padding: 10,
        borderRadius: 10,
        marginBottom: 6,
    },
    artifactName: { color: '#E2E8F0', fontSize: 12, fontFamily: 'monospace', flex: 1 },
    artifactSize: { color: '#64748B', fontSize: 11, fontFamily: 'monospace' },
    feedHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    toggleStderrText: { color: '#38BDF8', fontSize: 11, fontWeight: '600' },
    routeBadgeCard: {
        backgroundColor: '#312E8144',
        borderWidth: 1,
        borderColor: '#6366F166',
        borderRadius: 10,
        padding: 10,
        marginBottom: 8,
    },
    routeBadgeText: { color: '#C7D2FE', fontSize: 12, fontWeight: '700' },
    routeSubText: { color: '#94A3B8', fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
    stderrLine: {
        color: '#64748B',
        fontSize: 11,
        fontFamily: 'monospace',
        marginBottom: 4,
    },
    eventCard: {
        backgroundColor: '#1E293B',
        borderRadius: 10,
        padding: 10,
        marginBottom: 7,
    },
    eventBody: { color: '#E2E8F0', fontSize: 12, lineHeight: 18 },
    modalBackdrop: {
        flex: 1,
        backgroundColor: '#000000B3',
        justifyContent: 'flex-end',
    },
    modalSheet: {
        backgroundColor: '#0F172A',
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        borderTopWidth: 1,
        borderColor: '#F59E0B88',
        padding: 18,
        paddingBottom: 28,
    },
    modalHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    modalTitle: { color: '#FDE68A', fontSize: 16, fontWeight: '700' },
    modalPrompt: { color: '#E2E8F0', fontSize: 13, lineHeight: 19 },
    taskPreviewBox: {
        backgroundColor: '#1E293B',
        borderRadius: 10,
        padding: 10,
        gap: 4,
    },
    taskLine: { color: '#CBD5E1', fontSize: 12, fontFamily: 'monospace' },
    modalBtnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
    modalBtn: {
        flex: 1,
        paddingVertical: 11,
        borderRadius: 10,
        alignItems: 'center',
    },
    modalBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
    interruptErrorText: { color: '#FCA5A5', fontSize: 12, marginTop: 8 },
    artifactContentText: {
        color: '#E2E8F0',
        fontSize: 13,
        fontFamily: 'monospace',
        lineHeight: 20,
    },
});
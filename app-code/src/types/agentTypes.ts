export type AgentInputFieldType = 'string' | 'textarea' | 'number' | 'boolean' | 'select';

export interface AgentInputField {
    key: string;
    label: string;
    type: AgentInputFieldType;
    required?: boolean;
    default?: string | number | boolean;
    placeholder?: string;
    options?: string[];
    min?: number;
    max?: number;
}

export interface EdgeAgentManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    runtime: {
        entrypoint: string;
        timeout_sec?: number;
    };
    inputs: AgentInputField[];
    mounts?: Record<string, string | { path: string; mode: 'ro' | 'rw' }>;
    mesh_profile?: {
        supervisor_model?: string;
        worker_model?: string;
        default_model?: string;
    };
    required_env?: string[];
}

export interface GateDiagnostic {
    gate: 1 | 2 | 3 | 4 | 5;
    name: string;
    passed: boolean;
    message: string;
}

export interface ValidationReport {
    passed: boolean;
    checkedAtMs: number;
    gates: GateDiagnostic[];
}

export type AgentValidationStatus = 'READY' | 'FAILED_PREFLIGHT' | 'DISABLED';

export interface RegisteredAgentDTO {
    agentId: string;
    name: string;
    version: string;
    folderPath: string;
    manifest: EdgeAgentManifest;
    validationStatus: AgentValidationStatus;
    validationReport: ValidationReport;
    registeredAtMs: number;
    updatedAtMs: number;
}

export type AgentRunStatus =
    | 'QUEUED'
    | 'RUNNING'
    | 'WAITING_FOR_INPUT'
    | 'COMPLETED'
    | 'FAILED'
    | 'CANCELLED';

export type AgentRunEventType =
    | 'status'
    | 'todo_update'
    | 'node_step'
    | 'route_decision'
    | 'interrupt'
    | 'interrupt_resolved'
    | 'artifact'
    | 'stderr_log';

export interface AgentArtifactMeta {
    path: string;
    size_bytes: number;
    mime: string;
}

export interface PendingInterruptInfo {
    interruptId: string;
    kind: 'hitl_approval' | 'user_input';
    payload: Record<string, any>;
    response_schema?: Record<string, any> | null;
    priorityTargetClientId?: string;
}

export interface AgentRunDTO {
    runId: string;
    agentId: string;
    agentName?: string;
    traceId: string;
    sessionId: string;
    originClientId: string;
    pid: number | null;
    status: AgentRunStatus;
    inputs: Record<string, any>;
    pendingInterruptId: string | null;
    pendingInterrupt: PendingInterruptInfo | null;
    artifacts: AgentArtifactMeta[];
    startedAtMs: number;
    completedAtMs: number | null;
    errorMessage: string | null;
}

export interface AgentRunEventDTO {
    runId: string;
    seq: number;
    event_type: AgentRunEventType;
    payload: Record<string, any>;
    created_at_ms: number;
}

export type AgentWsNotification =
    | { method: 'agent.catalog_updated'; params: { agents: RegisteredAgentDTO[] } }
    | { method: 'agent.run_event'; params: AgentRunEventDTO }
    | {
    method: 'agent.run_interrupt';
    params: {
        runId: string;
        interruptId: string;
        kind: 'hitl_approval' | 'user_input';
        payload: Record<string, any>;
        response_schema?: Record<string, any> | null;
        priorityTargetClientId?: string;
    };
}
    | {
    method: 'agent.run_resumed';
    params: { runId: string; interruptId: string; resolvedByClientId: string };
};
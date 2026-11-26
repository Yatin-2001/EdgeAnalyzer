import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DesktopDb } from '../db/DesktopDb.js';
import { AuthTokenRegistry } from '../router/OpenAIGatewayRoutes.js';
import { isPathInsideRoot, killProcessTree, resolveUvBinary } from '../utils/processUtils.js';
import { AgentRegistryService } from './AgentRegistryService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export interface AgentRunRecord {
    run_id: string;
    agent_id: string;
    trace_id: string;
    session_id: string;
    origin_client_id: string;
    pid: number | null;
    status: AgentRunStatus;
    inputs_json: string;
    pending_interrupt_id: string | null;
    pending_interrupt_json: string | null;
    artifacts_json: string;
    started_at_ms: number;
    completed_at_ms: number | null;
    error_message: string | null;
}

export interface AgentRunDTO {
    runId: string;
    agentId: string;
    agentName?: string | undefined;
    traceId: string;
    sessionId: string;
    originClientId: string;
    pid: number | null;
    status: AgentRunStatus;
    inputs: Record<string, unknown>;
    pendingInterruptId: string | null;
    pendingInterrupt: Record<string, unknown> | null;
    artifacts: AgentArtifactMeta[];
    startedAtMs: number;
    completedAtMs: number | null;
    errorMessage: string | null;
}

export interface AgentRunEventRecord {
    seq: number;
    run_id: string;
    event_type: AgentRunEventType;
    payload_json: string;
    created_at_ms: number;
}

export interface AgentRunEventDTO {
    runId: string;
    seq: number;
    event_type: AgentRunEventType;
    payload: Record<string, unknown>;
    created_at_ms: number;
}

interface ActiveRunProcess {
    runId: string;
    child: ChildProcess;
    runToken: string;
    runDir: string;
    originClientId: string;
    timeoutTimer: ReturnType<typeof setTimeout>;
    cancelled: boolean;
}

export class AgentRunManager extends EventEmitter {
    private static instance: AgentRunManager;
    private db: DatabaseSync;
    private registry = AgentRegistryService.getInstance();
    private tokenRegistry = AuthTokenRegistry.getInstance();
    private activeRuns = new Map<string, ActiveRunProcess>();

    private readonly daemonRoot: string;
    private readonly runnerScriptPath: string;
    private readonly runsBaseDir: string;
    private daemonPort = parseInt(process.env.PORT || '8080', 10);

    private constructor() {
        super();
        this.db = DesktopDb.getInstance().getDb();
        this.daemonRoot = path.resolve(__dirname, '../..');
        this.runnerScriptPath = path.join(this.daemonRoot, 'agents', 'edge_runner.py');
        this.runsBaseDir = path.join(this.daemonRoot, 'db', 'agent_runs');

        if (!fs.existsSync(this.runsBaseDir)) {
            fs.mkdirSync(this.runsBaseDir, { recursive: true });
        }
    }

    public static getInstance(): AgentRunManager {
        if (!AgentRunManager.instance) {
            AgentRunManager.instance = new AgentRunManager();
        }
        return AgentRunManager.instance;
    }

    public setDaemonPort(port: number): void {
        this.daemonPort = port;
    }

    public getRunDir(runId: string): string {
        return path.join(this.runsBaseDir, runId);
    }

    /**
     * Appends an event to `agent_run_events` and emits `run_event` for live WebSocket broadcast.
     * Used internally and also by OpenAIGatewayRoutes for live `route_decision` badges.
     */
    public appendEvent(
        runId: string,
        eventType: AgentRunEventType,
        payload: Record<string, unknown>
    ): AgentRunEventDTO {
        const now = Date.now();
        const res = this.db
            .prepare(`
                INSERT INTO agent_run_events (run_id, event_type, payload_json, created_at_ms)
                VALUES (?, ?, ?, ?)
            `)
            .run(runId, eventType, JSON.stringify(payload), now);

        const seq = Number(res.lastInsertRowid ?? 0);
        const dto: AgentRunEventDTO = {
            runId,
            seq,
            event_type: eventType,
            payload,
            created_at_ms: now,
        };
        this.emit('run_event', dto);
        return dto;
    }

    /**
     * Launches a registered READY Python agent via `uv run --project <folderPath> python edge_runner.py`.
     */
    public async startRun(params: {
        agentId: string;
        inputs?: Record<string, unknown> | undefined;
        originClientId: string;
    }): Promise<{ runId: string; traceId: string; sessionId: string }> {
        const agent = this.registry.getAgent(params.agentId);
        if (!agent) {
            throw new Error(`Agent "${params.agentId}" is not registered.`);
        }
        if (agent.validationStatus !== 'READY') {
            throw new Error(
                `Agent "${agent.name}" is not READY (status=${agent.validationStatus}). Fix pre-flight errors first.`
            );
        }

        if (!fs.existsSync(this.runnerScriptPath)) {
            throw new Error(`Missing edge_runner.py at ${this.runnerScriptPath}`);
        }

        const uvBin = await resolveUvBinary();
        if (!uvBin) {
            throw new Error('Could not locate `uv` binary on host.');
        }

        const runId = DesktopDb.generateUuidV7('run');
        const traceId = crypto.randomBytes(16).toString('hex');
        const sessionId = `agent_${runId}`;
        const now = Date.now();
        const inputs = params.inputs ?? {};
        const originClientId = params.originClientId || 'admin_ui:local';

        const runDir = this.getRunDir(runId);
        fs.mkdirSync(runDir, { recursive: true });

        const resolvedMounts = this.registry.resolveVerifiedMounts(agent.folderPath, agent.manifest);
        const folderEnv = this.registry.loadFolderEnv(agent.folderPath);

        const timeoutSec = Math.max(30, agent.manifest.runtime.timeout_sec ?? 900);
        const runToken = this.tokenRegistry.issueRunToken(
            runId,
            traceId,
            sessionId,
            (timeoutSec + 600) * 1000
        );

        this.db
            .prepare(`
                INSERT INTO agent_runs (
                    run_id, agent_id, trace_id, session_id, origin_client_id, pid, status,
                    inputs_json, pending_interrupt_id, pending_interrupt_json, artifacts_json, started_at_ms
                ) VALUES (?, ?, ?, ?, ?, NULL, 'QUEUED', ?, NULL, NULL, '[]', ?)
            `)
            .run(runId, agent.agentId, traceId, sessionId, originClientId, JSON.stringify(inputs), now);

        const manifestPath = path.join(agent.folderPath, 'edge-agent.json');
        const child = spawn(
            uvBin,
            [
                'run',
                '--project',
                agent.folderPath,
                'python',
                this.runnerScriptPath,
                '--manifest',
                manifestPath,
            ],
            {
                cwd: agent.folderPath,
                detached: process.platform !== 'win32',
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    ...folderEnv,
                    OPENAI_BASE_URL: `http://127.0.0.1:${this.daemonPort}/v1`,
                    OPENAI_API_KEY: runToken,
                    EDGE_RUN_ID: runId,
                    EDGE_TRACE_ID: traceId,
                    EDGE_SESSION_ID: sessionId,
                    EDGE_RUN_DIR: runDir,
                    EDGE_RUN_INPUT_JSON: JSON.stringify(inputs),
                    EDGE_MOUNTS_JSON: JSON.stringify(resolvedMounts),
                    PYTHONUNBUFFERED: '1',
                    PYTHONIOENCODING: 'utf-8',
                },
            }
        );

        const pid = child.pid ?? null;
        this.db
            .prepare(`UPDATE agent_runs SET pid = ?, status = 'RUNNING' WHERE run_id = ?`)
            .run(pid, runId);

        this.appendEvent(runId, 'status', {
            status: 'RUNNING',
            agentId: agent.agentId,
            agentName: agent.name,
            pid,
        });

        const timeoutTimer = setTimeout(() => {
            const active = this.activeRuns.get(runId);
            if (!active) return;
            console.warn(`[AgentRunManager] ⏱️ Run ${runId} timed out after ${timeoutSec}s. Killing tree.`);
            this.failRunAndKill(runId, `Agent timed out after ${timeoutSec}s`).catch(() => {});
        }, timeoutSec * 1000);

        this.activeRuns.set(runId, {
            runId,
            child,
            runToken,
            runDir,
            originClientId,
            timeoutTimer,
            cancelled: false,
        });

        this.attachProcessStreams(runId, child, originClientId);

        console.log(
            `[AgentRunManager] 🚀 Started run ${runId} for "${agent.name}" (PID=${pid}, origin=${originClientId})`
        );

        return { runId, traceId, sessionId };
    }

    private attachProcessStreams(
        runId: string,
        child: ChildProcess,
        originClientId: string
    ): void {
        let stdoutBuf = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            stdoutBuf += chunk.toString('utf8');
            const lines = stdoutBuf.split(/\r?\n/);
            stdoutBuf = lines.pop() ?? '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;
                this.handleProtocolLine(runId, line, originClientId);
            }
        });

        let stderrBuf = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderrBuf += chunk.toString('utf8');
            const lines = stderrBuf.split(/\r?\n/);
            stderrBuf = lines.pop() ?? '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line) continue;
                this.appendEvent(runId, 'stderr_log', { line: line.slice(0, 2000) });
            }
        });

        child.on('error', (err) => {
            console.error(`[AgentRunManager] Subprocess error (${runId}):`, err);
            this.finalizeRun(runId, 'FAILED', err.message);
        });

        child.on('close', (code) => {
            if (stdoutBuf.trim()) {
                this.handleProtocolLine(runId, stdoutBuf.trim(), originClientId);
            }
            if (stderrBuf.trim()) {
                this.appendEvent(runId, 'stderr_log', { line: stderrBuf.trim().slice(0, 2000) });
            }

            const active = this.activeRuns.get(runId);
            if (active) {
                clearTimeout(active.timeoutTimer);
                this.tokenRegistry.revokeRunToken(active.runToken);
                this.activeRuns.delete(runId);
            }

            const current = this.getRun(runId);
            if (!current) return;

            if (
                current.status === 'RUNNING' ||
                current.status === 'WAITING_FOR_INPUT' ||
                current.status === 'QUEUED'
            ) {
                if (active?.cancelled) {
                    this.finalizeRun(runId, 'CANCELLED', 'Cancelled by user');
                } else if (code === 0) {
                    this.finalizeRun(runId, 'COMPLETED');
                } else {
                    this.finalizeRun(runId, 'FAILED', `Subprocess exited with code ${code ?? -1}`);
                }
            }
        });
    }

    private handleProtocolLine(runId: string, line: string, originClientId: string): void {
        let evt: Record<string, unknown>;
        try {
            evt = JSON.parse(line) as Record<string, unknown>;
        } catch {
            // Defensively route any stray non-JSON stdout to stderr_log instead of crashing
            this.appendEvent(runId, 'stderr_log', { line: line.slice(0, 2000) });
            return;
        }

        const eventName = String(evt.event || '');
        switch (eventName) {
            case 'status': {
                this.appendEvent(runId, 'status', evt);
                break;
            }
            case 'todo_update': {
                this.appendEvent(runId, 'todo_update', { todos: evt.todos ?? [] });
                break;
            }
            case 'node_step': {
                this.appendEvent(runId, 'node_step', {
                    who: evt.who ?? 'manager',
                    node: evt.node ?? 'node',
                    action: evt.action ?? 'message',
                    summary: evt.summary ?? '',
                });
                break;
            }
            case 'interrupt': {
                const interruptId = String(evt.interrupt_id || `int_${Date.now()}`);
                const kind = evt.kind === 'hitl_approval' ? 'hitl_approval' : 'user_input';
                const interruptData = {
                    interruptId,
                    kind,
                    payload: evt.payload ?? {},
                    response_schema: evt.response_schema ?? null,
                };

                this.db
                    .prepare(`
                        UPDATE agent_runs
                        SET status = 'WAITING_FOR_INPUT',
                            pending_interrupt_id = ?,
                            pending_interrupt_json = ?
                        WHERE run_id = ?
                    `)
                    .run(interruptId, JSON.stringify(interruptData), runId);

                this.appendEvent(runId, 'interrupt', interruptData);
                this.emit('run_interrupt', {
                    runId,
                    interruptId,
                    kind,
                    payload: interruptData.payload,
                    response_schema: interruptData.response_schema,
                    priorityTargetClientId: originClientId,
                });
                break;
            }
            case 'artifact': {
                const artifact: AgentArtifactMeta = {
                    path: String(evt.path || ''),
                    size_bytes: Number(evt.size_bytes ?? 0),
                    mime: String(evt.mime || 'text/plain'),
                };
                if (artifact.path) {
                    this.recordArtifact(runId, artifact);
                    this.appendEvent(runId, 'artifact', artifact as unknown as Record<string, unknown>);
                }
                break;
            }
            case 'completed': {
                const artifacts = Array.isArray(evt.artifacts)
                    ? (evt.artifacts as AgentArtifactMeta[])
                    : undefined;
                if (artifacts) {
                    this.db
                        .prepare(`UPDATE agent_runs SET artifacts_json = ? WHERE run_id = ?`)
                        .run(JSON.stringify(artifacts), runId);
                }
                this.finalizeRun(runId, 'COMPLETED', undefined, {
                    final_answer: evt.final_answer ?? '',
                    artifacts: artifacts ?? [],
                });
                break;
            }
            case 'failed': {
                const errMsg = String(evt.error || 'Agent execution failed');
                this.finalizeRun(runId, 'FAILED', errMsg, {
                    error: errMsg,
                    traceback: evt.traceback ?? '',
                });
                break;
            }
            default: {
                this.appendEvent(runId, 'node_step', evt);
                break;
            }
        }
    }

    private recordArtifact(runId: string, artifact: AgentArtifactMeta): void {
        try {
            const row = this.db
                .prepare(`SELECT artifacts_json FROM agent_runs WHERE run_id = ?`)
                .get(runId) as { artifacts_json: string } | undefined;
            const list: AgentArtifactMeta[] = row ? JSON.parse(row.artifacts_json || '[]') : [];
            const idx = list.findIndex((a) => a.path === artifact.path);
            if (idx >= 0) {
                list[idx] = artifact;
            } else {
                list.push(artifact);
            }
            this.db
                .prepare(`UPDATE agent_runs SET artifacts_json = ? WHERE run_id = ?`)
                .run(JSON.stringify(list), runId);
        } catch {}
    }

    private finalizeRun(
        runId: string,
        status: 'COMPLETED' | 'FAILED' | 'CANCELLED',
        errorMessage?: string,
        extraEventPayload?: Record<string, unknown>
    ): void {
        const now = Date.now();
        const res = this.db
            .prepare(`
                UPDATE agent_runs
                SET status = ?,
                    completed_at_ms = COALESCE(completed_at_ms, ?),
                    pending_interrupt_id = NULL,
                    pending_interrupt_json = NULL,
                    error_message = COALESCE(?, error_message)
                WHERE run_id = ?
                  AND status NOT IN ('COMPLETED', 'FAILED', 'CANCELLED')
            `)
            .run(status, now, errorMessage ?? null, runId);

        if (Number(res.changes ?? 0) > 0) {
            this.appendEvent(runId, 'status', {
                status,
                ...(errorMessage ? { error: errorMessage } : {}),
                ...(extraEventPayload ?? {}),
            });
        }
    }

    /**
     * Atomic CAS interrupt resumption (prevents cross-device double-submit races).
     */
    public resumeRun(params: {
        runId: string;
        interruptId: string;
        resume: unknown;
        resolvedByClientId: string;
    }): { ok: boolean; error?: string } {
        const { runId, interruptId, resume, resolvedByClientId } = params;

        this.db.exec('BEGIN IMMEDIATE');
        let changes = 0;
        try {
            const res = this.db
                .prepare(`
                    UPDATE agent_runs
                    SET status = 'RUNNING',
                        pending_interrupt_id = NULL,
                        pending_interrupt_json = NULL
                    WHERE run_id = ?
                      AND status = 'WAITING_FOR_INPUT'
                      AND pending_interrupt_id = ?
                `)
                .run(runId, interruptId);
            changes = Number(res.changes ?? 0);
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }

        if (changes === 0) {
            return { ok: false, error: 'INTERRUPT_ALREADY_RESOLVED' };
        }

        const active = this.activeRuns.get(runId);
        if (!active || !active.child.stdin || !active.child.stdin.writable) {
            this.finalizeRun(runId, 'FAILED', 'Agent subprocess stdin is no longer available');
            return { ok: false, error: 'PROCESS_NOT_RUNNING' };
        }

        const line = JSON.stringify({ interrupt_id: interruptId, resume }) + '\n';
        active.child.stdin.write(line);

        this.appendEvent(runId, 'interrupt_resolved', {
            interruptId,
            resolvedByClientId,
        });

        this.emit('run_resumed', {
            runId,
            interruptId,
            resolvedByClientId,
        });

        return { ok: true };
    }

    /**
     * Kills the entire process tree (Windows `taskkill /T /F`, POSIX `-pid`) and marks CANCELLED.
     */
    public async cancelRun(runId: string): Promise<{ ok: boolean; cancelled: boolean }> {
        const active = this.activeRuns.get(runId);
        if (active) {
            active.cancelled = true;
            clearTimeout(active.timeoutTimer);
            this.tokenRegistry.revokeRunToken(active.runToken);
            await killProcessTree(active.child.pid);
            this.activeRuns.delete(runId);
        } else {
            const row = this.getRun(runId);
            if (row?.pid) {
                await killProcessTree(row.pid);
            }
        }

        this.finalizeRun(runId, 'CANCELLED', 'Cancelled by client');
        return { ok: true, cancelled: true };
    }

    private async failRunAndKill(runId: string, reason: string): Promise<void> {
        this.finalizeRun(runId, 'FAILED', reason);
        const active = this.activeRuns.get(runId);
        if (active) {
            clearTimeout(active.timeoutTimer);
            this.tokenRegistry.revokeRunToken(active.runToken);
            this.activeRuns.delete(runId);
            await killProcessTree(active.child.pid);
        }
    }

    public listRuns(
        limit = 30,
        filters?: { agentId?: string | undefined; status?: string | undefined }
    ): AgentRunDTO[] {
        const clauses: string[] = [];
        const params: Array<string | number> = [];

        if (filters?.agentId) {
            clauses.push('r.agent_id = ?');
            params.push(filters.agentId);
        }
        if (filters?.status) {
            clauses.push('r.status = ?');
            params.push(filters.status);
        }

        const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
        params.push(limit);

        const rows = this.db
            .prepare(`
                SELECT r.*, a.name AS agent_name
                FROM agent_runs r
                LEFT JOIN registered_agents a ON a.agent_id = r.agent_id
                ${whereSql}
                ORDER BY r.started_at_ms DESC
                LIMIT ?
            `)
            .all(...params) as unknown as Array<AgentRunRecord & { agent_name?: string | null }>;

        return rows.map((r) => this.toRunDTO(r));
    }

    public getRun(runId: string): AgentRunDTO | null {
        const row = this.db
            .prepare(`
                SELECT r.*, a.name AS agent_name
                FROM agent_runs r
                LEFT JOIN registered_agents a ON a.agent_id = r.agent_id
                WHERE r.run_id = ?
            `)
            .get(runId) as unknown as (AgentRunRecord & { agent_name?: string | null }) | undefined;
        return row ? this.toRunDTO(row) : null;
    }

    public getRunEvents(runId: string, afterSeq = 0, limit = 500): AgentRunEventDTO[] {
        const rows = this.db
            .prepare(`
                SELECT * FROM agent_run_events
                WHERE run_id = ? AND seq > ?
                ORDER BY seq ASC
                LIMIT ?
            `)
            .all(runId, afterSeq, limit) as unknown as AgentRunEventRecord[];

        return rows.map((r) => {
            let payload: Record<string, unknown> = {};
            try {
                payload = JSON.parse(r.payload_json || '{}') as Record<string, unknown>;
            } catch {}
            return {
                runId: r.run_id,
                seq: r.seq,
                event_type: r.event_type,
                payload,
                created_at_ms: r.created_at_ms,
            };
        });
    }

    /**
     * Resolves an artifact file path strictly inside EDGE_RUN_DIR (blocks `..` traversal).
     */
    public resolveArtifactFile(runId: string, relPath: string): { realPath: string; mime: string } {
        const runDir = this.getRunDir(runId);
        if (!fs.existsSync(runDir)) {
            throw new Error(`Run directory for "${runId}" does not exist.`);
        }
        const canonicalRunDir = fs.realpathSync(runDir);
        const candidate = path.resolve(canonicalRunDir, relPath);
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
            throw new Error(`Artifact "${relPath}" not found.`);
        }
        const realPath = fs.realpathSync(candidate);
        if (!isPathInsideRoot(realPath, canonicalRunDir)) {
            throw new Error('Forbidden: artifact path escapes run directory.');
        }

        const ext = path.extname(realPath).toLowerCase();
        const mime =
            ext === '.md'
                ? 'text/markdown; charset=utf-8'
                : ext === '.json'
                    ? 'application/json; charset=utf-8'
                    : ext === '.csv'
                        ? 'text/csv; charset=utf-8'
                        : 'text/plain; charset=utf-8';

        return { realPath, mime };
    }

    private toRunDTO(row: AgentRunRecord & { agent_name?: string | null }): AgentRunDTO {
        let inputs: Record<string, unknown> = {};
        let pendingInterrupt: Record<string, unknown> | null = null;
        let artifacts: AgentArtifactMeta[] = [];

        try {
            inputs = JSON.parse(row.inputs_json || '{}') as Record<string, unknown>;
        } catch {}
        try {
            pendingInterrupt = row.pending_interrupt_json
                ? (JSON.parse(row.pending_interrupt_json) as Record<string, unknown>)
                : null;
        } catch {}
        try {
            artifacts = JSON.parse(row.artifacts_json || '[]') as AgentArtifactMeta[];
        } catch {}

        return {
            runId: row.run_id,
            agentId: row.agent_id,
            agentName: row.agent_name ?? undefined,
            traceId: row.trace_id,
            sessionId: row.session_id,
            originClientId: row.origin_client_id,
            pid: row.pid,
            status: row.status,
            inputs,
            pendingInterruptId: row.pending_interrupt_id,
            pendingInterrupt,
            artifacts,
            startedAtMs: row.started_at_ms,
            completedAtMs: row.completed_at_ms,
            errorMessage: row.error_message,
        };
    }
}
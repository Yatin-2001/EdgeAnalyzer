import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DesktopDb {
    private static instance: DesktopDb;
    private db: DatabaseSync;
    public readonly dbPath: string;

    private constructor() {
        const dbDir = path.resolve(__dirname, '../../db');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        this.dbPath = path.join(dbDir, 'desktop_mesh.db');
        this.db = new DatabaseSync(this.dbPath);

        this.initSchema();
        this.runStartupRecovery();
    }

    public static getInstance(): DesktopDb {
        if (!DesktopDb.instance) {
            DesktopDb.instance = new DesktopDb();
        }
        return DesktopDb.instance;
    }

    public getDb(): DatabaseSync {
        return this.db;
    }

    public static generateUuidV7(prefix?: string): string {
        const nowMs = BigInt(Date.now());
        const bytes = crypto.randomBytes(16);

        // 48-bit big-endian Unix timestamp in milliseconds
        bytes[0] = Number((nowMs >> 40n) & 0xffn);
        bytes[1] = Number((nowMs >> 32n) & 0xffn);
        bytes[2] = Number((nowMs >> 24n) & 0xffn);
        bytes[3] = Number((nowMs >> 16n) & 0xffn);
        bytes[4] = Number((nowMs >> 8n) & 0xffn);
        bytes[5] = Number(nowMs & 0xffn);

        // Version 7 & RFC 4122 variant bits
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

        const hex = bytes.toString('hex');
        const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        return prefix ? `${prefix}_${uuid}` : uuid;
    }

    private initSchema(): void {
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS registered_agents (
                agent_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                version TEXT NOT NULL,
                folder_path TEXT NOT NULL UNIQUE,
                manifest_json TEXT NOT NULL,
                validation_status TEXT NOT NULL,
                validation_report_json TEXT NOT NULL,
                registered_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
                run_id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                trace_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                origin_client_id TEXT NOT NULL,
                pid INTEGER,
                status TEXT NOT NULL,
                inputs_json TEXT NOT NULL,
                pending_interrupt_id TEXT,
                pending_interrupt_json TEXT,
                artifacts_json TEXT NOT NULL DEFAULT '[]',
                started_at_ms INTEGER NOT NULL,
                completed_at_ms INTEGER,
                error_message TEXT,
                FOREIGN KEY (agent_id) REFERENCES registered_agents(agent_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_runs_status
                ON agent_runs(status, started_at_ms DESC);

            CREATE TABLE IF NOT EXISTS agent_run_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_events_run
                ON agent_run_events(run_id, seq ASC);

            CREATE TABLE IF NOT EXISTS task_queue (
                task_id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL DEFAULT 'openai_gateway',
                run_id TEXT,
                session_id TEXT NOT NULL,
                trace_id TEXT NOT NULL,
                parent_span_id TEXT,
                client_device_id TEXT,
                connection_id TEXT,
                requested_model TEXT NOT NULL,
                resolved_node_id TEXT,
                resolved_model TEXT,
                routing_reason TEXT,
                priority INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL,
                estimated_tokens INTEGER NOT NULL DEFAULT 0,
                payload_json TEXT NOT NULL,
                enqueued_at_ms INTEGER NOT NULL,
                dequeued_at_ms INTEGER,
                completed_at_ms INTEGER,
                error_message TEXT,
                FOREIGN KEY (run_id) REFERENCES agent_runs(run_id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tq_sched
                ON task_queue(status, priority DESC, enqueued_at_ms ASC);

            CREATE INDEX IF NOT EXISTS idx_tq_lookup
                ON task_queue(task_id, trace_id);
        `);
    }

    private isPidAlive(pid: number | null | undefined): boolean {
        if (!pid || pid <= 0) return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException)?.code;
            return code === 'EPERM';
        }
    }

    private runStartupRecovery(): void {
        const now = Date.now();
        try {
            const taskRes = this.db
                .prepare(`
                    UPDATE task_queue
                    SET status = 'FAILED',
                        completed_at_ms = ?,
                        error_message = 'Daemon restarted during execution'
                    WHERE status = 'PROCESSING'
                `)
                .run(now);

            if (taskRes.changes && Number(taskRes.changes) > 0) {
                console.warn(
                    `[DesktopDb] ⚠️ Marked ${taskRes.changes} orphaned PROCESSING task_queue row(s) as FAILED.`
                );
            }

            const activeRuns = this.db
                .prepare(`
                    SELECT run_id, pid
                    FROM agent_runs
                    WHERE status IN ('RUNNING', 'WAITING_FOR_INPUT')
                `)
                .all() as Array<{ run_id: string; pid: number | null }>;

            const failRunStmt = this.db.prepare(`
                UPDATE agent_runs
                SET status = 'FAILED',
                    completed_at_ms = ?,
                    pending_interrupt_id = NULL,
                    pending_interrupt_json = NULL,
                    error_message = 'Daemon restarted during execution'
                WHERE run_id = ?
            `);

            let recoveredRuns = 0;
            for (const run of activeRuns) {
                if (!this.isPidAlive(run.pid)) {
                    failRunStmt.run(now, run.run_id);
                    recoveredRuns++;
                }
            }

            if (recoveredRuns > 0) {
                console.warn(
                    `[DesktopDb] ⚠️ Marked ${recoveredRuns} orphaned agent_runs row(s) as FAILED.`
                );
            }
        } catch (err) {
            console.error('[DesktopDb] Startup recovery error:', err);
        }
    }
}
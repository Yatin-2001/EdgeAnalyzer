import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import dotenv from 'dotenv';
import { DesktopDb } from '../db/DesktopDb.js';
import {
    execCommandWithTimeout,
    isPathInDeniedRoots,
    isPathInsideRoot,
    resolveUvBinary,
} from '../utils/processUtils.js';

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

export interface AgentMountConfig {
    path: string;
    mode: 'ro' | 'rw';
}

export interface EdgeAgentManifest {
    id: string;
    name: string;
    version: string;
    description?: string;
    runtime: {
        entrypoint: string; // e.g. "agent_app.graph:build_agent"
        timeout_sec?: number;
    };
    inputs: AgentInputField[];
    mounts?: Record<string, string | AgentMountConfig>;
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
    details?: Record<string, unknown>;
}

export interface ValidationReport {
    passed: boolean;
    checkedAtMs: number;
    gates: GateDiagnostic[];
}

export type AgentValidationStatus = 'READY' | 'FAILED_PREFLIGHT' | 'DISABLED';

export interface RegisteredAgentRecord {
    agent_id: string;
    name: string;
    version: string;
    folder_path: string;
    manifest_json: string;
    validation_status: AgentValidationStatus;
    validation_report_json: string;
    registered_at_ms: number;
    updated_at_ms: number;
}

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

const ENTRYPOINT_REGEX = /^[a-zA-Z0-9_./-]+:[a-zA-Z0-9_]+$/;
const VALID_INPUT_TYPES = new Set<string>(['string', 'textarea', 'number', 'boolean', 'select']);

export class AgentRegistryService extends EventEmitter {
    private static instance: AgentRegistryService;
    private db: DatabaseSync;
    private allowedExtraRoots: string[] = [];

    private constructor() {
        super();
        this.db = DesktopDb.getInstance().getDb();
        this.loadAllowedExtraRoots();
    }

    public static getInstance(): AgentRegistryService {
        if (!AgentRegistryService.instance) {
            AgentRegistryService.instance = new AgentRegistryService();
        }
        return AgentRegistryService.instance;
    }

    private loadAllowedExtraRoots(): void {
        const raw = process.env.ALLOWED_AGENT_ROOTS || '';
        const sep = process.platform === 'win32' ? ';' : ':';
        this.allowedExtraRoots = raw
            .split(sep)
            .map((p) => p.trim())
            .filter((p) => p.length > 0 && fs.existsSync(p))
            .map((p) => {
                try {
                    return fs.realpathSync(p);
                } catch {
                    return path.resolve(p);
                }
            });
    }

    public listAgents(onlyReady = false): RegisteredAgentDTO[] {
        const rows = onlyReady
            ? (this.db
                .prepare(
                    `SELECT * FROM registered_agents WHERE validation_status = 'READY' ORDER BY updated_at_ms DESC`
                )
                .all() as unknown as RegisteredAgentRecord[])
            : (this.db
                .prepare(`SELECT * FROM registered_agents ORDER BY updated_at_ms DESC`)
                .all() as unknown as RegisteredAgentRecord[]);

        return rows.map((r) => this.toDTO(r));
    }

    public getAgent(agentId: string): RegisteredAgentDTO | null {
        const row = this.db
            .prepare(`SELECT * FROM registered_agents WHERE agent_id = ?`)
            .get(agentId) as unknown as RegisteredAgentRecord | undefined;
        return row ? this.toDTO(row) : null;
    }

    public removeAgent(agentId: string): boolean {
        const res = this.db
            .prepare(`DELETE FROM registered_agents WHERE agent_id = ?`)
            .run(agentId);
        const deleted = Number(res.changes ?? 0) > 0;
        if (deleted) {
            this.emit('catalog_updated');
        }
        return deleted;
    }

    public async revalidateAgent(agentId: string): Promise<RegisteredAgentDTO> {
        const existing = this.getAgent(agentId);
        if (!existing) {
            throw new Error(`Agent "${agentId}" is not registered.`);
        }
        return this.registerFolder(existing.folderPath);
    }

    /**
     * Runs all 5 sequential pre-flight gates on `rawFolderPath` and upserts into `registered_agents`.
     */
    public async registerFolder(rawFolderPath: string): Promise<RegisteredAgentDTO> {
        const trimmed = (rawFolderPath || '').trim();
        if (!trimmed) {
            throw new Error('folderPath is required.');
        }

        if (!fs.existsSync(trimmed) || !fs.statSync(trimmed).isDirectory()) {
            throw new Error(`Agent folder does not exist or is not a directory: ${trimmed}`);
        }

        const canonicalFolder = fs.realpathSync(trimmed);
        const gates: GateDiagnostic[] = [];
        let parsedManifest: EdgeAgentManifest | null = null;
        let folderEnvVars: Record<string, string> = {};

        // ============================================================
        // GATE 1: Manifest Schema (edge-agent.json)
        // ============================================================
        const gate1 = this.runGate1Manifest(canonicalFolder);
        gates.push(gate1.diagnostic);
        parsedManifest = gate1.manifest;

        // ============================================================
        // GATE 2: Mount Containment & OS Deny-List
        // ============================================================
        if (parsedManifest) {
            gates.push(this.runGate2Mounts(canonicalFolder, parsedManifest));
        } else {
            gates.push({
                gate: 2,
                name: 'Mount Containment',
                passed: false,
                message: 'Skipped: Gate 1 manifest validation failed.',
            });
        }

        // ============================================================
        // GATE 3: Secret Binding (required_env[] check without leaking values)
        // ============================================================
        if (parsedManifest) {
            const gate3 = this.runGate3Secrets(canonicalFolder, parsedManifest);
            gates.push(gate3.diagnostic);
            folderEnvVars = gate3.loadedEnv;
        } else {
            gates.push({
                gate: 3,
                name: 'Secret Binding',
                passed: false,
                message: 'Skipped: Gate 1 manifest validation failed.',
            });
        }

        // ============================================================
        // GATE 4: Python Environment Check (`uv sync --frozen --no-dev` / `uv pip check`)
        // ============================================================
        const uvBin = await resolveUvBinary();
        if (parsedManifest && gates.every((g) => g.passed)) {
            gates.push(await this.runGate4PythonEnv(canonicalFolder, uvBin));
        } else {
            gates.push({
                gate: 4,
                name: 'Python Env Check',
                passed: false,
                message: 'Skipped: Previous pre-flight gate(s) failed.',
            });
        }

        // ============================================================
        // GATE 5: Dry-Run Compile & Entrypoint Callable Assertion
        // ============================================================
        if (parsedManifest && gates.every((g) => g.passed) && uvBin) {
            gates.push(
                await this.runGate5DryRunCompile(
                    canonicalFolder,
                    parsedManifest,
                    uvBin,
                    folderEnvVars
                )
            );
        } else {
            gates.push({
                gate: 5,
                name: 'Dry-Run Compile',
                passed: false,
                message: 'Skipped: Previous pre-flight gate(s) failed.',
            });
        }

        const allPassed = gates.every((g) => g.passed);
        const now = Date.now();

        const fallbackId = `invalid_${path.basename(canonicalFolder).toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`;
        const agentId = parsedManifest?.id || fallbackId;
        const manifestToStore: EdgeAgentManifest = parsedManifest ?? {
            id: agentId,
            name: path.basename(canonicalFolder),
            version: '0.0.0',
            runtime: { entrypoint: '' },
            inputs: [],
        };

        const report: ValidationReport = {
            passed: allPassed,
            checkedAtMs: now,
            gates,
        };
        const status: AgentValidationStatus = allPassed ? 'READY' : 'FAILED_PREFLIGHT';

        const existingByPath = this.db
            .prepare(`SELECT agent_id, registered_at_ms FROM registered_agents WHERE folder_path = ?`)
            .get(canonicalFolder) as { agent_id: string; registered_at_ms: number } | undefined;

        const existingById = this.db
            .prepare(`SELECT agent_id, registered_at_ms FROM registered_agents WHERE agent_id = ?`)
            .get(agentId) as { agent_id: string; registered_at_ms: number } | undefined;

        if (existingByPath && existingByPath.agent_id !== agentId) {
            this.db
                .prepare(`DELETE FROM registered_agents WHERE agent_id = ?`)
                .run(existingByPath.agent_id);
        }

        const registeredAt = existingByPath?.registered_at_ms ?? existingById?.registered_at_ms ?? now;

        this.db
            .prepare(`
                INSERT INTO registered_agents (
                    agent_id, name, version, folder_path, manifest_json,
                    validation_status, validation_report_json, registered_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(agent_id) DO UPDATE SET
                    name = excluded.name,
                    version = excluded.version,
                    folder_path = excluded.folder_path,
                    manifest_json = excluded.manifest_json,
                    validation_status = excluded.validation_status,
                    validation_report_json = excluded.validation_report_json,
                    updated_at_ms = excluded.updated_at_ms
            `)
            .run(
                agentId,
                manifestToStore.name,
                manifestToStore.version,
                canonicalFolder,
                JSON.stringify(manifestToStore),
                status,
                JSON.stringify(report),
                registeredAt,
                now
            );

        if (allPassed) {
            this.emit('catalog_updated');
        }

        const saved = this.getAgent(agentId);
        if (!saved) {
            throw new Error(`Failed to persist registered agent "${agentId}".`);
        }
        return saved;
    }

    /**
     * Resolves verified mount paths for an already-validated agent at launch time.
     */
    public resolveVerifiedMounts(folderPath: string, manifest: EdgeAgentManifest): Record<string, string> {
        const canonicalFolder = fs.realpathSync(folderPath);
        const resolved: Record<string, string> = {};
        const mounts = manifest.mounts ?? {};

        for (const [mountKey, mountVal] of Object.entries(mounts)) {
            const rawPath = typeof mountVal === 'string' ? mountVal : mountVal.path;
            const candidate = path.isAbsolute(rawPath)
                ? path.resolve(rawPath)
                : path.resolve(canonicalFolder, rawPath);
            const realTarget = fs.existsSync(candidate) ? fs.realpathSync(candidate) : candidate;
            resolved[mountKey] = realTarget;
        }
        return resolved;
    }

    /**
     * Loads the folder's `.env` file (if present) for injection into the agent subprocess.
     */
    public loadFolderEnv(folderPath: string): Record<string, string> {
        const envPath = path.join(folderPath, '.env');
        if (!fs.existsSync(envPath)) return {};
        try {
            return dotenv.parse(fs.readFileSync(envPath, 'utf8'));
        } catch {
            return {};
        }
    }

    private runGate1Manifest(canonicalFolder: string): {
        diagnostic: GateDiagnostic;
        manifest: EdgeAgentManifest | null;
    } {
        const manifestPath = path.join(canonicalFolder, 'edge-agent.json');
        if (!fs.existsSync(manifestPath)) {
            return {
                diagnostic: {
                    gate: 1,
                    name: 'Manifest Schema',
                    passed: false,
                    message: 'Missing edge-agent.json in folder root.',
                },
                manifest: null,
            };
        }

        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                diagnostic: {
                    gate: 1,
                    name: 'Manifest Schema',
                    passed: false,
                    message: `Malformed edge-agent.json: ${msg}`,
                },
                manifest: null,
            };
        }

        const obj = raw as Record<string, unknown> | null;
        const errors: string[] = [];

        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            errors.push('Manifest root must be a JSON object.');
        } else {
            if (typeof obj.id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(obj.id)) {
                errors.push('Missing or invalid string "id" (allowed: letters, numbers, ., _, -).');
            }
            if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
                errors.push('Missing or empty string "name".');
            }
            if (typeof obj.version !== 'string' || obj.version.trim().length === 0) {
                errors.push('Missing or empty string "version".');
            }

            const runtime = obj.runtime as Record<string, unknown> | undefined;
            if (!runtime || typeof runtime !== 'object') {
                errors.push('Missing "runtime" object.');
            } else if (
                typeof runtime.entrypoint !== 'string' ||
                !ENTRYPOINT_REGEX.test(runtime.entrypoint)
            ) {
                errors.push(
                    'Invalid "runtime.entrypoint" (must match ^[a-zA-Z0-9_./-]+:[a-zA-Z0-9_]+$, e.g. "app.agent:build_agent").'
                );
            }

            if (!Array.isArray(obj.inputs)) {
                errors.push('"inputs" must be an array.');
            } else {
                for (let i = 0; i < obj.inputs.length; i++) {
                    const inp = obj.inputs[i] as Record<string, unknown> | undefined;
                    if (!inp || typeof inp !== 'object') {
                        errors.push(`inputs[${i}] must be an object.`);
                        continue;
                    }
                    if (typeof inp.key !== 'string' || !inp.key.trim()) {
                        errors.push(`inputs[${i}].key must be a non-empty string.`);
                    }
                    if (typeof inp.label !== 'string' || !inp.label.trim()) {
                        errors.push(`inputs[${i}].label must be a non-empty string.`);
                    }
                    if (typeof inp.type !== 'string' || !VALID_INPUT_TYPES.has(inp.type)) {
                        errors.push(
                            `inputs[${i}].type must be one of: string, textarea, number, boolean, select.`
                        );
                    }
                }
            }

            if (obj.required_env !== undefined) {
                if (
                    !Array.isArray(obj.required_env) ||
                    obj.required_env.some((k) => typeof k !== 'string' || !k.trim())
                ) {
                    errors.push('"required_env" must be an array of non-empty strings.');
                }
            }
        }

        if (errors.length > 0) {
            return {
                diagnostic: {
                    gate: 1,
                    name: 'Manifest Schema',
                    passed: false,
                    message: errors.join(' '),
                    details: { errors },
                },
                manifest: null,
            };
        }

        const manifest = obj as unknown as EdgeAgentManifest;
        return {
            diagnostic: {
                gate: 1,
                name: 'Manifest Schema',
                passed: true,
                message: `Validated ${manifest.name} v${manifest.version} (${manifest.runtime.entrypoint}).`,
            },
            manifest,
        };
    }

    private runGate2Mounts(canonicalFolder: string, manifest: EdgeAgentManifest): GateDiagnostic {
        const mounts = manifest.mounts ?? {};
        const entries = Object.entries(mounts);
        if (entries.length === 0) {
            return {
                gate: 2,
                name: 'Mount Containment',
                passed: true,
                message: 'No external mounts declared (isolated to run directory).',
            };
        }

        const allowedRoots = [canonicalFolder, ...this.allowedExtraRoots];
        const failures: string[] = [];
        const verifiedMounts: Record<string, string> = {};

        for (const [key, rawCfg] of entries) {
            const rawPath = typeof rawCfg === 'string' ? rawCfg : rawCfg?.path;
            const mode: 'ro' | 'rw' = typeof rawCfg === 'string' ? 'ro' : rawCfg?.mode ?? 'ro';

            if (!rawPath || typeof rawPath !== 'string') {
                failures.push(`Mount "${key}" has an invalid path.`);
                continue;
            }

            const candidate = path.isAbsolute(rawPath)
                ? path.resolve(rawPath)
                : path.resolve(canonicalFolder, rawPath);

            const exists = fs.existsSync(candidate);
            if (mode === 'ro' && !exists) {
                failures.push(`Read-only mount "${key}" does not exist: ${rawPath}`);
                continue;
            }

            let realTarget: string;
            try {
                if (exists) {
                    realTarget = fs.realpathSync(candidate);
                } else {
                    // For rw mounts that don't exist yet, resolve nearest existing ancestor
                    const parentDir = path.dirname(candidate);
                    const realParent = fs.existsSync(parentDir)
                        ? fs.realpathSync(parentDir)
                        : path.resolve(parentDir);
                    realTarget = path.join(realParent, path.basename(candidate));
                }
            } catch (err: unknown) {
                failures.push(
                    `Failed to resolve mount "${key}": ${err instanceof Error ? err.message : String(err)}`
                );
                continue;
            }

            const deniedRoot = isPathInDeniedRoots(realTarget);
            if (deniedRoot) {
                failures.push(`Mount "${key}" targets denied system/credential root (${deniedRoot}).`);
                continue;
            }

            const insideAllowed = allowedRoots.some((root) => isPathInsideRoot(realTarget, root));
            if (!insideAllowed) {
                failures.push(
                    `Mount "${key}" (${rawPath}) escapes agent folder and ALLOWED_AGENT_ROOTS.`
                );
                continue;
            }

            verifiedMounts[key] = realTarget;
        }

        if (failures.length > 0) {
            return {
                gate: 2,
                name: 'Mount Containment',
                passed: false,
                message: failures.join(' '),
                details: { failures },
            };
        }

        return {
            gate: 2,
            name: 'Mount Containment',
            passed: true,
            message: `Verified ${entries.length} mount(s) inside allowed containment boundaries.`,
            details: { mounts: verifiedMounts },
        };
    }

    private runGate3Secrets(
        canonicalFolder: string,
        manifest: EdgeAgentManifest
    ): { diagnostic: GateDiagnostic; loadedEnv: Record<string, string> } {
        const folderEnv = this.loadFolderEnv(canonicalFolder);
        const requiredKeys = manifest.required_env ?? [];

        if (requiredKeys.length === 0) {
            return {
                diagnostic: {
                    gate: 3,
                    name: 'Secret Binding',
                    passed: true,
                    message: 'No required environment secrets declared.',
                },
                loadedEnv: folderEnv,
            };
        }

        const missingKeys: string[] = [];
        const presentKeys: string[] = [];

        for (const key of requiredKeys) {
            const val = folderEnv[key] ?? process.env[key];
            if (!val || val.trim().length === 0) {
                missingKeys.push(key);
            } else {
                presentKeys.push(key);
            }
        }

        if (missingKeys.length > 0) {
            return {
                diagnostic: {
                    gate: 3,
                    name: 'Secret Binding',
                    passed: false,
                    message: `Missing required environment key(s): ${missingKeys.join(', ')}`,
                    details: { missingKeys, presentKeys },
                },
                loadedEnv: folderEnv,
            };
        }

        return {
            diagnostic: {
                gate: 3,
                name: 'Secret Binding',
                passed: true,
                message: `Bound ${presentKeys.length} required secret key(s) (values redacted).`,
                details: { presentKeys },
            },
            loadedEnv: folderEnv,
        };
    }

    private async runGate4PythonEnv(
        canonicalFolder: string,
        uvBin: string | null
    ): Promise<GateDiagnostic> {
        if (!uvBin) {
            return {
                gate: 4,
                name: 'Python Env Check',
                passed: false,
                message:
                    'Could not locate `uv` binary (checked UV_BIN, PATH, and standard OS locations).',
            };
        }

        const hasPyproject = fs.existsSync(path.join(canonicalFolder, 'pyproject.toml'));
        const hasUvLock = fs.existsSync(path.join(canonicalFolder, 'uv.lock'));
        const hasVenv = fs.existsSync(path.join(canonicalFolder, '.venv'));

        if (!hasPyproject && !hasVenv) {
            return {
                gate: 4,
                name: 'Python Env Check',
                passed: false,
                message: 'Missing pyproject.toml (with uv.lock) or .venv inside agent folder.',
            };
        }

        const args =
            hasPyproject && hasUvLock
                ? ['sync', '--frozen', '--no-dev']
                : ['pip', 'check'];

        const res = await execCommandWithTimeout({
            command: uvBin,
            args,
            cwd: canonicalFolder,
            timeoutMs: 60000,
        });

        if (res.timedOut) {
            return {
                gate: 4,
                name: 'Python Env Check',
                passed: false,
                message: `uv ${args.join(' ')} timed out after 60s.`,
            };
        }

        if (res.exitCode !== 0) {
            const errOut = (res.stderr || res.stdout).trim().slice(0, 400);
            return {
                gate: 4,
                name: 'Python Env Check',
                passed: false,
                message: `uv ${args.join(' ')} failed (exit ${res.exitCode}): ${errOut}`,
            };
        }

        return {
            gate: 4,
            name: 'Python Env Check',
            passed: true,
            message: `Python environment verified via \`uv ${args.join(' ')}\`.`,
        };
    }

    private async runGate5DryRunCompile(
        canonicalFolder: string,
        manifest: EdgeAgentManifest,
        uvBin: string,
        folderEnvVars: Record<string, string>
    ): Promise<GateDiagnostic> {
        const entrypoint = manifest.runtime.entrypoint;
        const pythonSnippet = [
            'import importlib, sys',
            'sys.path.insert(0, ".")',
            'entry = sys.argv[1]',
            'mod_name, fn_name = entry.split(":", 1)',
            'mod_name = mod_name.replace("/", ".").removesuffix(".py")',
            'mod = importlib.import_module(mod_name)',
            'fn = getattr(mod, fn_name)',
            'assert callable(fn), f"{entry} is not callable"',
            'print("DRY_RUN_OK")',
        ].join('; ');

        const res = await execCommandWithTimeout({
            command: uvBin,
            args: ['run', '--project', canonicalFolder, 'python', '-c', pythonSnippet, entrypoint],
            cwd: canonicalFolder,
            env: {
                ...process.env,
                ...folderEnvVars,
                PYTHONUNBUFFERED: '1',
            },
            timeoutMs: 10000,
        });

        if (res.timedOut) {
            return {
                gate: 5,
                name: 'Dry-Run Compile',
                passed: false,
                message: `Dry-run import of "${entrypoint}" timed out after 10s.`,
            };
        }

        if (res.exitCode !== 0 || !res.stdout.includes('DRY_RUN_OK')) {
            const errOut = (res.stderr || res.stdout).trim().slice(0, 500);
            return {
                gate: 5,
                name: 'Dry-Run Compile',
                passed: false,
                message: `Entrypoint "${entrypoint}" failed dry-run compile: ${errOut}`,
            };
        }

        return {
            gate: 5,
            name: 'Dry-Run Compile',
            passed: true,
            message: `Entrypoint "${entrypoint}" imported and verified callable.`,
        };
    }

    private toDTO(row: RegisteredAgentRecord): RegisteredAgentDTO {
        let manifest: EdgeAgentManifest;
        try {
            manifest = JSON.parse(row.manifest_json) as EdgeAgentManifest;
        } catch {
            manifest = {
                id: row.agent_id,
                name: row.name,
                version: row.version,
                runtime: { entrypoint: '' },
                inputs: [],
            };
        }

        let report: ValidationReport;
        try {
            report = JSON.parse(row.validation_report_json) as ValidationReport;
        } catch {
            report = { passed: false, checkedAtMs: row.updated_at_ms, gates: [] };
        }

        return {
            agentId: row.agent_id,
            name: row.name,
            version: row.version,
            folderPath: row.folder_path,
            manifest,
            validationStatus: row.validation_status,
            validationReport: report,
            registeredAtMs: row.registered_at_ms,
            updatedAtMs: row.updated_at_ms,
        };
    }
}
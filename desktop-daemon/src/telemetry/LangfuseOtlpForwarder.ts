import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface UnifiedTelemetrySpan {
    span_id: string;
    trace_id: string;
    session_id: string;
    parent_span_id: string | null;
    name: string;
    observation_type: 'generation' | 'tool' | 'retriever' | 'span';
    target_device: string;
    duration_ms: number;
    ttft_ms?: number | null;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    tok_per_sec?: number | null;
    status: 'OK' | 'ERROR';
    error_message?: string | null;
    attributes_json: string;
    created_at: number;
}

export class LangfuseOtlpForwarder {
    private static instance: LangfuseOtlpForwarder;
    private db: DatabaseSync;
    private langfuseBaseUrl: string;
    private authHeader: string;
    private useOtlpEndpoint: boolean;
    private isLangfuseOnline = false;

    private constructor() {
        const dbDir = path.resolve(__dirname, '../../db');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        const dbPath = path.join(dbDir, 'desktop_telemetry.db');
        this.db = new DatabaseSync(dbPath);

        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS desktop_telemetry_spans (
                span_id TEXT PRIMARY KEY,
                trace_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                parent_span_id TEXT,
                name TEXT NOT NULL,
                observation_type TEXT NOT NULL,
                target_device TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                ttft_ms INTEGER,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                tok_per_sec REAL,
                status TEXT NOT NULL,
                error_message TEXT,
                attributes_json TEXT NOT NULL,
                forwarded_to_langfuse INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_desktop_spans_sync
                ON desktop_telemetry_spans (forwarded_to_langfuse, created_at);
            CREATE INDEX IF NOT EXISTS idx_desktop_spans_device_hwm
                ON desktop_telemetry_spans (target_device, created_at);
        `);

        this.langfuseBaseUrl = (process.env.LANGFUSE_HOST || 'http://127.0.0.1:3000').replace(/\/$/, '');
        const pubKey = process.env.LANGFUSE_PUBLIC_KEY || 'pk-lf-edgeanalyzer-local';
        const secKey = process.env.LANGFUSE_SECRET_KEY || 'sk-lf-edgeanalyzer-local';
        this.authHeader = `Basic ${Buffer.from(`${pubKey}:${secKey}`).toString('base64')}`;

        // Langfuse v2 uses /api/public/ingestion; set LANGFUSE_USE_OTLP=true only if running v3/v4
        this.useOtlpEndpoint = process.env.LANGFUSE_USE_OTLP === 'true';

        // Flush any cached spans shortly after startup, then every 15s
        setTimeout(() => {
            this.flushPendingToLangfuse().catch(() => {});
        }, 2000);

        setInterval(() => {
            this.flushPendingToLangfuse().catch(() => {});
        }, 15000);
    }

    public static getInstance(): LangfuseOtlpForwarder {
        if (!LangfuseOtlpForwarder.instance) {
            LangfuseOtlpForwarder.instance = new LangfuseOtlpForwarder();
        }
        return LangfuseOtlpForwarder.instance;
    }

    public static generateHexSpanId(): string {
        const timeHex = (Date.now() & 0xffffffff).toString(16).padStart(8, '0');
        let randHex = '';
        for (let i = 0; i < 8; i++) {
            randHex += Math.floor(Math.random() * 16).toString(16);
        }
        return (timeHex + randHex).toLowerCase();
    }

    public async ingestSpans(spans: UnifiedTelemetrySpan[]): Promise<string[]> {
        if (!Array.isArray(spans) || spans.length === 0) return [];

        const insertStmt = this.db.prepare(`
            INSERT OR IGNORE INTO desktop_telemetry_spans (
                span_id, trace_id, session_id, parent_span_id, name, observation_type,
                target_device, duration_ms, ttft_ms, prompt_tokens, completion_tokens,
                tok_per_sec, status, error_message, attributes_json, forwarded_to_langfuse, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `);

        const acceptedIds: string[] = [];
        this.db.exec('BEGIN IMMEDIATE');
        try {
            for (const s of spans) {
                if (!s.span_id || !s.trace_id) continue;
                insertStmt.run(
                    s.span_id,
                    s.trace_id,
                    s.session_id || 'default_session',
                    s.parent_span_id ?? null,
                    s.name,
                    s.observation_type || 'span',
                    s.target_device || 'unknown_device',
                    Math.max(0, Math.round(s.duration_ms || 0)),
                    s.ttft_ms ?? null,
                    s.prompt_tokens ?? null,
                    s.completion_tokens ?? null,
                    s.tok_per_sec ?? null,
                    s.status || 'OK',
                    s.error_message ?? null,
                    s.attributes_json || '{}',
                    s.created_at || Date.now()
                );
                acceptedIds.push(s.span_id);
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }

        this.flushPendingToLangfuse().catch(() => {});
        return acceptedIds;
    }

    public async flushPendingToLangfuse(): Promise<void> {
        const pendingStmt = this.db.prepare(`
            SELECT * FROM desktop_telemetry_spans
            WHERE forwarded_to_langfuse = 0
            ORDER BY created_at ASC
            LIMIT 100
        `);
        const rows = pendingStmt.all() as unknown as UnifiedTelemetrySpan[];
        if (rows.length === 0) return;

        const endpoint = this.useOtlpEndpoint
            ? `${this.langfuseBaseUrl}/api/public/otel/v1/traces`
            : `${this.langfuseBaseUrl}/api/public/ingestion`;

        const payload = this.useOtlpEndpoint
            ? this.buildOtlpPayload(rows)
            : this.buildLangfuseV2BatchPayload(rows);

        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: this.authHeader,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timer);

            const responseText = await res.text().catch(() => '');

            // Langfuse v2 /api/public/ingestion returns 207 Multi-Status (or 200/201) on success
            if (res.ok || res.status === 207) {
                let partialErrors: any[] = [];
                try {
                    const parsed = JSON.parse(responseText);
                    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
                        partialErrors = parsed.errors;
                    }
                } catch {}

                if (partialErrors.length > 0) {
                    console.warn(
                        `[Langfuse] ⚠️ Partial ingestion warnings (${partialErrors.length}):`,
                        JSON.stringify(partialErrors.slice(0, 3))
                    );
                }

                this.isLangfuseOnline = true;
                const markStmt = this.db.prepare(
                    `UPDATE desktop_telemetry_spans SET forwarded_to_langfuse = 1 WHERE span_id = ?`
                );
                this.db.exec('BEGIN IMMEDIATE');
                try {
                    for (const r of rows) {
                        markStmt.run(r.span_id);
                    }
                    this.db.exec('COMMIT');
                } catch {
                    this.db.exec('ROLLBACK');
                }
                console.log(`[Langfuse] ✅ Forwarded ${rows.length} span(s) to ${endpoint} (HTTP ${res.status})`);
            } else {
                this.isLangfuseOnline = false;
                console.warn(
                    `[Langfuse] ❌ Failed to forward spans to ${endpoint} (HTTP ${res.status}): ${responseText.substring(0, 300)}`
                );
            }
        } catch (err: any) {
            this.isLangfuseOnline = false;
            console.warn(`[Langfuse] ⚠️ Collector unreachable at ${this.langfuseBaseUrl}: ${err?.message || err}`);
        }
    }

    /**
     * Builds a Langfuse v2 /api/public/ingestion batch payload:
     * 1. Emits `trace-create` for each unique trace_id first
     * 2. Topologically orders spans so parents are created before children
     * 3. Maps `generation` -> `generation-create` (with model, usage, TTFT) and others -> `span-create`
     */
    private buildLangfuseV2BatchPayload(spans: UnifiedTelemetrySpan[]): { batch: any[] } {
        const batch: any[] = [];
        const createdTraceIds = new Set<string>();

        // 1. Emit trace-create events first
        for (const s of spans) {
            if (createdTraceIds.has(s.trace_id)) continue;
            createdTraceIds.add(s.trace_id);

            const traceSpans = spans.filter((x) => x.trace_id === s.trace_id);
            const rootSpan =
                traceSpans.find((x) => x.name === 'client.turn_orchestration') || traceSpans[0];

            let rootAttrs: Record<string, any> = {};
            try {
                rootAttrs = JSON.parse(rootSpan?.attributes_json || '{}');
            } catch {}

            // Resolve final trace output from root span or last generation span in this trace
            let traceOutput: any = rootAttrs['user.final_output'];
            if (!traceOutput) {
                const genSpans = traceSpans
                    .filter((x) => x.observation_type === 'generation')
                    .sort((a, b) => a.created_at - b.created_at);
                const lastGen = genSpans[genSpans.length - 1];
                if (lastGen) {
                    try {
                        const lastGenAttrs = JSON.parse(lastGen.attributes_json || '{}');
                        traceOutput = lastGenAttrs['gen_ai.completion'];
                    } catch {}
                }
            }

            const traceStartMs = Math.min(
                ...traceSpans.map((x) => Math.max(1, x.created_at - Math.max(0, x.duration_ms)))
            );
            const isoTimestamp = new Date(traceStartMs).toISOString();

            batch.push({
                id: `evt_trace_${s.trace_id}_${Date.now()}`,
                type: 'trace-create',
                timestamp: isoTimestamp,
                body: {
                    id: s.trace_id,
                    timestamp: isoTimestamp,
                    name: rootAttrs['user.query_preview']
                        ? `Turn: ${String(rootAttrs['user.query_preview']).substring(0, 60)}`
                        : 'EdgeAnalyzer Turn',
                    sessionId: s.session_id,
                    input: rootAttrs['user.query_preview'] || undefined,
                    output: traceOutput || undefined,
                    metadata: {
                        target_compute_node: rootAttrs['target.compute_node'] || s.target_device,
                        source: 'edgeanalyzer-mesh',
                    },
                    tags: ['edgeanalyzer', s.target_device],
                },
            });
        }

        // 2. Order spans so root/parent spans appear before children in the batch
        const spanIdsInBatch = new Set(spans.map((s) => s.span_id));
        const orderedSpans = [...spans].sort((a, b) => {
            const aHasParentInBatch = a.parent_span_id && spanIdsInBatch.has(a.parent_span_id) ? 1 : 0;
            const bHasParentInBatch = b.parent_span_id && spanIdsInBatch.has(b.parent_span_id) ? 1 : 0;
            if (aHasParentInBatch !== bHasParentInBatch) {
                return aHasParentInBatch - bHasParentInBatch;
            }
            return a.created_at - b.created_at;
        });

        // 3. Emit span-create / generation-create events
        for (const s of orderedSpans) {
            let parsedAttrs: Record<string, any> = {};
            try {
                parsedAttrs = JSON.parse(s.attributes_json || '{}');
            } catch {}

            const endMs = Math.max(1, s.created_at);
            const startMs = Math.max(1, endMs - Math.max(0, s.duration_ms));
            const startIso = new Date(startMs).toISOString();
            const endIso = new Date(endMs).toISOString();

            // Keep Input/Output in top-level Langfuse fields rather than duplicating them in metadata
            const { 'gen_ai.prompt': genPrompt, 'gen_ai.completion': genCompletion, ...restAttrs } = parsedAttrs;

            const metadata: Record<string, any> = {
                ...restAttrs,
                target_device: s.target_device,
                observation_type: s.observation_type,
                tok_per_sec: s.tok_per_sec ?? undefined,
                ttft_ms: s.ttft_ms ?? undefined,
            };

            if (s.observation_type === 'generation') {
                const completionStartMs =
                    s.ttft_ms && s.ttft_ms > 0 ? Math.min(endMs, startMs + s.ttft_ms) : undefined;
                const inputTokens = s.prompt_tokens ?? 0;
                const outputTokens = s.completion_tokens ?? 0;

                batch.push({
                    id: `evt_gen_${s.span_id}`,
                    type: 'generation-create',
                    timestamp: endIso,
                    body: {
                        id: s.span_id,
                        traceId: s.trace_id,
                        parentObservationId: s.parent_span_id || undefined,
                        name: s.name,
                        startTime: startIso,
                        endTime: endIso,
                        completionStartTime: completionStartMs
                            ? new Date(completionStartMs).toISOString()
                            : undefined,
                        model: parsedAttrs['gen_ai.request.model'] || 'local-llm',
                        input: genPrompt ?? undefined,
                        output: genCompletion ?? undefined,
                        usage: {
                            input: inputTokens,
                            output: outputTokens,
                            total: inputTokens + outputTokens,
                            unit: 'TOKENS',
                        },
                        level: s.status === 'ERROR' ? 'ERROR' : 'DEFAULT',
                        statusMessage: s.error_message || undefined,
                        metadata,
                    },
                });
            } else {
                batch.push({
                    id: `evt_span_${s.span_id}`,
                    type: 'span-create',
                    timestamp: endIso,
                    body: {
                        id: s.span_id,
                        traceId: s.trace_id,
                        parentObservationId: s.parent_span_id || undefined,
                        name: s.name,
                        startTime: startIso,
                        endTime: endIso,
                        input: parsedAttrs['tool.args'] || parsedAttrs['rag.query'] || parsedAttrs['user.query_preview'] || undefined,
                        output: parsedAttrs['tool.output'] || parsedAttrs['user.final_output'] || undefined,
                        level: s.status === 'ERROR' ? 'ERROR' : 'DEFAULT',
                        statusMessage: s.error_message || undefined,
                        metadata,
                    },
                });
            }
        }

        return { batch };
    }

    private toOtlpTraceId(rawTraceId: string): string {
        const cleanHex = rawTraceId.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        if (cleanHex.length >= 32) return cleanHex.slice(0, 32);
        return cleanHex.padEnd(32, '0');
    }

    private toOtlpSpanId(rawSpanId: string | null | undefined): string | undefined {
        if (!rawSpanId) return undefined;
        const cleanHex = rawSpanId.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
        if (cleanHex.length >= 16) return cleanHex.slice(0, 16);
        return cleanHex.padEnd(16, '0');
    }

    private buildOtlpPayload(spans: UnifiedTelemetrySpan[]): Record<string, any> {
        const otelSpans = spans.map((s) => {
            let parsedAttrs: Record<string, any> = {};
            try {
                parsedAttrs = JSON.parse(s.attributes_json || '{}');
            } catch {}

            const startEpochMs = s.created_at - Math.max(0, s.duration_ms);
            const startTimeUnixNano = (BigInt(Math.max(1, startEpochMs)) * 1000000n).toString();
            const endTimeUnixNano = (BigInt(Math.max(1, s.created_at)) * 1000000n).toString();

            const mergedAttributes: Record<string, any> = {
                'langfuse.session.id': s.session_id,
                'session.id': s.session_id,
                'langfuse.observation.type': s.observation_type,
                'mesh.target_device': s.target_device,
                ...parsedAttrs,
            };

            const otelAttrArray = Object.entries(mergedAttributes)
                .filter(([_, v]) => v !== undefined && v !== null)
                .map(([key, value]) => ({
                    key,
                    value: { stringValue: typeof value === 'string' ? value : JSON.stringify(value) },
                }));

            const spanObj: Record<string, any> = {
                traceId: this.toOtlpTraceId(s.trace_id),
                spanId: this.toOtlpSpanId(s.span_id),
                name: s.name,
                kind: s.observation_type === 'generation' ? 3 : 1,
                startTimeUnixNano,
                endTimeUnixNano,
                attributes: otelAttrArray,
                status: { code: s.status === 'ERROR' ? 2 : 1, message: s.error_message || '' },
            };

            const parentHex = this.toOtlpSpanId(s.parent_span_id);
            if (parentHex) spanObj.parentSpanId = parentHex;
            return spanObj;
        });

        return {
            resourceSpans: [
                {
                    resource: {
                        attributes: [{ key: 'service.name', value: { stringValue: 'edgeanalyzer-mesh' } }],
                    },
                    scopeSpans: [{ scope: { name: 'edgeanalyzer.tracer', version: '1.0.0' }, spans: otelSpans }],
                },
            ],
        };
    }

    public getHighWaterMarks(): Record<string, number> {
        const stmt = this.db.prepare(`
            SELECT target_device, MAX(created_at) as max_ts
            FROM desktop_telemetry_spans
            GROUP BY target_device
        `);
        const rows = stmt.all() as Array<{ target_device: string; max_ts: number }>;
        const map: Record<string, number> = {};
        for (const r of rows) {
            map[r.target_device] = r.max_ts;
        }
        return map;
    }

    public getSpansDelta(peerWaterMarks: Record<string, number>, limit = 200): UnifiedTelemetrySpan[] {
        const stmt = this.db.prepare(`
            SELECT * FROM desktop_telemetry_spans
            ORDER BY created_at ASC
            LIMIT ?
        `);
        const allRecent = stmt.all(limit * 2) as unknown as UnifiedTelemetrySpan[];
        return allRecent
            .filter((s) => s.created_at > (peerWaterMarks[s.target_device] || 0))
            .slice(0, limit);
    }

    public getStatusSummary(): { collector: string; langfuseOnline: boolean; totalCachedSpans: number } {
        const row = this.db
            .prepare(`SELECT COUNT(*) as cnt FROM desktop_telemetry_spans`)
            .get() as { cnt: number };
        return {
            collector: 'langfuse',
            langfuseOnline: this.isLangfuseOnline,
            totalCachedSpans: row?.cnt || 0,
        };
    }
}
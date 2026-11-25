import fs from 'node:fs';
import express from 'express';
import type { Request, Response, Router } from 'express';
import { DeviceStore } from '../mesh/DeviceStore.js';
import { AuthTokenRegistry } from '../router/OpenAIGatewayRoutes.js';
import { AgentRegistryService } from './AgentRegistryService.js';
import { AgentRunManager } from './AgentRunManager.js';

function isLoopback(remoteAddress: string | undefined): boolean {
    if (!remoteAddress) return false;
    return (
        remoteAddress === '127.0.0.1' ||
        remoteAddress === '::1' ||
        remoteAddress === '::ffff:127.0.0.1'
    );
}

function getParamStr(raw: string | string[] | undefined): string {
    if (Array.isArray(raw)) return raw[0] ?? '';
    return typeof raw === 'string' ? raw : '';
}

function authenticateAgentClient(req: Request): { ok: boolean; clientId: string } {
    const authHeader = req.headers.authorization;
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    const bearer =
        (typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '') ||
        queryToken.trim();

    if (bearer) {
        const tokenRegistry = AuthTokenRegistry.getInstance();
        const adminMeta = tokenRegistry.validateAdminToken(bearer);
        if (adminMeta) return { ok: true, clientId: adminMeta.originClientId };

        if (tokenRegistry.isValidStaticAdminKey(bearer)) {
            return { ok: true, clientId: 'admin_ui:key' };
        }

        const dev = DeviceStore.getInstance().getByToken(bearer);
        if (dev) return { ok: true, clientId: `mobile:${dev.deviceId}` };
    }

    // Allow local Admin UI browser calls over loopback
    if (isLoopback(req.socket.remoteAddress)) {
        return { ok: true, clientId: 'admin_ui:loopback' };
    }

    return { ok: false, clientId: '' };
}

export function createAgentRouter(): Router {
    const router = express.Router();
    const registry = AgentRegistryService.getInstance();
    const runManager = AgentRunManager.getInstance();

    // Shared auth guard for /api/v1/agents*
    router.use('/api/v1/agents', (req: Request, res: Response, next) => {
        const auth = authenticateAgentClient(req);
        if (!auth.ok) {
            return res.status(401).json({
                error: 'UNAUTHORIZED',
                message: 'Valid Bearer token or loopback origin required.',
            });
        }
        (req as Request & { agentClientId?: string }).agentClientId = auth.clientId;
        next();
    });

    // =========================================================================
    // AGENT REGISTRY ROUTES
    // =========================================================================

    // GET /api/v1/agents (?onlyReady=true for mobile catalog)
    router.get('/api/v1/agents', (req: Request, res: Response) => {
        const onlyReady = String(req.query.onlyReady || '').toLowerCase() === 'true';
        const agents = registry.listAgents(onlyReady);
        return res.json({ agents });
    });

    // POST /api/v1/agents/register { folderPath }
    router.post('/api/v1/agents/register', async (req: Request, res: Response) => {
        const folderPath = typeof req.body?.folderPath === 'string' ? req.body.folderPath : '';
        if (!folderPath.trim()) {
            return res.status(400).json({ error: 'folderPath is required' });
        }

        try {
            const agent = await registry.registerFolder(folderPath);
            const statusCode = agent.validationStatus === 'READY' ? 200 : 422;
            return res.status(statusCode).json({
                agent,
                validationReport: agent.validationReport,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return res.status(400).json({ error: msg });
        }
    });

    // =========================================================================
    // AGENT RUN LIFECYCLE & REPLAY ROUTES (Registered BEFORE /:agentId)
    // =========================================================================

    // GET /api/v1/agents/runs
    router.get('/api/v1/agents/runs', (req: Request, res: Response) => {
        const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
        const runs = runManager.listRuns(limit);
        return res.json({ runs });
    });

    // POST /api/v1/agents/runs (REST launch companion to WS agent.run_start)
    router.post('/api/v1/agents/runs', async (req: Request, res: Response) => {
        const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId : '';
        const inputs =
            req.body?.inputs && typeof req.body.inputs === 'object'
                ? (req.body.inputs as Record<string, unknown>)
                : {};
        const originClientId =
            typeof req.body?.originClientId === 'string' && req.body.originClientId.trim()
                ? req.body.originClientId.trim()
                : (req as Request & { agentClientId?: string }).agentClientId || 'admin_ui:rest';

        if (!agentId) {
            return res.status(400).json({ error: 'agentId is required' });
        }

        try {
            const started = await runManager.startRun({ agentId, inputs, originClientId });
            return res.status(201).json(started);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return res.status(400).json({ error: msg });
        }
    });

    // GET /api/v1/agents/runs/:runId
    router.get('/api/v1/agents/runs/:runId', (req: Request, res: Response) => {
        const runId = getParamStr(req.params.runId);
        const run = runManager.getRun(runId);
        if (!run) return res.status(404).json({ error: 'RUN_NOT_FOUND' });
        return res.json({ run });
    });

    // GET /api/v1/agents/runs/:runId/events?afterSeq=0
    router.get('/api/v1/agents/runs/:runId/events', (req: Request, res: Response) => {
        const runId = getParamStr(req.params.runId);
        const afterSeq = parseInt(String(req.query.afterSeq || '0'), 10) || 0;
        const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit || '500'), 10) || 500));

        const run = runManager.getRun(runId);
        if (!run) return res.status(404).json({ error: 'RUN_NOT_FOUND' });

        const events = runManager.getRunEvents(runId, afterSeq, limit);
        return res.json({ run, events });
    });

    // POST /api/v1/agents/runs/:runId/resume (REST atomic CAS companion to WS agent.run_resume)
    router.post('/api/v1/agents/runs/:runId/resume', (req: Request, res: Response) => {
        const runId = getParamStr(req.params.runId);
        const interruptId = typeof req.body?.interruptId === 'string' ? req.body.interruptId : '';
        const resume = req.body?.resume;
        const resolvedByClientId =
            (req as Request & { agentClientId?: string }).agentClientId || 'admin_ui:rest';

        if (!interruptId) {
            return res.status(400).json({ error: 'interruptId is required' });
        }

        const result = runManager.resumeRun({ runId, interruptId, resume, resolvedByClientId });
        if (!result.ok) {
            return res.status(409).json(result);
        }
        return res.json(result);
    });

    // POST /api/v1/agents/runs/:runId/cancel (REST cancel companion to WS agent.run_cancel)
    router.post('/api/v1/agents/runs/:runId/cancel', async (req: Request, res: Response) => {
        const runId = getParamStr(req.params.runId);
        const result = await runManager.cancelRun(runId);
        return res.json(result);
    });

    // GET /api/v1/agents/runs/:runId/artifacts/*relPath (Express 5 named wildcard)
    router.get('/api/v1/agents/runs/:runId/artifacts/*relPath', (req: Request, res: Response) => {
        const runId = getParamStr(req.params.runId);
        const rawRel = req.params.relPath as string | string[] | undefined;
        const relPath = Array.isArray(rawRel) ? rawRel.join('/') : String(rawRel ?? '');

        if (!relPath) {
            return res.status(400).json({ error: 'Artifact relative path is required' });
        }

        try {
            const { realPath, mime } = runManager.resolveArtifactFile(runId, relPath);
            res.setHeader('Content-Type', mime);
            const stream = fs.createReadStream(realPath);
            stream.on('error', (err) => {
                if (!res.headersSent) {
                    res.status(500).json({ error: err.message });
                }
            });
            stream.pipe(res);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = msg.startsWith('Forbidden') ? 403 : 404;
            return res.status(code).json({ error: msg });
        }
    });

    // =========================================================================
    // PER-AGENT MANAGEMENT ROUTES
    // =========================================================================

    // POST /api/v1/agents/:agentId/revalidate
    router.post('/api/v1/agents/:agentId/revalidate', async (req: Request, res: Response) => {
        const agentId = getParamStr(req.params.agentId);
        try {
            const agent = await registry.revalidateAgent(agentId);
            const statusCode = agent.validationStatus === 'READY' ? 200 : 422;
            return res.status(statusCode).json({
                agent,
                validationReport: agent.validationReport,
            });
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return res.status(404).json({ error: msg });
        }
    });

    // DELETE /api/v1/agents/:agentId
    router.delete('/api/v1/agents/:agentId', (req: Request, res: Response) => {
        const agentId = getParamStr(req.params.agentId);
        const deleted = registry.removeAgent(agentId);
        if (!deleted) {
            return res.status(404).json({ error: 'AGENT_NOT_FOUND' });
        }
        return res.json({ deleted: true, agentId });
    });

    return router;
}
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import path from 'path';
import os from 'os';
import { DeviceStore } from './mesh/DeviceStore.js';
import { PairingManager } from './mesh/PairingManager.js';
import { DiscoveryService } from './mesh/DiscoveryService.js';
import { OllamaBridge } from './mcp/OllamaBridge.js';
import { MCPProtocol } from './mcp/MCPProtocol.js';
import { SystemTelemetry } from './mesh/SystemTelemetry';

const PORT = 8080;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/mcp' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Helper: Get local network IPv4 address (e.g., 192.168.1.X)
function getLocalNetworkIp(): string {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const net of interfaces[name] || []) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
    return '127.0.0.1';
}

const adminDistPath = path.resolve(__dirname, '../admin-ui/dist');
app.use(express.static(adminDistPath));

const deviceStore = DeviceStore.getInstance();
const pairingManager = PairingManager.getInstance();
const discovery = DiscoveryService.getInstance();
const ollama = OllamaBridge.getInstance();
const mcp = new MCPProtocol();
const telemetryService = SystemTelemetry.getInstance();

const activeSockets = new Map<string, WebSocket>();

// 1. PIN Management Routes
app.post('/api/mesh/pin/generate', (_req, res) => {
    const result = pairingManager.generatePairingPin();
    const hostIp = getLocalNetworkIp();
    res.json({
        ...result,
        host: hostIp,
        port: PORT,
    });
});

app.get('/api/mesh/pin/status', (_req, res) => {
    const session = pairingManager.getActiveSession();
    const hostIp = getLocalNetworkIp();
    res.json({
        active: !!session,
        session,
        host: hostIp,
        port: PORT,
    });
});

// 2. Handshake Pairing Route
app.post('/api/mesh/pair', (req, res) => {
    const { pin, deviceId, deviceName, deviceTier, capabilities } = req.body;
    if (!pin || !deviceId || !deviceName || !deviceTier) {
        return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    try {
        const clientIp = req.socket.remoteAddress || 'unknown';
        const { meshToken } = pairingManager.verifyAndRegisterDevice(pin, {
            deviceId,
            deviceName,
            deviceTier,
            network: { ip: clientIp, port: 0 },
            capabilities: capabilities || {
                canRunInference: false,
                activeModality: 'none',
                maxContextTokens: 2048,
            },
        });

        res.json({ status: 'PAIRED', meshToken });
    } catch (err: any) {
        res.status(401).json({ error: err.message });
    }
});

// 3. Paired Devices Management
app.get('/api/mesh/devices', (_req, res) => {
    const devices = deviceStore.getAll().map((dev) => ({
        ...dev,
        isOnline: activeSockets.has(dev.deviceId),
    }));
    res.json({ devices });
});

app.post('/api/mesh/devices/revoke', (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'DEVICE_ID_REQUIRED' });

    deviceStore.revoke(deviceId);
    const activeSocket = activeSockets.get(deviceId);
    if (activeSocket) {
        activeSocket.terminate();
        activeSockets.delete(deviceId);
    }
    res.json({ status: 'REVOKED', deviceId });
});

// 4. Ollama Telemetry Routes
app.get('/api/mesh/telemetry', async (_req, res) => {
    const gpu = await telemetryService.getGpuStats();
    const systemRam = telemetryService.getSystemRamStats();
    const models = await ollama.listModels();

    // Query Ollama's active model status
    let ollamaAllocation = {
        name: null,
        totalBytes: 0,
        vramBytes: 0,
        ramBytes: 0,
        vramPercentage: 0,
    };

    try {
        const psRes = await fetch('http://127.0.0.1:11434/api/ps');
        if (psRes.ok) {
            const psData = await psRes.json();
            ollamaAllocation = telemetryService.parseOllamaAllocation(psData.models?.[0]);
        }
    } catch {}

    res.json({
        gpu,
        systemRam,
        ollama: ollamaAllocation,
        models,
    });
});

// 5. WebSocket Authentication & Heartbeat Pipeline
const lastHeartbeatMap = new Map<string, number>();

function normalizeIp(rawIp: string | undefined): string {
    if (!rawIp) return 'unknown';
    return rawIp.replace('::ffff:', '');
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
        ws.close(4001, 'Unauthorized: Missing token');
        return;
    }

    const device = deviceStore.getByToken(token);
    if (!device) {
        ws.close(4003, 'Forbidden: Invalid or revoked token');
        return;
    }

    const { deviceId } = device;

    // Refresh client IP dynamically on each new connection
    const currentIp = normalizeIp(req.socket.remoteAddress);
    device.network.ip = currentIp;
    deviceStore.upsert(device);

    activeSockets.set(deviceId, ws);
    lastHeartbeatMap.set(deviceId, Date.now());

    console.log(`[Mesh Socket] Connected: ${device.deviceName} (${deviceId}) from IP: ${currentIp}`);

    ws.on('message', async (data) => {
        const raw = data.toString();

        // Heartbeat handling
        try {
            const parsed = JSON.parse(raw);
            if (parsed.type === 'ping') {
                lastHeartbeatMap.set(deviceId, Date.now());

                const telemetry = await ollama.getTelemetry();
                ws.send(
                    JSON.stringify({
                        type: 'pong',
                        timestamp: Date.now(),
                        status: 'ready',
                        vramUsageBytes: telemetry.vramUsageBytes,
                        activeModel: telemetry.activeModel,
                        activeTask: null,
                    })
                );
                return;
            }
        } catch {}

        await mcp.handleMessage(ws, raw);
    });

    const cleanup = () => {
        activeSockets.delete(deviceId);
        lastHeartbeatMap.delete(deviceId);
        console.log(`[Mesh Socket] Disconnected: ${deviceId}`);
    };

    ws.on('close', cleanup);
    ws.on('error', (err) => {
        console.error(`[Mesh Socket Error] ${deviceId}:`, err);
        cleanup();
    });
});

// If a client misses 2 consecutive pings (>12s), terminate the dead socket
setInterval(() => {
    const now = Date.now();
    for (const [deviceId, lastSeen] of lastHeartbeatMap.entries()) {
        if (now - lastSeen > 12000) {
            console.warn(`[Watchdog] Device ${deviceId} timed out. Pruning dead socket.`);
            const socket = activeSockets.get(deviceId);
            if (socket) {
                socket.terminate();
            }
            activeSockets.delete(deviceId);
            lastHeartbeatMap.delete(deviceId);
        }
    }
}, 4000);

app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
        return res.sendFile(path.join(adminDistPath, 'index.html'));
    }
    next();
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[Desktop Daemon] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[Desktop Daemon] Local LAN IP: ${getLocalNetworkIp()}:${PORT}`);
    discovery.start(PORT);
});

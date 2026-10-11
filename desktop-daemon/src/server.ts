import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import os from 'os';
import { DeviceStore } from './mesh/DeviceStore.js';
import { PairingManager } from './mesh/PairingManager.js';
import { DiscoveryService } from './mesh/DiscoveryService.js';
import { OllamaBridge } from './mcp/OllamaBridge.js';
import { MCPProtocol } from './mcp/MCPProtocol.js';
import { SystemTelemetry } from './mesh/SystemTelemetry.js';
import type { OllamaModelAllocation } from './mesh/SystemTelemetry.js';
import type { MeshDeviceMetadata } from './mesh/DeviceStore.js';

const PORT = 8080;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/mcp' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

function normalizeIp(rawIp: string | undefined): string {
    if (!rawIp) return 'unknown';
    return rawIp.replace('::ffff:', '');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const adminDistPath = path.resolve(__dirname, '../admin-ui/dist');
app.use(express.static(adminDistPath));

const deviceStore = DeviceStore.getInstance();
const pairingManager = PairingManager.getInstance();
const discovery = DiscoveryService.getInstance();
const ollama = OllamaBridge.getInstance();
const mcp = new MCPProtocol();
const telemetryService = SystemTelemetry.getInstance();

const activeSockets = new Map<string, WebSocket>();
const lastHeartbeatMap = new Map<string, number>();
const peerDaemonSockets = new Map<string, WebSocket>();

const LOCAL_NODE_ID = `desktop_${os.hostname().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

// Helper: Merge an incoming roster into local DeviceStore (Deduplicated RA ∪ RB)
function mergeClusterRoster(incomingRoster: any[]): void {
    if (!Array.isArray(incomingRoster)) return;

    for (const incoming of incomingRoster) {
        const id = incoming.deviceId || incoming.nodeId;
        if (!id || id === LOCAL_NODE_ID) continue;

        const existing = deviceStore.get ? deviceStore.get(id) : deviceStore.getAll().find((d) => d.deviceId === id);
        const resolvedPort =
            incoming.deviceTier === 'thick_mobile' && (!incoming.network?.port || incoming.network.port === 8082)
                ? 8765
                : (incoming.network?.port || incoming.port || (incoming.deviceTier === 'thick_desktop' ? 8080 : 0));

        const merged: MeshDeviceMetadata = {
            deviceId: id,
            deviceName: incoming.deviceName || incoming.nodeName || 'Remote Peer',
            deviceTier: incoming.deviceTier || 'thick_mobile',
            network: {
                ip: incoming.network?.ip || incoming.ip || '127.0.0.1',
                port: resolvedPort,
            },
            capabilities: incoming.capabilities || {
                canRunInference: incoming.deviceTier !== 'thin',
                activeModality: 'both',
                maxContextTokens: 4096,
            },
            meshToken: incoming.meshToken || incoming.sharedToken || existing?.meshToken || '',
            pairedAt: incoming.pairedAt || Date.now(),
            isRevoked: false,
        };

        deviceStore.upsert(merged);
    }
}

// Helper: Broadcast peer sync payload to all active devices
function broadcastPeerRoster(): void {
    const peers = deviceStore.getAll().filter((d) => !d.isRevoked);
    const syncPayload = JSON.stringify({
        jsonrpc: '2.0',
        method: 'mcp.peer_sync',
        params: {
            peers: peers.map((d) => ({
                nodeId: d.deviceId,
                nodeName: d.deviceName,
                deviceTier: d.deviceTier,
                ip: d.network.ip,
                port: (d.deviceTier === 'thick_mobile' && (!d.network.port || d.network.port === 8082)) ? 8765 : (d.network.port || 8080),
                sharedToken: d.meshToken,
            })),
        },
    });

    for (const [_, socket] of activeSockets.entries()) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(syncPayload);
        }
    }

    // Also gossip to connected peer desktop daemons
    for (const [_, socket] of peerDaemonSockets.entries()) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(syncPayload);
        }
    }
}

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

// 2. Handshake Pairing Route (Supports both Mobile Clients and Desktop Federation)
app.post('/api/mesh/pair', (req, res) => {
    const { pin, deviceId, deviceName, deviceTier, capabilities, clusterRoster } = req.body;
    if (!pin || !deviceId || !deviceName || !deviceTier) {
        return res.status(400).json({ error: 'MISSING_FIELDS' });
    }

    try {
        const clientIp = normalizeIp(req.socket.remoteAddress);
        const designatedPort = deviceTier === 'thick_mobile' ? 8765 : (deviceTier === 'thick_desktop' ? PORT : 0);

        const { meshToken, clusterSecret, knownPeers } = pairingManager.verifyAndRegisterDevice(pin, {
            deviceId,
            deviceName,
            deviceTier,
            network: { ip: clientIp, port: designatedPort },
            capabilities: capabilities || {
                canRunInference: deviceTier !== 'thin',
                activeModality: 'both',
                maxContextTokens: 4096,
            },
        });

        // If another desktop is pairing, perform Roster Union on our side
        if (deviceTier === 'thick_desktop' && Array.isArray(clusterRoster)) {
            mergeClusterRoster(clusterRoster);
            console.log(`[Mesh Federation] Ingested ${clusterRoster.length} devices from peer desktop: ${deviceName}`);
        }

        const newPeerAnnouncement = JSON.stringify({
            jsonrpc: '2.0',
            method: 'mcp.peer_joined',
            params: {
                nodeId: deviceId,
                nodeName: deviceName,
                deviceTier,
                ip: clientIp,
                port: designatedPort,
                sharedToken: meshToken,
            },
        });

        for (const [id, socket] of activeSockets.entries()) {
            if (id !== deviceId && socket.readyState === WebSocket.OPEN) {
                socket.send(newPeerAnnouncement);
            }
        }

        // Return our full local roster to the remote desktop so it can complete the union
        const fullLocalRoster = deviceStore.getAll().filter((d) => !d.isRevoked);

        res.json({
            status: 'PAIRED',
            meshToken,
            clusterSecret,
            peerNodeId: LOCAL_NODE_ID,
            peerName: `Desktop (${os.hostname()})`,
            knownPeers: fullLocalRoster,
        });

        // Broadcast updated union to all local phones
        broadcastPeerRoster();
    } catch (err: any) {
        res.status(401).json({ error: err.message });
    }
});

// 2b. Outbound Federation Endpoint (Triggered from Admin UI)
app.post('/api/mesh/cluster/join', async (req, res) => {
    const { targetIp, targetPort, pin } = req.body;
    if (!targetIp || !pin) {
        return res.status(400).json({ error: 'TARGET_IP_AND_PIN_REQUIRED' });
    }

    const remotePort = targetPort || 8080;

    try {
        console.log(`[Mesh Federation] Initiating outbound federation to http://${targetIp}:${remotePort}...`);

        // Send our local identity and complete roster to the remote desktop
        const localRoster = deviceStore.getAll().filter((d) => !d.isRevoked);
        const joinRes = await fetch(`http://${targetIp}:${remotePort}/api/mesh/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pin,
                deviceId: LOCAL_NODE_ID,
                deviceName: `Desktop (${os.hostname()})`,
                deviceTier: 'thick_desktop',
                clusterRoster: localRoster,
            }),
        });

        if (!joinRes.ok) {
            const err = await joinRes.json().catch(() => ({}));
            return res.status(joinRes.status).json({ error: err.error || `Federation rejected (HTTP ${joinRes.status})` });
        }

        const data = await joinRes.json();

        // Register the remote desktop in our DeviceStore
        deviceStore.upsert({
            deviceId: data.peerNodeId || `desktop_${targetIp.replace(/\./g, '_')}`,
            deviceName: data.peerName || `Desktop (${targetIp})`,
            deviceTier: 'thick_desktop',
            network: { ip: targetIp, port: remotePort },
            capabilities: {
                canRunInference: true,
                activeModality: 'both',
                maxContextTokens: 8192,
                gpuAccelerator: 'CUDA',
            },
            meshToken: data.meshToken,
            pairedAt: Date.now(),
            isRevoked: false,
        });

        // Ingest the remote desktop's full roster (RA ∪ RB)
        if (Array.isArray(data.knownPeers)) {
            mergeClusterRoster(data.knownPeers);
        }

        // Establish persistent WebSocket link to the remote daemon for live gossip
        const remoteWsUrl = `ws://${targetIp}:${remotePort}/mcp?token=${encodeURIComponent(data.meshToken)}`;
        const remoteWs = new WebSocket(remoteWsUrl);

        remoteWs.on('open', () => {
            console.log(`[Mesh Federation] 🟢 Live inter-daemon socket open to ${targetIp}:${remotePort}`);
            peerDaemonSockets.set(targetIp, remoteWs);
        });

        remoteWs.on('message', (msgData) => {
            try {
                const parsed = JSON.parse(msgData.toString());
                if (parsed.method === 'mcp.peer_sync' && Array.isArray(parsed.params?.peers)) {
                    mergeClusterRoster(parsed.params.peers);
                    broadcastPeerRoster();
                }
            } catch {}
        });

        remoteWs.on('close', () => {
            console.log(`[Mesh Federation] 🔴 Remote daemon link closed: ${targetIp}`);
            peerDaemonSockets.delete(targetIp);
        });

        remoteWs.on('error', (err) => {
            console.warn(`[Mesh Federation] Inter-daemon link error:`, err);
        });

        // Broadcast the united roster to all local phones
        broadcastPeerRoster();

        res.json({
            success: true,
            peerName: data.peerName,
            unifiedDeviceCount: deviceStore.getAll().length,
        });
    } catch (err: any) {
        console.error('[Mesh Federation Error]:', err);
        res.status(500).json({ error: err.message || 'Failed to connect to remote desktop node' });
    }
});

// 3. Cluster Roster & Synchronization Routes
app.get('/api/mesh/cluster/peers', (_req, res) => {
    const peers = deviceStore.getAll().filter((d) => !d.isRevoked).map((d) => ({
        nodeId: d.deviceId,
        nodeName: d.deviceName,
        deviceTier: d.deviceTier,
        ip: d.network.ip,
        port: (d.deviceTier === 'thick_mobile' && (!d.network.port || d.network.port === 8082)) ? 8765 : (d.network.port || 8080),
        sharedToken: d.meshToken,
        isOnline: activeSockets.has(d.deviceId) || peerDaemonSockets.has(d.network.ip),
    }));
    res.json({ peers });
});

app.post('/api/mesh/cluster/sync', (_req, res) => {
    console.log(`[Cluster Sync] ⚡ Admin requested roster sync across ${activeSockets.size} active socket(s)...`);
    broadcastPeerRoster();
    console.log(`[Cluster Sync] ✅ Synced ${deviceStore.getAll().length} device(s) to cluster.`);
    res.json({ status: 'SYNC_DISPATCHED', connectedClients: activeSockets.size });
});

// 4. Paired Devices Management
app.get('/api/mesh/devices', (_req, res) => {
    const devices = deviceStore.getAll().map((dev) => ({
        ...dev,
        isOnline: activeSockets.has(dev.deviceId) || peerDaemonSockets.has(dev.network.ip),
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
    broadcastPeerRoster();
    res.json({ status: 'REVOKED', deviceId });
});

// 5. Ollama Telemetry Routes
app.get('/api/mesh/telemetry', async (_req, res) => {
    const gpu = await telemetryService.getGpuStats();
    const systemRam = telemetryService.getSystemRamStats();
    const models = await ollama.listModels();

    let ollamaAllocation: OllamaModelAllocation = {
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

// 5b. HTTP Streaming Inference Fallback
app.post('/api/mesh/chat', async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '') || (req.query.token as string);

    if (!token || !deviceStore.getByToken(token)) {
        return res.status(403).json({ error: 'UNAUTHORIZED_MESH_TOKEN' });
    }

    const { model, messages } = req.body;
    if (!model || !messages) {
        return res.status(400).json({ error: 'MISSING_PARAMS' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
        await ollama.streamChat(model, messages, (tokenChunk) => {
            res.write(`data: ${JSON.stringify({ token: tokenChunk })}\n\n`);
        });
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (err: any) {
        console.error('[server.ts /api/mesh/chat Error]:', err);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    }
});

// 6. WebSocket Authentication & Heartbeat Pipeline
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
    const currentIp = normalizeIp(req.socket.remoteAddress);
    device.network.ip = currentIp;
    if (device.deviceTier === 'thick_mobile' && (!device.network.port || device.network.port === 8082)) {
        device.network.port = 8765;
    }
    deviceStore.upsert(device);

    activeSockets.set(deviceId, ws);
    lastHeartbeatMap.set(deviceId, Date.now());

    console.log(`[Mesh Socket] 🟢 Online: ${device.deviceName} (${deviceId}) from IP: ${currentIp}`);

    const peers = deviceStore.getAll().filter((d) => !d.isRevoked);
    ws.send(
        JSON.stringify({
            jsonrpc: '2.0',
            method: 'mcp.peer_sync',
            params: {
                peers: peers.map((d) => ({
                    nodeId: d.deviceId,
                    nodeName: d.deviceName,
                    deviceTier: d.deviceTier,
                    ip: d.network.ip,
                    port: (d.deviceTier === 'thick_mobile' && (!d.network.port || d.network.port === 8082)) ? 8765 : (d.network.port || 8080),
                    sharedToken: d.meshToken,
                })),
            },
        })
    );

    ws.on('message', async (data) => {
        const raw = data.toString();

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
        console.log(`[Mesh Socket] 🔴 Disconnected: ${device.deviceName} (${deviceId})`);
    };

    ws.on('close', cleanup);
    ws.on('error', (err) => {
        console.error(`[Mesh Socket Error] ${deviceId}:`, err);
        cleanup();
    });
});

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
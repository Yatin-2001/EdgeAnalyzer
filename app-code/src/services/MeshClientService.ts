import * as SecureStore from 'expo-secure-store';

export type MeshConnectionStatus = 'DISCONNECTED' | 'ONLINE' | 'WAITING_PONG' | 'DEGRADED' | 'OFFLINE';

export interface HeartbeatTelemetry {
    status: string;
    vramUsageBytes: number;
    activeModel: string | null;
    latencyMs: number;
}

class MeshClientService {
    private static instance: MeshClientService;
    private ws: WebSocket | null = null;
    private status: MeshConnectionStatus = 'DISCONNECTED';
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private missedPings = 0;
    private lastPingTime = 0;
    private listeners = new Set<(status: MeshConnectionStatus, telemetry?: HeartbeatTelemetry) => void>();

    private constructor() {}

    public static getInstance(): MeshClientService {
        if (!MeshClientService.instance) {
            MeshClientService.instance = new MeshClientService();
        }
        return MeshClientService.instance;
    }

    public subscribe(fn: (status: MeshConnectionStatus, telemetry?: HeartbeatTelemetry) => void): () => void {
        this.listeners.add(fn);
        fn(this.status);
        return () => this.listeners.delete(fn);
    }

    private notify(telemetry?: HeartbeatTelemetry): void {
        this.listeners.forEach((fn) => fn(this.status, telemetry));
    }

    public async pairWithDesktop(
        desktopIp: string,
        port: number,
        pin: string,
        deviceId: string,
        deviceName: string
    ): Promise<void> {
        const res = await fetch(`http://${desktopIp}:${port}/api/mesh/pair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pin,
                deviceId,
                deviceName,
                deviceTier: 'thick_mobile',
                capabilities: {
                    canRunInference: true,
                    activeModality: 'both',
                    maxContextTokens: 4096,
                    gpuAccelerator: 'OpenCL-Adreno',
                },
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || 'PAIRING_FAILED');
        }

        const { meshToken } = await res.json();
        await SecureStore.setItemAsync('mesh_auth_token', meshToken);
        await SecureStore.setItemAsync('mesh_desktop_ip', desktopIp);
        await SecureStore.setItemAsync('mesh_desktop_port', port.toString());

        await this.connect();
    }

    public async connect(): Promise<void> {
        const token = await SecureStore.getItemAsync('mesh_auth_token');
        const ip = await SecureStore.getItemAsync('mesh_desktop_ip');
        const port = (await SecureStore.getItemAsync('mesh_desktop_port')) || '8080';

        if (!token || !ip) {
            this.status = 'DISCONNECTED';
            this.notify();
            return;
        }

        if (this.ws) {
            this.ws.close();
        }

        this.ws = new WebSocket(`ws://${ip}:${port}/mcp?token=${token}`);

        this.ws.onopen = () => {
            this.status = 'ONLINE';
            this.missedPings = 0;
            this.notify();
            this.startHeartbeat();
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data.toString());
                if (data.type === 'pong') {
                    const latencyMs = Date.now() - this.lastPingTime;
                    this.status = 'ONLINE';
                    this.missedPings = 0;
                    this.notify({
                        status: data.status,
                        vramUsageBytes: data.vramUsageBytes,
                        activeModel: data.activeModel,
                        latencyMs,
                    });
                }
            } catch {}
        };

        this.ws.onclose = () => {
            this.stopHeartbeat();
            this.status = 'OFFLINE';
            this.notify();
        };

        this.ws.onerror = () => {
            this.status = 'DEGRADED';
            this.notify();
        };
    }

    private startHeartbeat(): void {
        this.stopHeartbeat();
        this.heartbeatInterval = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

            if (this.status === 'WAITING_PONG') {
                this.missedPings++;
                if (this.missedPings >= 2) {
                    this.status = 'DEGRADED';
                    this.notify();
                }
                if (this.missedPings >= 3) {
                    this.status = 'OFFLINE';
                    this.ws.close();
                    this.notify();
                    return;
                }
            }

            this.status = 'WAITING_PONG';
            this.lastPingTime = Date.now();
            this.ws.send(JSON.stringify({ type: 'ping', timestamp: this.lastPingTime }));
        }, 5000);
    }

    private stopHeartbeat(): void {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    public streamRemoteChat(
        model: string,
        messages: Array<{ role: string; content: string }>,
        onChunk: (chunk: string) => void
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('Desktop node offline'));
            }

            const id = Date.now();
            const messageHandler = (event: WebSocketMessageEvent) => {
                try {
                    const res = JSON.parse(event.data.toString());
                    if (res.method === 'mcp.stream_chunk' && res.params?.id === id) {
                        onChunk(res.params.chunk);
                    } else if (res.id === id && res.result?.status === 'completed') {
                        this.ws?.removeEventListener('message', messageHandler);
                        resolve();
                    } else if (res.id === id && res.error) {
                        this.ws?.removeEventListener('message', messageHandler);
                        reject(new Error(res.error.message));
                    }
                } catch {}
            };

            this.ws.addEventListener('message', messageHandler);
            this.ws.send(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id,
                    method: 'mcp.stream_chat',
                    params: { model, messages },
                })
            );
        });
    }
}

export default MeshClientService
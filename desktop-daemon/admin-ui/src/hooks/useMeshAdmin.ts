import { useState, useEffect } from 'react';

export interface DeviceInfo {
    deviceId: string;
    deviceName: string;
    deviceTier: 'thin' | 'thick_mobile' | 'thick_desktop';
    network: { ip: string; port: number };
    pairedAt: number;
    isRevoked: boolean;
    isOnline: boolean;
}

export interface GpuStats {
    name: string;
    totalMB: number;
    usedMB: number;
    freeMB: number;
}

export interface SystemRamStats {
    totalMB: number;
    usedMB: number;
    freeMB: number;
}

export interface OllamaModelAllocation {
    name: string | null;
    totalBytes: number;
    vramBytes: number;
    ramBytes: number;
    vramPercentage: number;
}

export interface ModelTag {
    name: string;
    size: number;
    details: { parameter_size: string };
}

export function useMeshAdmin() {
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [models, setModels] = useState<ModelTag[]>([]);
    const [gpu, setGpu] = useState<GpuStats | null>(null);
    const [systemRam, setSystemRam] = useState<SystemRamStats | null>(null);
    const [ollama, setOllama] = useState<OllamaModelAllocation | null>(null);

    const fetchData = async () => {
        try {
            const devRes = await fetch('/api/mesh/devices');
            if (devRes.ok) {
                const d = await devRes.json();
                setDevices(d.devices || []);
            }

            const telRes = await fetch('/api/mesh/telemetry');
            if (telRes.ok) {
                const t = await telRes.json();
                setGpu(t.gpu || null);
                setSystemRam(t.systemRam || null);
                setOllama(t.ollama || null);
                setModels(t.models || []);
            }
        } catch (err) {
            console.error('[Admin Hook] Polling error:', err);
        }
    };

    useEffect(() => {
        fetchData();
        const interval = setInterval(fetchData, 3000);
        return () => clearInterval(interval);
    }, []);

    const revokeDevice = async (deviceId: string) => {
        await fetch('/api/mesh/devices/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId }),
        });
        await fetchData();
    };

    return { devices, models, gpu, systemRam, ollama, revokeDevice, refresh: fetchData };
}
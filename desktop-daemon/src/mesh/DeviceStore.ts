import fs from 'fs';
import path from 'path';

export type DeviceTier = 'thin' | 'thick_mobile' | 'thick_desktop';

export interface MeshDeviceMetadata {
    deviceId: string;
    deviceName: string;
    deviceTier: DeviceTier;
    network: {
        ip: string;
        port: number;
    };
    capabilities: {
        canRunInference: boolean;
        activeModality: 'none' | 'text' | 'vision' | 'both';
        maxContextTokens: number;
        gpuAccelerator?: 'OpenCL-Adreno' | 'CUDA' | 'Metal' | 'None';
    };
    meshToken: string;
    pairedAt: number;
    isRevoked: boolean;
}

export class DeviceStore {
    private static instance: DeviceStore;
    private filePath: string;
    private devices: Map<string, MeshDeviceMetadata> = new Map();

    private constructor() {
        this.filePath = path.resolve(__dirname, '../../paired_devices.json');
        this.load();
    }

    public static getInstance(): DeviceStore {
        if (!DeviceStore.instance) {
            DeviceStore.instance = new DeviceStore();
        }
        return DeviceStore.instance;
    }

    private load(): void {
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
            return;
        }
        try {
            const data = fs.readFileSync(this.filePath, 'utf-8');
            const list: MeshDeviceMetadata[] = JSON.parse(data);
            this.devices.clear();
            list.forEach((dev) => this.devices.set(dev.deviceId, dev));
        } catch (err) {
            console.error('[DeviceStore] Failed to parse paired_devices.json:', err);
        }
    }

    private persist(): void {
        const arr = Array.from(this.devices.values());
        fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2), 'utf-8');
    }

    public get(deviceId: string): MeshDeviceMetadata | undefined {
        return this.devices.get(deviceId);
    }

    public getByToken(token: string): MeshDeviceMetadata | undefined {
        for (const dev of this.devices.values()) {
            if (dev.meshToken === token && !dev.isRevoked) {
                return dev;
            }
        }
        return undefined;
    }

    public getAll(): MeshDeviceMetadata[] {
        return Array.from(this.devices.values());
    }

    public upsert(device: MeshDeviceMetadata): void {
        this.devices.set(device.deviceId, device);
        this.persist();
    }

    public revoke(deviceId: string): boolean {
        const dev = this.devices.get(deviceId);
        if (!dev) return false;
        dev.isRevoked = true;
        this.persist();
        return true;
    }
}
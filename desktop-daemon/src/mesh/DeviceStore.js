import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export class DeviceStore {
    static instance;
    filePath;
    devices = new Map();
    constructor() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        this.filePath = path.resolve(__dirname, '../../paired_devices.json');
        this.load();
    }
    static getInstance() {
        if (!DeviceStore.instance) {
            DeviceStore.instance = new DeviceStore();
        }
        return DeviceStore.instance;
    }
    load() {
        if (!fs.existsSync(this.filePath)) {
            fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
            return;
        }
        try {
            const data = fs.readFileSync(this.filePath, 'utf-8');
            const list = JSON.parse(data);
            this.devices.clear();
            list.forEach((dev) => this.devices.set(dev.deviceId, dev));
        }
        catch (err) {
            console.error('[DeviceStore] Failed to parse paired_devices.json:', err);
        }
    }
    persist() {
        const arr = Array.from(this.devices.values());
        fs.writeFileSync(this.filePath, JSON.stringify(arr, null, 2), 'utf-8');
    }
    get(deviceId) {
        return this.devices.get(deviceId);
    }
    getByToken(token) {
        for (const dev of this.devices.values()) {
            if (dev.meshToken === token && !dev.isRevoked) {
                return dev;
            }
        }
        return undefined;
    }
    getAll() {
        return Array.from(this.devices.values());
    }
    upsert(device) {
        this.devices.set(device.deviceId, device);
        this.persist();
    }
    revoke(deviceId) {
        const dev = this.devices.get(deviceId);
        if (!dev)
            return false;
        dev.isRevoked = true;
        this.persist();
        return true;
    }
}
//# sourceMappingURL=DeviceStore.js.map
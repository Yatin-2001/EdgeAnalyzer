import crypto from 'crypto';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceStore } from './DeviceStore.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export class PairingManager {
    static instance;
    currentSession = null;
    store = DeviceStore.getInstance();
    clusterSecret;
    configPath = path.resolve(__dirname, '../../cluster_config.json');
    constructor() {
        this.clusterSecret = this.loadOrCreateClusterSecret();
    }
    static getInstance() {
        if (!PairingManager.instance) {
            PairingManager.instance = new PairingManager();
        }
        return PairingManager.instance;
    }
    loadOrCreateClusterSecret() {
        if (fs.existsSync(this.configPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                if (raw.clusterSecret)
                    return raw.clusterSecret;
            }
            catch { }
        }
        const secret = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(this.configPath, JSON.stringify({ clusterSecret: secret }, null, 2), 'utf-8');
        return secret;
    }
    getClusterSecret() {
        return this.clusterSecret;
    }
    generatePairingPin() {
        const rawPin = crypto.randomInt(100000, 999999).toString();
        const hmacSecret = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 60 * 1000;
        this.currentSession = { pin: rawPin, expiresAt, hmacSecret };
        return { pin: rawPin, expiresIn: 60 };
    }
    getActiveSession() {
        if (!this.currentSession)
            return null;
        const remaining = Math.max(0, Math.floor((this.currentSession.expiresAt - Date.now()) / 1000));
        if (remaining === 0) {
            this.currentSession = null;
            return null;
        }
        return { pin: this.currentSession.pin, remainingSeconds: remaining };
    }
    verifyAndRegisterDevice(providedPin, deviceData) {
        if (!this.currentSession)
            throw new Error('NO_ACTIVE_PIN_SESSION');
        if (Date.now() > this.currentSession.expiresAt) {
            this.currentSession = null;
            throw new Error('PIN_EXPIRED');
        }
        if (this.currentSession.pin !== providedPin.trim())
            throw new Error('INVALID_PIN');
        const payload = `${deviceData.deviceId}:${Date.now()}`;
        const signature = crypto
            .createHmac('sha256', this.currentSession.hmacSecret)
            .update(payload)
            .digest('hex');
        const meshToken = `mesh_${crypto.randomUUID()}_${signature.slice(0, 16)}`;
        const metadata = {
            ...deviceData,
            meshToken,
            pairedAt: Date.now(),
            isRevoked: false,
        };
        // Get list of existing peers before saving this new one
        const knownPeers = this.store.getAll().filter((d) => !d.isRevoked && d.deviceId !== deviceData.deviceId);
        this.store.upsert(metadata);
        this.currentSession = null;
        return {
            meshToken,
            clusterSecret: this.clusterSecret,
            knownPeers,
        };
    }
}
//# sourceMappingURL=PairingManager.js.map
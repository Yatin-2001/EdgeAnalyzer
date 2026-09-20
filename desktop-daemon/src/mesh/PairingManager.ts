import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DeviceStore, type MeshDeviceMetadata } from './DeviceStore';

interface ActivePinSession {
    pin: string;
    expiresAt: number;
    hmacSecret: string;
}

export class PairingManager {
    private static instance: PairingManager;
    private currentSession: ActivePinSession | null = null;
    private store = DeviceStore.getInstance();
    private clusterSecret: string;
    private configPath = path.resolve(__dirname, '../../cluster_config.json');

    private constructor() {
        this.clusterSecret = this.loadOrCreateClusterSecret();
    }

    public static getInstance(): PairingManager {
        if (!PairingManager.instance) {
            PairingManager.instance = new PairingManager();
        }
        return PairingManager.instance;
    }

    private loadOrCreateClusterSecret(): string {
        if (fs.existsSync(this.configPath)) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
                if (raw.clusterSecret) return raw.clusterSecret;
            } catch {}
        }
        const secret = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(this.configPath, JSON.stringify({ clusterSecret: secret }, null, 2), 'utf-8');
        return secret;
    }

    public getClusterSecret(): string {
        return this.clusterSecret;
    }

    public generatePairingPin(): { pin: string; expiresIn: number } {
        const rawPin = crypto.randomInt(100000, 999999).toString();
        const hmacSecret = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 60 * 1000;

        this.currentSession = { pin: rawPin, expiresAt, hmacSecret };
        return { pin: rawPin, expiresIn: 60 };
    }

    public getActiveSession(): { pin: string; remainingSeconds: number } | null {
        if (!this.currentSession) return null;
        const remaining = Math.max(0, Math.floor((this.currentSession.expiresAt - Date.now()) / 1000));
        if (remaining === 0) {
            this.currentSession = null;
            return null;
        }
        return { pin: this.currentSession.pin, remainingSeconds: remaining };
    }

    public verifyAndRegisterDevice(
        providedPin: string,
        deviceData: Omit<MeshDeviceMetadata, 'meshToken' | 'pairedAt' | 'isRevoked'>
    ): { meshToken: string; clusterSecret: string; knownPeers: MeshDeviceMetadata[] } {
        if (!this.currentSession) throw new Error('NO_ACTIVE_PIN_SESSION');
        if (Date.now() > this.currentSession.expiresAt) {
            this.currentSession = null;
            throw new Error('PIN_EXPIRED');
        }
        if (this.currentSession.pin !== providedPin.trim()) throw new Error('INVALID_PIN');

        const payload = `${deviceData.deviceId}:${Date.now()}`;
        const signature = crypto
            .createHmac('sha256', this.currentSession.hmacSecret)
            .update(payload)
            .digest('hex');
        const meshToken = `mesh_${crypto.randomUUID()}_${signature.slice(0, 16)}`;

        const metadata: MeshDeviceMetadata = {
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
import crypto from 'crypto';
import { DeviceStore, type MeshDeviceMetadata } from './DeviceStore.js';

interface ActivePinSession {
    pin: string;
    expiresAt: number;
    hmacSecret: string;
}

export class PairingManager {
    private static instance: PairingManager;
    private currentSession: ActivePinSession | null = null;
    private store = DeviceStore.getInstance();

    private constructor() {}

    public static getInstance(): PairingManager {
        if (!PairingManager.instance) {
            PairingManager.instance = new PairingManager();
        }
        return PairingManager.instance;
    }

    public generatePairingPin(): { pin: string; expiresIn: number } {
        const rawPin = crypto.randomInt(100000, 999999).toString();
        const hmacSecret = crypto.randomBytes(32).toString('hex');
        const expiresAt = Date.now() + 60 * 1000;

        this.currentSession = {
            pin: rawPin,
            expiresAt,
            hmacSecret,
        };

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
    ): { meshToken: string } {
        if (!this.currentSession) {
            throw new Error('NO_ACTIVE_PIN_SESSION');
        }
        if (Date.now() > this.currentSession.expiresAt) {
            this.currentSession = null;
            throw new Error('PIN_EXPIRED');
        }
        if (this.currentSession.pin !== providedPin.trim()) {
            throw new Error('INVALID_PIN');
        }

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

        this.store.upsert(metadata);
        this.currentSession = null; // Single-use consumption

        return { meshToken };
    }
}
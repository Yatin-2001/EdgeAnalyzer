import { type MeshDeviceMetadata } from './DeviceStore.js';
export declare class PairingManager {
    private static instance;
    private currentSession;
    private store;
    private clusterSecret;
    private configPath;
    private constructor();
    static getInstance(): PairingManager;
    private loadOrCreateClusterSecret;
    getClusterSecret(): string;
    generatePairingPin(): {
        pin: string;
        expiresIn: number;
    };
    getActiveSession(): {
        pin: string;
        remainingSeconds: number;
    } | null;
    verifyAndRegisterDevice(providedPin: string, deviceData: Omit<MeshDeviceMetadata, 'meshToken' | 'pairedAt' | 'isRevoked'>): {
        meshToken: string;
        clusterSecret: string;
        knownPeers: MeshDeviceMetadata[];
    };
}
//# sourceMappingURL=PairingManager.d.ts.map
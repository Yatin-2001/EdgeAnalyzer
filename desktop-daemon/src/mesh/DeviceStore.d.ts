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
export declare class DeviceStore {
    private static instance;
    private filePath;
    private devices;
    private constructor();
    static getInstance(): DeviceStore;
    private load;
    private persist;
    get(deviceId: string): MeshDeviceMetadata | undefined;
    getByToken(token: string): MeshDeviceMetadata | undefined;
    getAll(): MeshDeviceMetadata[];
    upsert(device: MeshDeviceMetadata): void;
    revoke(deviceId: string): boolean;
}
//# sourceMappingURL=DeviceStore.d.ts.map
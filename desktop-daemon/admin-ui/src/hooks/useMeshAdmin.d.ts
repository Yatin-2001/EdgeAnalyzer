export interface DeviceInfo {
    deviceId: string;
    deviceName: string;
    deviceTier: 'thin' | 'thick_mobile' | 'thick_desktop';
    network: {
        ip: string;
        port: number;
    };
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
    details: {
        parameter_size: string;
    };
}
export declare function useMeshAdmin(): {
    devices: DeviceInfo[];
    models: ModelTag[];
    gpu: GpuStats | null;
    systemRam: SystemRamStats | null;
    ollama: OllamaModelAllocation | null;
    revokeDevice: (deviceId: string) => Promise<void>;
    syncMeshRoster: () => Promise<void>;
    refresh: () => Promise<void>;
};
//# sourceMappingURL=useMeshAdmin.d.ts.map
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
export declare class SystemTelemetry {
    private static instance;
    private constructor();
    static getInstance(): SystemTelemetry;
    /**
     * Queries real GPU VRAM usage from nvidia-smi
     */
    getGpuStats(): Promise<GpuStats | null>;
    /**
     * Reads host system RAM
     */
    getSystemRamStats(): SystemRamStats;
    /**
     * Calculates the VRAM vs System RAM split from Ollama's active models
     */
    parseOllamaAllocation(activeModelData: any): OllamaModelAllocation;
}
//# sourceMappingURL=SystemTelemetry.d.ts.map
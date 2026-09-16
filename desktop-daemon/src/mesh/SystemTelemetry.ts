import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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

export class SystemTelemetry {
    private static instance: SystemTelemetry;

    private constructor() {}

    public static getInstance(): SystemTelemetry {
        if (!SystemTelemetry.instance) {
            SystemTelemetry.instance = new SystemTelemetry();
        }
        return SystemTelemetry.instance;
    }

    /**
     * Queries real GPU VRAM usage from nvidia-smi
     */
    public async getGpuStats(): Promise<GpuStats | null> {
        try {
            const { stdout } = await execFileAsync('nvidia-smi', [
                '--query-gpu=name,memory.total,memory.used,memory.free',
                '--format=csv,noheader,nounits',
            ]);

            const parts = stdout.trim().split(',').map((s) => s.trim());
            if (parts.length >= 4) {
                return {
                    name: parts[0],
                    totalMB: parseFloat(parts[1]),
                    usedMB: parseFloat(parts[2]),
                    freeMB: parseFloat(parts[3]),
                };
            }
        } catch {
            // nvidia-smi not available or non-NVIDIA environment
        }
        return null;
    }

    /**
     * Reads host system RAM
     */
    public getSystemRamStats(): SystemRamStats {
        const totalBytes = os.totalmem();
        const freeBytes = os.freemem();
        const usedBytes = totalBytes - freeBytes;

        return {
            totalMB: Math.round(totalBytes / (1024 * 1024)),
            usedMB: Math.round(usedBytes / (1024 * 1024)),
            freeMB: Math.round(freeBytes / (1024 * 1024)),
        };
    }

    /**
     * Calculates the VRAM vs System RAM split from Ollama's active models
     */
    public parseOllamaAllocation(activeModelData: any): OllamaModelAllocation {
        if (!activeModelData) {
            return {
                name: null,
                totalBytes: 0,
                vramBytes: 0,
                ramBytes: 0,
                vramPercentage: 0,
            };
        }

        const total = activeModelData.size || 0;
        const vram = activeModelData.size_vram || 0;
        const ram = Math.max(0, total - vram);
        const vramPercentage = total > 0 ? Math.round((vram / total) * 100) : 0;

        return {
            name: activeModelData.name || null,
            totalBytes: total,
            vramBytes: vram,
            ramBytes: ram,
            vramPercentage,
        };
    }
}
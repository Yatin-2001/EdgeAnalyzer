import { execFile } from 'child_process';
import os from 'os';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);
export class SystemTelemetry {
    static instance;
    constructor() { }
    static getInstance() {
        if (!SystemTelemetry.instance) {
            SystemTelemetry.instance = new SystemTelemetry();
        }
        return SystemTelemetry.instance;
    }
    /**
     * Queries real GPU VRAM usage from nvidia-smi
     */
    async getGpuStats() {
        try {
            const { stdout } = await execFileAsync('nvidia-smi', [
                '--query-gpu=name,memory.total,memory.used,memory.free',
                '--format=csv,noheader,nounits',
            ]);
            const parts = stdout.trim().split(',').map((s) => s.trim());
            if (parts.length >= 4) {
                const [name, total, used, free] = parts;
                if (name === undefined || total === undefined ||
                    used === undefined || free === undefined) {
                    return null; // Use the appropriate fallback for your function.
                }
                return {
                    name,
                    totalMB: parseFloat(total),
                    usedMB: parseFloat(used),
                    freeMB: parseFloat(free),
                };
            }
        }
        catch {
            // nvidia-smi not available or non-NVIDIA environment
        }
        return null;
    }
    /**
     * Reads host system RAM
     */
    getSystemRamStats() {
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
    parseOllamaAllocation(activeModelData) {
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
//# sourceMappingURL=SystemTelemetry.js.map
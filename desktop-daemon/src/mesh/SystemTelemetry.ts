import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GpuStats {
    name: string;
    totalMB: number;
    usedMB: number;
    freeMB: number;
    source?: 'nvidia-smi' | 'ollama_fallback';
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
    private nvidiaAvailable: boolean | null = null;

    private constructor() {}

    public static getInstance(): SystemTelemetry {
        if (!SystemTelemetry.instance) {
            SystemTelemetry.instance = new SystemTelemetry();
        }
        return SystemTelemetry.instance;
    }

    /**
     * Queries GPU memory stats across Windows/Linux/macOS.
     * Uses nvidia-smi when available; falls back to Ollama /api/ps + OS unified memory otherwise.
     */
    public async getGpuStats(): Promise<GpuStats | null> {
        if (this.nvidiaAvailable !== false) {
            try {
                const { stdout } = await execFileAsync(
                    'nvidia-smi',
                    [
                        '--query-gpu=name,memory.total,memory.used,memory.free',
                        '--format=csv,noheader,nounits',
                    ],
                    { timeout: 1500 }
                );

                const firstLine = stdout.trim().split(/\r?\n/)[0] ?? '';
                const parts = firstLine.split(',').map((s) => s.trim());

                if (parts.length >= 4) {
                    const [name, total, used, free] = parts;
                    if (
                        name !== undefined &&
                        total !== undefined &&
                        used !== undefined &&
                        free !== undefined
                    ) {
                        this.nvidiaAvailable = true;
                        return {
                            name,
                            totalMB: parseFloat(total),
                            usedMB: parseFloat(used),
                            freeMB: parseFloat(free),
                            source: 'nvidia-smi',
                        };
                    }
                }
            } catch {
                this.nvidiaAvailable = false;
            }
        }

        // Cross-OS fallback: Apple Silicon Metal unified memory or Linux/AMD via Ollama /api/ps + os.freemem()
        try {
            const ram = this.getSystemRamStats();
            let ollamaVramUsedMB = 0;

            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 1000);
                const psRes = await fetch('http://127.0.0.1:11434/api/ps', {
                    signal: controller.signal,
                });
                clearTimeout(timer);
                if (psRes.ok) {
                    const psData = (await psRes.json()) as { models?: Array<{ size_vram?: number }> };
                    for (const m of psData.models ?? []) {
                        ollamaVramUsedMB += Math.round((m.size_vram ?? 0) / (1024 * 1024));
                    }
                }
            } catch {}

            const isAppleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
            const totalBudgetMB = isAppleSilicon ? Math.round(ram.totalMB * 0.75) : ram.totalMB;
            const usedMB = ollamaVramUsedMB > 0 ? ollamaVramUsedMB : ram.usedMB;
            const freeMB = Math.max(0, Math.min(ram.freeMB, totalBudgetMB - usedMB));

            return {
                name: isAppleSilicon
                    ? 'Apple Silicon (Metal Unified)'
                    : `Host Compute (${os.platform()}/${os.arch()})`,
                totalMB: totalBudgetMB,
                usedMB,
                freeMB,
                source: 'ollama_fallback',
            };
        } catch {
            return null;
        }
    }

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

    public parseOllamaAllocation(activeModelData: unknown): OllamaModelAllocation {
        const data = activeModelData as { name?: string; size?: number; size_vram?: number } | null | undefined;
        if (!data) {
            return {
                name: null,
                totalBytes: 0,
                vramBytes: 0,
                ramBytes: 0,
                vramPercentage: 0,
            };
        }

        const total = data.size ?? 0;
        const vram = data.size_vram ?? 0;
        const ram = Math.max(0, total - vram);
        const vramPercentage = total > 0 ? Math.round((vram / total) * 100) : 0;

        return {
            name: data.name ?? null,
            totalBytes: total,
            vramBytes: vram,
            ramBytes: ram,
            vramPercentage,
        };
    }
}
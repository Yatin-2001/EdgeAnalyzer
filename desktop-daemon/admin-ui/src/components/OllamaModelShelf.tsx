import React from 'react';
import type { GpuStats, SystemRamStats, OllamaModelAllocation, ModelTag } from '../hooks/useMeshAdmin';
import { Cpu, HardDrive, Layers } from 'lucide-react';

interface Props {
    gpu: GpuStats | null;
    systemRam: SystemRamStats | null;
    ollama: OllamaModelAllocation | null;
    models: ModelTag[];
}

export const OllamaModelShelf: React.FC<Props> = ({ gpu, systemRam, ollama, models }) => {
    // GPU VRAM calculations
    const gpuTotalGB = gpu ? (gpu.totalMB / 1024).toFixed(1) : '0.0';
    const gpuUsedGB = gpu ? (gpu.usedMB / 1024).toFixed(1) : '0.0';
    const gpuPct = gpu && gpu.totalMB > 0 ? Math.min(100, Math.round((gpu.usedMB / gpu.totalMB) * 100)) : 0;

    // System RAM calculations
    const ramTotalGB = systemRam ? (systemRam.totalMB / 1024).toFixed(1) : '0.0';
    const ramUsedGB = systemRam ? (systemRam.usedMB / 1024).toFixed(1) : '0.0';
    const ramPct =
        systemRam && systemRam.totalMB > 0
            ? Math.min(100, Math.round((systemRam.usedMB / systemRam.totalMB) * 100))
            : 0;

    // Ollama Model Memory Footprint
    const modelTotalGB = ollama && ollama.totalBytes > 0 ? (ollama.totalBytes / (1024 ** 3)).toFixed(1) : null;
    const modelVramGB = ollama && ollama.vramBytes > 0 ? (ollama.vramBytes / (1024 ** 3)).toFixed(1) : null;
    const modelRamGB = ollama && ollama.ramBytes > 0 ? (ollama.ramBytes / (1024 ** 3)).toFixed(1) : null;

    return (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
            {/* 1. Real GPU VRAM Meter */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
                <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5 truncate">
            <Cpu className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="truncate">{gpu?.name || 'RTX 3060'} VRAM</span>
          </span>
                    <span className="text-xs font-mono font-medium text-slate-300 shrink-0">
            {gpuUsedGB} / {gpuTotalGB} GB
          </span>
                </div>
                <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden mb-2">
                    <div
                        className="h-full bg-gradient-to-r from-indigo-500 to-emerald-400 transition-all duration-500"
                        style={{ width: `${gpuPct}%` }}
                    />
                </div>
                <div className="text-[11px] text-slate-400 flex justify-between">
                    <span>Usage: {gpuPct}%</span>
                    <span>{gpu ? `${(gpu.freeMB / 1024).toFixed(1)} GB free` : ''}</span>
                </div>
            </div>

            {/* 2. System Host RAM Meter */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
                <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs uppercase tracking-wider font-semibold flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-sky-400" /> Host System RAM
          </span>
                    <span className="text-xs font-mono font-medium text-slate-300">
            {ramUsedGB} / {ramTotalGB} GB
          </span>
                </div>
                <div className="w-full h-2.5 bg-slate-800 rounded-full overflow-hidden mb-2">
                    <div
                        className="h-full bg-gradient-to-r from-sky-500 to-blue-400 transition-all duration-500"
                        style={{ width: `${ramPct}%` }}
                    />
                </div>
                <div className="text-[11px] text-slate-400 flex justify-between">
                    <span>Usage: {ramPct}%</span>
                    <span>{systemRam ? `${(systemRam.freeMB / 1024).toFixed(1)} GB free` : ''}</span>
                </div>
            </div>

            {/* 3. Active Ollama Model & Offload Distribution */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl flex flex-col justify-between">
                <div>
                    <div className="flex items-center justify-between mb-1">
            <span className="text-xs uppercase tracking-wider font-semibold text-slate-400 flex items-center gap-1.5">
              <HardDrive className="w-4 h-4 text-emerald-400" /> Active Model
            </span>
                        {ollama?.name && (
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {ollama.vramPercentage}% GPU Offload
              </span>
                        )}
                    </div>
                    <div className="text-base font-bold text-slate-100 truncate">
                        {ollama?.name || 'Idle / No Active Model'}
                    </div>
                </div>

                <div className="text-xs text-slate-400 border-t border-slate-800 pt-2 mt-2">
                    {ollama?.name && modelTotalGB ? (
                        <div className="flex justify-between font-mono text-[11px]">
                            <span>Model Total: {modelTotalGB} GB</span>
                            <span className="text-slate-400">
                {modelVramGB}G VRAM {modelRamGB && parseFloat(modelRamGB) > 0 ? `+ ${modelRamGB}G RAM` : ''}
              </span>
                        </div>
                    ) : (
                        <span>{models.length} local models available</span>
                    )}
                </div>
            </div>
        </div>
    );
};
import React from 'react';
import type { GpuStats, SystemRamStats, OllamaModelAllocation, ModelTag } from '../hooks/useMeshAdmin';
interface Props {
    gpu: GpuStats | null;
    systemRam: SystemRamStats | null;
    ollama: OllamaModelAllocation | null;
    models: ModelTag[];
}
export declare const OllamaModelShelf: React.FC<Props>;
export {};
//# sourceMappingURL=OllamaModelShelf.d.ts.map
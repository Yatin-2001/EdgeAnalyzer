export type ModelModality = 'text' | 'vision' | 'embedding';

export interface ModelEntry {
    id: string;
    name: string;
    filename: string;
    sourceUri: string; // SAF content:// or app file://
    sizeBytes: number;
    modality: ModelModality;
    mmprojFilename?: string;
    mmprojSourceUri?: string;
    mmprojSizeBytes?: number;
    nCtx: number;
    nGpuLayers: number;
}
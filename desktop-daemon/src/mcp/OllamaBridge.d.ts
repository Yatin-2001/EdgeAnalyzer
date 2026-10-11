export interface OllamaModelInfo {
    name: string;
    size: number;
    digest: string;
    details: {
        format: string;
        family: string;
        families: string[];
        parameter_size: string;
        quantization_level: string;
    };
}
export declare class OllamaBridge {
    private static instance;
    private baseUrl;
    private constructor();
    static getInstance(): OllamaBridge;
    listModels(): Promise<OllamaModelInfo[]>;
    streamChat(model: string, messages: Array<{
        role: string;
        content: string;
        images?: string[];
    }>, onChunk: (text: string) => void): Promise<void>;
    getTelemetry(): Promise<{
        vramUsageBytes: number;
        activeModel: string | null;
    }>;
}
//# sourceMappingURL=OllamaBridge.d.ts.map
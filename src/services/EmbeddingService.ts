import { initLlama, LlamaContext } from 'llama.rn';
import { ModelManager } from './ModelManager';
import { getEmbeddingModel } from '../database/repository';

export class EmbeddingService {
    private static instance: EmbeddingService;
    private embedContext: LlamaContext | null = null;
    private isInitializing = false;
    private modelName: string | null = null;

    private constructor() {}

    public static getInstance(): EmbeddingService {
        if (!EmbeddingService.instance) {
            EmbeddingService.instance = new EmbeddingService();
        }
        return EmbeddingService.instance;
    }

    public isReady(): boolean {
        return this.embedContext !== null;
    }

    public getModelName(): string | null {
        return this.modelName;
    }

    public async initialize(): Promise<boolean> {
        if (this.embedContext) return true;
        if (this.isInitializing) return false;

        this.isInitializing = true;
        try {
            const embeddingRecord = await getEmbeddingModel();
            if (!embeddingRecord) {
                this.isInitializing = false;
                return false;
            }

            const modelManager = ModelManager.getInstance();
            const prepared = await modelManager.prepareModelFromRecord(
                embeddingRecord,
                'embedding'
            );

            if (!prepared.workingUri) {
                throw new Error('Failed to prepare embedding model working file.');
            }

            const normalizedPath = prepared.workingUri.startsWith('file://')
                ? prepared.workingUri
                : `file://${prepared.workingUri}`;

            this.embedContext = await initLlama({
                model: normalizedPath,
                embedding: true,
                n_ctx: 512,
                n_threads: 2,
                use_mlock: true,
            });

            this.modelName = prepared.originalName;
            this.isInitializing = false;
            return true;
        } catch (error) {
            this.embedContext = null;
            this.modelName = null;
            this.isInitializing = false;
            console.warn('[EmbeddingService] Failed to load dedicated embedding engine:', error);
            return false;
        }
    }

    public async getEmbedding(text: string): Promise<Float32Array> {
        if (!this.embedContext) {
            const initialized = await this.initialize();
            if (!initialized || !this.embedContext) {
                throw new Error('Dedicated Embedding Model is not initialized.');
            }
        }

        const cleanText = text.replace(/\n+/g, ' ').trim();

        // llama.rn embedding() takes direct string input
        const result = await this.embedContext.embedding(cleanText);

        // Handle result whether returned as { embedding: number[] } or number[]
        const rawVector: number[] = Array.isArray(result) ? result : result.embedding;
        return this.normalize(new Float32Array(rawVector));
    }

    public cosineSimilarity(a: Float32Array, b: Float32Array): number {
        if (a.length !== b.length) return 0;
        let dotProduct = 0;
        for (let i = 0; i < a.length; i++) {
            dotProduct += a[i] * b[i];
        }
        return dotProduct;
    }

    private normalize(vector: Float32Array): Float32Array {
        let norm = 0;
        for (let i = 0; i < vector.length; i++) {
            norm += vector[i] * vector[i];
        }
        norm = Math.sqrt(norm);
        if (norm === 0) return vector;

        const normalized = new Float32Array(vector.length);
        for (let i = 0; i < vector.length; i++) {
            normalized[i] = vector[i] / norm;
        }
        return normalized;
    }

    public chunkText(text: string, maxChunkLength: number = 280): string[] {
        if (text.length <= maxChunkLength) return [text.trim()];

        const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [text];
        const chunks: string[] = [];
        let currentChunk = '';

        for (const sentence of sentences) {
            if ((currentChunk + sentence).length <= maxChunkLength) {
                currentChunk += sentence;
            } else {
                if (currentChunk.trim()) chunks.push(currentChunk.trim());
                currentChunk = sentence;
            }
        }
        if (currentChunk.trim()) chunks.push(currentChunk.trim());
        return chunks;
    }
}
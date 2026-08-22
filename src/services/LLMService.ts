import { initLlama, LlamaContext } from 'llama.rn';

export type LLMStatus =
    | 'UNLOADED'
    | 'LOADING'
    | 'READY'
    | 'GENERATING'
    | 'ERROR';

export interface PerformanceMetrics {
  ttftMs: number;
  totalTokens: number;
  generationTimeSec: number;
  tokensPerSecond: number;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onMetrics?: (metrics: PerformanceMetrics) => void;
}

export interface LoadedModel {
  name: string;
  path: string;
}

export interface LLMRuntimeConfig {
  nCtx?: number;
  nGpuLayers?: number;
  nThreads?: number;
  nBatch?: number;
  useMlock?: boolean;
}

export class LLMService {
  private static instance: LLMService;
  private context: LlamaContext | null = null;
  private status: LLMStatus = 'UNLOADED';
  private loadedModel: LoadedModel | null = null;
  private isInterrupted = false;

  private constructor() {}

  public static getInstance(): LLMService {
    if (!LLMService.instance) {
      LLMService.instance = new LLMService();
    }
    return LLMService.instance;
  }

  public getStatus(): LLMStatus {
    return this.status;
  }

  public isReady(): boolean {
    return this.status === 'READY' && this.context !== null;
  }

  public getLoadedModel(): LoadedModel | null {
    return this.loadedModel;
  }

  public async loadModel(
      modelPath: string,
      modelName: string,
      onProgress?: (progress: number) => void,
      config: LLMRuntimeConfig = {}
  ): Promise<void> {
    if (!modelPath) throw new Error('Model path is required.');
    if (this.status === 'LOADING') throw new Error('A model is already loading.');
    if (this.status === 'GENERATING') throw new Error('Cannot load during active generation.');

    if (this.context) {
      await this.unloadModel();
    }

    this.status = 'LOADING';

    try {
      const normalizedPath = this.normalizeModelPath(modelPath);

      this.context = await initLlama(
          {
            model: normalizedPath,
            use_mlock: config.useMlock ?? true,
            n_ctx: config.nCtx ?? 2048,
            n_gpu_layers: config.nGpuLayers ?? 99,
            n_threads: config.nThreads ?? 4,
            n_batch: config.nBatch ?? 512,
          },
          (progress: number) => {
            if (!onProgress) return;
            const normalized = progress > 1 ? progress / 100 : progress;
            onProgress(Math.max(0, Math.min(1, normalized)));
          }
      );

      this.loadedModel = { name: modelName, path: normalizedPath };
      this.status = 'READY';
    } catch (error) {
      this.context = null;
      this.loadedModel = null;
      this.status = 'ERROR';
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load model "${modelName}": ${message}`);
    }
  }

  private normalizeModelPath(path: string): string {
    if (path.startsWith('file://') || path.startsWith('content://')) {
      return path;
    }
    return `file://${path}`;
  }

  public async streamCompletion(
      formattedPrompt: string,
      callbacks: StreamCallbacks
  ): Promise<{ fullText: string; metrics: PerformanceMetrics }> {
    if (!this.context) throw new Error('LLM Context is not initialized.');
    if (this.status !== 'READY') throw new Error(`LLM is not ready (Status: ${this.status}).`);

    this.status = 'GENERATING';
    this.isInterrupted = false;

    let fullText = '';
    let tokenCount = 0;
    let ttftRecorded = false;
    let ttftMs = 0;
    const startTime = performance.now();

    try {
      const result = await this.context.completion(
          {
            prompt: formattedPrompt,
            n_predict: 512,
            temperature: 0.7,
            top_p: 0.9,
            stop: ['<|eot_id|>', '<|end_of_text|>', '<|im_end|>', 'User:', 'Assistant:'],
          },
          (data) => {
            if (this.isInterrupted) return;
            if (!ttftRecorded) {
              ttftMs = performance.now() - startTime;
              ttftRecorded = true;
            }
            tokenCount += 1;
            fullText += data.token;
            callbacks.onToken(data.token);
          }
      );

      const endTime = performance.now();
      const generationTimeSec = Math.max((endTime - startTime) / 1000, 0.001);
      const effectiveTokens = result.tokens_predicted || tokenCount;
      const tokensPerSecond = parseFloat((effectiveTokens / generationTimeSec).toFixed(2));

      const metrics: PerformanceMetrics = {
        ttftMs: Math.round(ttftMs),
        totalTokens: effectiveTokens,
        generationTimeSec: parseFloat(generationTimeSec.toFixed(2)),
        tokensPerSecond,
      };

      callbacks.onMetrics?.(metrics);
      this.status = 'READY';
      return { fullText, metrics };
    } catch (error) {
      this.status = 'READY';
      throw error;
    }
  }

  /**
   * Fast, truncated completion for generating conversation titles.
   */
  public async generateTitle(firstUserPrompt: string): Promise<string> {
    if (!this.context || this.status !== 'READY') return 'New Conversation';

    try {
      const prompt = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nCreate a 3-5 word concise title for this query. Output ONLY the title text.<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${firstUserPrompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;

      const result = await this.context.completion({
        prompt,
        n_predict: 16,
        temperature: 0.3,
        stop: ['\n', '<|eot_id|>', '<|end_of_text|>'],
      });

      const clean = result.text.replace(/["'\n]/g, '').trim();
      return clean.length > 0 ? clean : 'New Conversation';
    } catch {
      return 'New Conversation';
    }
  }

  public async stopCompletion(): Promise<void> {
    if (this.context && this.status === 'GENERATING') {
      this.isInterrupted = true;
      try {
        await this.context.stopCompletion();
      } finally {
        this.status = 'READY';
      }
    }
  }

  public async unloadModel(): Promise<void> {
    if (!this.context) {
      this.status = 'UNLOADED';
      this.loadedModel = null;
      return;
    }
    try {
      if (this.status === 'GENERATING') {
        await this.stopCompletion();
      }
      await this.context.release();
    } finally {
      this.context = null;
      this.loadedModel = null;
      this.status = 'UNLOADED';
    }
  }
}
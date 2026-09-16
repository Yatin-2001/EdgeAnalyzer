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
  mmprojPath?: string;
  isVisionCapable: boolean;
}

export interface LLMRuntimeConfig {
  nCtx?: number;
  nGpuLayers?: number;
  nThreads?: number;
  nBatch?: number;
  useMlock?: boolean;
}

export interface MessageContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MessageContentPart[];
}

export interface CompletionOptions {
  prompt?: string;
  messages?: ChatMessage[];
  imagePaths?: string[];
  nPredict?: number;
  temperature?: number;
  topP?: number;
  repeatPenalty?: number;
  stop?: string[];
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

  public isVisionCapable(): boolean {
    return !!this.loadedModel?.isVisionCapable;
  }

  public getLoadedModel(): LoadedModel | null {
    return this.loadedModel;
  }

  public async loadModel(
      modelPath: string,
      modelName: string,
      onProgress?: (progress: number) => void,
      config: LLMRuntimeConfig = {},
      mmprojPath?: string
  ): Promise<void> {
    if (!modelPath) throw new Error('Model path is required.');
    if (this.status === 'LOADING') throw new Error('A model is already loading.');
    if (this.status === 'GENERATING') throw new Error('Cannot load during active generation.');

    if (this.context) {
      await this.unloadModel();
    }

    this.status = 'LOADING';

    try {
      const normalizedModelPath = this.normalizeModelPath(modelPath);
      const normalizedMmproj = mmprojPath ? this.normalizeModelPath(mmprojPath) : undefined;

      this.context = await initLlama(
          {
            model: normalizedModelPath,
            use_mlock: config.useMlock ?? false,
            n_ctx: config.nCtx ?? (normalizedMmproj ? 2048 : 4096),
            n_gpu_layers: config.nGpuLayers ?? 99,
            n_threads: config.nThreads ?? 4,
            n_batch: config.nBatch ?? (normalizedMmproj ? 256 : 512),
          },
          (progress: number) => {
            if (!onProgress) return;
            const normalized = progress > 1 ? progress / 100 : progress;
            onProgress(Math.max(0, Math.min(1, normalized)));
          }
      );

      console.log('Is GPU Active:', this.context.gpu);
      console.log('GPU Device Info:', this.context.devices);

      let isVisionActive = false;
      if (normalizedMmproj) {
        try {
          const cleanMmproj = normalizedMmproj.replace('file://', '');
          const success = await this.context.initMultimodal({
            path: cleanMmproj,
            use_gpu: true,
          });

          const isEnabled = await this.context.isMultimodalEnabled();
          isVisionActive = success !== false && isEnabled;
          console.log('[LLMService] Multimodal Initialized:', isVisionActive);
        } catch (mmErr) {
          console.warn('[LLMService] Failed to initialize mmproj:', mmErr);
        }
      }

      this.loadedModel = {
        name: modelName,
        path: normalizedModelPath,
        mmprojPath: normalizedMmproj,
        isVisionCapable: isVisionActive,
      };
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
      optionsOrPrompt: string | CompletionOptions,
      callbacks: StreamCallbacks
  ): Promise<{ fullText: string; metrics: PerformanceMetrics }> {
    if (!this.context) throw new Error('LLM Context is not initialized.');
    if (this.status !== 'READY') throw new Error(`LLM is not ready (Status: ${this.status}).`);

    const options: CompletionOptions =
        typeof optionsOrPrompt === 'string'
            ? { prompt: optionsOrPrompt }
            : optionsOrPrompt;

    this.status = 'GENERATING';
    this.isInterrupted = false;

    let fullText = '';
    let tokenCount = 0;
    let ttftRecorded = false;
    let ttftMs = 0;
    const startTime = performance.now();

    let messagesPayload: ChatMessage[] | undefined = options.messages;

    if (!messagesPayload && options.imagePaths && options.imagePaths.length > 0) {
      const contentParts: MessageContentPart[] = [
        { type: 'text', text: options.prompt || 'Describe and analyze this image.' },
      ];

      for (const imgPath of options.imagePaths) {
        const cleanUri = imgPath.startsWith('file://') ? imgPath : `file://${imgPath}`;
        contentParts.push({
          type: 'image_url',
          image_url: { url: cleanUri },
        });
      }

      messagesPayload = [
        {
          role: 'user',
          content: contentParts,
        },
      ];
    }

    try {
      const completionConfig: Record<string, any> = {
        n_predict: options.nPredict ?? 512,
        temperature: options.temperature ?? 0.3,
        top_p: options.topP ?? 0.9,
        // Anti-repetition penalties in llama.rn format
        penalty_repeat: options.repeatPenalty ?? 1.18,
        penalty_present: 0.15,
        penalty_last_n: 64,
        stop: options.stop ?? [
          '<|eot_id|>',
          '<|end_of_text|>',
          '<|im_end|>',
          '<|endoftext|>',
          'User:',
          'Assistant:',
          '</s>',
        ],
      };

      if (messagesPayload) {
        completionConfig.messages = messagesPayload as any;
      } else {
        completionConfig.prompt = options.prompt || '';
      }

      const result = await this.context.completion(
          completionConfig as any,
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

  public async completeNonStreaming(
      formattedPrompt: string,
      maxTokens: number = 128
  ): Promise<string> {
    if (!this.context || this.status !== 'READY') return '';

    try {
      const res = await this.context.completion({
        prompt: formattedPrompt,
        n_predict: maxTokens,
        temperature: 0.1,
        penalty_repeat: 1.18,
        penalty_present: 0.15,
        penalty_last_n: 64,
        stop: ['<|eot_id|>', '<|end_of_text|>', '<|im_end|>', '<|endoftext|>'],
      } as any);
      return res.text || '';
    } catch (error) {
      console.warn('[LLMService] Non-streaming completion failed:', error);
      return '';
    }
  }

  public async generateTitle(firstUserPrompt: string): Promise<string> {
    if (!this.context || this.status !== 'READY') return 'New Conversation';

    try {
      const isChatML = this.loadedModel?.isVisionCapable;
      const prompt = isChatML
          ? `<|im_start|>system\nCreate a 3-5 word concise title for this query. Output ONLY the title text.<|im_end|>\n<|im_start|>user\n${firstUserPrompt}<|im_end|>\n<|im_start|>assistant\n`
          : `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nCreate a 3-5 word concise title for this query. Output ONLY the title text.<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${firstUserPrompt}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;

      const text = await this.completeNonStreaming(prompt, 16);
      const clean = text.replace(/["'\n]/g, '').trim();
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
      if (this.loadedModel?.isVisionCapable) {
        try {
          await this.context.releaseMultimodal();
        } catch (mmErr) {
          console.warn('[LLMService] Error releasing multimodal context:', mmErr);
        }
      }
      await this.context.release();
    } finally {
      this.context = null;
      this.loadedModel = null;
      this.status = 'UNLOADED';
    }
  }
}
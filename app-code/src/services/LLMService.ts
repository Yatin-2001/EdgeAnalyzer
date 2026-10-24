import { initLlama, LlamaContext } from 'llama.rn';
import ModelFile from '../../modules/model-file/src/ModelFileModule';
import { MeshIdentityService } from './MeshIdentityService';

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

  /**
   * Unpacks pre-templated strings (Llama-3 or ChatML/Qwen2-VL) or __MESSAGES_JSON__ payloads
   * into canonical { role, content } turns so the host phone can apply the loaded
   * GGUF model's native chat/vision template.
   */
  public unpackTemplatedPrompt(rawPrompt: string): Array<{ role: string; content: string }> {
    if (rawPrompt.startsWith('__MESSAGES_JSON__:')) {
      try {
        const parsed = JSON.parse(rawPrompt.slice('__MESSAGES_JSON__:'.length));
        if (Array.isArray(parsed) && parsed.length > 0) {
          if (
              parsed.length === 1 &&
              typeof parsed[0].content === 'string' &&
              (parsed[0].content.includes('<|start_header_id|>') || parsed[0].content.includes('<|im_start|>'))
          ) {
            return this.unpackTemplatedPrompt(parsed[0].content);
          }
          return parsed.map((m: any) => ({
            role: m.role === 'tool' ? 'user' : String(m.role || 'user'),
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          }));
        }
      } catch {}
    }

    const messages: Array<{ role: string; content: string }> = [];

    if (rawPrompt.includes('<|start_header_id|>')) {
      const regex = /<\|start_header_id\|>(system|user|assistant|tool)<\|end_header_id\|>([\s\S]*?)(?=<\|start_header_id\|>|<\|eot_id\|>|$)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(rawPrompt)) !== null) {
        const rawRole = match[1];
        const rawContent = match[2];
        if (!rawRole || rawContent === undefined) continue;
        const content = rawContent.replace(/<\|eot_id\|>/g, '').trim();
        if (content.length > 0) {
          messages.push({ role: rawRole === 'tool' ? 'user' : rawRole, content });
        }
      }
    } else if (rawPrompt.includes('<|im_start|>')) {
      const regex = /<\|im_start\|>(system|user|assistant|tool)\n?([\s\S]*?)(?=<\|im_start\|>|<\|im_end\|>|$)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(rawPrompt)) !== null) {
        const rawRole = match[1];
        const rawContent = match[2];
        if (!rawRole || rawContent === undefined) continue;
        // Strip trailing ChatML end tags while preserving inner Qwen2-VL vision tags if present
        const content = rawContent.replace(/<\|im_end\|>/g, '').trim();
        if (content.length > 0) {
          messages.push({ role: rawRole === 'tool' ? 'user' : rawRole, content });
        }
      }
    }

    if (messages.length === 0 && rawPrompt.trim().length > 0) {
      messages.push({ role: 'user', content: rawPrompt.trim() });
    }

    return messages;
  }

  /**
   * Formats canonical { role, content } messages into the exact chat template
   * expected by the currently loaded GGUF model on this phone (including Qwen2-VL / ChatML).
   */
  public formatPromptForLoadedModel(
      messages: Array<{ role: string; content: string }>,
      imageCount: number = 0
  ): string {
    const modelName = (this.loadedModel?.name || '').toLowerCase();
    const isQwenVL =
        modelName.includes('qwen2-vl') ||
        modelName.includes('qwen2.5-vl') ||
        modelName.includes('qwen-vl') ||
        (modelName.includes('qwen') && this.loadedModel?.isVisionCapable);

    // 1. Qwen2-VL / Qwen2.5-VL & ChatML Family (Qwen, SmolVLM, Yi, DeepSeek, Hermes)
    if (
        isQwenVL ||
        this.loadedModel?.isVisionCapable ||
        modelName.includes('qwen') ||
        modelName.includes('smolvlm') ||
        modelName.includes('yi') ||
        modelName.includes('hermes')
    ) {
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');

      return (
          messages
              .map((m, idx) => {
                let body = m.content;
                // If raw prompt formatting is used with Qwen2-VL and images are attached,
                // prepend Qwen2-VL vision tokens if not already embedded
                if (
                    isQwenVL &&
                    imageCount > 0 &&
                    idx === lastUserIdx &&
                    !body.includes('<|vision_start|>')
                ) {
                  const visionBlocks = Array(imageCount)
                      .fill('<|vision_start|><|image_pad|><|vision_end|>')
                      .join('');
                  body = `${visionBlocks}${body}`;
                }
                return `<|im_start|>${m.role}\n${body}<|im_end|>`;
              })
              .join('\n') + '\n<|im_start|>assistant\n'
      );
    }

    // 2. Microsoft Phi-3 / Phi-3.5
    if (modelName.includes('phi')) {
      return (
          messages.map((m) => `<|${m.role}|>\n${m.content}<|end|>`).join('\n') +
          '\n<|assistant|>\n'
      );
    }

    // 3. Google Gemma / Gemma 2
    if (modelName.includes('gemma')) {
      let systemPrefix = '';
      const turns: string[] = [];
      for (const m of messages) {
        if (m.role === 'system') {
          systemPrefix += `${m.content}\n\n`;
        } else {
          const gemmaRole = m.role === 'assistant' ? 'model' : 'user';
          const content = gemmaRole === 'user' && systemPrefix ? `${systemPrefix}${m.content}` : m.content;
          if (gemmaRole === 'user') systemPrefix = '';
          turns.push(`<start_of_turn>${gemmaRole}\n${content}<end_of_turn>`);
        }
      }
      return turns.join('\n') + '\n<start_of_turn>model\n';
    }

    // 4. Mistral / Mixtral Instruct
    if (modelName.includes('mistral') || modelName.includes('mixtral')) {
      let systemPrefix = '';
      const turns: string[] = [];
      for (const m of messages) {
        if (m.role === 'system') {
          systemPrefix += `${m.content}\n\n`;
        } else if (m.role === 'user') {
          turns.push(`[INST] ${systemPrefix}${m.content} [/INST]`);
          systemPrefix = '';
        } else if (m.role === 'assistant') {
          turns.push(`${m.content}</s>`);
        }
      }
      return turns.join(' ');
    }

    // 5. Default: Llama-3 / Llama-3.1 / Llama-3.2
    return (
        '<|begin_of_text|>' +
        messages
            .map((m) => `<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`)
            .join('') +
        '<|start_header_id|>assistant<|end_header_id|>\n\n'
    );
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

      // Sync active model name & persistent node identity with native EdgeComputeWorkerService
      try {
        await ModelFile.setWorkerActiveModel(modelName);
        const identity = await MeshIdentityService.getInstance().getOrCreateIdentity();
        await ModelFile.setWorkerNodeIdentity?.(identity.node_id, identity.node_name);
      } catch {}
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

    // Multimodal Vision Path (Qwen2-VL, SmolVLM, LLaVA):
    // Unpack any pre-templated prompt into clean turns and attach image_url parts to the final user turn
    if (!messagesPayload && options.imagePaths && options.imagePaths.length > 0) {
      const rawPrompt = options.prompt || 'Describe and analyze this image.';
      const unpacked =
          rawPrompt.includes('<|start_header_id|>') ||
          rawPrompt.includes('<|im_start|>') ||
          rawPrompt.startsWith('__MESSAGES_JSON__:')
              ? this.unpackTemplatedPrompt(rawPrompt)
              : [{ role: 'user', content: rawPrompt }];

      const imageParts: MessageContentPart[] = options.imagePaths.map((imgPath) => {
        const cleanUri = imgPath.startsWith('file://') ? imgPath : `file://${imgPath}`;
        return {
          type: 'image_url',
          image_url: { url: cleanUri },
        };
      });

      const lastUserIdx = unpacked.map((m) => m.role).lastIndexOf('user');
      messagesPayload = unpacked.map((m, idx) => {
        if (idx === lastUserIdx || (lastUserIdx === -1 && idx === unpacked.length - 1)) {
          // Place image_url parts before text (standard Qwen2-VL & SmolVLM multimodal order)
          const cleanText = m.content
              .replace(/<\|vision_start\|>[\s\S]*?<\|vision_end\|>/g, '')
              .replace(/<\|image_pad\|>/g, '')
              .trim();
          return {
            role: 'user',
            content: [
              ...imageParts,
              { type: 'text', text: cleanText || 'Describe and analyze this image.' },
            ],
          };
        }
        return {
          role: (m.role === 'system' || m.role === 'assistant' ? m.role : 'user') as 'system' | 'user' | 'assistant',
          content: m.content,
        };
      });
    }

    try {
      const completionConfig: Record<string, any> = {
        n_predict: options.nPredict ?? 512,
        temperature: options.temperature ?? 0.3,
        top_p: options.topP ?? 0.9,
        penalty_repeat: options.repeatPenalty ?? 1.18,
        penalty_present: 0.15,
        penalty_last_n: 64,
        stop: options.stop ?? [
          '<|eot_id|>',
          '<|end_of_text|>',
          '<|end|>',
          '<|im_end|>',
          '<|im_start|>',
          '<|endoftext|>',
          '<|vision_end|>',
          '<end_of_turn>',
          '<|user|>',
          '<|system|>',
          '### AVAILABLE TOOLS',
          '### EXAMPLES',
          '\nQuery:',
          '\nUser:',
          'User:',
          'Assistant:',
          '</s>',
        ],
      };

      if (messagesPayload) {
        completionConfig.messages = messagesPayload as any;
      } else {
        let rawPrompt = options.prompt || '';
        if (
            rawPrompt.startsWith('__MESSAGES_JSON__:') ||
            rawPrompt.includes('<|start_header_id|>') ||
            rawPrompt.includes('<|im_start|>')
        ) {
          const unpacked = this.unpackTemplatedPrompt(rawPrompt);
          rawPrompt = this.formatPromptForLoadedModel(unpacked);
        }
        completionConfig.prompt = rawPrompt;
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
      let normalizedPrompt = formattedPrompt;
      if (
          normalizedPrompt.startsWith('__MESSAGES_JSON__:') ||
          normalizedPrompt.includes('<|start_header_id|>') ||
          normalizedPrompt.includes('<|im_start|>')
      ) {
        const unpacked = this.unpackTemplatedPrompt(normalizedPrompt);
        normalizedPrompt = this.formatPromptForLoadedModel(unpacked);
      }

      const res = await this.context.completion({
        prompt: normalizedPrompt,
        n_predict: maxTokens,
        temperature: 0.1,
        penalty_repeat: 1.18,
        penalty_present: 1.15,
        penalty_last_n: 64,
        stop: [
          '<|eot_id|>',
          '<|end_of_text|>',
          '<|end|>',
          '<|im_end|>',
          '<|im_start|>',
          '<|endoftext|>',
          '<end_of_turn>',
          '### AVAILABLE TOOLS',
          '### EXAMPLES',
          '\nQuery:',
          '\nUser:',
        ],
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
      const prompt = this.formatPromptForLoadedModel([
        {
          role: 'system',
          content: 'Create a 3-5 word concise title for this query. Output ONLY the title text.',
        },
        { role: 'user', content: firstUserPrompt },
      ]);

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
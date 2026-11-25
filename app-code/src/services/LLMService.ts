import { initLlama, LlamaContext } from 'llama.rn';
import ModelFile from '../../modules/model-file/src/ModelFileModule';
import { MeshIdentityService } from './MeshIdentityService';
import type { OpenAIToolCall, OpenAIToolDefinition } from '../tools/types';

export type LLMStatus =
    | 'UNLOADED'
    | 'LOADING'
    | 'READY'
    | 'GENERATING'
    | 'ERROR';

export interface PerformanceMetrics {
  ttftMs: number;
  totalTokens: number;
  promptTokens?: number;
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
  nCtx: number;
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
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content?: string | MessageContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
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

export interface OpenAIChatExecutionOptions {
  messages: ChatMessage[];
  tools?: OpenAIToolDefinition[];
  tool_choice?: string | Record<string, any>;
  response_format?: {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: { name?: string; schema?: Record<string, any>; strict?: boolean };
  };
  temperature?: number;
  max_tokens?: number;
  stop?: string[];
}

export interface OpenAIChatStreamCallbacks {
  onDelta?: (delta: { content?: string; reasoning_content?: string }) => void;
  onToolCalls?: (toolCalls: OpenAIToolCall[]) => void;
}

export interface OpenAIChatExecutionResult {
  fullText: string;
  reasoningText: string;
  toolCalls: OpenAIToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  metrics: PerformanceMetrics;
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

  public static generateToolCallId(): string {
    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += Math.floor(Math.random() * 16).toString(16);
    }
    return `call_${hex}`;
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

    if (modelName.includes('phi')) {
      return (
          messages.map((m) => `<|${m.role}|>\n${m.content}<|end|>`).join('\n') +
          '\n<|assistant|>\n'
      );
    }

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
      const resolvedCtx = config.nCtx ?? (normalizedMmproj ? 2048 : 4096);

      this.context = await initLlama(
          {
            model: normalizedModelPath,
            use_mlock: config.useMlock ?? false,
            n_ctx: resolvedCtx,
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
        } catch (mmErr) {
          console.warn('[LLMService] Failed to initialize mmproj:', mmErr);
        }
      }

      this.loadedModel = {
        name: modelName,
        path: normalizedModelPath,
        nCtx: resolvedCtx,
        mmprojPath: normalizedMmproj,
        isVisionCapable: isVisionActive,
      };
      this.status = 'READY';

      // Sync active model, context window, vision capability & node identity with EdgeComputeWorkerService
      try {
        await ModelFile.setWorkerActiveModel(modelName);
        await ModelFile.setWorkerModelCapabilities?.(modelName, resolvedCtx, isVisionActive);
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

  /**
   * Normalizes llama.rn or fallback JSON tool calls into strict OpenAI wire format:
   * { id: "call_<hex8>", type: "function", function: { name, arguments: "<json-string>" } }
   */
  public static normalizeToolCalls(rawCalls: any[]): OpenAIToolCall[] {
    if (!Array.isArray(rawCalls)) return [];
    const out: OpenAIToolCall[] = [];
    for (const tc of rawCalls) {
      const fnName = tc?.function?.name || tc?.name || tc?.tool;
      if (!fnName || typeof fnName !== 'string') continue;

      const rawArgs = tc?.function?.arguments ?? tc?.arguments ?? tc?.parameters ?? {};
      const serializedArgs =
          typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});

      out.push({
        id: typeof tc?.id === 'string' && tc.id.length > 0 ? tc.id : LLMService.generateToolCallId(),
        type: 'function',
        function: {
          name: fnName.trim(),
          arguments: serializedArgs,
        },
      });
    }
    return out;
  }

  /**
   * Fallback JSON tool-call extractor when a GGUF omits native Jinja tool templates
   * or outputs raw {"tool": ..., "parameters": ...} / {"name": ..., "arguments": ...} JSON.
   */
  public static extractFallbackToolCalls(
      text: string,
      allowedTools?: OpenAIToolDefinition[]
  ): OpenAIToolCall[] {
    const trimmed = (text || '').trim();
    if (!trimmed) return [];
    const allowedNames = new Set(
        (allowedTools || []).map((t) => t.function.name.toLowerCase())
    );

    const extracted: any[] = [];
    let depth = 0;
    let inString = false;
    let escape = false;
    let startIdx = -1;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === '{') {
          if (depth === 0) startIdx = i;
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0 && startIdx !== -1) {
            const candidate = trimmed.slice(startIdx, i + 1);
            try {
              const obj = JSON.parse(candidate);
              if (Array.isArray(obj?.tool_calls)) {
                extracted.push(...obj.tool_calls);
              } else {
                const name = String(obj?.function?.name || obj?.name || obj?.tool || '').trim();
                if (name && (allowedNames.size === 0 || allowedNames.has(name.toLowerCase()))) {
                  extracted.push(obj);
                }
              }
            } catch {}
            startIdx = -1;
          }
        }
      }
    }

    return LLMService.normalizeToolCalls(extracted);
  }

  /**
   * MVP 4 OpenAI-Compatible Completion Engine (used by POST /v1/edge/chat & ToolOrchestrator).
   * Attempts native llama.rn `jinja: true` + `tools` first inside try/catch; falls back safely
   * to prompt-formatted execution + JSON tool extraction for GGUFs without Jinja tool metadata.
   */
  /**
   * MVP 4 OpenAI-Compatible Completion Engine (used by POST /v1/edge/chat & ToolOrchestrator).
   * Attempts native llama.rn `jinja: true` + `tools` first inside try/catch; falls back safely
   * to prompt-formatted execution + JSON tool extraction for GGUFs without Jinja tool metadata.
   */
  public async streamOpenAIChat(
      options: OpenAIChatExecutionOptions,
      callbacks: OpenAIChatStreamCallbacks = {}
  ): Promise<OpenAIChatExecutionResult> {
    if (!this.context) throw new Error('LLM Context is not initialized.');
    if (this.status !== 'READY') throw new Error(`LLM is not ready (Status: ${this.status}).`);

    this.status = 'GENERATING';
    this.isInterrupted = false;

    const startTime = performance.now();
    let ttftRecorded = false;
    let ttftMs = 0;
    let tokenCount = 0;
    let fullText = '';
    let reasoningText = '';
    let normalizedToolCalls: OpenAIToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let stoppedLimit = false;

    const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
    const isRawToolPrefix = (txt: string): boolean => {
      const t = txt.trimStart();
      return (
          t.startsWith('{') ||
          t.startsWith('<|python_tag|>') ||
          t.startsWith('<tool_call>')
      );
    };

    const normalizedMessages = options.messages.map((m) => ({
      ...m,
      role: m.role === 'developer' ? 'system' : m.role,
      content: m.content ?? '',
    }));

    const baseStop = options.stop ?? [
      '<|eot_id|>',
      '<|end_of_text|>',
      '<|end|>',
      '<|im_end|>',
      '<|im_start|>',
      '<|endoftext|>',
      '<end_of_turn>',
      '</s>',
    ];

    try {
      // Primary Path: Native llama.rn minja + chat.cpp (`jinja: true` + OpenAI `tools`)
      const nativeParams: Record<string, any> = {
        messages: normalizedMessages,
        jinja: true,
        n_predict: options.max_tokens ?? 1024,
        temperature: options.temperature ?? 0.2,
        top_p: 0.9,
        penalty_repeat: 1.12,
        stop: baseStop,
      };

      if (hasTools) {
        nativeParams.tools = options.tools;
        if (options.tool_choice !== undefined) {
          nativeParams.tool_choice = options.tool_choice;
        }
      }

      if (options.response_format) {
        if (options.response_format.type === 'json_object') {
          nativeParams.response_format = { type: 'json_object' };
        } else if (
            options.response_format.type === 'json_schema' &&
            options.response_format.json_schema?.schema
        ) {
          nativeParams.response_format = {
            type: 'json_schema',
            json_schema: options.response_format.json_schema,
          };
        }
      }

      let nativeSucceeded = false;
      try {
        const result: any = await this.context.completion(nativeParams as any, (data: any) => {
          if (this.isInterrupted) return;
          if (!ttftRecorded) {
            ttftMs = performance.now() - startTime;
            ttftRecorded = true;
          }
          tokenCount += 1;

          const rChunk = typeof data?.reasoning_content === 'string' ? data.reasoning_content : '';
          const tChunk = typeof data?.token === 'string' ? data.token : '';

          if (rChunk) {
            reasoningText += rChunk;
            callbacks.onDelta?.({ reasoning_content: rChunk });
          }

          if (tChunk) {
            fullText += tChunk;
            if (!hasTools || !isRawToolPrefix(fullText)) {
              callbacks.onDelta?.({ content: tChunk });
            }
          }
        });

        nativeSucceeded = true;
        if (typeof result?.content === 'string' && result.content.length > 0 && !fullText) {
          fullText = result.content;
        }
        if (typeof result?.reasoning_content === 'string' && !reasoningText) {
          reasoningText = result.reasoning_content;
        }
        if (Array.isArray(result?.tool_calls) && result.tool_calls.length > 0) {
          normalizedToolCalls = LLMService.normalizeToolCalls(result.tool_calls);
        }
        promptTokens =
            result?.tokens_evaluated || Math.ceil(JSON.stringify(normalizedMessages).length / 3.8);
        completionTokens = result?.tokens_predicted || tokenCount;
        stoppedLimit = !!result?.stopped_limit;
      } catch (jinjaErr) {
        console.warn('[LLMService] Native jinja/tools completion failed; falling back to prompt template:', jinjaErr);
      }

      // Fallback Path: Standard template formatting + explicit tool schema injection
      if (!nativeSucceeded) {
        fullText = '';
        reasoningText = '';
        tokenCount = 0;

        const flatMessages = normalizedMessages.map((m) => {
          let contentStr =
              typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
            contentStr = `${contentStr}\n${JSON.stringify({ tool_calls: m.tool_calls })}`.trim();
          }
          if (m.role === 'tool') {
            contentStr = `[Tool Output (${m.name || 'tool'})]: ${contentStr}`;
          }
          return {
            role: m.role === 'tool' ? 'user' : m.role,
            content: contentStr,
          };
        });

        if (hasTools) {
          const toolBlock =
              `You have access to these tools. To call a tool, respond ONLY with JSON: ` +
              `{"name": "<tool_name>", "arguments": {<args>}}\n` +
              `Available tools:\n${JSON.stringify(options.tools)}`;
          if (flatMessages.length > 0 && flatMessages[0].role === 'system') {
            flatMessages[0].content = `${flatMessages[0].content}\n\n${toolBlock}`;
          } else {
            flatMessages.unshift({ role: 'system', content: toolBlock });
          }
        }

        const formattedPrompt = this.formatPromptForLoadedModel(flatMessages);
        const fallbackRes: any = await this.context.completion(
            {
              prompt: formattedPrompt,
              n_predict: options.max_tokens ?? 1024,
              temperature: options.temperature ?? 0.2,
              top_p: 0.9,
              penalty_repeat: 1.15,
              stop: baseStop,
            } as any,
            (data: any) => {
              if (this.isInterrupted) return;
              if (!ttftRecorded) {
                ttftMs = performance.now() - startTime;
                ttftRecorded = true;
              }
              tokenCount += 1;
              if (data?.token) {
                fullText += data.token;
                if (!hasTools || !isRawToolPrefix(fullText)) {
                  callbacks.onDelta?.({ content: data.token });
                }
              }
            }
        );

        promptTokens =
            fallbackRes?.tokens_evaluated || Math.ceil(formattedPrompt.length / 3.8);
        completionTokens = fallbackRes?.tokens_predicted || tokenCount;
        stoppedLimit = !!fallbackRes?.stopped_limit;
      }

      // If tools were requested and native tool_calls was empty, check JSON fallback extractor
      if (hasTools && normalizedToolCalls.length === 0 && fullText.trim().length > 0) {
        const extracted = LLMService.extractFallbackToolCalls(fullText, options.tools);
        if (extracted.length > 0) {
          normalizedToolCalls = extracted;
          fullText = '';
        } else if (isRawToolPrefix(fullText)) {
          callbacks.onDelta?.({ content: fullText });
        }
      }

      if (normalizedToolCalls.length > 0) {
        callbacks.onToolCalls?.(normalizedToolCalls);
      }

      const endTime = performance.now();
      const generationTimeSec = Math.max((endTime - startTime) / 1000, 0.001);
      const effectiveTokens = completionTokens || tokenCount;
      const tokensPerSecond = parseFloat((effectiveTokens / generationTimeSec).toFixed(2));
      const finishReason: 'stop' | 'tool_calls' | 'length' =
          normalizedToolCalls.length > 0
              ? 'tool_calls'
              : stoppedLimit
                  ? 'length'
                  : 'stop';

      const metrics: PerformanceMetrics = {
        ttftMs: Math.round(ttftMs),
        totalTokens: effectiveTokens,
        promptTokens,
        generationTimeSec: parseFloat(generationTimeSec.toFixed(2)),
        tokensPerSecond,
      };

      this.status = 'READY';
      return {
        fullText,
        reasoningText,
        toolCalls: normalizedToolCalls,
        finishReason,
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: effectiveTokens,
          total_tokens: promptTokens + effectiveTokens,
        },
        metrics,
      };
    } catch (error) {
      this.status = 'READY';
      throw error;
    }
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

    // Multimodal Vision Path (Qwen2-VL, SmolVLM, LLaVA)
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

      const result: any = await this.context.completion(
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
        promptTokens: result.tokens_evaluated,
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
      ModelFile.setWorkerModelCapabilities?.('No Model Loaded', 4096, false).catch(() => {});
    }
  }
}
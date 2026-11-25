import crypto from 'node:crypto';
import { SystemTelemetry } from '../mesh/SystemTelemetry.js';

export interface OllamaModelTag {
    name: string;
    size: number;
    digest: string;
    details?: {
        parameter_size?: string;
        quantization_level?: string;
        family?: string;
    };
}

export interface OllamaGenerationMetrics {
    ttftMs: number;
    generationDurationMs: number;
    promptTokens: number;
    completionTokens: number;
    tokensPerSec: number;
    vramUsedMb: number;
    fullText: string;
    emittedToolCall: boolean;
}

export interface OpenAIToolCall {
    index?: number;
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

export interface OpenAIContentPart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: { url: string; detail?: string };
}

export interface OpenAIChatMessage {
    role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
    content?: string | OpenAIContentPart[] | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolDefinition {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

export interface OpenAIResponseFormat {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: {
        name?: string;
        schema?: Record<string, unknown>;
        strict?: boolean;
    };
}

export interface OpenAIChatRequest {
    model: string;
    messages: OpenAIChatMessage[];
    tools?: OpenAIToolDefinition[];
    tool_choice?: string | Record<string, unknown>;
    response_format?: OpenAIResponseFormat;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    stop?: string | string[];
}

export interface OpenAIUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface OpenAIStreamDelta {
    role?: 'assistant';
    content?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function: {
            name?: string;
            arguments: string;
        };
    }>;
}

export interface OpenAIStreamChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: OpenAIStreamDelta;
        finish_reason: 'stop' | 'tool_calls' | 'length' | null;
    }>;
    usage?: OpenAIUsage | null;
}

export interface OllamaOpenAIExecutionResult {
    completionId: string;
    model: string;
    fullText: string;
    reasoningText: string;
    toolCalls: OpenAIToolCall[];
    finishReason: 'stop' | 'tool_calls' | 'length';
    usage: OpenAIUsage;
    ttftMs: number;
    generationDurationMs: number;
    tokensPerSec: number;
    vramUsedMb: number;
}

export class OllamaBridge {
    private static instance: OllamaBridge;
    private baseUrl = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');

    private constructor() {}

    public static getInstance(): OllamaBridge {
        if (!OllamaBridge.instance) {
            OllamaBridge.instance = new OllamaBridge();
        }
        return OllamaBridge.instance;
    }

    public static generateToolCallId(): string {
        return `call_${crypto.randomBytes(4).toString('hex')}`;
    }

    public async listModels(): Promise<OllamaModelTag[]> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tags`);
            if (!res.ok) return [];
            const data = (await res.json()) as { models?: OllamaModelTag[] };
            return data.models ?? [];
        } catch {
            return [];
        }
    }

    public async getTelemetry(): Promise<{ vramUsageBytes: number; activeModel: string | null }> {
        try {
            const res = await fetch(`${this.baseUrl}/api/ps`);
            if (!res.ok) return { vramUsageBytes: 0, activeModel: null };
            const data = (await res.json()) as { models?: Array<{ size_vram?: number; name?: string }> };
            const first = data.models?.[0];
            return {
                vramUsageBytes: first?.size_vram ?? 0,
                activeModel: first?.name ?? null,
            };
        } catch {
            return { vramUsageBytes: 0, activeModel: null };
        }
    }

    public unpackTemplatedPrompt(rawPrompt: string): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];

        if (rawPrompt.includes('<|start_header_id|>')) {
            const regex =
                /<\|start_header_id\|>(system|user|assistant|tool)<\|end_header_id\|>([\s\S]*?)(?=<\|start_header_id\|>|<\|eot_id\|>|$)/g;
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
            const regex =
                /<\|im_start\|>(system|user|assistant|tool)\n?([\s\S]*?)(?=<\|im_start\|>|<\|im_end\|>|$)/g;
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

    private isToolCallOutput(text: string): boolean {
        const trimmed = text.trim();
        if (trimmed.length > 350 && !trimmed.startsWith('{') && !trimmed.startsWith('```')) {
            return false;
        }
        return /"tool"\s*:\s*"(calculator|web_search|device_location|weather)"/i.test(trimmed);
    }

    private mapOpenAIMessagesToOllama(messages: OpenAIChatMessage[]): Array<Record<string, unknown>> {
        return messages.map((msg) => {
            const role = msg.role === 'developer' ? 'system' : msg.role;

            // Flatten OpenAI multimodal content parts into text + Ollama base64 images[]
            let textContent = '';
            const images: string[] = [];

            if (typeof msg.content === 'string') {
                textContent = msg.content;
            } else if (Array.isArray(msg.content)) {
                const textParts: string[] = [];
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) {
                        textParts.push(part.text);
                    } else if (part.type === 'image_url' && part.image_url?.url) {
                        const url = part.image_url.url;
                        const b64Idx = url.indexOf('base64,');
                        if (b64Idx !== -1) {
                            images.push(url.slice(b64Idx + 7));
                        }
                    }
                }
                textContent = textParts.join('\n');
            }

            if (role === 'tool') {
                const toolMsg: Record<string, unknown> = {
                    role: 'tool',
                    content: textContent,
                };
                if (msg.name) {
                    toolMsg.tool_name = msg.name;
                }
                return toolMsg;
            }

            const ollamaMsg: Record<string, unknown> = {
                role,
                content: textContent,
            };

            if (images.length > 0) {
                ollamaMsg.images = images;
            }

            // Convert OpenAI stringified tool_calls arguments -> JSON objects for Ollama /api/chat
            if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                ollamaMsg.tool_calls = msg.tool_calls.map((tc) => {
                    let parsedArgs: Record<string, unknown> = {};
                    if (typeof tc.function.arguments === 'string') {
                        try {
                            const parsed = JSON.parse(tc.function.arguments) as unknown;
                            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                                parsedArgs = parsed as Record<string, unknown>;
                            }
                        } catch {
                            parsedArgs = {};
                        }
                    } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
                        parsedArgs = tc.function.arguments as unknown as Record<string, unknown>;
                    }
                    return {
                        function: {
                            name: tc.function.name,
                            arguments: parsedArgs,
                        },
                    };
                });
            }

            return ollamaMsg;
        });
    }

    /**
     * Strict OpenAI-compatible execution adapter over Ollama /api/chat (MVP 4)
     */
    public async executeOpenAIChat(params: {
        resolvedModel: string;
        request: OpenAIChatRequest;
        numCtx?: number;
        signal?: AbortSignal;
        onStreamChunk?: (chunk: OpenAIStreamChunk) => void;
    }): Promise<OllamaOpenAIExecutionResult> {
        const { resolvedModel, request, numCtx, signal, onStreamChunk } = params;
        const completionId = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
        const created = Math.floor(Date.now() / 1000);

        const ollamaMessages = this.mapOpenAIMessagesToOllama(request.messages);

        const ollamaOptions: Record<string, unknown> = {
            temperature: request.temperature ?? 0.2,
            num_predict: request.max_completion_tokens ?? request.max_tokens ?? 1024,
        };
        if (request.top_p !== undefined) {
            ollamaOptions.top_p = request.top_p;
        }
        if (numCtx !== undefined) {
            ollamaOptions.num_ctx = numCtx;
        }
        if (request.stop !== undefined) {
            ollamaOptions.stop = Array.isArray(request.stop) ? request.stop : [request.stop];
        }

        const ollamaBody: Record<string, unknown> = {
            model: resolvedModel,
            messages: ollamaMessages,
            stream: true,
            options: ollamaOptions,
        };

        if (Array.isArray(request.tools) && request.tools.length > 0) {
            ollamaBody.tools = request.tools;
        }

        if (request.response_format) {
            if (request.response_format.type === 'json_object') {
                ollamaBody.format = 'json';
            } else if (
                request.response_format.type === 'json_schema' &&
                request.response_format.json_schema?.schema
            ) {
                ollamaBody.format = request.response_format.json_schema.schema;
            }
        }

        const startTimeMs = Date.now();
        let ttftMs = 0;
        let firstEventSeen = false;
        let sentRoleHeader = false;
        let fullText = '';
        let reasoningText = '';
        let streamedTokens = 0;
        let promptEvalCount = 0;
        let evalCount = 0;
        let evalDurationNs = 0;
        let promptEvalDurationNs = 0;
        let doneReason = 'stop';

        const emittedToolCalls: OpenAIToolCall[] = [];
        let toolCallIndex = 0;

        const fetchInit: RequestInit = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ollamaBody),
        };
        if (signal) {
            fetchInit.signal = signal;
        }

        console.log(
            `[OllamaBridge] 🚀 OpenAI /api/chat -> "${resolvedModel}" (num_ctx=${numCtx ?? 'default'}, stream=${request.stream === true}, tools=${request.tools?.length ?? 0})`
        );

        const res = await fetch(`${this.baseUrl}/api/chat`, fetchInit);
        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`Ollama /api/chat failed (${res.status}): ${errText || res.statusText}`);
        }
        if (!res.body) {
            throw new Error('Ollama /api/chat returned an empty body');
        }

        const emitDelta = (delta: OpenAIStreamDelta): void => {
            if (!onStreamChunk) return;
            const outDelta: OpenAIStreamDelta = sentRoleHeader ? delta : { role: 'assistant', ...delta };
            sentRoleHeader = true;
            onStreamChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: resolvedModel,
                choices: [
                    {
                        index: 0,
                        delta: outDelta,
                        finish_reason: null,
                    },
                ],
            });
        };

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.trim()) continue;
                let parsed: {
                    message?: {
                        content?: string;
                        thinking?: string;
                        tool_calls?: Array<{
                            id?: string;
                            function?: { name?: string; arguments?: unknown };
                        }>;
                    };
                    done?: boolean;
                    done_reason?: string;
                    prompt_eval_count?: number;
                    eval_count?: number;
                    eval_duration?: number;
                    prompt_eval_duration?: number;
                };
                try {
                    parsed = JSON.parse(line);
                } catch {
                    continue;
                }

                const msg = parsed.message;
                if (msg?.thinking) {
                    if (!firstEventSeen) {
                        firstEventSeen = true;
                        ttftMs = Date.now() - startTimeMs;
                    }
                    reasoningText += msg.thinking;
                    streamedTokens++;
                    emitDelta({ reasoning_content: msg.thinking });
                }

                if (msg?.content) {
                    if (!firstEventSeen) {
                        firstEventSeen = true;
                        ttftMs = Date.now() - startTimeMs;
                    }
                    fullText += msg.content;
                    streamedTokens++;
                    emitDelta({ content: msg.content });
                }

                if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
                    if (!firstEventSeen) {
                        firstEventSeen = true;
                        ttftMs = Date.now() - startTimeMs;
                    }

                    const normalizedDeltaCalls: NonNullable<OpenAIStreamDelta['tool_calls']> = [];
                    for (const rawTc of msg.tool_calls) {
                        const callId = rawTc.id || OllamaBridge.generateToolCallId();
                        const fnName = rawTc.function?.name || 'unknown_tool';
                        const rawArgs = rawTc.function?.arguments;
                        const serializedArgs =
                            typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
                        const idx = toolCallIndex++;

                        emittedToolCalls.push({
                            index: idx,
                            id: callId,
                            type: 'function',
                            function: {
                                name: fnName,
                                arguments: serializedArgs,
                            },
                        });

                        normalizedDeltaCalls.push({
                            index: idx,
                            id: callId,
                            type: 'function',
                            function: {
                                name: fnName,
                                arguments: serializedArgs,
                            },
                        });
                    }

                    emitDelta({ tool_calls: normalizedDeltaCalls });
                }

                if (parsed.done) {
                    promptEvalCount = parsed.prompt_eval_count ?? 0;
                    evalCount = parsed.eval_count ?? streamedTokens;
                    evalDurationNs = parsed.eval_duration ?? 0;
                    promptEvalDurationNs = parsed.prompt_eval_duration ?? 0;
                    if (parsed.done_reason) {
                        doneReason = parsed.done_reason;
                    }
                }
            }
        }

        const totalDurationMs = Math.max(1, Date.now() - startTimeMs);
        if (promptEvalDurationNs > 0 && ttftMs === 0) {
            ttftMs = Math.round(promptEvalDurationNs / 1e6);
        }

        const finishReason: 'stop' | 'tool_calls' | 'length' =
            emittedToolCalls.length > 0
                ? 'tool_calls'
                : doneReason === 'length'
                    ? 'length'
                    : 'stop';

        const promptTokens =
            promptEvalCount || Math.ceil(JSON.stringify(request.messages).length / 3.8);
        const completionTokens = evalCount || streamedTokens;
        const usage: OpenAIUsage = {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        };

        const tokensPerSec =
            evalDurationNs > 0
                ? parseFloat((completionTokens / (evalDurationNs / 1e9)).toFixed(1))
                : parseFloat((completionTokens / (totalDurationMs / 1000)).toFixed(1));

        // Emit terminal finish_reason chunk (and usage chunk if requested)
        if (onStreamChunk) {
            onStreamChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: resolvedModel,
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: finishReason,
                    },
                ],
            });

            if (request.stream_options?.include_usage) {
                onStreamChunk({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: resolvedModel,
                    choices: [],
                    usage,
                });
            }
        }

        let vramUsedMb = 0;
        try {
            const gpuStats = await SystemTelemetry.getInstance().getGpuStats();
            vramUsedMb = gpuStats?.usedMB ?? 0;
        } catch {}

        console.log(
            `[OllamaBridge] ✅ OpenAI /api/chat done ("${resolvedModel}": ${completionTokens} tok @ ${tokensPerSec} tok/s, TTFT=${ttftMs}ms, finish=${finishReason})`
        );

        return {
            completionId,
            model: resolvedModel,
            fullText,
            reasoningText,
            toolCalls: emittedToolCalls,
            finishReason,
            usage,
            ttftMs,
            generationDurationMs: totalDurationMs,
            tokensPerSec,
            vramUsedMb,
        };
    }

    /**
     * MVP 3 Backward-Compatible Mobile MCP Streaming Chat
     */
    public async streamChat(
        model: string,
        messages: Array<{ role: string; content: string; images?: string[] }>,
        onChunk: (text: string) => void,
        options: { nPredict?: number; signal?: AbortSignal } = {}
    ): Promise<OllamaGenerationMetrics> {
        let normalizedMessages = messages;

        if (messages.length === 1 && messages[0]?.content) {
            const rawContent = messages[0].content;
            if (rawContent.includes('<|start_header_id|>') || rawContent.includes('<|im_start|>')) {
                normalizedMessages = this.unpackTemplatedPrompt(rawContent);
                console.log(
                    `[OllamaBridge] 🔄 Unpacked ${rawContent.length} raw chars into ${normalizedMessages.length} structured chat message(s) for "${model}"`
                );
            }
        }

        const startTimeMs = Date.now();
        let ttftMs = 0;
        let firstTokenArrived = false;
        let fullText = '';
        let streamedTokens = 0;
        let promptEvalCount = 0;
        let evalCount = 0;
        let evalDurationNs = 0;
        let promptEvalDurationNs = 0;

        console.log(
            `[OllamaBridge] 🚀 Dispatching prompt to model "${model}" (${normalizedMessages.length} messages) via /api/chat`
        );

        const fetchInit: RequestInit = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: normalizedMessages,
                stream: true,
                options: {
                    temperature: 0.2,
                    num_predict: options.nPredict ?? 512,
                    stop: [
                        '<|eot_id|>',
                        '<|end_of_text|>',
                        '<|end|>',
                        '<|im_end|>',
                        '<|user|>',
                        '<|system|>',
                        '</s>',
                        '### AVAILABLE TOOLS',
                        '### RULES FOR TOOL USE',
                        '### EXAMPLES',
                        '\nQuery:',
                        '\nUser:',
                    ],
                },
            }),
        };
        if (options.signal) {
            fetchInit.signal = options.signal;
        }

        const res = await fetch(`${this.baseUrl}/api/chat`, fetchInit);

        if (!res.ok) {
            const errText = await res.text().catch(() => '');
            console.error(`[OllamaBridge] ❌ Ollama returned ${res.status}: ${errText}`);
            throw new Error(`Ollama error (${res.status}): ${errText || res.statusText}`);
        }

        if (!res.body) {
            throw new Error('Ollama response body is empty');
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line) as {
                        message?: { content?: string };
                        done?: boolean;
                        prompt_eval_count?: number;
                        eval_count?: number;
                        eval_duration?: number;
                        prompt_eval_duration?: number;
                    };
                    if (parsed.message?.content) {
                        if (!firstTokenArrived) {
                            firstTokenArrived = true;
                            ttftMs = Date.now() - startTimeMs;
                        }
                        streamedTokens++;
                        fullText += parsed.message.content;
                        onChunk(parsed.message.content);
                    }
                    if (parsed.done) {
                        promptEvalCount = parsed.prompt_eval_count ?? 0;
                        evalCount = parsed.eval_count ?? streamedTokens;
                        evalDurationNs = parsed.eval_duration ?? 0;
                        promptEvalDurationNs = parsed.prompt_eval_duration ?? 0;
                    }
                } catch {}
            }
        }

        const totalDurationMs = Math.max(1, Date.now() - startTimeMs);
        if (promptEvalDurationNs > 0 && ttftMs === 0) {
            ttftMs = Math.round(promptEvalDurationNs / 1e6);
        }

        const completionTokens = evalCount || streamedTokens;
        const promptTokens =
            promptEvalCount ||
            Math.ceil(normalizedMessages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0) / 4);

        const tokensPerSec =
            evalDurationNs > 0
                ? parseFloat((completionTokens / (evalDurationNs / 1e9)).toFixed(1))
                : parseFloat((completionTokens / (totalDurationMs / 1000)).toFixed(1));

        let vramUsedMb = 0;
        try {
            const gpuStats = await SystemTelemetry.getInstance().getGpuStats();
            vramUsedMb = gpuStats?.usedMB ?? 0;
        } catch {}

        console.log(
            `[OllamaBridge] ✅ Completed generation (${completionTokens} tokens @ ${tokensPerSec} tok/s, TTFT: ${ttftMs}ms)`
        );

        return {
            ttftMs,
            generationDurationMs: totalDurationMs,
            promptTokens,
            completionTokens,
            tokensPerSec,
            vramUsedMb,
            fullText,
            emittedToolCall: this.isToolCallOutput(fullText),
        };
    }
}
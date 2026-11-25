import crypto from 'node:crypto';
import type { ClusterNodeState } from './ClusterStateService.js';
import { OllamaBridge } from '../mcp/OllamaBridge.js';
import type {
    OpenAIChatRequest,
    OpenAIStreamChunk,
    OpenAIStreamDelta,
    OpenAIToolCall,
    OpenAIUsage,
} from '../mcp/OllamaBridge.js';

export class MobileWorkerError extends Error {
    public readonly code: string;

    constructor(message: string, code: string = 'INTERNAL') {
        super(message);
        this.name = 'MobileWorkerError';
        this.code = code;
    }
}

export interface MobileWorkerExecutionResult {
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
}

export class MobileWorkerAdapter {
    public static async execute(params: {
        node: ClusterNodeState;
        resolvedModel: string;
        request: OpenAIChatRequest;
        traceContext: Record<string, unknown>;
        signal?: AbortSignal;
        onStatus?: (status: { type: string; message: string; from?: string; to?: string }) => void;
        onStreamChunk?: (chunk: OpenAIStreamChunk) => void;
    }): Promise<MobileWorkerExecutionResult> {
        const { node, resolvedModel: requestedTargetModel, request, traceContext, signal, onStatus, onStreamChunk } = params;
        const completionId = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`;
        const created = Math.floor(Date.now() / 1000);
        const resolvedModel = requestedTargetModel || node.activeModel || 'mobile-gguf';

        const url = `${node.endpointUrl.replace(/\/$/, '')}/v1/edge/chat`;
        const startTimeMs = Date.now();

        const payload = {
            model: resolvedModel,
            messages: request.messages,
            tools: request.tools,
            tool_choice: request.tool_choice,
            response_format: request.response_format,
            temperature: request.temperature ?? 0.2,
            max_tokens: request.max_completion_tokens ?? request.max_tokens ?? 1024,
            trace_context: traceContext,
        };

        // Pre-stream connection timeout (10s) merged with caller AbortSignal
        const connectController = new AbortController();
        let connected = false;
        const connectTimer = setTimeout(() => {
            if (!connected) {
                connectController.abort(new MobileWorkerError('Mobile worker connection timeout', 'TIMEOUT'));
            }
        }, 10000);

        const onExternalAbort = () => connectController.abort(signal?.reason);
        if (signal) {
            if (signal.aborted) {
                clearTimeout(connectTimer);
                throw new MobileWorkerError('Caller aborted request', 'ABORTED');
            }
            signal.addEventListener('abort', onExternalAbort, { once: true });
        }

        let res: globalThis.Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: connectController.signal,
            });
            connected = true;
            clearTimeout(connectTimer);
        } catch (err: unknown) {
            clearTimeout(connectTimer);
            signal?.removeEventListener('abort', onExternalAbort);
            if (err instanceof MobileWorkerError) throw err;
            const msg = err instanceof Error ? err.message : String(err);
            throw new MobileWorkerError(`Cannot reach mobile worker at ${url}: ${msg}`, 'UNREACHABLE');
        }

        if (!res.ok) {
            signal?.removeEventListener('abort', onExternalAbort);
            const errBody = await res.text().catch(() => '');
            throw new MobileWorkerError(
                `Mobile worker returned HTTP ${res.status}: ${errBody || res.statusText}`,
                res.status === 503 ? 'BUSY' : 'HTTP_ERROR'
            );
        }

        if (!res.body) {
            signal?.removeEventListener('abort', onExternalAbort);
            throw new MobileWorkerError('Mobile worker returned an empty stream', 'EMPTY_BODY');
        }

        let sentRoleHeader = false;
        let firstTokenMs = 0;
        let fullText = '';
        let reasoningText = '';
        let toolCallIndex = 0;
        const emittedToolCalls: OpenAIToolCall[] = [];

        let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop';
        let usage: OpenAIUsage = {
            prompt_tokens: Math.ceil(JSON.stringify(request.messages).length / 3.8),
            completion_tokens: 0,
            total_tokens: 0,
        };
        let workerTtftMs = 0;
        let workerTokPerSec = 0;

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
        let currentEvent = 'message';

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? '';

                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (!line) {
                        currentEvent = 'message';
                        continue;
                    }

                    if (line.startsWith('event:')) {
                        currentEvent = line.slice(6).trim();
                        continue;
                    }

                    if (!line.startsWith('data:')) continue;
                    const dataStr = line.slice(5).trim();
                    if (!dataStr || dataStr === '[DONE]') continue;

                    let parsed: Record<string, unknown>;
                    try {
                        parsed = JSON.parse(dataStr) as Record<string, unknown>;
                    } catch {
                        continue;
                    }

                    if (currentEvent === 'status') {
                        const msg = String(parsed.message || 'Mobile worker status update');
                        console.log(`[MobileWorkerAdapter] 🔄 ${node.nodeName}: ${msg}`);
                        onStatus?.({
                            type: String(parsed.type || 'status'),
                            message: msg,
                            ...(typeof parsed.from === 'string' ? { from: parsed.from } : {}),
                            ...(typeof parsed.to === 'string' ? { to: parsed.to } : {}),
                        });
                        continue;
                    }

                    if (currentEvent === 'error' || typeof parsed.error === 'string') {
                        const errMsg = String(parsed.message || parsed.error || 'Mobile worker error');
                        const errCode = String(parsed.code || 'INTERNAL');
                        throw new MobileWorkerError(errMsg, errCode);
                    }

                    if (currentEvent === 'delta' || typeof parsed.content === 'string' || typeof parsed.reasoning_content === 'string' || typeof parsed.token === 'string') {
                        if (firstTokenMs === 0) {
                            firstTokenMs = Date.now() - startTimeMs;
                        }
                        const contentPart =
                            typeof parsed.content === 'string'
                                ? parsed.content
                                : typeof parsed.token === 'string'
                                    ? parsed.token
                                    : '';
                        const reasoningPart =
                            typeof parsed.reasoning_content === 'string' ? parsed.reasoning_content : '';

                        const delta: OpenAIStreamDelta = {};
                        if (contentPart) {
                            fullText += contentPart;
                            delta.content = contentPart;
                        }
                        if (reasoningPart) {
                            reasoningText += reasoningPart;
                            delta.reasoning_content = reasoningPart;
                        }
                        if (delta.content || delta.reasoning_content) {
                            emitDelta(delta);
                        }
                        continue;
                    }

                    if (currentEvent === 'tool_calls' && Array.isArray(parsed.tool_calls)) {
                        if (firstTokenMs === 0) {
                            firstTokenMs = Date.now() - startTimeMs;
                        }

                        const normalizedDeltaCalls: NonNullable<OpenAIStreamDelta['tool_calls']> = [];
                        for (const rawItem of parsed.tool_calls as Array<{
                            id?: string;
                            function?: { name?: string; arguments?: unknown };
                        }>) {
                            const callId = rawItem.id || OllamaBridge.generateToolCallId();
                            const fnName = rawItem.function?.name || 'unknown_tool';
                            const rawArgs = rawItem.function?.arguments;
                            const serializedArgs =
                                typeof rawArgs === 'string'
                                    ? rawArgs
                                    : JSON.stringify(rawArgs ?? {});
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

                        if (normalizedDeltaCalls.length > 0) {
                            emitDelta({ tool_calls: normalizedDeltaCalls });
                        }
                        continue;
                    }

                    if (currentEvent === 'done') {
                        const rawFinish = parsed.finish_reason;
                        if (rawFinish === 'tool_calls' || rawFinish === 'length' || rawFinish === 'stop') {
                            finishReason = rawFinish;
                        }
                        const rawUsage = parsed.usage as Partial<OpenAIUsage> | undefined;
                        if (rawUsage) {
                            const pTok = rawUsage.prompt_tokens ?? usage.prompt_tokens;
                            const cTok = rawUsage.completion_tokens ?? Math.ceil(fullText.length / 4);
                            usage = {
                                prompt_tokens: pTok,
                                completion_tokens: cTok,
                                total_tokens: rawUsage.total_tokens ?? pTok + cTok,
                            };
                        }
                        const rawMetrics = parsed.metrics as
                            | { ttft_ms?: number; tok_per_sec?: number }
                            | undefined;
                        if (rawMetrics?.ttft_ms) workerTtftMs = rawMetrics.ttft_ms;
                        if (rawMetrics?.tok_per_sec) workerTokPerSec = rawMetrics.tok_per_sec;
                    }
                }
            }
        } finally {
            signal?.removeEventListener('abort', onExternalAbort);
        }

        const totalDurationMs = Math.max(1, Date.now() - startTimeMs);
        if (emittedToolCalls.length > 0) {
            finishReason = 'tool_calls';
        }
        if (usage.completion_tokens === 0 && fullText.length > 0) {
            usage.completion_tokens = Math.max(1, Math.ceil(fullText.length / 4));
            usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
        }

        const effectiveTtft = workerTtftMs || firstTokenMs || Math.min(totalDurationMs, 150);
        const effectiveTokPerSec =
            workerTokPerSec ||
            parseFloat((usage.completion_tokens / (totalDurationMs / 1000)).toFixed(1));

        // Emit terminal OpenAI finish chunk (and optional usage chunk)
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

        return {
            completionId,
            model: resolvedModel,
            fullText,
            reasoningText,
            toolCalls: emittedToolCalls,
            finishReason,
            usage,
            ttftMs: effectiveTtft,
            generationDurationMs: totalDurationMs,
            tokensPerSec: effectiveTokPerSec,
        };
    }
}
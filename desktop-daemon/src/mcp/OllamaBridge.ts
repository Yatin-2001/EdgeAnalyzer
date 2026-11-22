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

export class OllamaBridge {
    private static instance: OllamaBridge;
    private baseUrl = 'http://127.0.0.1:11434';

    private constructor() {}

    public static getInstance(): OllamaBridge {
        if (!OllamaBridge.instance) {
            OllamaBridge.instance = new OllamaBridge();
        }
        return OllamaBridge.instance;
    }

    public async listModels(): Promise<OllamaModelTag[]> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tags`);
            if (!res.ok) return [];
            const data = await res.json();
            return data.models || [];
        } catch {
            return [];
        }
    }

    public async getTelemetry(): Promise<{ vramUsageBytes: number; activeModel: string | null }> {
        try {
            const res = await fetch(`${this.baseUrl}/api/ps`);
            if (!res.ok) return { vramUsageBytes: 0, activeModel: null };
            const data = await res.json();
            const first = data.models?.[0];
            return {
                vramUsageBytes: first?.size_vram || 0,
                activeModel: first?.name || null,
            };
        } catch {
            return { vramUsageBytes: 0, activeModel: null };
        }
    }

    public unpackTemplatedPrompt(rawPrompt: string): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];

        if (rawPrompt.includes('<|start_header_id|>')) {
            const regex = /<\|start_header_id\|>(system|user|assistant|tool)<\|end_header_id\|>([\s\S]*?)(?=<\|start_header_id\|>|<\|eot_id\|>|\$)/g;
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
            const regex = /<\|im_start\|>(system|user|assistant|tool)\n?([\s\S]*?)(?=<\|im_start\|>|<\|im_end\|>|\$)/g;
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

        console.log(`[OllamaBridge] 🚀 Dispatching prompt to model "${model}" (${normalizedMessages.length} messages) via /api/chat`);

        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: options.signal,
            body: JSON.stringify({
                model,
                messages: normalizedMessages,
                stream: true,
                options: {
                    temperature: 0.2,
                    num_predict: options.nPredict || 512,
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
        });

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
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const parsed = JSON.parse(line);
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
                        promptEvalCount = parsed.prompt_eval_count || 0;
                        evalCount = parsed.eval_count || streamedTokens;
                        evalDurationNs = parsed.eval_duration || 0;
                        promptEvalDurationNs = parsed.prompt_eval_duration || 0;
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
            Math.ceil(normalizedMessages.reduce((acc, m) => acc + (m.content?.length || 0), 0) / 4);

        const tokensPerSec =
            evalDurationNs > 0
                ? parseFloat((completionTokens / (evalDurationNs / 1e9)).toFixed(1))
                : parseFloat((completionTokens / (totalDurationMs / 1000)).toFixed(1));

        let vramUsedMb = 0;
        try {
            const gpuStats = await SystemTelemetry.getInstance().getGpuStats();
            vramUsedMb = gpuStats.vramUsedMB || 0;
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
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

    public async listModels(): Promise<OllamaModelInfo[]> {
        try {
            const res = await fetch(`${this.baseUrl}/api/tags`);
            if (!res.ok) throw new Error(`Ollama responded with status: ${res.status}`);
            const data = await res.json();
            return data.models || [];
        } catch (err) {
            console.warn('[OllamaBridge] listModels failed:', err);
            return [];
        }
    }

    /**
     * Unpacks pre-templated prompt strings (Llama-3 or ChatML) into standard structured
     * messages so Ollama's /api/chat can apply the target model's native template.
     */
    private unpackTemplatedPrompt(rawPrompt: string): Array<{ role: string; content: string }> {
        const messages: Array<{ role: string; content: string }> = [];

        if (rawPrompt.includes('<|start_header_id|>')) {
            // Llama-3 delimiter format
            const regex = /<\|start_header_id\|>(system|user|assistant|tool)<\|end_header_id\|>([\s\S]*?)(?=<\|start_header_id\|>|<\|eot_id\|>|$)/g;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(rawPrompt)) !== null) {
                const rawRole = match[1];
                const rawContent = match[2];
                if (!rawRole || rawContent === undefined) continue;

                const content = rawContent.replace(/<\|eot_id\|>/g, '').trim();
                if (content.length > 0) {
                    messages.push({
                        role: rawRole === 'tool' ? 'user' : rawRole,
                        content,
                    });
                }
            }
        } else if (rawPrompt.includes('<|im_start|>')) {
            // ChatML delimiter format
            const regex = /<\|im_start\|>(system|user|assistant|tool)\n?([\s\S]*?)(?=<\|im_start\|>|<\|im_end\|>|$)/g;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(rawPrompt)) !== null) {
                const rawRole = match[1];
                const rawContent = match[2];
                if (!rawRole || rawContent === undefined) continue;

                const content = rawContent.replace(/<\|im_end\|>/g, '').trim();
                if (content.length > 0) {
                    messages.push({
                        role: rawRole === 'tool' ? 'user' : rawRole,
                        content,
                    });
                }
            }
        }

        // Fallback: If no markers found, treat entire string as single user message
        if (messages.length === 0 && rawPrompt.trim().length > 0) {
            messages.push({ role: 'user', content: rawPrompt.trim() });
        }

        return messages;
    }

    public async streamChat(
        model: string,
        messages: Array<{ role: string; content: string; images?: string[] }>,
        onChunk: (text: string) => void
    ): Promise<void> {
        let normalizedMessages = messages;

        // If client wrapped a pre-templated string into a single user message, unpack it
        if (messages.length === 1 && messages[0]?.content) {
            const rawContent = messages[0].content;
            if (rawContent.includes('<|start_header_id|>') || rawContent.includes('<|im_start|>')) {
                normalizedMessages = this.unpackTemplatedPrompt(rawContent);
                console.log(
                    `[OllamaBridge] 🔄 Unpacked ${rawContent.length} raw chars into ${normalizedMessages.length} structured chat message(s) for "${model}"`
                );
            }
        }

        console.log(`[OllamaBridge] 🚀 Dispatching prompt to model "${model}" (${normalizedMessages.length} messages) via /api/chat`);

        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages: normalizedMessages,
                stream: true,
                options: {
                    // Universal stop tokens to prevent runaway streams on any model
                    stop: [
                        '<|eot_id|>',
                        '<|end_of_text|>',
                        '<|end|>',
                        '<|im_end|>',
                        '</s>',
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
        let tokenCount = 0;

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
                        tokenCount++;
                        onChunk(parsed.message.content);
                    }
                } catch {
                    // Ignore partial JSON fragments
                }
            }
        }

        console.log(`[OllamaBridge] ✅ Completed generation (${tokenCount} tokens streamed)`);
    }

    public async getTelemetry(): Promise<{ vramUsageBytes: number; activeModel: string | null }> {
        try {
            const res = await fetch(`${this.baseUrl}/api/ps`);
            if (res.ok) {
                const data = await res.json();
                const active = data.models?.[0];
                return {
                    vramUsageBytes: active?.size_vram || 0,
                    activeModel: active?.name || null,
                };
            }
        } catch {}
        return { vramUsageBytes: 0, activeModel: null };
    }
}
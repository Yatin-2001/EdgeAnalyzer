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

    public async streamChat(
        model: string,
        messages: Array<{ role: string; content: string; images?: string[] }>,
        onChunk: (text: string) => void
    ): Promise<void> {
        console.log(`[OllamaBridge] 🚀 Dispatching prompt to model "${model}" (${messages.length} messages)`);

        const res = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                messages,
                stream: true,
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
                    // ignore partial fragments
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
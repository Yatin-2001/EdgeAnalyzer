import { LLMService, PerformanceMetrics, StreamCallbacks } from './LLMService';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolCallPayload, ToolResult } from '../tools/types';
import { MeshClientService } from './MeshClientService';

export interface OrchestrationCallbacks extends StreamCallbacks {
    onToolCallDetected?: (toolName: string, params: any, step: number) => void;
    onToolExecutionCompleted?: (toolName: string, result: ToolResult, step: number) => void;
}

export class ToolOrchestrator {
    private static instance: ToolOrchestrator;
    private registry = ToolRegistry.getInstance();
    private llm = LLMService.getInstance();
    private mesh = MeshClientService.getInstance();
    private static readonly MAX_TOOL_STEPS = 3;

    private constructor() {}

    public static getInstance(): ToolOrchestrator {
        if (!ToolOrchestrator.instance) {
            ToolOrchestrator.instance = new ToolOrchestrator();
        }
        return ToolOrchestrator.instance;
    }

    private formatToolSignatures(): string {
        return this.registry
            .getAllDefinitions()
            .map((t) => {
                const params = Object.entries(t.parameters.properties)
                    .map(([k, v]) => `${k}: ${v.type}`)
                    .join(', ');
                return `- ${t.name}(${params}): ${t.description}`;
            })
            .join('\n');
    }

    private static readonly TEMPORAL_KEYWORDS_REGEX =
        /\b(today|now|currently|current|yesterday|tomorrow|latest|recent|recently|this (week|month|year)|tonight|exchange rate|price|weather)\b/i;

    public formatSystemPromptWithTools(baseSystemPrompt: string, userPrompt?: string): string {
        const signatures = this.formatToolSignatures();

        let temporalContext = '';
        if (userPrompt && ToolOrchestrator.TEMPORAL_KEYWORDS_REGEX.test(userPrompt)) {
            const today = new Date().toISOString().split('T')[0];
            temporalContext = `### TEMPORAL ANCHOR:\nRelative reference date: ${today}\n\n`;
        }

        return (
            `${baseSystemPrompt}\n\n` +
            temporalContext +
            `### AVAILABLE TOOLS:\n${signatures}\n\n` +
            `### RULES FOR TOOL USE:\n` +
            `1. You can ONLY use the tools listed above. NEVER invent new tool names.\n` +
            `2. For current facts, YouTube channels, links, video info, currency rates, or search, use: web_search\n` +
            `3. For ANY math, arithmetic, or computation, you MUST call: calculator\n` +
            `4. For device coordinates (e.g. "where am I"), use: device_location\n` +
            `5. For ANY weather query, you MUST call: weather\n` +
            `6. Output ONLY a raw JSON call when invoking a tool:\n` +
            `{"tool": "<tool_name>", "parameters": {<key>: <value>}}\n\n` +
            `### EXAMPLES:\n` +
            `User: What is 1/0.01034?\n` +
            `Assistant: {"tool": "calculator", "parameters": {"expression": "1/0.01034"}}\n\n` +
            `User: Who made this video?\n` +
            `Assistant: {"tool": "web_search", "parameters": {"query": "video title from image"}}\n\n` +
            `When tool output is provided, synthesize your response directly in plain language without further JSON.`
        );
    }

    /**
     * Unified generation dispatcher: routes to local Snapdragon (JNI)
     * or remote compute node (OnePlus 15 / Desktop Ollama) over Wi-Fi.
     */
    private async dispatchGeneration(
        prompt: string,
        onToken?: (tok: string) => void,
        options: { maxTokens?: number; imagePaths?: string[] } = {}
    ): Promise<{ text: string; tokenCount: number; durationSec: number }> {
        const target = this.mesh.getSelectedTarget();
        const isRemote = target.nodeId !== 'local_engine';

        const startTime = Date.now();
        let fullText = '';
        let tokenCount = 0;

        if (isRemote) {
            await this.mesh.streamChat([{ role: 'user', content: prompt }], (tok) => {
                fullText += tok;
                tokenCount++;
                onToken?.(tok);
            });
        } else {
            if (options.imagePaths && options.imagePaths.length > 0) {
                const res = await this.llm.streamCompletion(
                    {
                        prompt,
                        imagePaths: options.imagePaths,
                        nPredict: options.maxTokens || 220,
                        temperature: 0.1,
                    },
                    { onToken: (tok) => onToken?.(tok) }
                );
                fullText = res.fullText;
                tokenCount = res.metrics.totalTokens;
            } else if (onToken) {
                const res = await this.llm.streamCompletion(
                    { prompt, nPredict: options.maxTokens },
                    { onToken: (tok) => onToken(tok) }
                );
                fullText = res.fullText;
                tokenCount = res.metrics.totalTokens;
            } else {
                fullText = await this.llm.completeNonStreaming(prompt, options.maxTokens || 160);
                tokenCount = Math.ceil(fullText.length / 4);
            }
        }

        const durationSec = Math.max((Date.now() - startTime) / 1000, 0.05);
        return { text: fullText, tokenCount, durationSec };
    }

    public async executeAgentLoop(
        initialPrompt: string,
        rawUserQuery: string,
        callbacks: OrchestrationCallbacks,
        options: { imagePaths?: string[] } = {}
    ): Promise<{ fullText: string; metrics: PerformanceMetrics }> {
        let currentPrompt = initialPrompt;
        let cumulativeTokens = 0;
        let cumulativeTimeSec = 0;
        let initialTtftMs = 0;
        let stepCount = 0;

        const executedCalls = new Set<string>();

        while (stepCount < ToolOrchestrator.MAX_TOOL_STEPS) {
            stepCount++;

            const isFirstTurnWithImage = stepCount === 1 && !!options.imagePaths && options.imagePaths.length > 0;

            // If a tool was already executed in a previous step, synthesize directly to the user
            if (stepCount > 1) {
                const finalGen = await this.dispatchGeneration(
                    currentPrompt,
                    (tok) => callbacks.onToken(tok),
                    {
                        imagePaths: isFirstTurnWithImage ? options.imagePaths : undefined,
                    }
                );

                cumulativeTokens += finalGen.tokenCount;
                cumulativeTimeSec += finalGen.durationSec;

                const aggregateMetrics: PerformanceMetrics = {
                    ttftMs: initialTtftMs || 45,
                    totalTokens: cumulativeTokens,
                    generationTimeSec: parseFloat(cumulativeTimeSec.toFixed(2)),
                    tokensPerSecond:
                        cumulativeTimeSec > 0
                            ? parseFloat((cumulativeTokens / cumulativeTimeSec).toFixed(1))
                            : 0,
                };

                callbacks.onMetrics?.(aggregateMetrics);
                return {
                    fullText: finalGen.text,
                    metrics: aggregateMetrics,
                };
            }

            // Step 1: Query the model silently to detect if a tool is required
            const stepGen = await this.dispatchGeneration(
                currentPrompt,
                undefined,
                {
                    maxTokens: 160,
                    imagePaths: isFirstTurnWithImage ? options.imagePaths : undefined,
                }
            );

            cumulativeTokens += stepGen.tokenCount;
            cumulativeTimeSec += stepGen.durationSec;
            if (initialTtftMs === 0) initialTtftMs = 45;

            const stepOutput = stepGen.text;
            let toolCall = this.parseAndNormalizeToolCall(stepOutput);

            if (!toolCall && stepCount === 1 && rawUserQuery) {
                toolCall = this.detectFallbackIntent(rawUserQuery);
            }

            const callSignature = toolCall
                ? `${toolCall.tool}:${JSON.stringify(toolCall.parameters)}`
                : '';

            // If no tool is required, stream the direct response
            if (!toolCall || executedCalls.has(callSignature)) {
                const finalGen = await this.dispatchGeneration(
                    currentPrompt,
                    (tok) => callbacks.onToken(tok),
                    {
                        imagePaths: isFirstTurnWithImage ? options.imagePaths : undefined,
                    }
                );

                cumulativeTokens += finalGen.tokenCount;
                cumulativeTimeSec += finalGen.durationSec;

                const aggregateMetrics: PerformanceMetrics = {
                    ttftMs: initialTtftMs || 45,
                    totalTokens: cumulativeTokens,
                    generationTimeSec: parseFloat(cumulativeTimeSec.toFixed(2)),
                    tokensPerSecond:
                        cumulativeTimeSec > 0
                            ? parseFloat((cumulativeTokens / cumulativeTimeSec).toFixed(1))
                            : 0,
                };

                callbacks.onMetrics?.(aggregateMetrics);
                return {
                    fullText: finalGen.text,
                    metrics: aggregateMetrics,
                };
            }

            // Tool call identified: Execute locally on this device
            executedCalls.add(callSignature);
            callbacks.onToolCallDetected?.(toolCall.tool, toolCall.parameters, stepCount);

            const executor = this.registry.get(toolCall.tool);
            let toolResult: ToolResult;

            if (!executor) {
                toolResult = {
                    success: false,
                    error: `Tool "${toolCall.tool}" is not available.`,
                    executionTimeMs: 0,
                };
            } else {
                toolResult = await executor.execute(toolCall.parameters || {});
            }

            callbacks.onToolExecutionCompleted?.(toolCall.tool, toolResult, stepCount);

            const rawDataString = JSON.stringify(toolResult.data || { error: toolResult.error });
            const clampedData =
                rawDataString.length > 900
                    ? `${rawDataString.substring(0, 900)}...}`
                    : rawDataString;

            const isChatML = currentPrompt.includes('<|im_start|>');

            if (isChatML) {
                currentPrompt +=
                    `<|im_start|>assistant\n` +
                    `{"tool": "${toolCall.tool}", "parameters": ${JSON.stringify(toolCall.parameters || {})}}<|im_end|>\n` +
                    `<|im_start|>tool\n` +
                    `[Tool Output]:\n${clampedData}\n\nInstruction: Synthesize the final answer in natural language based on the data above.<|im_end|>\n` +
                    `<|im_start|>assistant\n`;
            } else {
                currentPrompt +=
                    `<|start_header_id|>assistant<|end_header_id|>\n\n` +
                    `{"tool": "${toolCall.tool}", "parameters": ${JSON.stringify(toolCall.parameters || {})}}<|eot_id|>` +
                    `<|start_header_id|>tool<|end_header_id|>\n\n` +
                    `[Tool Output]:\n${clampedData}\n\nInstruction: Synthesize the final answer in natural language based on the data above.<|eot_id|>` +
                    `<|start_header_id|>assistant<|end_header_id|>\n\n`;
            }
        }

        const finalFallback = await this.dispatchGeneration(currentPrompt, (tok) => callbacks.onToken(tok));
        return {
            fullText: finalFallback.text,
            metrics: {
                ttftMs: initialTtftMs || 45,
                totalTokens: cumulativeTokens + finalFallback.tokenCount,
                generationTimeSec: parseFloat((cumulativeTimeSec + finalFallback.durationSec).toFixed(2)),
                tokensPerSecond: parseFloat(
                    ((cumulativeTokens + finalFallback.tokenCount) / (cumulativeTimeSec + finalFallback.durationSec)).toFixed(1)
                ),
            },
        };
    }

    private detectFallbackIntent(query: string): ToolCallPayload | null {
        const q = query.toLowerCase().trim();

        if (mathRegex.test(q)) {
            const match = q.match(/([\d\.]+\s*[\+\-\*\/\^%]\s*[\d\.\+\-\*\/\^%\s\(\)]+)/);
            if (match && match[1]) {
                return { tool: 'calculator', parameters: { expression: match[1].trim() } };
            }
        }
        if (/\b(calculate|compute|solve|math)\b/i.test(q)) {
            const expr = q.replace(/calculate|compute|solve|math|what is|how much is/gi, '').trim();
            if (expr.length > 0) {
                return { tool: 'calculator', parameters: { expression: expr } };
            }
        }

        if (/\b(where am i|my location|my coordinates|what city am i in|current location)\b/i.test(q)) {
            return { tool: 'device_location', parameters: {} };
        }

        if (/\b(weather|temperature|temp|forecast|rain|cloudy|sunny)\b/i.test(q)) {
            if (/\b(here|my location|current|me)\b/i.test(q)) {
                return { tool: 'weather', parameters: { location: 'current_location' } };
            }
            const cityMatch = q
                .replace(/weather|temperature|temp|forecast|in|for|today|is|what|how|the/gi, '')
                .trim();
            return { tool: 'weather', parameters: { location: cityMatch || 'current_location' } };
        }

        if (/\b(search|who is|who made|video link|channel|youtube|price of|buy|news|exchange rate|dollar to inr|usd to inr)\b/i.test(q)) {
            return { tool: 'web_search', parameters: { query } };
        }

        return null;
    }

    private parseAndNormalizeToolCall(output: string): ToolCallPayload | null {
        if (!output || typeof output !== 'string') return null;

        const objects = this.extractAllJsonObjects(output);
        for (const obj of objects) {
            if (typeof obj !== 'object' || obj === null) continue;

            let rawName = (obj.tool || obj.name || '').trim().toLowerCase();
            let rawParams = typeof obj.parameters === 'object' && obj.parameters !== null ? obj.parameters : {};

            if (!rawName) continue;

            if (rawName.includes('calc') || rawName.includes('math')) {
                rawName = 'calculator';
                if (!rawParams.expression) {
                    rawParams = {
                        expression:
                            rawParams.num ||
                            rawParams.expr ||
                            rawParams.formula ||
                            rawParams.query ||
                            rawParams.math ||
                            String(Object.values(rawParams)[0] || ''),
                    };
                }
            } else if (
                rawName === 'exchange_rate' ||
                rawName === 'search' ||
                rawName === 'google' ||
                rawName === 'youtube' ||
                rawName === 'finance'
            ) {
                rawName = 'web_search';
                if (!rawParams.query) {
                    rawParams = { query: rawParams.reason || rawParams.expression || rawParams.channel || 'information' };
                }
            } else if (rawName.includes('locat') || rawName.includes('gps')) {
                rawName = 'device_location';
            } else if (rawName.includes('weather') || rawName.includes('temp')) {
                rawName = 'weather';
                if (!rawParams.location) {
                    rawParams = {
                        location: rawParams.city || rawParams.place || rawParams.query || 'current_location',
                    };
                }
            }

            if (this.registry.get(rawName)) {
                return {
                    tool: rawName,
                    parameters: rawParams,
                };
            }
        }

        return null;
    }

    private extractAllJsonObjects(text: string): any[] {
        const results: any[] = [];
        let depth = 0;
        let inString = false;
        let escape = false;
        let startIndex = -1;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (escape) {
                escape = false;
                continue;
            }
            if (char === '\\') {
                escape = true;
                continue;
            }
            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (!inString) {
                if (char === '{') {
                    if (depth === 0) startIndex = i;
                    depth++;
                } else if (char === '}') {
                    depth--;
                    if (depth === 0 && startIndex !== -1) {
                        const rawJson = text.substring(startIndex, i + 1);
                        try {
                            const cleaned = rawJson
                                .replace(/\/\/.*\$/gm, '')
                                .replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/,(\s*[}\]])/g, '\$1')
                                .trim();

                            const parsed = JSON.parse(cleaned);
                            results.push(parsed);
                        } catch {}
                        startIndex = -1;
                    }
                }
            }
        }

        return results;
    }
}

const mathRegex = /([\d\.]+\s*[\+\-\*\/\^%]\s*[\d\.\+\-\*\/\^%\s\(\)]+)/;
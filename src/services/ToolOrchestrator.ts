import { LLMService, PerformanceMetrics, StreamCallbacks } from './LLMService';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolCallPayload, ToolResult } from '../tools/types';

export interface OrchestrationCallbacks extends StreamCallbacks {
    onToolCallDetected?: (toolName: string, params: any, step: number) => void;
    onToolExecutionCompleted?: (toolName: string, result: ToolResult, step: number) => void;
}

export class ToolOrchestrator {
    private static instance: ToolOrchestrator;
    private registry = ToolRegistry.getInstance();
    private llm = LLMService.getInstance();
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
            `2. For current facts, currency rates, news, or general search, use: web_search\n` +
            `1. For ANY math, division, multiplication, or arithmetic (e.g. "1/0.01034", "15 * 89"), you MUST call: calculator\n` +
            `4. For device coordinates(e.g. "where am I"), use: device_location\n` +
            `5. For ANY weather/temperature query (e.g. "weather in Delhi" or "weather here"), you MUST call: weather\n` +
            `6. You have live GPS and real-time APIs. NEVER guess or hallucinate weather, location, or facts.\n` +
            `7. Output ONLY a raw JSON call and nothing else when invoking a tool:\n` +
            `{"tool": "<tool_name>", "parameters": {<key>: <value>}}\n\n` +
            `### EXAMPLES:\n` +
            `User: What is 1/0.01034?\n` +
            `Assistant: {"tool": "calculator", "parameters": {"expression": "1/0.01034"}}\n\n` +
            `User: Weather in Delhi\n` +
            `Assistant: {"tool": "weather", "parameters": {"location": "Delhi"}}\n\n` +
            `User: Where am I currently?\n` +
            `Assistant: {"tool": "device_location", "parameters": {}}\n\n` +
            `When tool output is provided, synthesize your response directly in plain language without further JSON.`
        );
    }

    public async executeAgentLoop(
        initialPrompt: string,
        rawUserQuery: string,
        callbacks: OrchestrationCallbacks
    ): Promise<{ fullText: string; metrics: PerformanceMetrics }> {
        let currentPrompt = initialPrompt;
        let cumulativeTokens = 0;
        let cumulativeTimeSec = 0;
        let initialTtftMs = 0;
        let stepCount = 0;

        const executedCalls = new Set<string>();

        while (stepCount < ToolOrchestrator.MAX_TOOL_STEPS) {
            stepCount++;

            const stepOutput = await this.llm.completeNonStreaming(currentPrompt, 160);
            let toolCall = this.parseAndNormalizeToolCall(stepOutput);

            // Intent-Gating Fallback: Catch 1B hallucinations on step 1
            if (!toolCall && stepCount === 1 && rawUserQuery) {
                toolCall = this.detectFallbackIntent(rawUserQuery);
            }

            const callSignature = toolCall
                ? `${toolCall.tool}:${JSON.stringify(toolCall.parameters)}`
                : '';

            if (!toolCall || executedCalls.has(callSignature)) {
                const finalStream = await this.llm.streamCompletion(currentPrompt, {
                    onToken: (token) => callbacks.onToken(token),
                    onMetrics: (metrics) => {
                        if (initialTtftMs === 0) initialTtftMs = metrics.ttftMs;
                        cumulativeTokens += metrics.totalTokens;
                        cumulativeTimeSec += metrics.generationTimeSec;
                    },
                });

                const totalTps =
                    cumulativeTimeSec > 0
                        ? parseFloat((cumulativeTokens / cumulativeTimeSec).toFixed(2))
                        : finalStream.metrics.tokensPerSecond;

                const aggregateMetrics: PerformanceMetrics = {
                    ttftMs: initialTtftMs || finalStream.metrics.ttftMs,
                    totalTokens: cumulativeTokens + finalStream.metrics.totalTokens,
                    generationTimeSec: parseFloat(
                        (cumulativeTimeSec + finalStream.metrics.generationTimeSec).toFixed(2)
                    ),
                    tokensPerSecond: totalTps,
                };

                callbacks.onMetrics?.(aggregateMetrics);
                return {
                    fullText: finalStream.fullText,
                    metrics: aggregateMetrics,
                };
            }

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

            currentPrompt +=
                `<|start_header_id|>assistant<|end_header_id|>\n\n` +
                `{"tool": "${toolCall.tool}", "parameters": ${JSON.stringify(toolCall.parameters || {})}}<|eot_id|>` +
                `<|start_header_id|>tool<|end_header_id|>\n\n` +
                `[Tool Output]:\n${clampedData}\n\nInstruction: Synthesize the final answer in natural language based on the data above.<|eot_id|>` +
                `<|start_header_id|>assistant<|end_header_id|>\n\n`;
        }

        return this.llm.streamCompletion(currentPrompt, callbacks);
    }

    private detectFallbackIntent(query: string): ToolCallPayload | null {
        const q = query.toLowerCase().trim();

        // 1. Math / Calculations (e.g. "1/0.01034", "what is 45 * 12", "calculate 2^8")
        const mathMatch = q.match(/([\d\.]+\s*[\+\-\*\/\^%]\s*[\d\.\+\-\*\/\^%\s\(\)]+)/);
        if (mathMatch && mathMatch[1] && /[\+\-\*\/\^%]/.test(mathMatch[1])) {
            const expr = mathMatch[1].trim();
            return { tool: 'calculator', parameters: { expression: expr } };
        }
        if (/\b(calculate|compute|solve|math)\b/i.test(q)) {
            const expr = q.replace(/calculate|compute|solve|math|what is|how much is/gi, '').trim();
            if (expr.length > 0) {
                return { tool: 'calculator', parameters: { expression: expr } };
            }
        }

        // 2. Where am I / Location
        if (/\b(where am i|my location|my coordinates|what city am i in|current location)\b/i.test(q)) {
            return { tool: 'device_location', parameters: {} };
        }

        // 3. Weather & Temperature
        if (/\b(weather|temperature|temp|forecast|rain|cloudy|sunny)\b/i.test(q)) {
            if (/\b(here|my location|current|me)\b/i.test(q)) {
                return { tool: 'weather', parameters: { location: 'current_location' } };
            }
            const cityMatch = q
                .replace(/weather|temperature|temp|forecast|in|for|today|is|what|how|the/gi, '')
                .trim();
            return { tool: 'weather', parameters: { location: cityMatch || 'current_location' } };
        }

        // 4. Exchange rates & currency
        if (/\b(exchange rate|dollar to inr|usd to inr|price of dollar|bitcoin price|gold rate)\b/i.test(q)) {
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

            // Calculator normalization
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
                rawName === 'finance'
            ) {
                rawName = 'web_search';
                if (!rawParams.query) {
                    rawParams = { query: rawParams.reason || rawParams.expression || 'USD to INR exchange rate' };
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
                                .replace(/\/\/.*$/gm, '')
                                .replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/,(\s*[}\]])/g, '$1')
                                .trim();

                            const parsed = JSON.parse(cleaned);
                            results.push(parsed);
                        } catch {
                            // Ignore malformed JSON chunks
                        }
                        startIndex = -1;
                    }
                }
            }
        }

        return results;
    }
}
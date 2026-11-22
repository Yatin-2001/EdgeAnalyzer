import { LLMService, PerformanceMetrics, StreamCallbacks } from './LLMService';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ToolCallPayload, ToolResult } from '../tools/types';
import { MeshClientService } from './MeshClientService';
import { TelemetryService, TraceContext } from './TelemetryService';

export interface OrchestrationCallbacks extends StreamCallbacks {
    onToolCallDetected?: (toolName: string, params: any, step: number) => void;
    onToolExecutionCompleted?: (toolName: string, result: ToolResult, step: number) => void;
    onQueueStatusChange?: (statusText: string) => void;
}

export interface AgentLoopOptions {
    imagePaths?: string[];
    sessionId?: string;
    traceContext?: TraceContext;
    priority?: number;
}

const mathRegex = /([\d\.]+\s*[\+\-\*\/\^%]\s*[\d\.\+\-\*\/\^%\s\(\)]+)/;

export class ToolOrchestrator {
    private static instance: ToolOrchestrator;
    private registry = ToolRegistry.getInstance();
    private llm = LLMService.getInstance();
    private mesh = MeshClientService.getInstance();
    private telemetry = TelemetryService.getInstance();
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
            `1. You can ONLY use the exact tools listed above (calculator, web_search, device_location, weather). NEVER invent new tool names.\n` +
            `2. If the user greets you (e.g. "Hello", "Hi") or asks a general question that does not require a tool, respond naturally in plain text. Do NOT output JSON or mention tools.\n` +
            `3. For current facts, YouTube channels, links, video info, currency rates, or search, use: web_search\n` +
            `4. For ANY math, arithmetic, or computation, you MUST call: calculator\n` +
            `5. For device coordinates (e.g. "where am I"), use: device_location\n` +
            `6. For ANY weather query, you MUST call: weather. If no specific city is requested by the user, you MUST set "location": "current_location".\n` +
            `7. Output ONLY a raw JSON call when invoking a tool:\n` +
            `{"tool": "<tool_name>", "parameters": {"<key>": "<value>"}}\n\n` +
            `### EXAMPLES:\n` +
            `Query: Hello!\n` +
            `Output: Hello! How can I help you today?\n\n` +
            `Query: What is 1/0.01034?\n` +
            `Output: {"tool": "calculator", "parameters": {"expression": "1/0.01034"}}\n\n` +
            `Query: What is the weather right now?\n` +
            `Output: {"tool": "weather", "parameters": {"location": "current_location"}}\n\n` +
            `Query: Who made this video?\n` +
            `Output: {"tool": "web_search", "parameters": {"query": "video title from image"}}\n\n` +
            `When tool output is provided, synthesize your response directly in plain language without further JSON.`
        );
    }

    private async dispatchGeneration(
        prompt: string,
        onToken: ((tok: string) => void) | undefined,
        options: {
            maxTokens?: number;
            imagePaths?: string[];
            traceContext: TraceContext;
            parentSpanId: string;
            stepNumber: number;
            taskId?: string;
            priority?: number;
            onQueueStatusChange?: (status: string) => void;
        }
    ): Promise<{
        text: string;
        tokenCount: number;
        durationSec: number;
        ttftMs: number;
        taskId?: string;
    }> {
        const target = this.mesh.getSelectedTarget();
        const isRemote = target.nodeId !== 'local_engine';

        const startTime = Date.now();
        let fullText = '';
        let tokenCount = 0;
        let ttftMs = 45;
        let returnedTaskId = options.taskId;

        if (isRemote) {
            const isDesktop = target.deviceTier === 'thick_desktop';
            const mobileGenSpan = !isDesktop
                ? this.telemetry.startSpan({
                    traceId: options.traceContext.trace_id,
                    sessionId: options.traceContext.session_id,
                    parentSpanId: options.parentSpanId,
                    name: `worker.generation_turn_${options.stepNumber}`,
                    observationType: 'generation',
                    targetDevice: target.nodeId,
                    attributes: {
                        'gen_ai.system': 'llama.rn.remote_worker',
                        'gen_ai.request.model': target.modelName,
                        'remote.worker_device_id': target.nodeId,
                    },
                })
                : null;

            const meshRes = await this.mesh.streamChat(
                [{ role: 'user', content: prompt }],
                (tok) => {
                    fullText += tok;
                    tokenCount++;
                    onToken?.(tok);
                },
                {
                    traceContext: {
                        ...options.traceContext,
                        parent_span_id: options.parentSpanId,
                    },
                    taskId: options.taskId,
                    priority: options.priority ?? 1,
                    nPredict: options.maxTokens,
                    onQueueUpdate: (q) => {
                        returnedTaskId = q.taskId;
                        if (q.queuePosition > 1) {
                            options.onQueueStatusChange?.(
                                `⏳ Queued on Desktop (Position #${q.queuePosition})...`
                            );
                        }
                    },
                    onTaskStarted: (s) => {
                        returnedTaskId = s.taskId;
                    },
                }
            );

            returnedTaskId = meshRes.taskId || returnedTaskId;
            if (meshRes.ttftMs) ttftMs = meshRes.ttftMs;
            if (meshRes.tokenCount) tokenCount = meshRes.tokenCount;

            if (mobileGenSpan) {
                const durSec = Math.max((Date.now() - startTime) / 1000, 0.05);
                await this.telemetry.endSpan(mobileGenSpan, {
                    status: 'OK',
                    ttftMs,
                    promptTokens: Math.ceil(prompt.length / 4),
                    completionTokens: tokenCount,
                    tokPerSec: parseFloat((tokenCount / durSec).toFixed(1)),
                    extraAttributes: {
                        'gen_ai.prompt': prompt.substring(0, 4000),
                        'gen_ai.completion': fullText,
                    },
                });
            }
        } else {
            const loadedModel = this.llm.getLoadedModel()?.name || 'local_gguf';
            const localSpan = this.telemetry.startSpan({
                traceId: options.traceContext.trace_id,
                sessionId: options.traceContext.session_id,
                parentSpanId: options.parentSpanId,
                name: `local.generation_turn_${options.stepNumber}`,
                observationType: 'generation',
                targetDevice: 'local_snapdragon',
                attributes: {
                    'gen_ai.system': 'llama.rn',
                    'gen_ai.request.model': loadedModel,
                    'hardware.backend': 'OpenCL_Adreno',
                    'hardware.threads': 4,
                },
            });

            try {
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
                    ttftMs = res.metrics.ttftMs;
                } else if (onToken) {
                    const res = await this.llm.streamCompletion(
                        { prompt, nPredict: options.maxTokens },
                        { onToken: (tok) => onToken(tok) }
                    );
                    fullText = res.fullText;
                    tokenCount = res.metrics.totalTokens;
                    ttftMs = res.metrics.ttftMs;
                } else {
                    const t0 = Date.now();
                    fullText = await this.llm.completeNonStreaming(prompt, options.maxTokens || 160);
                    ttftMs = Date.now() - t0;
                    tokenCount = Math.ceil(fullText.length / 4);
                }

                const durSec = Math.max((Date.now() - startTime) / 1000, 0.05);
                await this.telemetry.endSpan(localSpan, {
                    status: 'OK',
                    ttftMs,
                    promptTokens: Math.ceil(prompt.length / 4),
                    completionTokens: tokenCount,
                    tokPerSec: parseFloat((tokenCount / durSec).toFixed(1)),
                    extraAttributes: {
                        'gen_ai.prompt': prompt.substring(0, 4000),
                        'gen_ai.completion': fullText,
                    },
                });
            } catch (err: any) {
                await this.telemetry.endSpan(localSpan, {
                    status: 'ERROR',
                    errorMessage: err?.message || String(err),
                });
                throw err;
            }
        }

        const durationSec = Math.max((Date.now() - startTime) / 1000, 0.05);
        return { text: fullText, tokenCount, durationSec, ttftMs, taskId: returnedTaskId };
    }

    public async executeAgentLoop(
        initialPrompt: string,
        rawUserQuery: string,
        callbacks: OrchestrationCallbacks,
        options: AgentLoopOptions = {}
    ): Promise<{ fullText: string; metrics: PerformanceMetrics }> {
        const target = this.mesh.getSelectedTarget();
        const traceContext =
            options.traceContext ||
            (await this.telemetry.createTurnTraceContext(
                options.sessionId || this.telemetry.getActiveSessionId(),
                target.nodeId
            ));

        const rootTurnSpan = this.telemetry.startSpan({
            traceId: traceContext.trace_id,
            sessionId: traceContext.session_id,
            parentSpanId: traceContext.parent_span_id ?? null,
            name: 'client.turn_orchestration',
            observationType: 'span',
            targetDevice: 'local_snapdragon',
            attributes: {
                'user.query_preview': rawUserQuery.substring(0, 120),
                'target.compute_node': target.displayName,
            },
        });

        let currentPrompt = initialPrompt;
        let cumulativeTokens = 0;
        let cumulativeTimeSec = 0;
        let initialTtftMs = 0;
        let stepCount = 0;
        let activeDesktopTaskId: string | undefined;

        const executedCalls = new Set<string>();

        try {
            while (stepCount < ToolOrchestrator.MAX_TOOL_STEPS) {
                stepCount++;

                const isFirstTurnWithImage =
                    stepCount === 1 && !!options.imagePaths && options.imagePaths.length > 0;

                // Step 2+: Priority-2 Tool Resumption (Synthesize final answer directly to user)
                if (stepCount > 1) {
                    const finalGen = await this.dispatchGeneration(
                        currentPrompt,
                        (tok) => callbacks.onToken(tok),
                        {
                            imagePaths: isFirstTurnWithImage ? options.imagePaths : undefined,
                            traceContext,
                            parentSpanId: rootTurnSpan.spanId,
                            stepNumber: stepCount,
                            taskId: activeDesktopTaskId,
                            priority: 2, // High priority so interrupted tool-calling agents resume first!
                            onQueueStatusChange: callbacks.onQueueStatusChange,
                        }
                    );

                    cumulativeTokens += finalGen.tokenCount;
                    cumulativeTimeSec += finalGen.durationSec;

                    const aggregateMetrics: PerformanceMetrics = {
                        ttftMs: initialTtftMs || finalGen.ttftMs || 45,
                        totalTokens: cumulativeTokens,
                        generationTimeSec: parseFloat(cumulativeTimeSec.toFixed(2)),
                        tokensPerSecond:
                            cumulativeTimeSec > 0
                                ? parseFloat((cumulativeTokens / cumulativeTimeSec).toFixed(1))
                                : 0,
                    };

                    await this.telemetry.endSpan(rootTurnSpan, {
                        status: 'OK',
                        ttftMs: aggregateMetrics.ttftMs,
                        completionTokens: cumulativeTokens,
                        tokPerSec: aggregateMetrics.tokensPerSecond,
                        extraAttributes: { 'user.final_output': finalGen.text }
                    });

                    callbacks.onMetrics?.(aggregateMetrics);
                    return {
                        fullText: finalGen.text,
                        metrics: aggregateMetrics,
                    };
                }

                // Step 1: Query the model silently to detect if a tool is required
                const stepGen = await this.dispatchGeneration(currentPrompt, undefined, {
                    maxTokens: 160,
                    imagePaths: isFirstTurnWithImage ? options.imagePaths : undefined,
                    traceContext,
                    parentSpanId: rootTurnSpan.spanId,
                    stepNumber: stepCount,
                    priority: options.priority ?? 1,
                    onQueueStatusChange: callbacks.onQueueStatusChange,
                });

                activeDesktopTaskId = stepGen.taskId;
                cumulativeTokens += stepGen.tokenCount;
                cumulativeTimeSec += stepGen.durationSec;
                if (initialTtftMs === 0) initialTtftMs = stepGen.ttftMs || 45;

                const stepOutput = stepGen.text;
                let toolCall = this.parseAndNormalizeToolCall(stepOutput);

                if (!toolCall && stepCount === 1 && rawUserQuery) {
                    toolCall = this.detectFallbackIntent(rawUserQuery);
                }

                const callSignature = toolCall
                    ? `${toolCall.tool}:${JSON.stringify(toolCall.parameters)}`
                    : '';

                // If no tool is required, stream the response
                if (!toolCall || executedCalls.has(callSignature)) {
                    const finalGen = await this.dispatchGeneration(
                        currentPrompt,
                        (tok) => callbacks.onToken(tok),
                        {
                            imagePaths: isFirstTurnWithImage ? options.imagePaths : undefined,
                            traceContext,
                            parentSpanId: rootTurnSpan.spanId,
                            stepNumber: stepCount + 1,
                            priority: options.priority ?? 1,
                            onQueueStatusChange: callbacks.onQueueStatusChange,
                        }
                    );

                    cumulativeTokens += finalGen.tokenCount;
                    cumulativeTimeSec += finalGen.durationSec;

                    const aggregateMetrics: PerformanceMetrics = {
                        ttftMs: initialTtftMs || finalGen.ttftMs || 45,
                        totalTokens: cumulativeTokens,
                        generationTimeSec: parseFloat(cumulativeTimeSec.toFixed(2)),
                        tokensPerSecond:
                            cumulativeTimeSec > 0
                                ? parseFloat((cumulativeTokens / cumulativeTimeSec).toFixed(1))
                                : 0,
                    };

                    await this.telemetry.endSpan(rootTurnSpan, {
                        status: 'OK',
                        ttftMs: aggregateMetrics.ttftMs,
                        completionTokens: cumulativeTokens,
                        tokPerSec: aggregateMetrics.tokensPerSecond,
                        extraAttributes: { 'user.final_output': finalGen.text }
                    });

                    callbacks.onMetrics?.(aggregateMetrics);
                    return {
                        fullText: finalGen.text,
                        metrics: aggregateMetrics,
                    };
                }

                // Tool call identified: Execute locally on this device & record Tool Span
                executedCalls.add(callSignature);
                callbacks.onToolCallDetected?.(toolCall.tool, toolCall.parameters, stepCount);

                const toolSpan = this.telemetry.startSpan({
                    traceId: traceContext.trace_id,
                    sessionId: traceContext.session_id,
                    parentSpanId: rootTurnSpan.spanId,
                    name: `client.tool_exec:${toolCall.tool}`,
                    observationType: 'tool',
                    targetDevice: 'local_snapdragon',
                    attributes: {
                        'tool.name': toolCall.tool,
                        'tool.iteration_step': `${stepCount} of ${ToolOrchestrator.MAX_TOOL_STEPS}`,
                        'tool.args': JSON.stringify(toolCall.parameters || {}),
                        'tool.cache_hit': false,
                    },
                });

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

                const rawDataString = JSON.stringify(toolResult.data || { error: toolResult.error });
                const clampedData =
                    rawDataString.length > 900
                        ? `${rawDataString.substring(0, 900)}...}`
                        : rawDataString;

                await this.telemetry.endSpan(toolSpan, {
                    status: toolResult.success ? 'OK' : 'ERROR',
                    errorMessage: toolResult.error || null,
                    extraAttributes: {
                        'tool.duration_ms': toolResult.executionTimeMs,
                        'tool.output': clampedData.substring(0, 300),
                    },
                });

                callbacks.onToolExecutionCompleted?.(toolCall.tool, toolResult, stepCount);

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

            const finalFallback = await this.dispatchGeneration(
                currentPrompt,
                (tok) => callbacks.onToken(tok),
                {
                    traceContext,
                    parentSpanId: rootTurnSpan.spanId,
                    stepNumber: stepCount + 1,
                    taskId: activeDesktopTaskId,
                    priority: 2,
                }
            );

            await this.telemetry.endSpan(rootTurnSpan, {
                status: 'OK',
                ttftMs: initialTtftMs || 45,
                completionTokens: cumulativeTokens + finalFallback.tokenCount,
                extraAttributes: { 'user.final_output': finalFallback.text }
            });

            return {
                fullText: finalFallback.text,
                metrics: {
                    ttftMs: initialTtftMs || 45,
                    totalTokens: cumulativeTokens + finalFallback.tokenCount,
                    generationTimeSec: parseFloat(
                        (cumulativeTimeSec + finalFallback.durationSec).toFixed(2)
                    ),
                    tokensPerSecond: parseFloat(
                        (
                            (cumulativeTokens + finalFallback.tokenCount) /
                            (cumulativeTimeSec + finalFallback.durationSec)
                        ).toFixed(1)
                    ),
                },
            };
        } catch (err: any) {
            await this.telemetry.endSpan(rootTurnSpan, {
                status: 'ERROR',
                errorMessage: err?.message || String(err),
            });
            throw err;
        }
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
            if (expr.length > 0 && /\d/.test(expr)) {
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

        const trimmed = output.trim();
        if (trimmed.length > 350 && !trimmed.startsWith('{') && !trimmed.startsWith('```')) {
            return null;
        }

        const objects = this.extractAllJsonObjects(trimmed);
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
                                .replace(/\/\/.*$/gm, '')
                                .replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/,(\s*[}\]])/g, '$1')
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
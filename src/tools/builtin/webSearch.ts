import { ToolExecutor, ToolDefinition, ToolResult } from '../types';

interface TavilyRawResult {
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
}

type SearchMode = 'LIVE_FINANCE' | 'LIVE_NEWS' | 'GENERAL';

export class WebSearchTool implements ToolExecutor {
    private static volatileCache = new Map<string, { data: any; timestamp: number }>();
    private static CACHE_TTL_LIVE_MS = 1000 * 60 * 10; // 10-minute cache for live/finance
    private static CACHE_TTL_GENERAL_MS = 1000 * 60 * 60; // 1-hour cache for general facts

    public definition: ToolDefinition = {
        name: 'web_search',
        description: 'Searches the live web for facts, currency rates, news, and current events.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The exact search query to look up on the web.',
                },
            },
            required: ['query'],
        },
    };

    public async execute(args: { query: string }): Promise<ToolResult> {
        const start = performance.now();
        try {
            const query = args.query?.trim();
            if (!query) throw new Error('A search query is required.');

            const mode = this.detectSearchMode(query);
            const cacheTtl =
                mode === 'GENERAL'
                    ? WebSearchTool.CACHE_TTL_GENERAL_MS
                    : WebSearchTool.CACHE_TTL_LIVE_MS;

            const cacheKey = this.hashQuery(`${query}_${mode}`);
            const cached = WebSearchTool.volatileCache.get(cacheKey);
            if (cached && performance.now() - cached.timestamp < cacheTtl) {
                return {
                    success: true,
                    data: cached.data,
                    executionTimeMs: Math.round(performance.now() - start),
                };
            }

            const payload = this.buildTavilyPayload(query, mode);

            const response = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Tavily-Access-Mode': 'keyless',
                },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`Tavily API returned HTTP status ${response.status}`);
            }

            const json = await response.json();
            const rawResults: TavilyRawResult[] = json.results || [];

            // Dynamic Threshold & Filtering Strategy:
            // - LIVE_FINANCE / LIVE_NEWS: Relaxed threshold (>= 0.40) to capture breaking articles
            // - GENERAL: Strict threshold (>= 0.70) to filter out noise
            const scoreThreshold = mode === 'GENERAL' ? 0.70 : 0.40;

            const filteredResults = rawResults
                .filter((r) => (r.score ?? 1) >= scoreThreshold)
                .slice(0, 3)
                .map((r) => ({
                    title: r.title,
                    content: this.cleanSnippet(r.content, 450),
                    relevance_score: parseFloat(r.score.toFixed(3)),
                }));

            // Fallback: If strict threshold returned empty, grab top-1 raw result
            const finalResults =
                filteredResults.length > 0
                    ? filteredResults
                    : rawResults.slice(0, 1).map((r) => ({
                        title: r.title,
                        content: this.cleanSnippet(r.content, 450),
                        relevance_score: parseFloat(r.score.toFixed(3)),
                    }));

            const finalData = {
                query,
                mode,
                results_count: finalResults.length,
                results: finalResults,
            };

            WebSearchTool.volatileCache.set(cacheKey, {
                data: finalData,
                timestamp: performance.now(),
            });

            return {
                success: true,
                data: finalData,
                executionTimeMs: Math.round(performance.now() - start),
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                executionTimeMs: Math.round(performance.now() - start),
            };
        }
    }

    private detectSearchMode(query: string): SearchMode {
        const isFinance =
            /\b(usd|inr|eur|gbp|dollar|rupee|exchange rate|rate|stock|stocks|crypto|bitcoin|gold price|forex|inflation)\b/i.test(
                query
            );
        if (isFinance) return 'LIVE_FINANCE';

        const isNews =
            /\b(today|latest|news|breaking|yesterday|election|war|match score|result|released)\b/i.test(
                query
            );
        if (isNews) return 'LIVE_NEWS';

        return 'GENERAL';
    }

    private buildTavilyPayload(query: string, mode: SearchMode): Record<string, any> {
        switch (mode) {
            case 'LIVE_FINANCE':
                return {
                    query,
                    search_depth: 'basic',
                    topic: 'finance',
                    time_range: 'day',
                    max_results: 5,
                };
            case 'LIVE_NEWS':
                return {
                    query,
                    search_depth: 'basic',
                    topic: 'news',
                    time_range: 'week',
                    max_results: 5,
                };
            case 'GENERAL':
            default:
                return {
                    query,
                    search_depth: 'basic',
                    topic: 'general',
                    max_results: 3,
                };
        }
    }

    private cleanSnippet(content: string, maxChars: number): string {
        if (!content) return '';
        const cleaned = content
            .replace(/#+\s*/g, '') // Strip markdown headers
            .replace(/\s+/g, ' ') // Collapse multiple whitespace/newlines
            .trim();

        return cleaned.length > maxChars
            ? `${cleaned.substring(0, maxChars)}...`
            : cleaned;
    }

    private hashQuery(query: string): string {
        return query.toLowerCase().replace(/\s+/g, '_');
    }
}
import { EmbeddingService } from './EmbeddingService';
import { LLMService } from './LLMService';
import {
    getAllMessageEmbeddings,
    getAllUserFacts,
    insertMessageEmbedding,
    insertUserFact,
    searchMessagesFTS,
    blobToVector,
    getAllConversations,
    ConversationRecord,
} from '../database/repository';

export interface MemoryContextResult {
    facts: string[];
    historicalExcerpts: Array<{
        conversationId: string;
        text: string;
        similarity: number;
    }>;
    formattedSystemContext: string;
}

export interface ConversationSearchResult {
    conversation: ConversationRecord;
    relevanceSnippet: string;
    score: number;
}

export class SemanticMemoryService {
    private static instance: SemanticMemoryService;
    private embeddingService = EmbeddingService.getInstance();
    private isProcessingQueue = false;

    private constructor() {}

    public static getInstance(): SemanticMemoryService {
        if (!SemanticMemoryService.instance) {
            SemanticMemoryService.instance = new SemanticMemoryService();
        }
        return SemanticMemoryService.instance;
    }

    /**
     * Hybrid Vector + FTS Retrieval for prompt augmentation.
     */
    public async retrieveRelevantMemory(
        queryText: string,
        currentConversationId: string,
        topKFacts: number = 3,
        topKMessages: number = 3
    ): Promise<MemoryContextResult> {
        if (!this.embeddingService.isReady()) {
            return { facts: [], historicalExcerpts: [], formattedSystemContext: '' };
        }

        const queryVector = await this.embeddingService.getEmbedding(queryText);

        // 1. Vector Search on User Facts
        const allFacts = await getAllUserFacts();
        const scoredFacts = allFacts.map((f) => ({
            fact: f.fact_text,
            similarity: this.embeddingService.cosineSimilarity(
                queryVector,
                blobToVector(f.embedding_vector)
            ),
        }));
        scoredFacts.sort((a, b) => b.similarity - a.similarity);
        const topFacts = scoredFacts
            .filter((f) => f.similarity >= 0.45)
            .slice(0, topKFacts)
            .map((f) => f.fact);

        // 2. Hybrid Retrieval: FTS Keyword Pre-filter + Vector Cosine Scoring
        const allEmbeddings = await getAllMessageEmbeddings();
        const historicalEmbeddings = allEmbeddings.filter(
            (e) => e.conversation_id !== currentConversationId
        );

        const ftsMatches = await searchMessagesFTS(queryText, 25);
        const ftsMessageIds = new Set(ftsMatches.map((r) => r.message_id));

        const scoredMessages = historicalEmbeddings.map((e) => {
            let sim = this.embeddingService.cosineSimilarity(
                queryVector,
                blobToVector(e.embedding_vector)
            );
            if (ftsMessageIds.has(e.message_id)) {
                sim += 0.15; // Hybrid keyword boost
            }
            return {
                conversationId: e.conversation_id,
                text: e.chunk_text,
                similarity: sim,
            };
        });

        scoredMessages.sort((a, b) => b.similarity - a.similarity);

        // Deduplication
        const topHistorical: Array<{ conversationId: string; text: string; similarity: number }> = [];
        for (const msg of scoredMessages) {
            if (msg.similarity < 0.38) break;
            const isDup = topHistorical.some((existing) =>
                existing.text.includes(msg.text) || msg.text.includes(existing.text)
            );
            if (!isDup) {
                topHistorical.push(msg);
                if (topHistorical.length >= topKMessages) break;
            }
        }

        let formattedSystemContext = '';
        if (topFacts.length > 0 || topHistorical.length > 0) {
            formattedSystemContext = `\n\n### Recalled Historical Context & User Facts:\n`;
            if (topFacts.length > 0) {
                formattedSystemContext += `[User Facts]:\n` + topFacts.map((f) => `- ${f}`).join('\n') + `\n`;
            }
            if (topHistorical.length > 0) {
                formattedSystemContext += `[Past Conversations]:\n` +
                    topHistorical.map((h) => `- ${h.text}`).join('\n') + `\n`;
            }
        }

        return {
            facts: topFacts,
            historicalExcerpts: topHistorical,
            formattedSystemContext,
        };
    }

    /**
     * Semantic Conversation Search across all past chats.
     */
    public async searchConversations(queryText: string): Promise<ConversationSearchResult[]> {
        if (!queryText.trim() || !this.embeddingService.isReady()) return [];

        const conversations = await getAllConversations();
        const convMap = new Map(conversations.map((c) => [c.id, c]));
        const queryVector = await this.embeddingService.getEmbedding(queryText);

        const allEmbeddings = await getAllMessageEmbeddings();
        const convScores = new Map<string, { maxScore: number; bestSnippet: string }>();

        for (const emb of allEmbeddings) {
            const sim = this.embeddingService.cosineSimilarity(
                queryVector,
                blobToVector(emb.embedding_vector)
            );

            const existing = convScores.get(emb.conversation_id);
            if (!existing || sim > existing.maxScore) {
                convScores.set(emb.conversation_id, {
                    maxScore: sim,
                    bestSnippet: emb.chunk_text,
                });
            }
        }

        // FTS exact keywords boost
        const ftsMatches = await searchMessagesFTS(queryText, 25);
        for (const match of ftsMatches) {
            const existing = convScores.get(match.conversation_id);
            if (existing) {
                existing.maxScore += 0.2;
            } else {
                convScores.set(match.conversation_id, {
                    maxScore: 0.5,
                    bestSnippet: match.content.substring(0, 120),
                });
            }
        }

        const results: ConversationSearchResult[] = [];
        convScores.forEach((value, convId) => {
            const conv = convMap.get(convId);
            if (conv && value.maxScore >= 0.35) {
                results.push({
                    conversation: conv,
                    relevanceSnippet: value.bestSnippet,
                    score: value.maxScore,
                });
            }
        });

        return results.sort((a, b) => b.score - a.score);
    }

    public async ingestTurnAsync(
        userMessageId: string,
        assistantMessageId: string,
        conversationId: string,
        userText: string,
        assistantText: string
    ): Promise<void> {
        if (this.isProcessingQueue || !this.embeddingService.isReady()) return;
        this.isProcessingQueue = true;

        try {
            const userChunks = this.embeddingService.chunkText(userText);
            for (const chunk of userChunks) {
                const vec = await this.embeddingService.getEmbedding(chunk);
                await insertMessageEmbedding(userMessageId, conversationId, chunk, vec);
            }

            const assistantChunks = this.embeddingService.chunkText(assistantText);
            for (const chunk of assistantChunks) {
                const vec = await this.embeddingService.getEmbedding(chunk);
                await insertMessageEmbedding(assistantMessageId, conversationId, chunk, vec);
            }

            await this.extractUserFacts(userText);
        } catch (err) {
            console.warn('[SemanticMemoryService] Ingestion error:', err);
        } finally {
            this.isProcessingQueue = false;
        }
    }

    private async extractUserFacts(userText: string): Promise<void> {
        const llm = LLMService.getInstance();
        if (!llm.isReady()) return;

        try {
            const prompt = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\nAnalyze the statement. Extract permanent personal facts, preferences, or user traits. If none exist, output "NONE". Otherwise format: [CATEGORY] Fact.<|eot_id|><|start_header_id|>user<|end_header_id|>\n\n${userText}<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;

            const result = await llm.completeNonStreaming(prompt, 64);
            const text = result.trim();
            if (!text || text.includes('NONE')) return;

            const match = text.match(/\[(.*?)\]\s*(.*)/);
            if (match) {
                const category = match[1].trim() || 'general';
                const fact = match[2].trim();
                if (fact.length > 5) {
                    const vec = await this.embeddingService.getEmbedding(fact);
                    await insertUserFact(fact, category, vec, 1.0);
                }
            }
        } catch {
            // Non-blocking
        }
    }
}
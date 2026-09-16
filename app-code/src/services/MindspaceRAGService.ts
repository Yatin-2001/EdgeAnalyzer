import {
  getAssetById,
  getAssetChunksByNotebook,
  getAssetsByNotebook,
  getNotebookById,
  getNotebookMessages,
  insertNotebookMessage,
  searchAssetChunksFTS,
  blobToVector,
  cosineSimilarity,
  NotebookAssetRecord,
  NotebookMessageRecord,
} from '../database/repository';
import { LLMService, PerformanceMetrics } from './LLMService';
import { EmbeddingService } from './EmbeddingService';
import { ToolOrchestrator } from './ToolOrchestrator';

export interface ScoredChunk {
  chunkId: string;
  assetId: string;
  assetTitle: string;
  assetType: string;
  chunkText: string;
  score: number;
}

export interface RAGCallbacks {
  onToken: (token: string) => void;
  onMetrics?: (metrics: PerformanceMetrics) => void;
  onSourcesResolved?: (
      sources: Array<{ asset_id: string; title: string; chunk_preview: string }>
  ) => void;
}

export class MindspaceRAGService {
  private static instance: MindspaceRAGService;
  private llm = LLMService.getInstance();
  private embeddingService = EmbeddingService.getInstance();
  private orchestrator = ToolOrchestrator.getInstance();

  private constructor() {}

  public static getInstance(): MindspaceRAGService {
    if (!MindspaceRAGService.instance) {
      MindspaceRAGService.instance = new MindspaceRAGService();
    }
    return MindspaceRAGService.instance;
  }

  /**
   * Hybrid RRF (Vector Cosine + FTS5 Keyword) with Modality-Balanced Allocation
   */
  private async retrieveHybridBalancedChunks(
      notebookId: string,
      userQuery: string,
      allAssets: NotebookAssetRecord[]
  ): Promise<ScoredChunk[]> {
    const assetMap = new Map<string, NotebookAssetRecord>();
    allAssets.forEach((a) => assetMap.set(a.id, a));

    const allChunks = await getAssetChunksByNotebook(notebookId);
    if (allChunks.length === 0) return [];

    const RRF_K = 60;
    const rrfScores = new Map<string, { chunk: typeof allChunks[0]; score: number }>();

    // 1. Dense Semantic Vector Retrieval Rank
    if (this.embeddingService.isReady()) {
      try {
        const queryVec = await this.embeddingService.getEmbedding(userQuery);
        const vectorScored = allChunks
            .map((chunk) => {
              const vec = blobToVector(chunk.embedding);
              const sim = vec.length > 0 ? cosineSimilarity(queryVec, vec) : 0;
              return { chunk, sim };
            })
            .sort((a, b) => b.sim - a.sim);

        vectorScored.forEach((item, rank) => {
          const current = rrfScores.get(item.chunk.id) || { chunk: item.chunk, score: 0 };
          current.score += 1 / (RRF_K + (rank + 1));
          rrfScores.set(item.chunk.id, current);
        });
      } catch (err) {
        console.warn('[MindspaceRAG] Vector scoring fallback:', err);
      }
    }

    // 2. Sparse Keyword BM25 / FTS5 Retrieval Rank
    const ftsHits = await searchAssetChunksFTS(notebookId, userQuery, 25);
    ftsHits.forEach((hit, rank) => {
      const matchChunk = allChunks.find((c) => c.id === hit.chunk_id);
      if (matchChunk) {
        const current = rrfScores.get(matchChunk.id) || { chunk: matchChunk, score: 0 };
        current.score += 1 / (RRF_K + (rank + 1));
        rrfScores.set(matchChunk.id, current);
      }
    });

    // 3. Partition Candidates by Modality
    const visualCandidates: ScoredChunk[] = [];
    const documentCandidates: ScoredChunk[] = [];

    rrfScores.forEach(({ chunk, score }) => {
      const parent = assetMap.get(chunk.asset_id);
      const isVisual = parent?.type === 'screenshot' || parent?.type === 'image';
      const scored: ScoredChunk = {
        chunkId: chunk.id,
        assetId: chunk.asset_id,
        assetTitle: parent?.title || 'Asset',
        assetType: parent?.type || 'unknown',
        chunkText: chunk.chunk_text,
        score,
      };

      if (isVisual) {
        visualCandidates.push(scored);
      } else {
        documentCandidates.push(scored);
      }
    });

    visualCandidates.sort((a, b) => b.score - a.score);
    documentCandidates.sort((a, b) => b.score - a.score);

    // 4. Modality-Balanced Selection: Reserve guaranteed slots for images
    // e.g., Target 6 total chunks: Max 3 Visual + Max 3 Document
    const balancedResults: ScoredChunk[] = [];
    const reservedVisual = visualCandidates.slice(0, 3);
    const reservedDocs = documentCandidates.slice(0, 3);

    balancedResults.push(...reservedVisual, ...reservedDocs);

    // If one modality has fewer than 3, fill remaining capacity from the other
    if (balancedResults.length < 6) {
      const remainingSlots = 6 - balancedResults.length;
      if (visualCandidates.length > 3 && reservedDocs.length < 3) {
        balancedResults.push(...visualCandidates.slice(3, 3 + remainingSlots));
      } else if (documentCandidates.length > 3 && reservedVisual.length < 3) {
        balancedResults.push(...documentCandidates.slice(3, 3 + remainingSlots));
      }
    }

    return balancedResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Executes Dual-Scope RAG Query
   */
  public async executeQuery(
      notebookId: string,
      conversationId: string,
      userQuery: string,
      targetAssetId: string | null,
      callbacks: RAGCallbacks
  ): Promise<{ fullText: string; messageRecord: NotebookMessageRecord }> {
    await insertNotebookMessage(
        conversationId,
        'user',
        userQuery,
        [],
        Math.ceil(userQuery.length / 4)
    );

    const history = await getNotebookMessages(conversationId);
    const recentTurns = history.slice(-6);

    let promptPayload = '';
    const sources: Array<{ asset_id: string; title: string; chunk_preview: string }> = [];

    // ==========================================
    // Scope A: Single-Asset Inspection Mode
    // ==========================================
    if (targetAssetId) {
      const asset = await getAssetById(targetAssetId);
      if (!asset) throw new Error('Target asset not found.');

      sources.push({
        asset_id: asset.id,
        title: asset.title,
        chunk_preview: asset.structured_card || asset.extracted_text?.substring(0, 100) || '',
      });
      callbacks.onSourcesResolved?.(sources);

      let assetContext = `### INSPECTED ASSET: "${asset.title}" (${asset.type.toUpperCase()})\n`;
      if (asset.structured_card) {
        assetContext += `${asset.structured_card}\n\n`;
      }
      if (asset.user_note) {
        assetContext += `### USER ATTACHED NOTES:\n${asset.user_note}\n\n`;
      }
      if (asset.extracted_text) {
        assetContext += `### HIGH-PRECISION OCR / TEXT:\n${asset.extracted_text.substring(0, 2000)}\n\n`;
      }

      const baseSystem =
          `You are MindSpace, an intelligent on-device research assistant analyzing a single asset.\n` +
          `Answer the user's questions accurately using the provided asset context.`;

      const formattedSystem = this.orchestrator.formatSystemPromptWithTools(baseSystem, userQuery);

      let historyString = '';
      for (const msg of recentTurns) {
        historyString += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
      }

      promptPayload =
          `<|im_start|>system\n${formattedSystem}\n\n${assetContext}<|im_end|>\n` +
          historyString +
          `<|im_start|>assistant\n`;
    }

        // ==========================================
        // Scope B: Global Notebook Hybrid RAG Mode
    // ==========================================
    else {
      const notebook = await getNotebookById(notebookId);
      const allAssets = await getAssetsByNotebook(notebookId);

      const topChunks = await this.retrieveHybridBalancedChunks(notebookId, userQuery, allAssets);

      let groundingContext = '### NOTEBOOK GROUNDING SOURCES:\n';

      if (topChunks.length > 0) {
        const uniqueAssetIds = new Set<string>();
        topChunks.forEach((c) => {
          const typeLabel = c.assetType === 'screenshot' || c.assetType === 'image' ? 'Visual Card' : 'Doc Text';
          groundingContext += `[Source: "${c.assetTitle}" (${typeLabel}) | Asset ID: ${c.assetId}]\n${c.chunkText}\n\n`;

          if (!uniqueAssetIds.has(c.assetId)) {
            uniqueAssetIds.add(c.assetId);
            sources.push({
              asset_id: c.assetId,
              title: c.assetTitle,
              chunk_preview: c.chunkText.substring(0, 80),
            });
          }
        });
      } else {
        // Fallback to top-level knowledge cards
        allAssets.slice(0, 6).forEach((a) => {
          groundingContext += `[Source: "${a.title}"]\n${a.structured_card || a.extracted_text?.substring(0, 200) || 'Empty'}\n\n`;
          sources.push({
            asset_id: a.id,
            title: a.title,
            chunk_preview: (a.structured_card || a.title).substring(0, 80),
          });
        });
      }

      if (notebook?.notebook_notes) {
        groundingContext += `### NOTEBOOK SCRATCHPAD & SYNTHESIS NOTES:\n${notebook.notebook_notes}\n\n`;
      }

      callbacks.onSourcesResolved?.(sources);

      const baseSystem =
          `You are MindSpace, an on-device multimodal research assistant synthesizing information across all assets in notebook: "${notebook?.title || 'Research'}".\n` +
          `Compare specs, aggregate facts, and answer user queries accurately using the grounding sources above.`;

      const formattedSystem = this.orchestrator.formatSystemPromptWithTools(baseSystem, userQuery);

      let historyString = '';
      for (const msg of recentTurns) {
        historyString += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
      }

      promptPayload =
          `<|im_start|>system\n${formattedSystem}\n\n${groundingContext}<|im_end|>\n` +
          historyString +
          `<|im_start|>assistant\n`;
    }

    const result = await this.orchestrator.executeAgentLoop(
        promptPayload,
        userQuery,
        {
          onToken: callbacks.onToken,
          onMetrics: callbacks.onMetrics,
        }
    );

    const assistantMsg = await insertNotebookMessage(
        conversationId,
        'assistant',
        result.fullText,
        sources,
        result.metrics.totalTokens
    );

    return {
      fullText: result.fullText,
      messageRecord: assistantMsg,
    };
  }
}
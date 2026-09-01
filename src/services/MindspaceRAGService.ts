import {
  getAssetById,
  getAssetChunksByNotebook,
  getAssetsByNotebook,
  getNotebookById,
  getNotebookMessages,
  insertNotebookMessage,
  blobToVector,
  cosineSimilarity,
  NotebookAssetRecord,
  NotebookMessageRecord,
} from '../database/repository';
import { LLMService, PerformanceMetrics } from './LLMService';
import { EmbeddingService } from './EmbeddingService';
import { ToolOrchestrator } from './ToolOrchestrator';

export interface ScoredChunk {
  assetId: string;
  assetTitle: string;
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
   * Executes Dual-Scope RAG Query
   */
  public async executeQuery(
    notebookId: string,
    conversationId: string,
    userQuery: string,
    targetAssetId: string | null,
    callbacks: RAGCallbacks
  ): Promise<{ fullText: string; messageRecord: NotebookMessageRecord }> {
    // 1. Save User Message
    await insertNotebookMessage(conversationId, 'user', userQuery, [], Math.ceil(userQuery.length / 4));

    // 2. Fetch Conversation History (last 3 turns)
    const history = await getNotebookMessages(conversationId);
    const recentTurns = history.slice(-6);

    let promptPayload = '';
    let sources: Array<{ asset_id: string; title: string; chunk_preview: string }> = [];

    // ==========================================
    // Scope A: Single-Asset Inspection Mode
    // ==========================================
    if (targetAssetId) {
      const asset = await getAssetById(targetAssetId);
      if (!asset) throw new Error('Target asset not found.');

      sources = [
        {
          asset_id: asset.id,
          title: asset.title,
          chunk_preview: asset.structured_card || asset.extracted_text?.substring(0, 100) || '',
        },
      ];
      callbacks.onSourcesResolved?.(sources);

      let assetContext = `### INSPECTED ASSET: "${asset.title}" (${asset.type.toUpperCase()})\n`;
      if (asset.structured_card) {
        assetContext += `${asset.structured_card}\n\n`;
      }
      if (asset.user_note) {
        assetContext += `### USER ATTACHED NOTES:\n${asset.user_note}\n\n`;
      }
      if (asset.extracted_text) {
        assetContext += `### HIGH-PRECISION OCR / TEXT CONTENT:\n${asset.extracted_text.substring(0, 2000)}\n\n`;
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
    // Scope B: Global Notebook RAG Mode
    // ==========================================
    else {
      const notebook = await getNotebookById(notebookId);
      const allAssets = await getAssetsByNotebook(notebookId);
      const allChunks = await getAssetChunksByNotebook(notebookId);

      const assetMap = new Map<string, NotebookAssetRecord>();
      allAssets.forEach((a) => assetMap.set(a.id, a));

      const scoredChunks: ScoredChunk[] = [];

      // 1. Semantic Cosine Vector Search
      if (this.embeddingService.isReady() && allChunks.length > 0) {
        try {
          const queryVec = await this.embeddingService.getEmbedding(userQuery);
          for (const chunk of allChunks) {
            const chunkVec = blobToVector(chunk.embedding);
            if (chunkVec.length > 0) {
              const score = cosineSimilarity(queryVec, chunkVec);
              scoredChunks.push({
                assetId: chunk.asset_id,
                assetTitle: assetMap.get(chunk.asset_id)?.title || 'Asset',
                chunkText: chunk.chunk_text,
                score,
              });
            }
          }
        } catch (vecErr) {
          console.warn('[MindspaceRAG] Vector similarity skipped:', vecErr);
        }
      }

      // 2. Sort and select Top-K Chunks
      scoredChunks.sort((a, b) => b.score - a.score);
      const topChunks = scoredChunks.slice(0, 5);

      // 3. Fallback: If no chunks match, ground on asset summaries
      let groundingContext = '### NOTEBOOK GROUNDING SOURCES:\n';

      if (topChunks.length > 0) {
        const uniqueAssetIds = new Set<string>();
        topChunks.forEach((c) => {
          groundingContext += `[Source: "${c.assetTitle}" | Asset ID: ${c.assetId}]\n${c.chunkText}\n\n`;
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
        `Compare specs, aggregate facts, and answer user queries using the notebook grounding sources above.`;

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

    // 3. Stream Response via ToolOrchestrator
    const result = await this.orchestrator.executeAgentLoop(
      promptPayload,
      userQuery,
      {
        onToken: callbacks.onToken,
        onMetrics: callbacks.onMetrics,
      }
    );

    // 4. Save Assistant Response with Referenced Sources
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
import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import ModelFile from '../../modules/model-file/src/ModelFileModule';
import {
  insertNotebookAsset,
  insertAssetChunk,
  updateAssetStructuredCard,
  NotebookAssetRecord,
} from '../database/repository';
import { LLMService } from './LLMService';
import { EmbeddingService } from './EmbeddingService';

export class MindspaceIngestionService {
  private static instance: MindspaceIngestionService;
  private llm = LLMService.getInstance();
  private embeddingService = EmbeddingService.getInstance();

  private constructor() {}

  public static getInstance(): MindspaceIngestionService {
    if (!MindspaceIngestionService.instance) {
      MindspaceIngestionService.instance = new MindspaceIngestionService();
    }
    return MindspaceIngestionService.instance;
  }

  private ensureNotebookDirectory(notebookId: string): Directory {
    const notebookDir = new Directory(Paths.document, `notebooks/${notebookId}`);
    if (!notebookDir.exists) {
      notebookDir.create({ intermediates: true });
    }
    return notebookDir;
  }

  /**
   * 1. Ingest Screenshot / Camera Image
   */
  public async ingestImage(
      notebookId: string,
      sourceUri: string,
      filename: string,
      type: 'screenshot' | 'image' = 'screenshot'
  ): Promise<NotebookAssetRecord> {
    const notebookDir = this.ensureNotebookDirectory(notebookId);
    const sanitizedName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const destination = new File(notebookDir, sanitizedName);

    // 1. Copy into permanent internal storage
    if (sourceUri.startsWith('content://')) {
      await ModelFile.copyContentUriToFile(sourceUri, destination.uri);
    } else {
      const src = new File(sourceUri);
      await src.copy(destination);
    }

    const permanentUri = destination.uri;

    // 2. High-res ML Kit OCR (with dual path fallback)
    let extractedText = '';
    try {
      const ocrResult = await TextRecognition.recognize(permanentUri);
      extractedText = ocrResult?.text ? ocrResult.text.trim() : '';
    } catch {
      try {
        const cleanPath = permanentUri.replace('file://', '');
        const ocrResult = await TextRecognition.recognize(cleanPath);
        extractedText = ocrResult?.text ? ocrResult.text.trim() : '';
      } catch (ocrErr) {
        console.warn('[MindspaceIngestion] ML Kit OCR skipped:', ocrErr);
      }
    }

    // 3. Downscale to 448px for VLM token compression (~256 tokens)
    let downscaledUri = permanentUri;
    try {
      const manipResult = await ImageManipulator.manipulateAsync(
          permanentUri,
          [{ resize: { width: 448 } }],
          { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG }
      );
      if (manipResult?.uri) {
        downscaledUri = manipResult.uri;
      }
    } catch (scaleErr) {
      console.warn('[MindspaceIngestion] Image downscale failed:', scaleErr);
    }

    // 4. Grounded Knowledge Card Extraction
    const structuredCard = await this.generateStructuredKnowledgeCard(
        downscaledUri,
        extractedText,
        type
    );

    // 5. Persist Asset record to SQLite
    const asset = await insertNotebookAsset(
        notebookId,
        type,
        filename,
        permanentUri,
        extractedText,
        structuredCard,
        {
          downscaledUri,
          ocrLength: extractedText.length,
          isVisionProcessed: this.llm.isVisionCapable(),
        }
    );

    // 6. Chunk & Generate Vector Embeddings for Global Notebook RAG
    await this.indexAssetChunks(
        notebookId,
        asset.id,
        `${structuredCard}\n\n### OCR ON-SCREEN TEXT:\n${extractedText}`
    );

    return asset;
  }

  /**
   * 2. Ingest Text Note
   */
  public async ingestTextNote(
      notebookId: string,
      title: string,
      content: string
  ): Promise<NotebookAssetRecord> {
    const asset = await insertNotebookAsset(
        notebookId,
        'text_note',
        title,
        null,
        content,
        `### NOTE: ${title}\n${content}`,
        { charCount: content.length }
    );

    await this.indexAssetChunks(notebookId, asset.id, content);
    return asset;
  }

  /**
   * 3. Ingest File Document (.txt, .md, .pdf)
   */
  public async ingestDocument(
      notebookId: string,
      sourceUri: string,
      filename: string
  ): Promise<NotebookAssetRecord> {
    const notebookDir = this.ensureNotebookDirectory(notebookId);
    const sanitizedName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const destination = new File(notebookDir, sanitizedName);

    if (sourceUri.startsWith('content://')) {
      await ModelFile.copyContentUriToFile(sourceUri, destination.uri);
    } else {
      const src = new File(sourceUri);
      await src.copy(destination);
    }

    let extractedText = '';
    try {
      extractedText = await destination.text();
    } catch {
      extractedText = '';
    }

    const clampedText = extractedText.substring(0, 15000);

    const asset = await insertNotebookAsset(
        notebookId,
        'document',
        filename,
        destination.uri,
        clampedText,
        `### DOCUMENT: ${filename}\n${clampedText.substring(0, 1000)}...`,
        { sizeBytes: destination.size }
    );

    await this.indexAssetChunks(notebookId, asset.id, clampedText);
    return asset;
  }

  /**
   * Re-analyzes an existing asset when the user switches to a Vision model
   */
  public async reanalyzeAsset(asset: NotebookAssetRecord): Promise<string> {
    if (!asset.file_uri) return asset.structured_card || '';

    let downscaledUri = asset.file_uri;
    try {
      const meta = asset.metadata_json ? JSON.parse(asset.metadata_json) : {};
      if (meta.downscaledUri) downscaledUri = meta.downscaledUri;
    } catch {}

    const newCard = await this.generateStructuredKnowledgeCard(
        downscaledUri,
        asset.extracted_text || '',
        asset.type
    );

    await updateAssetStructuredCard(asset.id, newCard);
    return newCard;
  }

  /**
   * Grounded Knowledge Card Extraction
   * Prevents text models from hallucinating visual scenes when no vision model is loaded.
   */
  private async generateStructuredKnowledgeCard(
      downscaledUri: string,
      ocrText: string,
      assetType: string
  ): Promise<string> {
    const isVision = this.llm.isVisionCapable();

    // Mode A: Vision Model Loaded -> Perform True Multimodal Grounding
    if (isVision && this.llm.isReady()) {
      try {
        const prompt =
            `<|im_start|>system\n` +
            `You are an on-device visual analysis engine. Look at the attached image and OCR text. Extract a concise, strictly factual markdown knowledge card.\n` +
            `Format:\n` +
            `- **Primary Subject / Title**:\n` +
            `- **Channel / Creator / App**:\n` +
            `- **Timestamps / Stats / Numbers**:\n` +
            `- **Visual Scene & Visible Subjects**:\n` +
            `- **Summary / Core Details**:<|im_end|>\n` +
            `<|im_start|>user\n` +
            (ocrText ? `### OCR DETECTED ON-SCREEN TEXT:\n${ocrText.substring(0, 1000)}\n\n` : '') +
            `Analyze this image accurately.<|im_end|>\n` +
            `<|im_start|>assistant\n`;

        const res = await this.llm.streamCompletion(
            {
              prompt,
              imagePaths: [downscaledUri],
              nPredict: 220,
              temperature: 0.1,
            },
            { onToken: () => {} }
        );

        const card = res.fullText.trim();
        if (card.length > 20) return card;
      } catch (err) {
        console.warn('[MindspaceIngestion] Vision knowledge card generation failed:', err);
      }
    }

    // Mode B: Text Model + Valid OCR Text -> Structure ONLY what was extracted
    if (ocrText && ocrText.length > 15 && this.llm.isReady()) {
      try {
        const prompt =
            `<|im_start|>system\n` +
            `You are a text processing assistant. Format the following OCR text extracted from an image into a structured summary. Do NOT invent details that are not present in the OCR text.<|im_end|>\n` +
            `<|im_start|>user\n` +
            `### EXTRACTED OCR TEXT:\n${ocrText.substring(0, 1500)}\n\n` +
            `Extract the title, names, numbers, and main topics from this text.<|im_end|>\n` +
            `<|im_start|>assistant\n`;

        const res = await this.llm.completeNonStreaming(prompt, 180);
        if (res.trim().length > 15) {
          return `### ASSET CARD (OCR Extracted):\n${res.trim()}`;
        }
      } catch (err) {
        console.warn('[MindspaceIngestion] OCR text formatting fallback:', err);
      }
    }

    // Mode C: Deterministic Fallback (Zero LLM Hallucination)
    if (ocrText && ocrText.length > 0) {
      return (
          `### ASSET CARD (${assetType.toUpperCase()} - OCR Extracted):\n` +
          `- **Detected On-Screen Text**:\n${ocrText.substring(0, 600)}`
      );
    }

    return (
        `### ASSET CARD (${assetType.toUpperCase()}):\n` +
        `- Image stored. No text was detected via OCR.\n` +
        `- Switch to a Vision model (e.g., Qwen2-VL or SmolVLM) in Settings, then tap "Re-Analyze" to extract full visual scene details.`
    );
  }

  /**
   * Sliding-Window Semantic Chunking & Vector Ingestion
   */
  private async indexAssetChunks(
      notebookId: string,
      assetId: string,
      fullText: string
  ): Promise<void> {
    const cleanText = fullText.trim();
    if (!cleanText) return;

    const chunkSize = 350;
    const overlap = 50;
    const chunks: string[] = [];

    let startIndex = 0;
    while (startIndex < cleanText.length) {
      const chunk = cleanText.substring(startIndex, startIndex + chunkSize).trim();
      if (chunk.length > 20) {
        chunks.push(chunk);
      }
      startIndex += chunkSize - overlap;
    }

    if (chunks.length === 0 && cleanText.length > 0) {
      chunks.push(cleanText);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      let embeddingVector = new Float32Array(0);

      try {
        if (this.embeddingService.isReady()) {
          const emb = await this.embeddingService.getEmbedding(chunkText);
          embeddingVector = new Float32Array(emb);
        }
      } catch (embErr) {
        console.warn(`[MindspaceIngestion] Embedding failed for chunk ${i}:`, embErr);
      }

      await insertAssetChunk(
          notebookId,
          assetId,
          i,
          chunkText,
          embeddingVector,
          Math.ceil(chunkText.length / 4)
      );
    }
  }

}
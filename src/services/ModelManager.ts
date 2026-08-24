import { Directory, File, Paths } from 'expo-file-system';
import ModelFile, {
  ModelFileMetadata,
} from '../../modules/model-file/src/ModelFileModule';
import { ModelRecord } from '../database/repository';

export type ModelSlotType = 'chat' | 'embedding';

export type ModelFileStatus =
    | 'NO_MODEL'
    | 'MODEL_AVAILABLE'
    | 'PREPARING'
    | 'READY_TO_LOAD'
    | 'CLEANING';

export interface ModelInfo {
  originalName: string;
  workingFileName: string;
  originalUri: string;
  workingUri: string | null;
  sizeBytes: number | null;
  status: ModelFileStatus;
  slotType: ModelSlotType;
}

export class ModelManager {
  private static instance: ModelManager;
  private readonly modelsDirectory: Directory;

  private currentChatModel: ModelInfo | null = null;
  private currentEmbeddingModel: ModelInfo | null = null;

  private constructor() {
    this.modelsDirectory = new Directory(Paths.document, 'models');
  }

  public static getInstance(): ModelManager {
    if (!ModelManager.instance) {
      ModelManager.instance = new ModelManager();
    }
    return ModelManager.instance;
  }

  private ensureModelsDirectory(): void {
    if (!this.modelsDirectory.exists) {
      this.modelsDirectory.create({ intermediates: true });
    }
  }

  public async prepareModelFromRecord(
      record: ModelRecord,
      slotType: ModelSlotType = 'chat'
  ): Promise<ModelInfo> {
    return this.selectModel(record.original_uri, record.original_name, slotType);
  }

  public async selectModel(
      originalUri: string,
      fallbackName?: string,
      slotType: ModelSlotType = 'chat'
  ): Promise<ModelInfo> {
    if (!originalUri) throw new Error('No model URI was provided.');

    const activeSlot =
        slotType === 'chat' ? this.currentChatModel : this.currentEmbeddingModel;

    // Cache hit: avoid re-copying if already prepared in this slot
    if (
        activeSlot &&
        activeSlot.originalUri === originalUri &&
        activeSlot.workingUri &&
        activeSlot.status === 'READY_TO_LOAD'
    ) {
      const workingFile = new File(activeSlot.workingUri);
      if (workingFile.exists && workingFile.size > 0) {
        return activeSlot;
      }
    }

    if (activeSlot && activeSlot.originalUri !== originalUri) {
      await this.deleteWorkingCopy(slotType);
    }

    let metadata: ModelFileMetadata;
    try {
      metadata = await ModelFile.getContentUriMetadata(originalUri);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read model metadata: ${msg}`);
    }

    const originalName = metadata.name?.trim() || fallbackName;
    if (!originalName || !originalName.toLowerCase().endsWith('.gguf')) {
      throw new Error(`Invalid model: "${originalName}". Only GGUF files are supported.`);
    }

    const workingFileName =
        slotType === 'chat' ? 'chat_model.gguf' : 'embedding_model.gguf';

    const newModelInfo: ModelInfo = {
      originalName,
      workingFileName,
      originalUri,
      workingUri: null,
      sizeBytes: metadata.sizeBytes,
      status: 'MODEL_AVAILABLE',
      slotType,
    };

    if (slotType === 'chat') {
      this.currentChatModel = newModelInfo;
      return this.prepareWorkingCopy(this.currentChatModel);
    } else {
      this.currentEmbeddingModel = newModelInfo;
      return this.prepareWorkingCopy(this.currentEmbeddingModel);
    }
  }

  private async prepareWorkingCopy(modelInfo: ModelInfo): Promise<ModelInfo> {
    this.ensureModelsDirectory();
    modelInfo.status = 'PREPARING';

    try {
      const destination = new File(
          this.modelsDirectory,
          modelInfo.workingFileName
      );

      if (destination.exists) {
        destination.delete();
      }

      await ModelFile.copyContentUriToFile(
          modelInfo.originalUri,
          destination.uri
      );

      const workingFile = new File(destination.uri);
      if (!workingFile.exists || workingFile.size <= 0) {
        throw new Error('Working model binary copy failed or is empty.');
      }

      const isGGUF = await ModelFile.isGGUFFile(workingFile.uri);
      if (!isGGUF) {
        workingFile.delete();
        throw new Error('The selected binary is not a valid GGUF file.');
      }

      modelInfo.workingUri = workingFile.uri;
      modelInfo.sizeBytes = workingFile.size;
      modelInfo.status = 'READY_TO_LOAD';

      return modelInfo;
    } catch (error) {
      modelInfo.status = 'MODEL_AVAILABLE';
      throw error;
    }
  }

  public getCurrentModel(slotType: ModelSlotType = 'chat'): ModelInfo | null {
    return slotType === 'chat' ? this.currentChatModel : this.currentEmbeddingModel;
  }

  public async deleteWorkingCopy(slotType: ModelSlotType = 'chat'): Promise<void> {
    const model =
        slotType === 'chat' ? this.currentChatModel : this.currentEmbeddingModel;
    if (!model?.workingUri) return;

    model.status = 'CLEANING';
    try {
      const workingFile = new File(model.workingUri);
      if (workingFile.exists) {
        workingFile.delete();
      }
      model.workingUri = null;
      model.status = 'MODEL_AVAILABLE';
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete ${slotType} working copy: ${msg}`);
    }
  }
}
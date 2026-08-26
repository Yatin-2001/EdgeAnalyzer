import { Directory, File, Paths } from 'expo-file-system';
import ModelFile, {
  ModelFileMetadata,
} from '../../modules/model-file/src/ModelFileModule';
import { ModelRecord } from '../database/repository';

export type ModelSlotType = 'chat' | 'embedding' | 'mmproj';

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
  private currentMmprojModel: ModelInfo | null = null;

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

  public async prepareVisionPair(
      baseModelUri: string,
      mmprojUri: string,
      baseName?: string,
      mmprojName?: string
  ): Promise<{ baseModel: ModelInfo; mmprojModel: ModelInfo }> {
    const baseModel = await this.selectModel(baseModelUri, baseName, 'chat');
    const mmprojModel = await this.selectModel(mmprojUri, mmprojName, 'mmproj');
    return { baseModel, mmprojModel };
  }

  public async selectModel(
      originalUri: string,
      fallbackName?: string,
      slotType: ModelSlotType = 'chat'
  ): Promise<ModelInfo> {
    if (!originalUri) throw new Error('No model URI was provided.');

    const activeSlot = this.getActiveSlot(slotType);

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

    let workingFileName = 'chat_model.gguf';
    if (slotType === 'embedding') workingFileName = 'embedding_model.gguf';
    if (slotType === 'mmproj') workingFileName = 'mmproj_model.gguf';

    const newModelInfo: ModelInfo = {
      originalName,
      workingFileName,
      originalUri,
      workingUri: null,
      sizeBytes: metadata.sizeBytes,
      status: 'MODEL_AVAILABLE',
      slotType,
    };

    this.setActiveSlot(slotType, newModelInfo);
    return this.prepareWorkingCopy(newModelInfo);
  }

  private async prepareWorkingCopy(modelInfo: ModelInfo): Promise<ModelInfo> {
    this.ensureModelsDirectory();
    modelInfo.status = 'PREPARING';

    try {
      const destination = new File(this.modelsDirectory, modelInfo.workingFileName);

      if (destination.exists) {
        destination.delete();
      }

      await ModelFile.copyContentUriToFile(modelInfo.originalUri, destination.uri);

      const workingFile = new File(destination.uri);
      if (!workingFile.exists || workingFile.size <= 0) {
        throw new Error(`Working model binary copy failed for ${modelInfo.slotType}.`);
      }

      const isGGUF = await ModelFile.isGGUFFile(workingFile.uri);
      if (!isGGUF) {
        workingFile.delete();
        throw new Error(`The selected binary for ${modelInfo.slotType} is not a valid GGUF file.`);
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

  private getActiveSlot(slotType: ModelSlotType): ModelInfo | null {
    if (slotType === 'chat') return this.currentChatModel;
    if (slotType === 'embedding') return this.currentEmbeddingModel;
    return this.currentMmprojModel;
  }

  private setActiveSlot(slotType: ModelSlotType, info: ModelInfo | null): void {
    if (slotType === 'chat') this.currentChatModel = info;
    else if (slotType === 'embedding') this.currentEmbeddingModel = info;
    else this.currentMmprojModel = info;
  }

  public getCurrentModel(slotType: ModelSlotType = 'chat'): ModelInfo | null {
    return this.getActiveSlot(slotType);
  }

  public async deleteWorkingCopy(slotType: ModelSlotType = 'chat'): Promise<void> {
    const model = this.getActiveSlot(slotType);
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
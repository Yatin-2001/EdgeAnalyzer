import { Directory, File, Paths } from 'expo-file-system';
import ModelFile, {
  ModelFileMetadata,
} from '../../modules/model-file/src/ModelFileModule';
import { ModelRecord } from '../database/repository';

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
}

export class ModelManager {
  private static instance: ModelManager;
  private readonly modelsDirectory: Directory;
  private currentModel: ModelInfo | null = null;

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

  public async prepareModelFromRecord(record: ModelRecord): Promise<ModelInfo> {
    return this.selectModel(record.original_uri, record.original_name);
  }

  public async selectModel(
      originalUri: string,
      fallbackName?: string
  ): Promise<ModelInfo> {
    if (!originalUri) {
      throw new Error('No model URI was provided.');
    }

    // Cache check: Reuse existing working copy if identical model
    if (
        this.currentModel &&
        this.currentModel.originalUri === originalUri &&
        this.currentModel.workingUri &&
        this.currentModel.status === 'READY_TO_LOAD'
    ) {
      const workingFile = new File(this.currentModel.workingUri);
      if (workingFile.exists && workingFile.size > 0) {
        return this.currentModel;
      }
    }

    if (this.currentModel && this.currentModel.originalUri !== originalUri) {
      await this.deleteWorkingCopy();
    }

    let metadata: ModelFileMetadata;
    try {
      metadata = await ModelFile.getContentUriMetadata(originalUri);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to read model metadata: ${msg}`);
    }

    const originalName = metadata.name?.trim() || fallbackName;
    if (!originalName) {
      throw new Error('Android did not provide a valid model filename.');
    }

    if (!originalName.toLowerCase().endsWith('.gguf')) {
      throw new Error(`Invalid model file: "${originalName}". Only GGUF supported.`);
    }

    this.currentModel = {
      originalName,
      workingFileName: 'model.gguf',
      originalUri,
      workingUri: null,
      sizeBytes: metadata.sizeBytes,
      status: 'MODEL_AVAILABLE',
    };

    return this.prepareWorkingCopy();
  }

  private async prepareWorkingCopy(): Promise<ModelInfo> {
    if (!this.currentModel) {
      throw new Error('No model has been selected.');
    }

    this.ensureModelsDirectory();
    this.currentModel.status = 'PREPARING';

    try {
      const destination = new File(
          this.modelsDirectory,
          this.currentModel.workingFileName
      );

      if (destination.exists) {
        destination.delete();
      }

      await ModelFile.copyContentUriToFile(
          this.currentModel.originalUri,
          destination.uri
      );

      const workingFile = new File(destination.uri);
      if (!workingFile.exists || workingFile.size <= 0) {
        throw new Error('Working model copy failed or file is empty.');
      }

      const isGGUF = await ModelFile.isGGUFFile(workingFile.uri);
      if (!isGGUF) {
        workingFile.delete();
        throw new Error('The selected file is not a valid GGUF binary.');
      }

      this.currentModel = {
        ...this.currentModel,
        workingUri: workingFile.uri,
        sizeBytes: workingFile.size,
        status: 'READY_TO_LOAD',
      };

      return this.currentModel;
    } catch (error) {
      this.currentModel.status = 'MODEL_AVAILABLE';
      throw error;
    }
  }

  public getCurrentModel(): ModelInfo | null {
    return this.currentModel;
  }

  public async deleteWorkingCopy(): Promise<void> {
    if (!this.currentModel?.workingUri) return;

    this.currentModel.status = 'CLEANING';
    try {
      const workingFile = new File(this.currentModel.workingUri);
      if (workingFile.exists) {
        workingFile.delete();
      }
      this.currentModel = {
        ...this.currentModel,
        workingUri: null,
        status: 'MODEL_AVAILABLE',
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to delete working model: ${msg}`);
    }
  }
}
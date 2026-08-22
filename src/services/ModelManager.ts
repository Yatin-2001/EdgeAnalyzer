import { Directory, File, Paths } from 'expo-file-system';
import ModelFile, {
  ModelFileMetadata,
} from '../../modules/model-file/src/ModelFileModule';

export type ModelFileStatus =
    | 'NO_MODEL'
    | 'MODEL_AVAILABLE'
    | 'PREPARING'
    | 'READY_TO_LOAD'
    | 'CLEANING';

export interface ModelInfo {
  // Actual filename reported by Android's ContentResolver.
  originalName: string;
  //Filename used by the app's private working copy.
  workingFileName: string;
  // Android content:URI selected by android.
  originalUri: string;
  // App-private file:// URI used by llama.rn.
  workingUri: string | null;
  sizeBytes: number | null;
  status: ModelFileStatus;
}

export class ModelManager {

  private static instance: ModelManager;

  private readonly modelsDirectory: Directory;

  private currentModel: ModelInfo | null = null;

  private constructor() {

    this.modelsDirectory = new Directory(
        Paths.document,
        'models',
    );
  }

  public static getInstance(): ModelManager {

    if (!ModelManager.instance) {
      ModelManager.instance = new ModelManager();
    }

    return ModelManager.instance;
  }

  private ensureModelsDirectory(): void {

    if (!this.modelsDirectory.exists) {

      this.modelsDirectory.create({
        intermediates: true,
      });
    }
  }

  /**
   * Called by the UI after Android's native file picker
   * returns a content:// URI.
   *
   * Android's ContentResolver is used to obtain the
   * actual filename.
   */
  public async selectModel(
      originalUri: string,
      pickerName?: string,
  ): Promise<ModelInfo> {

    if (!originalUri) {
      throw new Error(
          'No model URI was provided.',
      );
    }

    console.log(
        '[ModelManager] Selected URI:',
        originalUri,
    );

    console.log(
        '[ModelManager] Picker name:',
        pickerName,
    );

    /*
     * --------------------------------------------------
     * SAME MODEL ALREADY PREPARED
     * --------------------------------------------------
     *
     * If the user selected exactly the same Android URI
     * again and our working copy still exists, don't copy
     * the model again.
     */
    if (
        this.currentModel &&
        this.currentModel.originalUri === originalUri &&
        this.currentModel.workingUri &&
        this.currentModel.status === 'READY_TO_LOAD'
    ) {

      const workingFile = new File(
          this.currentModel.workingUri,
      );

      if (workingFile.exists && workingFile.size > 0) {

        console.log(
            '[ModelManager] Same model already prepared.',
        );

        console.log(
            '[ModelManager] Reusing working copy:',
            workingFile.uri,
        );

        return this.currentModel;
      }
    }

    /*
     * --------------------------------------------------
     * DIFFERENT MODEL
     * --------------------------------------------------
     *
     * Remove the previous working copy before preparing
     * the new model.
     */
    if (
        this.currentModel &&
        this.currentModel.originalUri !== originalUri
    ) {

      console.log(
          '[ModelManager] Different model selected.',
      );

      await this.deleteWorkingCopy();
    }

    /*
     * --------------------------------------------------
     * GET REAL ANDROID FILE METADATA
     * --------------------------------------------------
     *
     * Do NOT trust pickerName.
     *
     * Android Downloads can return:
     *
     *     msf:18903
     *
     * instead of:
     *
     *     llama-3.2-1b-instruct-q4_k_m.gguf
     */
    let metadata: ModelFileMetadata;

    try {

      metadata =
          await ModelFile.getContentUriMetadata(
              originalUri,
          );

    } catch (error) {

      const message =
          error instanceof Error
              ? error.message
              : String(error);

      throw new Error(
          `Unable to read model metadata: ${message}`,
      );
    }

    const originalName =
        metadata.name?.trim();

    if (!originalName) {

      throw new Error(
          'Android did not provide a valid model filename.',
      );
    }

    console.log(
        '[ModelManager] Android filename:',
        originalName,
    );

    console.log(
        '[ModelManager] Android file size:',
        metadata.sizeBytes,
    );

    if (
        !originalName
            .toLowerCase()
            .endsWith('.gguf')
    ) {

      throw new Error(
          `Invalid model file: "${originalName}". ` +
          'Only GGUF models are supported.',
      );
    }

    /*
     * The working copy always uses a stable filename.
     *
     * This is intentional.
     *
     * The UI displays originalName.
     * llama.rn receives workingUri.
     */
    const workingFileName = 'model.gguf';

    this.currentModel = {

      originalName,

      workingFileName,

      originalUri,

      workingUri: null,

      sizeBytes:
      metadata.sizeBytes,

      status:
          'MODEL_AVAILABLE',
    };

    console.log(
        '[ModelManager] Original model:',
        originalName,
    );

    console.log(
        '[ModelManager] Working model:',
        workingFileName,
    );

    return this.prepareWorkingCopy();
  }

  /**
   * Creates the private app-owned working copy.
   */
  private async prepareWorkingCopy(): Promise<ModelInfo> {

    if (!this.currentModel) {
      throw new Error(
          'No model has been selected.',
      );
    }

    this.ensureModelsDirectory();

    this.currentModel.status =
        'PREPARING';

    try {

      const sourceUri =
          this.currentModel.originalUri;

      console.log(
          '[ModelManager] Preparing model:',
          this.currentModel.originalName,
      );

      console.log(
          '[ModelManager] Source URI:',
          sourceUri,
      );

      const destination =
          new File(
              this.modelsDirectory,
              this.currentModel.workingFileName,
          );

      /*
       * Remove old working copy.
       */
      if (destination.exists) {

        console.log(
            '[ModelManager] Removing existing working copy:',
            destination.uri,
        );

        destination.delete();
      }

      console.log(
          '[ModelManager] Destination:',
          destination.uri,
      );

      /*
       * --------------------------------------------------
       * NATIVE CONTENT URI COPY
       * --------------------------------------------------
       *
       * Java/Kotlin:
       *
       * content://
       *     ↓
       * ContentResolver
       *     ↓
       * app-private file://
       */
      const destinationPath =
          await ModelFile.copyContentUriToFile(
              sourceUri,
              destination.uri,
          );

      console.log(
          '[ModelManager] Native copy completed:',
          destinationPath,
      );

      const workingFile =
          new File(destination.uri);

      if (!workingFile.exists) {

        throw new Error(
            'Working model was not created.',
        );
      }

      const sizeBytes =
          workingFile.size;

      if (
          !sizeBytes ||
          sizeBytes <= 0
      ) {

        throw new Error(
            'Working model is empty.',
        );
      }

      const isGGUF =
          await ModelFile.isGGUFFile(
              workingFile.uri,
          );

      if (!isGGUF) {

        workingFile.delete();

        throw new Error(
            'The selected file is not a valid GGUF model.',
        );
      }


      this.currentModel = {

        ...this.currentModel,

        workingUri:
        workingFile.uri,

        sizeBytes,

        status:
            'READY_TO_LOAD',
      };

      console.log(
          '[ModelManager] Working model ready:',
          workingFile.uri,
      );

      console.log(
          '[ModelManager] Original model name:',
          this.currentModel.originalName,
      );

      console.log(
          '[ModelManager] Working model name:',
          this.currentModel.workingFileName,
      );

      console.log(
          '[ModelManager] Working model size:',
          sizeBytes,
      );

      return this.currentModel;

    } catch (error) {

      this.currentModel.status =
          'MODEL_AVAILABLE';

      const message =
          error instanceof Error
              ? error.message
              : String(error);

      console.error(
          '[ModelManager] Failed to prepare model:',
          message,
      );

      throw new Error(
          `Failed to prepare model: ${message}`,
      );
    }
  }


  public getCurrentModel():
      ModelInfo | null {

    return this.currentModel;
  }

  /**
   * Deletes ONLY the app-owned working copy.
   *
   * The original user-selected model is NEVER touched.
   */
  public async deleteWorkingCopy(): Promise<void> {

    if (
        !this.currentModel?.workingUri
    ) {
      return;
    }

    this.currentModel.status =
        'CLEANING';

    try {

      const workingFile =
          new File(
              this.currentModel.workingUri,
          );

      if (workingFile.exists) {

        console.log(
            '[ModelManager] Deleting working copy:',
            workingFile.uri,
        );

        workingFile.delete();
      }

      this.currentModel = {

        ...this.currentModel,

        workingUri:
            null,

        status:
            'MODEL_AVAILABLE',
      };

    } catch (error) {

      const message =
          error instanceof Error
              ? error.message
              : String(error);

      throw new Error(
          `Failed to delete working model: ${message}`,
      );
    }
  }
}
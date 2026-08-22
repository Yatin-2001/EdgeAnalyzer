import { requireNativeModule } from 'expo-modules-core';

export interface ModelFileMetadata {
  name: string;
  sizeBytes: number | null;
}

interface ModelFileModule {
  copyContentUriToFile(
      sourceUri: string,
      destinationPath: string,
  ): Promise<string>;

  getContentUriMetadata(
      uri: string,
  ): Promise<ModelFileMetadata>;

  isGGUFFile(
      fileUri: string,
  ): Promise<boolean>;
}

const ModelFile =
    requireNativeModule<ModelFileModule>('ModelFile');

export default ModelFile;
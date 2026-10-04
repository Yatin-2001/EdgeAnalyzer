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

  // Worker Lifecycle & Dynamic Model Sync
  startWorkerService(): Promise<boolean>;
  stopWorkerService(): Promise<boolean>;
  setWorkerActiveModel(modelName: string): Promise<boolean>;

  // Token Streaming Bridge from React Native to Native HTTP Server
  pushWorkerToken(requestId: string, token: string): Promise<boolean>;
  finishWorkerInference(requestId: string): Promise<boolean>;

  // Expo Native Event Subscription
  addListener(eventName: string, listener: (event: any) => void): { remove: () => void };
  removeListener?(eventName: string, listener: (event: any) => void): void;
}

const ModelFile = requireNativeModule<ModelFileModule>('ModelFile');

export default ModelFile;
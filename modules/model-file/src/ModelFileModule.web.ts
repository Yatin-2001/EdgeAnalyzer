import { registerWebModule, NativeModule } from 'expo';

import { ModelFileModuleEvents } from './ModelFile.types';

class ModelFileModule extends NativeModule<ModelFileModuleEvents> {
  PI = Math.PI;
  async setValueAsync(value: string): Promise<void> {
    this.emit('onChange', { value });
  }
  hello() {
    return 'Hello world! 👋';
  }
}

export default registerWebModule(ModelFileModule, 'ModelFileModule');

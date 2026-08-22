import { requireNativeView } from 'expo';
import * as React from 'react';

import { ModelFileViewProps } from './ModelFile.types';

const NativeView: React.ComponentType<ModelFileViewProps> =
  requireNativeView('ModelFile');

export default function ModelFileView(props: ModelFileViewProps) {
  return <NativeView {...props} />;
}

import * as React from 'react';

import { ModelFileViewProps } from './ModelFile.types';

export default function ModelFileView(props: ModelFileViewProps) {
  return (
    <div>
      <iframe
        style={{ flex: 1 }}
        src={props.url}
        onLoad={() => props.onLoad({ nativeEvent: { url: props.url } })}
      />
    </div>
  );
}

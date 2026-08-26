import { File } from 'expo-file-system';

export type ModalityType = 'TEXT_DOC' | 'STANDALONE_IMAGE';

export interface InspectedAsset {
    id: string;
    name: string;
    uri: string;
    type: ModalityType;
    mimeType: string;
    sizeBytes: number;
    extractedText?: string;
    estimatedTokens: number;
}

export class DocumentInspectorService {
    private static instance: DocumentInspectorService;

    public static getInstance(): DocumentInspectorService {
        if (!DocumentInspectorService.instance) {
            DocumentInspectorService.instance = new DocumentInspectorService();
        }
        return DocumentInspectorService.instance;
    }

    public async inspectAsset(
        name: string,
        uri: string,
        mimeType: string
    ): Promise<InspectedAsset> {
        const file = new File(uri);
        const sizeBytes = file.exists ? file.size : 0;
        const id = `asset_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(name)) {
            return {
                id,
                name,
                uri,
                type: 'STANDALONE_IMAGE',
                mimeType: mimeType || 'image/jpeg',
                sizeBytes,
                estimatedTokens: 320,
            };
        }

        if (
            mimeType.includes('text') ||
            /\.(txt|md|json|csv|py|js|ts|tsx|html|css)$/i.test(name)
        ) {
            let content = '';
            try {
                content = await file.text();
            } catch {
                content = '';
            }

            const estimatedTokens = Math.ceil(content.length / 4);

            return {
                id,
                name,
                uri,
                type: 'TEXT_DOC',
                mimeType: mimeType || 'text/plain',
                sizeBytes,
                extractedText: content,
                estimatedTokens,
            };
        }

        if (mimeType.includes('pdf') || name.toLowerCase().endsWith('.pdf')) {
            let rawText = '';
            try {
                const rawContent = await file.text();
                rawText = rawContent
                    .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            } catch {
                rawText = '[Searchable text stream could not be decoded.]';
            }

            const clamped = rawText.substring(0, 8000);
            return {
                id,
                name,
                uri,
                type: 'TEXT_DOC',
                mimeType,
                sizeBytes,
                extractedText: clamped,
                estimatedTokens: Math.ceil(clamped.length / 4),
            };
        }

        return {
            id,
            name,
            uri,
            type: 'TEXT_DOC',
            mimeType,
            sizeBytes,
            extractedText: '',
            estimatedTokens: 0,
        };
    }

    public assembleDocumentContext(assets: InspectedAsset[], maxTokens = 2000): string {
        const textAssets = assets.filter((a) => a.extractedText);
        if (textAssets.length === 0) return '';

        let assembled = '### ATTACHED DOCUMENT CONTEXT:\n';
        let currentTokens = 0;

        for (const asset of textAssets) {
            const header = `\n--- Resource: ${asset.name} ---\n`;
            const content = asset.extractedText || '';
            const docTokens = asset.estimatedTokens;

            if (currentTokens + docTokens <= maxTokens) {
                assembled += `${header}${content}\n`;
                currentTokens += docTokens;
            } else {
                const remainingChars = Math.max((maxTokens - currentTokens) * 4, 0);
                if (remainingChars > 100) {
                    assembled += `${header}${content.substring(0, remainingChars)}... [TRUNCATED]\n`;
                }
                break;
            }
        }

        return assembled;
    }
}
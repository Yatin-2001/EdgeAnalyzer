import * as ImageManipulator from 'expo-image-manipulator';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import { File } from 'expo-file-system';

export type ModalityType = 'TEXT_DOC' | 'STANDALONE_IMAGE';

export interface InspectedAsset {
    id: string;
    name: string;
    originalUri: string;
    downscaledUri?: string; // 448px JPEG for VLM
    type: ModalityType;
    mimeType: string;
    sizeBytes: number;
    extractedText?: string; // High-res ML Kit OCR text or doc content
    estimatedTokens: number;
    isProcessing: boolean;
    ocrConfidence?: string;
}

export class DocumentInspectorService {
    private static instance: DocumentInspectorService;

    public static getInstance(): DocumentInspectorService {
        if (!DocumentInspectorService.instance) {
            DocumentInspectorService.instance = new DocumentInspectorService();
        }
        return DocumentInspectorService.instance;
    }

    public async inspectAndPreprocessAsset(
        name: string,
        uri: string,
        mimeType: string
    ): Promise<InspectedAsset> {
        const id = `asset_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        let sizeBytes = 0;

        try {
            const file = new File(uri);
            if (file.exists) {
                sizeBytes = file.size;
            }
        } catch {
            sizeBytes = 0;
        }

        // 1. Image Modality: Full-Res OCR -> 448px Downscaling
        if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(name)) {
            let ocrText = '';
            let downscaledUri = uri;

            // Step A: ML Kit OCR with safe URI handling
            try {
                const ocrUri = uri.startsWith('file://') || uri.startsWith('content://') ? uri : `file://${uri}`;
                const ocrResult = await TextRecognition.recognize(ocrUri);
                ocrText = ocrResult?.text ? ocrResult.text.trim() : '';
            } catch (ocrErr) {
                console.warn('[Inspector] ML Kit OCR skipped/failed:', ocrErr);
            }

            // Step B: Downscale longest edge to 448px to cap visual tokens
            try {
                const manipResult = await ImageManipulator.manipulateAsync(
                    uri,
                    [{ resize: { width: 448 } }],
                    {
                        compress: 0.75,
                        format: ImageManipulator.SaveFormat.JPEG,
                    }
                );
                downscaledUri = manipResult.uri;
            } catch (scaleErr) {
                console.warn('[Inspector] Downscaling fallback to original URI:', scaleErr);
                downscaledUri = uri;
            }

            return {
                id,
                name,
                originalUri: uri,
                downscaledUri,
                type: 'STANDALONE_IMAGE',
                mimeType: 'image/jpeg',
                sizeBytes,
                extractedText: ocrText,
                estimatedTokens: 256 + Math.ceil(ocrText.length / 4),
                isProcessing: false,
                ocrConfidence: ocrText.length > 20 ? 'HIGH_DENSITY_TEXT' : 'SCENE_IMAGE',
            };
        }

        // 2. Text / Code Document Modality
        if (
            mimeType.includes('text') ||
            /\.(txt|md|json|csv|py|js|ts|tsx|html|css)$/i.test(name)
        ) {
            let content = '';
            try {
                const file = new File(uri);
                content = await file.text();
            } catch {
                content = '';
            }

            return {
                id,
                name,
                originalUri: uri,
                type: 'TEXT_DOC',
                mimeType: mimeType || 'text/plain',
                sizeBytes,
                extractedText: content,
                estimatedTokens: Math.ceil(content.length / 4),
                isProcessing: false,
            };
        }

        // 3. Searchable PDF Modality
        if (mimeType.includes('pdf') || name.toLowerCase().endsWith('.pdf')) {
            let rawText = '';
            try {
                const file = new File(uri);
                const rawContent = await file.text();
                rawText = rawContent
                    .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
            } catch {
                rawText = '';
            }

            const clamped = rawText.substring(0, 6000);
            return {
                id,
                name,
                originalUri: uri,
                type: 'TEXT_DOC',
                mimeType,
                sizeBytes,
                extractedText: clamped,
                estimatedTokens: Math.ceil(clamped.length / 4),
                isProcessing: false,
            };
        }

        return {
            id,
            name,
            originalUri: uri,
            type: 'TEXT_DOC',
            mimeType,
            sizeBytes,
            extractedText: '',
            estimatedTokens: 0,
            isProcessing: false,
        };
    }

    public assemblePromptContext(assets: InspectedAsset[], userQuery: string): string {
        const textDocs = assets.filter((a) => a.type === 'TEXT_DOC' && a.extractedText);
        const imageAsset = assets.find((a) => a.type === 'STANDALONE_IMAGE');

        let contextBlock = '';

        if (textDocs.length > 0) {
            contextBlock += '### ATTACHED DOCUMENT CONTEXT:\n';
            for (const doc of textDocs) {
                contextBlock += `--- ${doc.name} ---\n${doc.extractedText}\n\n`;
            }
        }

        if (imageAsset?.extractedText && imageAsset.extractedText.length > 15) {
            contextBlock += `### HIGH-PRECISION ON-SCREEN TEXT & OCR:\n${imageAsset.extractedText}\n\n`;
        }

        if (!contextBlock) {
            return userQuery || 'Describe and analyze this content in detail.';
        }

        return `${contextBlock}### USER QUESTION:\n${userQuery || 'Analyze the attached content based on the data above.'}`;
    }
}
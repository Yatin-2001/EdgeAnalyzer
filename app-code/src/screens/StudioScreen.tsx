import React, { useState, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    Image,
    FlatList,
    Alert,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
    DocumentInspectorService,
    InspectedAsset,
} from '../services/DocumentInspectorService';
import { LLMService, PerformanceMetrics } from '../services/LLMService';
import { ToolOrchestrator } from '../services/ToolOrchestrator';
import { ModelRegistryModal } from '../components/ModelRegistryModal';
import { ModelRecord } from '../database/repository';



export interface StudioMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

interface Props {
    onBackToChat?: () => void;
    onSelectModel?: (model: ModelRecord) => Promise<void>;
}

export const StudioScreen: React.FC<Props> = ({ onBackToChat, onSelectModel }) => {
    const insets = useSafeAreaInsets();
    const llm = LLMService.getInstance();
    const inspector = DocumentInspectorService.getInstance();
    const orchestrator = ToolOrchestrator.getInstance();
    const flatListRef = useRef<FlatList>(null);

    // Asset & Chat State
    const [assets, setAssets] = useState<InspectedAsset[]>([]);
    const [messages, setMessages] = useState<StudioMessage[]>([]);
    const [prompt, setPrompt] = useState('');
    const [streamingContent, setStreamingContent] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
    const [isRegistryOpen, setRegistryOpen] = useState(false);

    // Flag: Has the visual baseline already been established through mmproj?
    const [isVisualGrounded, setIsVisualGrounded] = useState(false);

    const activeImage = assets.find((a) => a.type === 'STANDALONE_IMAGE');
    const isImagePreProcessing = !!activeImage?.isProcessing;
    const activeModel = llm.getLoadedModel();

    let badgeLabel = 'No Model Loaded';
    if (activeModel) {
        badgeLabel = activeModel.isVisionCapable
            ? `Vision • ${activeModel.name}`
            : `Text • ${activeModel.name}`;
    }

    // Reset entire Studio session and visual baseline
    const handleResetStudio = () => {
        setAssets([]);
        setMessages([]);
        setPrompt('');
        setStreamingContent('');
        setIsVisualGrounded(false);
        setMetrics(null);
    };

    const handleProcessImage = async (uri: string, name: string) => {
        // A new image resets previous chat context
        setMessages([]);
        setIsVisualGrounded(false);

        const tempId = `temp_${Date.now()}`;
        const placeholderAsset: InspectedAsset = {
            id: tempId,
            name,
            originalUri: uri,
            type: 'STANDALONE_IMAGE',
            mimeType: 'image/jpeg',
            sizeBytes: 0,
            estimatedTokens: 256,
            isProcessing: true,
        };

        setAssets((prev) => [...prev.filter((a) => a.type !== 'STANDALONE_IMAGE'), placeholderAsset]);

        try {
            const processed = await inspector.inspectAndPreprocessAsset(name, uri, 'image/jpeg');
            setAssets((prev) => prev.map((a) => (a.id === tempId ? processed : a)));
        } catch {
            setAssets((prev) => prev.filter((a) => a.id !== tempId));
            Alert.alert('Processing Error', 'Failed to preprocess image.');
        }
    };

    const handleTakePhoto = async () => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('Permission Denied', 'Camera access is required.');
            return;
        }

        const res = await ImagePicker.launchCameraAsync({
            quality: 0.85,
            allowsEditing: false,
        });

        if (!res.canceled && res.assets[0]) {
            const file = res.assets[0];
            await handleProcessImage(file.uri, file.fileName || 'camera_capture.jpg');
        }
    };

    const handlePickImage = async () => {
        const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.85,
            allowsMultipleSelection: false,
        });

        if (!res.canceled && res.assets[0]) {
            const file = res.assets[0];
            await handleProcessImage(file.uri, file.fileName || 'gallery_image.jpg');
        }
    };

    const handleImportDoc = async () => {
        const res = await DocumentPicker.getDocumentAsync({
            type: ['text/*', 'application/pdf'],
            copyToCacheDirectory: true,
            multiple: false,
        });

        if (!res.canceled && res.assets?.[0]) {
            const file = res.assets[0];
            const inspected = await inspector.inspectAndPreprocessAsset(
                file.name,
                file.uri,
                file.mimeType || 'text/plain'
            );
            setAssets((prev) => [...prev.filter((a) => a.type !== 'TEXT_DOC'), inspected]);
        }
    };

    const handleSendMessage = async () => {
        const userQuery = prompt.trim();
        if (!userQuery && assets.length === 0) return;

        if (isImagePreProcessing) {
            Alert.alert('Please Wait', 'Image is still running OCR & compression.');
            return;
        }

        if (!llm.isReady()) {
            Alert.alert('No Model Loaded', 'Tap the model badge above to select a model.');
            return;
        }

        if (activeImage && !llm.isVisionCapable()) {
            Alert.alert(
                'Vision Model Required',
                'An image is attached, but the active model is text-only. Load a vision pair (e.g. Qwen2-VL or SmolVLM) in Settings.'
            );
            return;
        }

        const effectiveUserText = userQuery || 'Describe and analyze the attached image in detail.';
        const userMsg: StudioMessage = {
            id: `usr_${Date.now()}`,
            role: 'user',
            content: effectiveUserText,
        };

        const updatedHistory = [...messages, userMsg];
        setMessages(updatedHistory);
        setPrompt('');
        setIsGenerating(true);
        setStreamingContent('');

        try {
            // 1. Determine if this turn requires raw mmproj evaluation
            const isFirstVisualTurn = !isVisualGrounded && !!activeImage?.downscaledUri;

            let promptPayload = '';
            const baseSystem = 'You are an intelligent multimodal AI assistant analyzing documents, images, and screens.';

            if (isFirstVisualTurn) {
                // Turn 1: Ground visual context with OCR text block
                const formattedSystem = orchestrator.formatSystemPromptWithTools(baseSystem, effectiveUserText);
                const docAndOcrContext = inspector.assemblePromptContext(assets, effectiveUserText);

                promptPayload =
                    `<|im_start|>system\n${formattedSystem}<|im_end|>\n` +
                    `<|im_start|>user\n${docAndOcrContext}<|im_end|>\n` +
                    `<|im_start|>assistant\n`;
            } else {
                // Turn 2+: Standard conversational context (bypasses mmproj for ~120ms TTFT)
                let conversationTurns = '';
                for (const msg of updatedHistory) {
                    conversationTurns += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
                }

                const formattedSystem = orchestrator.formatSystemPromptWithTools(baseSystem, effectiveUserText);
                promptPayload =
                    `<|im_start|>system\n${formattedSystem}<|im_end|>\n` +
                    conversationTurns +
                    `<|im_start|>assistant\n`;
            }

            // 2. Execute via ToolOrchestrator
            const { fullText, metrics: genMetrics } = await orchestrator.executeAgentLoop(
                promptPayload,
                effectiveUserText,
                {
                    onToken: (tok) => setStreamingContent((prev) => prev + tok),
                    onMetrics: (m) => setMetrics(m),
                    onToolCallDetected: (toolName, _, step) => {
                        setStreamingContent(
                            (prev) => prev + `⚙️ [Step ${step}] Executing tool: ${toolName}...\n`
                        );
                    },
                    onToolExecutionCompleted: (toolName, res, step) => {
                        setStreamingContent(
                            (prev) =>
                                prev + `✓ [Step ${step}] ${toolName} completed (${res.executionTimeMs}ms)\n\n`
                        );
                    },
                },
                {
                    imagePaths: isFirstVisualTurn ? [activeImage!.downscaledUri!] : undefined,
                }
            );

            setMessages((prev) => [
                ...prev,
                {
                    id: `asst_${Date.now()}`,
                    role: 'assistant',
                    content: fullText,
                },
            ]);

            if (isFirstVisualTurn) {
                setIsVisualGrounded(true); // Visual baseline is now cached in conversation history
            }
        } catch (error) {
            setMessages((prev) => [
                ...prev,
                {
                    id: `err_${Date.now()}`,
                    role: 'assistant',
                    content: `Inference Error: ${String(error)}`,
                },
            ]);
        } finally {
            setStreamingContent('');
            setIsGenerating(false);
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                {onBackToChat && (
                    <TouchableOpacity style={styles.backBtn} onPress={onBackToChat}>
                        <Text style={styles.backBtnText}>‹ Chat</Text>
                    </TouchableOpacity>
                )}

                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle}>Studio</Text>
                    <TouchableOpacity
                        style={[
                            styles.badge,
                            activeModel?.isVisionCapable ? styles.badgeVision : styles.badgeText,
                        ]}
                        onPress={() => setRegistryOpen(true)}
                        activeOpacity={0.7}
                    >
                        <Text style={styles.badgeLabel} numberOfLines={1} ellipsizeMode="tail">
                            {badgeLabel} ▾
                        </Text>
                    </TouchableOpacity>
                </View>

                <TouchableOpacity style={styles.resetBtn} onPress={handleResetStudio}>
                    <Text style={styles.resetText}>Reset</Text>
                </TouchableOpacity>
            </View>

            {/* Action Buttons */}
            <View style={styles.actionBar}>
                <TouchableOpacity style={styles.actionBtn} onPress={handleTakePhoto}>
                    <Text style={styles.actionBtnText}>📷 Photo</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={handlePickImage}>
                    <Text style={styles.actionBtnText}>🖼️ Image (Max 1)</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={handleImportDoc}>
                    <Text style={styles.actionBtnText}>📄 Doc / PDF</Text>
                </TouchableOpacity>
            </View>

            {/* Active Image / Document Card */}
            {assets.length > 0 && (
                <View style={styles.assetContainer}>
                    {assets.map((item) => (
                        <View key={item.id} style={styles.assetCard}>
                            {item.type === 'STANDALONE_IMAGE' ? (
                                <View style={styles.imageWrap}>
                                    <Image
                                        source={{ uri: item.downscaledUri || item.originalUri }}
                                        style={styles.thumbImage}
                                    />
                                    {item.isProcessing && (
                                        <View style={styles.processingOverlay}>
                                            <ActivityIndicator color="#38BDF8" size="small" />
                                            <Text style={styles.processingText}>Running OCR & Compression...</Text>
                                        </View>
                                    )}
                                </View>
                            ) : (
                                <View style={styles.docWrap}>
                                    <Text style={styles.docIcon}>📄</Text>
                                    <Text style={styles.docName} numberOfLines={1}>
                                        {item.name}
                                    </Text>
                                </View>
                            )}

                            <View style={styles.assetFooter}>
                                <Text style={styles.tokenText}>
                                    {item.isProcessing
                                        ? 'Preprocessing...'
                                        : item.extractedText
                                            ? `✓ OCR Found (${item.extractedText.length} chars) • Grounded`
                                            : `~${item.estimatedTokens} visual tokens`}
                                </Text>
                                <TouchableOpacity
                                    onPress={() => {
                                        setAssets((prev) => prev.filter((a) => a.id !== item.id));
                                        setIsVisualGrounded(false);
                                    }}
                                >
                                    <Text style={styles.deleteText}>✕</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    ))}
                </View>
            )}

            {/* Telemetry Bar */}
            {metrics && (
                <View style={styles.telemetryBar}>
                    <Text style={styles.telemetryText}>
                        Speed: {metrics.tokensPerSecond} t/s | TTFT: {metrics.ttftMs}ms | Generated: {metrics.totalTokens} tokens
                    </Text>
                </View>
            )}

            {/* Multi-Turn Studio Chat Stream */}
            <KeyboardAvoidingView
                style={styles.flexFill}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <FlatList
                    ref={flatListRef}
                    data={messages}
                    keyExtractor={(item) => item.id}
                    style={styles.messageList}
                    contentContainerStyle={[styles.messageListContent, { paddingBottom: 16 }]}
                    keyboardShouldPersistTaps="handled"
                    onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyTitle}>Ephemeral Visual Workspace</Text>
                            <Text style={styles.emptyDesc}>
                                Take a photo or pick an image above. Ask questions, extract text, or invoke tools
                                (e.g., search the creator or calculate items in frame). Subsequent questions will
                                stream with fast text-level TTFT.
                            </Text>
                        </View>
                    }
                    renderItem={({ item }) => (
                        <View
                            style={[
                                styles.bubble,
                                item.role === 'user' ? styles.userBubble : styles.assistantBubble,
                            ]}
                        >
                            <Text style={styles.bubbleText}>{item.content}</Text>
                        </View>
                    )}
                    ListFooterComponent={
                        streamingContent ? (
                            <View style={[styles.bubble, styles.assistantBubble]}>
                                <Text style={styles.bubbleText}>{streamingContent}</Text>
                            </View>
                        ) : null
                    }
                />

                {/* Input Bar */}
                <View style={[styles.inputContainer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
                    <TextInput
                        style={styles.textInput}
                        placeholder={
                            isGenerating
                                ? 'Generating response...'
                                : isImagePreProcessing
                                    ? 'Preprocessing image...'
                                    : 'Ask a question about this image/doc...'
                        }
                        placeholderTextColor="#64748B"
                        value={prompt}
                        onChangeText={setPrompt}
                        editable={!isGenerating && !isImagePreProcessing}
                        multiline
                    />

                    {isGenerating ? (
                        <TouchableOpacity style={styles.stopBtn} onPress={() => llm.stopCompletion()}>
                            <Text style={styles.btnText}>Stop</Text>
                        </TouchableOpacity>
                    ) : (
                        <TouchableOpacity
                            style={[
                                styles.sendBtn,
                                (!prompt.trim() && assets.length === 0) && styles.disabledBtn,
                            ]}
                            onPress={handleSendMessage}
                            disabled={(!prompt.trim() && assets.length === 0) || isImagePreProcessing}
                        >
                            <Text style={styles.btnText}>Send</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </KeyboardAvoidingView>

            {/* Direct Model Switcher Modal inside Studio */}
            <ModelRegistryModal
                visible={isRegistryOpen}
                onClose={() => setRegistryOpen(false)}
                onSelectChatModel={async (model) => {
                    setRegistryOpen(false);
                    if (onSelectModel) {
                        await onSelectModel(model);
                    }
                }}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0F172A' },
    flexFill: { flex: 1 },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#1E293B',
    },
    backBtn: { paddingVertical: 4, paddingHorizontal: 8, flexShrink: 0 },
    backBtnText: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
    headerCenter: { flex: 1, marginHorizontal: 8, alignItems: 'center' },
    headerTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
    badge: { maxWidth: '100%', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, marginTop: 2 },
    badgeText: { backgroundColor: '#0284C720' },
    badgeVision: { backgroundColor: '#10B98120' },
    badgeLabel: { color: '#38BDF8', fontSize: 11, fontWeight: '700', flexShrink: 1 },
    resetBtn: { backgroundColor: '#334155', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, flexShrink: 0 },
    resetText: { color: '#F8FAFC', fontSize: 12, fontWeight: '600' },
    actionBar: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 8, gap: 8 },
    actionBtn: {
        flex: 1,
        backgroundColor: '#1E293B',
        paddingVertical: 8,
        borderRadius: 8,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#334155',
    },
    actionBtnText: { color: '#F8FAFC', fontSize: 12, fontWeight: '600' },
    assetContainer: { paddingHorizontal: 16, marginBottom: 6 },
    assetCard: { backgroundColor: '#1E293B', borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: '#334155' },
    imageWrap: { width: '100%', height: 100, backgroundColor: '#0F172A', position: 'relative' },
    thumbImage: { width: '100%', height: '100%', resizeMode: 'cover' },
    processingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(15, 23, 42, 0.85)',
        justifyContent: 'center',
        alignItems: 'center',
        gap: 6,
    },
    processingText: { color: '#38BDF8', fontSize: 12, fontWeight: '600' },
    docWrap: { height: 50, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8, backgroundColor: '#0F172A' },
    docIcon: { fontSize: 18 },
    docName: { color: '#F8FAFC', fontSize: 12, flex: 1 },
    assetFooter: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        paddingVertical: 5,
        backgroundColor: '#1E293B',
        alignItems: 'center',
    },
    tokenText: { color: '#94A3B8', fontSize: 11 },
    deleteText: { color: '#EF4444', fontSize: 13, fontWeight: '700', paddingHorizontal: 4 },
    telemetryBar: { backgroundColor: '#0284C715', paddingVertical: 4, alignItems: 'center' },
    telemetryText: { color: '#38BDF8', fontSize: 11, fontFamily: 'monospace' },
    messageList: { flex: 1, paddingHorizontal: 16 },
    messageListContent: { paddingTop: 12 },
    emptyContainer: { padding: 24, alignItems: 'center', marginTop: 40 },
    emptyTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', marginBottom: 8 },
    emptyDesc: { color: '#64748B', fontSize: 13, textAlign: 'center', lineHeight: 20 },
    bubble: { maxWidth: '85%', padding: 12, borderRadius: 12, marginBottom: 10 },
    userBubble: { backgroundColor: '#2563EB', alignSelf: 'flex-end', borderBottomRightRadius: 2 },
    assistantBubble: { backgroundColor: '#1E293B', alignSelf: 'flex-start', borderBottomLeftRadius: 2 },
    bubbleText: { color: '#F8FAFC', fontSize: 14, lineHeight: 20 },
    inputContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingTop: 8,
        backgroundColor: '#0F172A',
        borderTopWidth: 1,
        borderTopColor: '#1E293B',
        gap: 8,
    },
    textInput: {
        flex: 1,
        backgroundColor: '#1E293B',
        color: '#F8FAFC',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 14,
        maxHeight: 90,
    },
    sendBtn: { backgroundColor: '#2563EB', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
    stopBtn: { backgroundColor: '#DC2626', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
    disabledBtn: { opacity: 0.4 },
    btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
});
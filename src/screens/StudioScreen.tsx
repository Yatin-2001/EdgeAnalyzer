import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    ScrollView,
    Image,
    FlatList,
    Alert,
    ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import {
    DocumentInspectorService,
    InspectedAsset,
} from '../services/DocumentInspectorService';
import { LLMService, PerformanceMetrics } from '../services/LLMService';

interface Props {
    onBackToChat?: () => void;
}

export const StudioScreen: React.FC<Props> = ({ onBackToChat }) => {
    const insets = useSafeAreaInsets();
    const llm = LLMService.getInstance();
    const inspector = DocumentInspectorService.getInstance();

    const [assets, setAssets] = useState<InspectedAsset[]>([]);
    const [prompt, setPrompt] = useState('');
    const [output, setOutput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);

    const hasImages = assets.some((a) => a.type === 'STANDALONE_IMAGE');
    const activeModel = llm.getLoadedModel();

    let badgeLabel = 'Text Engine • CPU/GPU';
    if (hasImages) {
        badgeLabel = activeModel?.isVisionCapable
            ? `Vision Engine • ${activeModel.name} (GPU)`
            : '⚠️ Image attached (Load Vision/mmproj Model)';
    } else if (activeModel) {
        badgeLabel = `Text Engine • ${activeModel.name} (GPU)`;
    }

    const handleTakePhoto = async () => {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
            Alert.alert('Permission Denied', 'Camera access is required to take photos.');
            return;
        }

        const res = await ImagePicker.launchCameraAsync({
            quality: 0.8,
            allowsEditing: false,
        });

        if (!res.canceled && res.assets[0]) {
            const file = res.assets[0];
            const inspected = await inspector.inspectAsset(
                file.fileName || 'camera_capture.jpg',
                file.uri,
                file.mimeType || 'image/jpeg'
            );
            setAssets((prev) => [...prev, inspected]);
        }
    };

    const handlePickImage = async () => {
        const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.8,
            allowsMultipleSelection: true,
        });

        if (!res.canceled) {
            for (const file of res.assets) {
                const inspected = await inspector.inspectAsset(
                    file.fileName || 'gallery_image.jpg',
                    file.uri,
                    file.mimeType || 'image/jpeg'
                );
                setAssets((prev) => [...prev, inspected]);
            }
        }
    };

    const handleImportDoc = async () => {
        const res = await DocumentPicker.getDocumentAsync({
            type: ['text/*', 'application/pdf'],
            copyToCacheDirectory: true,
            multiple: true,
        });

        if (!res.canceled && res.assets) {
            for (const file of res.assets) {
                const inspected = await inspector.inspectAsset(
                    file.name,
                    file.uri,
                    file.mimeType || 'text/plain'
                );
                setAssets((prev) => [...prev, inspected]);
            }
        }
    };

    const handleExecuteStudio = async () => {
        if (!prompt.trim() && assets.length === 0) {
            Alert.alert('Input Required', 'Provide a prompt or attach documents/images to analyze.');
            return;
        }

        if (!llm.isReady()) {
            Alert.alert('No Model Loaded', 'Please load a GGUF model in the chat screen before running Studio analysis.');
            return;
        }

        const imageAssets = assets.filter((a) => a.type === 'STANDALONE_IMAGE');
        if (imageAssets.length > 0 && !llm.isVisionCapable()) {
            Alert.alert(
                'Vision Model Required',
                'You attached an image, but the loaded model does not have an active mmproj projector. Load a Vision Model pair (e.g. Qwen2-VL) or remove the image.'
            );
            return;
        }

        setIsProcessing(true);
        setOutput('');
        setMetrics(null);

        try {
            const docContext = inspector.assembleDocumentContext(assets, 2000);

            let finalPrompt = prompt.trim() || 'Analyze the attached content in detail.';
            if (docContext) {
                finalPrompt = `${docContext}\n\nUser Question: ${finalPrompt}`;
            }

            await llm.streamCompletion(
                {
                    prompt: finalPrompt,
                    imagePaths: imageAssets.map((a) => a.uri),
                    nPredict: 512,
                    temperature: 0.2,
                },
                {
                    onToken: (token) => setOutput((prev) => prev + token),
                    onMetrics: (m) => setMetrics(m),
                }
            );
        } catch (error) {
            Alert.alert('Studio Inference Error', String(error));
        } finally {
            setIsProcessing(false);
        }
    };

    const handleResetStudio = () => {
        setAssets([]);
        setPrompt('');
        setOutput('');
        setMetrics(null);
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <View style={styles.headerLeft}>
                    {onBackToChat && (
                        <TouchableOpacity style={styles.backBtn} onPress={onBackToChat}>
                            <Text style={styles.backBtnText}>‹ Chat</Text>
                        </TouchableOpacity>
                    )}
                    <View>
                        <Text style={styles.headerTitle}>Document & Image Studio</Text>
                        <View style={[styles.badge, hasImages ? styles.badgeVision : styles.badgeText]}>
                            <Text style={styles.badgeLabel}>{badgeLabel}</Text>
                        </View>
                    </View>
                </View>

                <TouchableOpacity style={styles.resetBtn} onPress={handleResetStudio}>
                    <Text style={styles.resetText}>Reset</Text>
                </TouchableOpacity>
            </View>

            <View style={styles.actionBar}>
                <TouchableOpacity style={styles.actionBtn} onPress={handleTakePhoto}>
                    <Text style={styles.actionBtnText}>📷 Take Photo</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={handlePickImage}>
                    <Text style={styles.actionBtnText}>🖼️ Pick Image</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionBtn} onPress={handleImportDoc}>
                    <Text style={styles.actionBtnText}>📄 Import Doc</Text>
                </TouchableOpacity>
            </View>

            {assets.length > 0 && (
                <FlatList
                    data={assets}
                    horizontal
                    keyExtractor={(item) => item.id}
                    style={styles.carousel}
                    contentContainerStyle={styles.carouselContent}
                    showsHorizontalScrollIndicator={false}
                    renderItem={({ item }) => (
                        <View style={styles.card}>
                            {item.type === 'STANDALONE_IMAGE' ? (
                                <Image source={{ uri: item.uri }} style={styles.thumbImage} />
                            ) : (
                                <View style={styles.docPlaceholder}>
                                    <Text style={styles.docIcon}>📄</Text>
                                    <Text style={styles.docName} numberOfLines={2}>
                                        {item.name}
                                    </Text>
                                </View>
                            )}
                            <View style={styles.cardMeta}>
                                <Text style={styles.metaText}>~{item.estimatedTokens} tok</Text>
                                <TouchableOpacity
                                    onPress={() => setAssets((prev) => prev.filter((a) => a.id !== item.id))}
                                >
                                    <Text style={styles.deleteText}>✕</Text>
                                </TouchableOpacity>
                            </View>
                        </View>
                    )}
                />
            )}

            <View style={styles.promptContainer}>
                <TextInput
                    style={styles.promptInput}
                    placeholder="Ask a question about the attached documents or images..."
                    placeholderTextColor="#64748B"
                    value={prompt}
                    onChangeText={setPrompt}
                    multiline
                />
                <TouchableOpacity
                    style={[styles.runBtn, isProcessing && styles.stopBtn]}
                    onPress={isProcessing ? () => llm.stopCompletion() : handleExecuteStudio}
                >
                    <Text style={styles.runBtnText}>{isProcessing ? 'Stop' : 'Analyze'}</Text>
                </TouchableOpacity>
            </View>

            {metrics && (
                <View style={styles.telemetryBar}>
                    <Text style={styles.telemetryText}>
                        ⚡ {metrics.tokensPerSecond} t/s | TTFT: {metrics.ttftMs}ms | Generated: {metrics.totalTokens} tokens
                    </Text>
                </View>
            )}

            <ScrollView style={styles.outputScroll} contentContainerStyle={styles.outputContent}>
                {isProcessing && !output && (
                    <View style={styles.loadingBox}>
                        <ActivityIndicator color="#38BDF8" size="small" />
                        <Text style={styles.loadingText}>Processing visual and text tokens...</Text>
                    </View>
                )}
                {output ? (
                    <Text style={styles.outputText}>{output}</Text>
                ) : (
                    !isProcessing && (
                        <Text style={styles.placeholderText}>
                            Ephemeral analysis output will stream here. State is maintained in memory and will not be saved to conversation history.
                        </Text>
                    )
                )}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0F172A' },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#1E293B',
    },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    backBtn: { paddingVertical: 4, paddingHorizontal: 6 },
    backBtnText: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
    headerTitle: { color: '#F8FAFC', fontSize: 17, fontWeight: '700' },
    badge: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        alignSelf: 'flex-start',
        marginTop: 3,
    },
    badgeText: { backgroundColor: '#0284C720' },
    badgeVision: { backgroundColor: '#10B98120' },
    badgeLabel: { color: '#38BDF8', fontSize: 11, fontWeight: '700' },
    resetBtn: {
        backgroundColor: '#334155',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
    },
    resetText: { color: '#F8FAFC', fontSize: 12, fontWeight: '600' },
    actionBar: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 8,
        backgroundColor: '#1E293B40',
    },
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
    carousel: { maxHeight: 115, marginVertical: 6 },
    carouselContent: { paddingHorizontal: 16, gap: 10 },
    card: {
        width: 95,
        backgroundColor: '#1E293B',
        borderRadius: 8,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: '#334155',
    },
    thumbImage: { width: '100%', height: 70 },
    docPlaceholder: {
        width: '100%',
        height: 70,
        backgroundColor: '#0F172A',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 4,
    },
    docIcon: { fontSize: 22 },
    docName: { color: '#94A3B8', fontSize: 9, textAlign: 'center', marginTop: 2 },
    cardMeta: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 6,
        paddingVertical: 3,
        alignItems: 'center',
    },
    metaText: { color: '#64748B', fontSize: 9 },
    deleteText: { color: '#EF4444', fontSize: 11, fontWeight: '700' },
    promptContainer: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 8,
        gap: 8,
        alignItems: 'flex-end',
    },
    promptInput: {
        flex: 1,
        backgroundColor: '#1E293B',
        color: '#F8FAFC',
        borderRadius: 8,
        padding: 10,
        fontSize: 13,
        maxHeight: 90,
    },
    runBtn: {
        backgroundColor: '#2563EB',
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderRadius: 8,
    },
    stopBtn: { backgroundColor: '#DC2626' },
    runBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
    telemetryBar: {
        backgroundColor: '#0284C715',
        paddingVertical: 4,
        alignItems: 'center',
        marginHorizontal: 16,
        borderRadius: 4,
    },
    telemetryText: { color: '#38BDF8', fontSize: 11, fontFamily: 'monospace' },
    outputScroll: {
        flex: 1,
        margin: 16,
        backgroundColor: '#1E293B30',
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#1E293B',
    },
    outputContent: { padding: 14 },
    outputText: { color: '#F8FAFC', fontSize: 14, lineHeight: 22 },
    placeholderText: { color: '#64748B', fontSize: 13, lineHeight: 20 },
    loadingBox: { flexDirection: 'row', gap: 8, alignItems: 'center' },
    loadingText: { color: '#38BDF8', fontSize: 12 },
});
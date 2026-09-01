import React, { useEffect, useState, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    TextInput,
    Image,
    Alert,
    Modal,
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
    NotebookRecord,
    NotebookAssetRecord,
    NotebookMessageRecord,
    ModelRecord,
    getNotebookById,
    getAssetsByNotebook,
    getOrCreateNotebookConversation,
    getNotebookMessages,
    deleteNotebookAsset,
    updateNotebookNotes,
} from '../../database/repository';
import { MindspaceIngestionService } from '../../services/MindspaceIngestionService';
import { MindspaceRAGService } from '../../services/MindspaceRAGService';
import { LLMService, PerformanceMetrics } from '../../services/LLMService';
import { ModelRegistryModal } from '../../components/ModelRegistryModal';
import { AssetViewerModal } from './AssetViewerModal';

interface Props {
    notebookId: string;
    onBack: () => void;
    onSelectModel?: (model: ModelRecord) => Promise<void>;
}

export const NotebookDetailScreen: React.FC<Props> = ({
                                                          notebookId,
                                                          onBack,
                                                          onSelectModel,
                                                      }) => {
    const insets = useSafeAreaInsets();
    const flatListRef = useRef<FlatList>(null);

    const ingestionService = MindspaceIngestionService.getInstance();
    const ragService = MindspaceRAGService.getInstance();
    const llm = LLMService.getInstance();

    const [notebook, setNotebook] = useState<NotebookRecord | null>(null);
    const [assets, setAssets] = useState<NotebookAssetRecord[]>([]);
    const [messages, setMessages] = useState<NotebookMessageRecord[]>([]);
    const [conversationId, setConversationId] = useState<string>('');

    // Dual-Tier RAG Toggle: null = Entire Notebook (Global), string = Single Asset
    const [targetAssetId, setTargetAssetId] = useState<string | null>(null);

    const [prompt, setPrompt] = useState('');
    const [streamingContent, setStreamingContent] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [isIngesting, setIsIngesting] = useState(false);
    const [ingestText, setIngestText] = useState<string | null>(null);
    const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);

    // Model Selector Modal
    const [isRegistryOpen, setRegistryOpen] = useState(false);

    // Asset Inspection Modal
    const [selectedAsset, setSelectedAsset] = useState<NotebookAssetRecord | null>(null);

    // Global Notebook Scratchpad Modal
    const [isScratchpadOpen, setScratchpadOpen] = useState(false);
    const [scratchpadText, setScratchpadText] = useState('');
    const [isSavingScratchpad, setIsSavingScratchpad] = useState(false);

    const activeModel = llm.getLoadedModel();
    let badgeLabel = 'No Model Loaded';
    if (activeModel) {
        badgeLabel = activeModel.isVisionCapable
            ? `Vision • ${activeModel.name}`
            : `Text • ${activeModel.name}`;
    }

    const loadNotebookData = async () => {
        const nb = await getNotebookById(notebookId);
        const asts = await getAssetsByNotebook(notebookId);
        setNotebook(nb);
        setAssets(asts);
        setScratchpadText(nb?.notebook_notes || '');

        // Synchronize open asset modal
        setSelectedAsset((prev) => (prev ? asts.find((a) => a.id === prev.id) || null : null));

        const conv = await getOrCreateNotebookConversation(notebookId, targetAssetId);
        setConversationId(conv.id);

        const msgs = await getNotebookMessages(conv.id);
        setMessages(msgs);
    };

    useEffect(() => {
        loadNotebookData();
    }, [notebookId, targetAssetId]);

    // Ingestion Handlers
    const handleAddPhoto = async () => {
        const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
        if (!res.canceled && res.assets[0]) {
            const file = res.assets[0];
            setIsIngesting(true);
            setIngestText('Extracting OCR & indexing visual card...');
            try {
                await ingestionService.ingestImage(
                    notebookId,
                    file.uri,
                    file.fileName || 'camera_photo.jpg',
                    'image'
                );
                await loadNotebookData();
            } catch (err) {
                Alert.alert('Ingest Failed', String(err));
            } finally {
                setIsIngesting(false);
                setIngestText(null);
            }
        }
    };

    const handlePickScreenshot = async () => {
        const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.9,
        });
        if (!res.canceled && res.assets[0]) {
            const file = res.assets[0];
            setIsIngesting(true);
            setIngestText('Extracting OCR & indexing visual card...');
            try {
                await ingestionService.ingestImage(
                    notebookId,
                    file.uri,
                    file.fileName || 'screenshot.jpg',
                    'screenshot'
                );
                await loadNotebookData();
            } catch (err) {
                Alert.alert('Ingest Failed', String(err));
            } finally {
                setIsIngesting(false);
                setIngestText(null);
            }
        }
    };

    const handleImportDoc = async () => {
        const res = await DocumentPicker.getDocumentAsync({
            type: ['text/*', 'application/pdf', 'application/json'],
            copyToCacheDirectory: true,
        });
        if (!res.canceled && res.assets?.[0]) {
            const file = res.assets[0];
            setIsIngesting(true);
            setIngestText(`Indexing "${file.name}" chunks...`);
            try {
                await ingestionService.ingestDocument(notebookId, file.uri, file.name);
                await loadNotebookData();
            } catch (err) {
                Alert.alert('Import Failed', String(err));
            } finally {
                setIsIngesting(false);
                setIngestText(null);
            }
        }
    };

    const handleSaveScratchpad = async () => {
        setIsSavingScratchpad(true);
        try {
            await updateNotebookNotes(notebookId, scratchpadText.trim());
            await loadNotebookData();
            setScratchpadOpen(false);
            Alert.alert('Saved', 'Notebook scratchpad updated.');
        } catch {
            Alert.alert('Error', 'Failed to update scratchpad.');
        } finally {
            setIsSavingScratchpad(false);
        }
    };

    const handleDeleteAsset = (asset: NotebookAssetRecord) => {
        Alert.alert('Delete Asset', `Permanently remove "${asset.title}"?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    try {
                        if (asset.file_uri && asset.file_uri.startsWith('file://')) {
                            const f = new File(asset.file_uri);
                            if (f.exists) f.delete();
                        }
                        await deleteNotebookAsset(asset.id);
                        if (targetAssetId === asset.id) setTargetAssetId(null);
                        await loadNotebookData();
                    } catch (err) {
                        Alert.alert('Delete Failed', String(err));
                    }
                },
            },
        ]);
    };

    // Chat Execution
    const handleSendMessage = async () => {
        const query = prompt.trim();
        if (!query) return;

        if (!llm.isReady()) {
            Alert.alert('No Model Loaded', 'Tap the model badge above to select a model.');
            return;
        }

        setPrompt('');
        setIsGenerating(true);
        setStreamingContent('');

        try {
            await ragService.executeQuery(
                notebookId,
                conversationId,
                query,
                targetAssetId,
                {
                    onToken: (tok) => setStreamingContent((prev) => prev + tok),
                    onMetrics: (m) => setMetrics(m),
                }
            );
            await loadNotebookData();
        } catch (err) {
            Alert.alert('RAG Query Error', String(err));
        } finally {
            setIsGenerating(false);
            setStreamingContent('');
        }
    };

    const activeTargetAsset = assets.find((a) => a.id === targetAssetId);

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity style={styles.backBtn} onPress={onBack}>
                    <Text style={styles.backBtnText}>‹ Notebooks</Text>
                </TouchableOpacity>

                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle} numberOfLines={1}>
                        {notebook?.title || 'Notebook'}
                    </Text>
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

                <TouchableOpacity
                    style={styles.scratchpadHeaderBtn}
                    onPress={() => setScratchpadOpen(true)}
                >
                    <Text style={styles.scratchpadHeaderText}>📝 Notes</Text>
                </TouchableOpacity>
            </View>

            {/* Asset Ingestion Action Bar */}
            <View style={styles.ingestBar}>
                <TouchableOpacity style={styles.ingestBtn} onPress={handleAddPhoto}>
                    <Text style={styles.ingestBtnText}>📷 Camera Photo</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.ingestBtn} onPress={handlePickScreenshot}>
                    <Text style={styles.ingestBtnText}>🖼️ Screenshot</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.ingestBtn} onPress={handleImportDoc}>
                    <Text style={styles.ingestBtnText}>📄 Import Document</Text>
                </TouchableOpacity>
            </View>

            {/* Ingestion Spinner Banner */}
            {isIngesting && (
                <View style={styles.ingestingBanner}>
                    <ActivityIndicator color="#38BDF8" size="small" />
                    <Text style={styles.ingestingText}>{ingestText || 'Ingesting asset...'}</Text>
                </View>
            )}

            {/* Horizontal Asset Shelf */}
            <View style={styles.shelfSection}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.shelfContent}
                >
                    {/* Global Notebook Selector Pill */}
                    <TouchableOpacity
                        style={[
                            styles.shelfCard,
                            targetAssetId === null && styles.shelfCardActive,
                        ]}
                        onPress={() => setTargetAssetId(null)}
                    >
                        <Text style={styles.shelfIcon}>🌐</Text>
                        <Text style={styles.shelfTitle} numberOfLines={1}>
                            Entire Notebook
                        </Text>
                        <Text style={styles.shelfSub}>All {assets.length} assets</Text>
                    </TouchableOpacity>

                    {/* Asset Pills */}
                    {assets.map((item) => {
                        const isSelected = targetAssetId === item.id;
                        return (
                            <TouchableOpacity
                                key={item.id}
                                style={[styles.shelfCard, isSelected && styles.shelfCardActive]}
                                onPress={() => setTargetAssetId(item.id)}
                                onLongPress={() => handleDeleteAsset(item)}
                            >
                                <TouchableOpacity
                                    style={styles.shelfDeleteBtn}
                                    onPress={() => handleDeleteAsset(item)}
                                >
                                    <Text style={styles.shelfDeleteText}>✕</Text>
                                </TouchableOpacity>

                                {item.file_uri && (item.type === 'screenshot' || item.type === 'image') ? (
                                    <Image source={{ uri: item.file_uri }} style={styles.shelfThumb} />
                                ) : (
                                    <Text style={styles.shelfIcon}>📄</Text>
                                )}
                                <Text style={styles.shelfTitle} numberOfLines={1}>
                                    {item.title}
                                </Text>
                                <TouchableOpacity
                                    style={styles.shelfInspectBtn}
                                    onPress={() => setSelectedAsset(item)}
                                >
                                    <Text style={styles.shelfInspectText}>Inspect ↗</Text>
                                </TouchableOpacity>
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            </View>

            {/* Active Scope Indicator */}
            <View style={styles.scopeBanner}>
                <Text style={styles.scopeText}>
                    {targetAssetId && activeTargetAsset
                        ? `🎯 Querying Asset: "${activeTargetAsset.title}"`
                        : `🌐 Cross-Asset Synthesis (Synthesizing ${assets.length} assets)`}
                </Text>
            </View>

            {/* Telemetry Bar */}
            {metrics && (
                <View style={styles.telemetryBar}>
                    <Text style={styles.telemetryText}>
                        ⚡ {metrics.tokensPerSecond} t/s | TTFT: {metrics.ttftMs}ms | Generated: {metrics.totalTokens} tokens
                    </Text>
                </View>
            )}

            {/* Scoped Chat Message Stream */}
            <KeyboardAvoidingView
                style={styles.flexFill}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <FlatList
                    ref={flatListRef}
                    data={messages}
                    keyExtractor={(item) => item.id}
                    style={styles.messageList}
                    contentContainerStyle={{ paddingVertical: 12 }}
                    keyboardShouldPersistTaps="handled"
                    onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
                    ListEmptyComponent={
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyTitle}>MindSpace Research Feed</Text>
                            <Text style={styles.emptyDesc}>
                                {targetAssetId
                                    ? 'Ask questions specifically grounded on this asset.'
                                    : 'Ask comparison or synthesis questions across all assets in this notebook (e.g., "Compare prices and specs across all screenshots").'}
                            </Text>
                        </View>
                    }
                    renderItem={({ item }) => {
                        const sources: Array<{ asset_id: string; title: string }> = item.sources_json
                            ? JSON.parse(item.sources_json)
                            : [];

                        return (
                            <View
                                style={[
                                    styles.bubble,
                                    item.role === 'user' ? styles.userBubble : styles.assistantBubble,
                                ]}
                            >
                                <Text style={styles.bubbleText}>{item.content}</Text>
                                {sources.length > 0 && (
                                    <View style={styles.sourceWrap}>
                                        <Text style={styles.sourceHeader}>Sources:</Text>
                                        {sources.map((s, idx) => (
                                            <View key={idx} style={styles.sourceBadge}>
                                                <Text style={styles.sourceBadgeText}>📌 {s.title}</Text>
                                            </View>
                                        ))}
                                    </View>
                                )}
                            </View>
                        );
                    }}
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
                            targetAssetId
                                ? 'Ask about this asset...'
                                : 'Query across all notebook assets...'
                        }
                        placeholderTextColor="#64748B"
                        value={prompt}
                        onChangeText={setPrompt}
                        editable={!isGenerating}
                        multiline
                    />
                    {isGenerating ? (
                        <TouchableOpacity style={styles.stopBtn} onPress={() => llm.stopCompletion()}>
                            <Text style={styles.btnText}>Stop</Text>
                        </TouchableOpacity>
                    ) : (
                        <TouchableOpacity
                            style={[styles.sendBtn, !prompt.trim() && styles.disabledBtn]}
                            onPress={handleSendMessage}
                            disabled={!prompt.trim()}
                        >
                            <Text style={styles.btnText}>Ask</Text>
                        </TouchableOpacity>
                    )}
                </View>
            </KeyboardAvoidingView>

            {/* Asset Viewer Modal */}
            <AssetViewerModal
                visible={!!selectedAsset}
                asset={selectedAsset}
                onClose={() => setSelectedAsset(null)}
                onAssetUpdated={loadNotebookData}
                onAssetDeleted={loadNotebookData}
            />

            {/* Model Selector Modal */}
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

            {/* Global Notebook Scratchpad Modal */}
            <Modal visible={isScratchpadOpen} animationType="slide" transparent>
                <View style={styles.modalOverlay}>
                    <View style={styles.scratchpadModal}>
                        <View style={styles.scratchpadHeader}>
                            <Text style={styles.scratchpadTitle}>Notebook Scratchpad & Notes</Text>
                            <TouchableOpacity onPress={() => setScratchpadOpen(false)}>
                                <Text style={styles.scratchpadClose}>Close</Text>
                            </TouchableOpacity>
                        </View>
                        <TextInput
                            style={styles.scratchpadInput}
                            placeholder="Write notebook-wide notes, conclusions, or comparison summaries..."
                            placeholderTextColor="#64748B"
                            value={scratchpadText}
                            onChangeText={setScratchpadText}
                            multiline
                        />
                        <TouchableOpacity
                            style={[styles.saveScratchpadBtn, isSavingScratchpad && styles.disabledBtn]}
                            onPress={handleSaveScratchpad}
                            disabled={isSavingScratchpad}
                        >
                            <Text style={styles.saveScratchpadText}>
                                {isSavingScratchpad ? 'Saving...' : 'Save Notebook Notes'}
                            </Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
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
    backBtn: { paddingVertical: 4, paddingHorizontal: 6 },
    backBtnText: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
    headerCenter: { flex: 1, alignItems: 'center', marginHorizontal: 8 },
    headerTitle: { color: '#F8FAFC', fontSize: 15, fontWeight: '700' },
    badge: {
        maxWidth: '100%',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 6,
        marginTop: 2,
    },
    badgeText: { backgroundColor: '#0284C720' },
    badgeVision: { backgroundColor: '#10B98120' },
    badgeLabel: { color: '#38BDF8', fontSize: 11, fontWeight: '700' },
    scratchpadHeaderBtn: {
        backgroundColor: '#1E293B',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#334155',
    },
    scratchpadHeaderText: { color: '#F8FAFC', fontSize: 12, fontWeight: '600' },
    ingestBar: {
        flexDirection: 'row',
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 8,
        backgroundColor: '#1E293B50',
    },
    ingestBtn: {
        flex: 1,
        backgroundColor: '#1E293B',
        paddingVertical: 8,
        borderRadius: 6,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: '#334155',
    },
    ingestBtnText: { color: '#F8FAFC', fontSize: 11, fontWeight: '600' },
    ingestingBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#0284C720',
        padding: 8,
        marginHorizontal: 12,
        marginTop: 6,
        borderRadius: 6,
        gap: 8,
    },
    ingestingText: { color: '#38BDF8', fontSize: 12, fontWeight: '600' },
    shelfSection: {
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#1E293B',
    },
    shelfContent: { paddingHorizontal: 12, gap: 8 },
    shelfCard: {
        width: 110,
        height: 95,
        backgroundColor: '#1E293B',
        borderRadius: 8,
        padding: 8,
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1.5,
        borderColor: 'transparent',
        position: 'relative',
    },
    shelfCardActive: { borderColor: '#38BDF8', backgroundColor: '#1E293B' },
    shelfDeleteBtn: {
        position: 'absolute',
        top: 4,
        right: 4,
        width: 18,
        height: 18,
        borderRadius: 9,
        backgroundColor: '#EF444430',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
    shelfDeleteText: { color: '#EF4444', fontSize: 10, fontWeight: '700' },
    shelfThumb: { width: 40, height: 40, borderRadius: 4, resizeMode: 'cover' },
    shelfIcon: { fontSize: 22 },
    shelfTitle: { color: '#F8FAFC', fontSize: 11, fontWeight: '600', textAlign: 'center' },
    shelfSub: { color: '#64748B', fontSize: 9 },
    shelfInspectBtn: { paddingVertical: 1 },
    shelfInspectText: { color: '#38BDF8', fontSize: 9, fontWeight: '700' },
    scopeBanner: {
        backgroundColor: '#1E293B80',
        paddingVertical: 4,
        paddingHorizontal: 12,
        alignItems: 'center',
    },
    scopeText: { color: '#38BDF8', fontSize: 11, fontWeight: '600' },
    telemetryBar: { backgroundColor: '#0284C715', paddingVertical: 3, alignItems: 'center' },
    telemetryText: { color: '#38BDF8', fontSize: 10, fontFamily: 'monospace' },
    messageList: { flex: 1, paddingHorizontal: 12 },
    emptyContainer: { padding: 30, alignItems: 'center', marginTop: 20 },
    emptyTitle: { color: '#F8FAFC', fontSize: 15, fontWeight: '700', marginBottom: 6 },
    emptyDesc: { color: '#64748B', fontSize: 12, textAlign: 'center', lineHeight: 18 },
    bubble: { maxWidth: '85%', padding: 12, borderRadius: 12, marginBottom: 10 },
    userBubble: { backgroundColor: '#2563EB', alignSelf: 'flex-end', borderBottomRightRadius: 2 },
    assistantBubble: { backgroundColor: '#1E293B', alignSelf: 'flex-start', borderBottomLeftRadius: 2 },
    bubbleText: { color: '#F8FAFC', fontSize: 13, lineHeight: 20 },
    sourceWrap: { marginTop: 8, borderTopWidth: 1, borderTopColor: '#334155', paddingTop: 6 },
    sourceHeader: { color: '#94A3B8', fontSize: 10, fontWeight: '700', marginBottom: 4 },
    sourceBadge: {
        backgroundColor: '#0F172A',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        alignSelf: 'flex-start',
        marginBottom: 2,
    },
    sourceBadgeText: { color: '#38BDF8', fontSize: 10 },
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
        fontSize: 13,
        maxHeight: 80,
    },
    sendBtn: { backgroundColor: '#2563EB', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
    stopBtn: { backgroundColor: '#DC2626', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
    disabledBtn: { opacity: 0.4 },
    btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        padding: 20,
    },
    scratchpadModal: {
        backgroundColor: '#1E293B',
        borderRadius: 12,
        padding: 16,
        maxHeight: '80%',
    },
    scratchpadHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    scratchpadTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
    scratchpadClose: { color: '#38BDF8', fontSize: 14, fontWeight: '600' },
    scratchpadInput: {
        backgroundColor: '#0F172A',
        color: '#F8FAFC',
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
        minHeight: 180,
        textAlignVertical: 'top',
        marginBottom: 14,
    },
    saveScratchpadBtn: {
        backgroundColor: '#059669',
        paddingVertical: 10,
        borderRadius: 8,
        alignItems: 'center',
    },
    saveScratchpadText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
});
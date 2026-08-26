import React, { useEffect, useState } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    Alert,
    ActivityIndicator,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import ModelFile from '../../modules/model-file/src/ModelFileModule';
import {
    getAllModels,
    insertModel,
    insertVisionModel,
    setDefaultChatModel,
    lockDedicatedEmbeddingModel,
    deleteModel,
    getEmbeddingModel,
    ModelRecord,
} from '../database/repository';
import { EmbeddingService } from '../services/EmbeddingService';

interface Props {
    visible: boolean;
    onClose: () => void;
    onSelectChatModel?: (model: ModelRecord) => void;
}

export const ModelRegistryModal: React.FC<Props> = ({
                                                        visible,
                                                        onClose,
                                                        onSelectChatModel,
                                                    }) => {
    const [models, setModels] = useState<ModelRecord[]>([]);
    const [embeddingModel, setEmbeddingModel] = useState<ModelRecord | null>(null);
    const [loading, setLoading] = useState(false);

    const loadRegistry = async () => {
        setLoading(true);
        try {
            const records = await getAllModels();
            const currentEmb = await getEmbeddingModel();
            setModels(records);
            setEmbeddingModel(currentEmb);
        } catch (err) {
            console.warn('[ModelRegistry] Failed to load registry:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (visible) loadRegistry();
    }, [visible]);

    // Safe DocumentPicker for Text Model (.gguf)
    const handleRegisterTextModel = async () => {
        try {
            const res = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: false,
            });

            if (res.canceled || !res.assets?.[0]) return;
            const file = res.assets[0];

            let originalName = file.name?.trim();
            let sizeBytes = file.size ?? null;

            try {
                const metadata = await ModelFile.getContentUriMetadata(file.uri);
                if (metadata.name) originalName = metadata.name.trim();
                if (metadata.sizeBytes) sizeBytes = metadata.sizeBytes;
            } catch {}

            if (!originalName || !originalName.toLowerCase().endsWith('.gguf')) {
                Alert.alert('Invalid Model', 'Please select a valid GGUF binary file.');
                return;
            }

            await insertModel(originalName, file.uri, sizeBytes);
            await loadRegistry();
        } catch (error) {
            Alert.alert(
                'Registration Failed',
                error instanceof Error ? error.message : String(error)
            );
        }
    };

    // Safe DocumentPicker for Vision Model Pair (Base Model + mmproj)
    const handleRegisterVisionPair = async () => {
        try {
            // 1. Pick Base Model
            const baseRes = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: false,
            });

            if (baseRes.canceled || !baseRes.assets?.[0]) return;
            const baseFile = baseRes.assets[0];

            let baseName = baseFile.name?.trim();
            let baseSize = baseFile.size ?? null;

            try {
                const meta = await ModelFile.getContentUriMetadata(baseFile.uri);
                if (meta.name) baseName = meta.name.trim();
                if (meta.sizeBytes) baseSize = meta.sizeBytes;
            } catch {}

            if (!baseName || !baseName.toLowerCase().endsWith('.gguf')) {
                Alert.alert('Invalid Base Model', 'Please select a valid base .gguf model.');
                return;
            }

            // Small delay so Android Activity lifecycle settles
            await new Promise((resolve) => setTimeout(resolve, 350));

            // 2. Pick Companion mmproj File
            const mmprojRes = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: false,
            });

            if (mmprojRes.canceled || !mmprojRes.assets?.[0]) return;
            const mmprojFile = mmprojRes.assets[0];

            let mmprojName = mmprojFile.name?.trim();
            let mmprojSize = mmprojFile.size ?? null;

            try {
                const meta = await ModelFile.getContentUriMetadata(mmprojFile.uri);
                if (meta.name) mmprojName = meta.name.trim();
                if (meta.sizeBytes) mmprojSize = meta.sizeBytes;
            } catch {}

            if (!mmprojName || !mmprojName.toLowerCase().endsWith('.gguf')) {
                Alert.alert('Invalid Projector', 'The projector must be a valid .gguf file.');
                return;
            }

            await insertVisionModel(
                baseName,
                baseFile.uri,
                baseSize,
                mmprojName,
                mmprojFile.uri,
                mmprojSize
            );

            await loadRegistry();
        } catch (error) {
            Alert.alert(
                'Vision Registration Failed',
                error instanceof Error ? error.message : String(error)
            );
        }
    };

    const handleSetDefaultChat = async (id: string) => {
        await setDefaultChatModel(id);
        await loadRegistry();
    };

    const handleLockAsEmbedding = (record: ModelRecord) => {
        Alert.alert(
            'Lock Dedicated Embedding Engine',
            `Set "${record.original_name}" as the permanent embedding engine?\n\nWARNING: Once set, all cross-session vector indexes will be permanently keyed to this model and it CANNOT be changed.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Confirm & Lock Engine',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await lockDedicatedEmbeddingModel(record.id);
                            await EmbeddingService.getInstance().initialize();
                            await loadRegistry();
                            Alert.alert('Success', 'Dedicated Embedding Engine initialized and locked.');
                        } catch (err) {
                            Alert.alert('Lock Failed', String(err));
                        }
                    },
                },
            ]
        );
    };

    const handleDelete = (id: string, name: string) => {
        Alert.alert(
            'Remove Model',
            `Unregister "${name}"? The original file on device storage will remain untouched.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await deleteModel(id);
                            await loadRegistry();
                        } catch (err) {
                            Alert.alert('Cannot Delete', String(err));
                        }
                    },
                },
            ]
        );
    };

    const formatSize = (bytes: number | null) => {
        if (!bytes) return 'Unknown Size';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1) return `${gb.toFixed(2)} GB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={styles.modalOverlay}>
                <View style={styles.modalContainer}>
                    <View style={styles.header}>
                        <Text style={styles.headerTitle}>Engine & Model Registry</Text>
                        <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                            <Text style={styles.closeBtnText}>Done</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Embedding Status Banner */}
                    <View style={styles.embedBanner}>
                        <Text style={styles.embedBannerTitle}>
                            {embeddingModel ? '🔒 Permanent Embedding Engine' : '⚠️ No Embedding Engine Set'}
                        </Text>
                        <Text style={styles.embedBannerDesc}>
                            {embeddingModel
                                ? `${embeddingModel.original_name} (${formatSize(embeddingModel.size_bytes)})`
                                : 'Select a model below to permanently lock as your dedicated embedding engine.'}
                        </Text>
                    </View>

                    {/* Action Row for Import */}
                    <View style={styles.importActionRow}>
                        <TouchableOpacity style={styles.addBtn} onPress={handleRegisterTextModel}>
                            <Text style={styles.addBtnText}>+ Text GGUF</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.addVisionBtn} onPress={handleRegisterVisionPair}>
                            <Text style={styles.addBtnText}>📷 Vision Pair (Base + mmproj)</Text>
                        </TouchableOpacity>
                    </View>

                    {loading ? (
                        <ActivityIndicator color="#38BDF8" style={{ marginTop: 24 }} />
                    ) : (
                        <FlatList
                            data={models}
                            keyExtractor={(item) => item.id}
                            contentContainerStyle={{ paddingVertical: 8 }}
                            renderItem={({ item }) => (
                                <View style={styles.modelCard}>
                                    <View style={{ flex: 1 }}>
                                        <View style={styles.nameRow}>
                                            <Text style={styles.modelName} numberOfLines={1}>
                                                {item.original_name}
                                            </Text>
                                            {item.modality === 'vision' && (
                                                <View style={styles.visionBadge}>
                                                    <Text style={styles.visionBadgeText}>VISION</Text>
                                                </View>
                                            )}
                                        </View>
                                        <Text style={styles.modelMeta}>
                                            {formatSize(item.size_bytes)}{' '}
                                            {item.is_embedding === 1 && ' • [Dedicated Embedding]'}
                                            {item.is_default === 1 && ' • [Default Chat]'}
                                        </Text>
                                        {item.modality === 'vision' && item.mmproj_filename && (
                                            <Text style={styles.mmprojMeta} numberOfLines={1}>
                                                Projector: {item.mmproj_filename} ({formatSize(item.mmproj_size_bytes || null)})
                                            </Text>
                                        )}
                                    </View>

                                    <View style={styles.cardActions}>
                                        {item.is_embedding === 0 && (
                                            <>
                                                {onSelectChatModel && (
                                                    <TouchableOpacity
                                                        style={styles.selectBtn}
                                                        onPress={() => {
                                                            onSelectChatModel(item);
                                                            onClose();
                                                        }}
                                                    >
                                                        <Text style={styles.actionText}>Chat</Text>
                                                    </TouchableOpacity>
                                                )}
                                                {item.is_default === 0 && (
                                                    <TouchableOpacity
                                                        style={styles.defaultBtn}
                                                        onPress={() => handleSetDefaultChat(item.id)}
                                                    >
                                                        <Text style={styles.actionText}>Default</Text>
                                                    </TouchableOpacity>
                                                )}
                                                {!embeddingModel && item.modality !== 'vision' && (
                                                    <TouchableOpacity
                                                        style={styles.embedLockBtn}
                                                        onPress={() => handleLockAsEmbedding(item)}
                                                    >
                                                        <Text style={styles.actionText}>Lock as Embed</Text>
                                                    </TouchableOpacity>
                                                )}
                                                <TouchableOpacity
                                                    style={styles.deleteBtn}
                                                    onPress={() => handleDelete(item.id, item.original_name)}
                                                >
                                                    <Text style={styles.deleteText}>Delete</Text>
                                                </TouchableOpacity>
                                            </>
                                        )}
                                    </View>
                                </View>
                            )}
                        />
                    )}
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    modalContainer: {
        backgroundColor: '#0F172A',
        height: '82%',
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        padding: 16,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    headerTitle: { color: '#F8FAFC', fontSize: 18, fontWeight: '700' },
    closeBtn: { padding: 4 },
    closeBtnText: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
    embedBanner: {
        backgroundColor: '#1E293B',
        padding: 12,
        borderRadius: 8,
        borderLeftWidth: 4,
        borderLeftColor: '#38BDF8',
        marginBottom: 12,
    },
    embedBannerTitle: { color: '#F8FAFC', fontSize: 13, fontWeight: '700' },
    embedBannerDesc: { color: '#94A3B8', fontSize: 11, marginTop: 2 },
    importActionRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 12,
    },
    addBtn: {
        flex: 1,
        backgroundColor: '#0284C7',
        padding: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    addVisionBtn: {
        flex: 1.5,
        backgroundColor: '#059669',
        padding: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    addBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
    modelCard: {
        backgroundColor: '#1E293B',
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
    },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    modelName: { color: '#F8FAFC', fontSize: 14, fontWeight: '600', flexShrink: 1 },
    visionBadge: {
        backgroundColor: '#10B98125',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
    },
    visionBadgeText: { color: '#10B981', fontSize: 10, fontWeight: '700' },
    modelMeta: { color: '#94A3B8', fontSize: 12, marginTop: 4 },
    mmprojMeta: { color: '#38BDF8', fontSize: 11, marginTop: 2 },
    cardActions: {
        flexDirection: 'row',
        gap: 6,
        marginTop: 10,
        justifyContent: 'flex-end',
        flexWrap: 'wrap',
    },
    selectBtn: {
        backgroundColor: '#2563EB',
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
    },
    defaultBtn: {
        backgroundColor: '#334155',
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
    },
    embedLockBtn: {
        backgroundColor: '#059669',
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
    },
    deleteBtn: {
        backgroundColor: '#EF444420',
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 6,
    },
    actionText: { color: '#FFFFFF', fontSize: 12, fontWeight: '500' },
    deleteText: { color: '#EF4444', fontSize: 12, fontWeight: '500' },
});
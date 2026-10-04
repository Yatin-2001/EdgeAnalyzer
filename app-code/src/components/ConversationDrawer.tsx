import React, { useState, useEffect } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    TouchableWithoutFeedback,
    Alert,
    Switch,
    TextInput, PermissionsAndroid, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConversationRecord } from '../database/repository';
import { SearchProvider } from '../services/SecureStorageService';
import { PairDesktopModal } from './PairDesktopModal';
import { MeshIdentityService } from '../services/MeshIdentityService';
import ModelFile from '../../modules/model-file/src/ModelFileModule';

interface Props {
    visible: boolean;
    conversations: ConversationRecord[];
    activeId: string | null;
    activeTab: 'chat' | 'studio' | 'mindspace' | 'advisor';
    searchProvider: SearchProvider;
    onSelectTab: (tab: 'chat' | 'studio' | 'mindspace' | 'advisor') => void;
    onSelect: (conv: ConversationRecord) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
    onRename: (id: string, newTitle: string) => void;
    onOpenSearchSettings: () => void;
    onClose: () => void;
}

export const ConversationDrawer: React.FC<Props> = ({
                                                        visible,
                                                        conversations,
                                                        activeId,
                                                        activeTab,
                                                        searchProvider,
                                                        onSelectTab,
                                                        onSelect,
                                                        onNew,
                                                        onDelete,
                                                        onRename,
                                                        onOpenSearchSettings,
                                                        onClose,
                                                    }) => {
    const insets = useSafeAreaInsets();
    const [isPairModalOpen, setIsPairModalOpen] = useState(false);
    const [isWorkerEnabled, setIsWorkerEnabled] = useState(false);
    const [deviceTier, setDeviceTier] = useState<string>('thin');

    // Cross-Platform Android Rename Modal State
    const [renameModalVisible, setRenameModalVisible] = useState(false);
    const [renameTargetId, setRenameTargetId] = useState<string | null>(null);
    const [renameTitleInput, setRenameTitleInput] = useState('');

    useEffect(() => {
        (async () => {
            const identity = await MeshIdentityService.getInstance().getOrCreateIdentity();
            setIsWorkerEnabled(identity.is_worker_enabled === 1);
            setDeviceTier(identity.node_tier);
        })();
    }, [visible]);

    const handleToggleWorker = async (value: boolean) => {
        try {
            if (value) {
                // Request Notification Permission on Android 13+ (API 33+)
                if (Platform.OS === 'android' && Platform.Version >= 33) {
                    const granted = await PermissionsAndroid.request(
                        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
                    );
                    if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
                        Alert.alert(
                            'Permission Required',
                            'Please grant notification permission so the worker can run continuously in the background.'
                        );
                    }
                }

                const started = await ModelFile.startWorkerService();
                if (!started) {
                    throw new Error('Native worker service returned false.');
                }
            } else {
                await ModelFile.stopWorkerService();
            }
            await MeshIdentityService.getInstance().setWorkerEnabled(value);
            setIsWorkerEnabled(value);
        } catch (err: any) {
            Alert.alert('Worker Error', err.message || 'Failed to toggle mobile worker service.');
        }
    };

    const handleLongPress = (item: ConversationRecord) => {
        Alert.alert(
            item.title,
            'Manage conversation thread',
            [
                {
                    text: 'Rename',
                    onPress: () => {
                        setRenameTargetId(item.id);
                        setRenameTitleInput(item.title);
                        setRenameModalVisible(true);
                    },
                },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: () => onDelete(item.id),
                },
                { text: 'Cancel', style: 'cancel' },
            ],
            { cancelable: true }
        );
    };

    const submitRename = () => {
        if (renameTargetId && renameTitleInput.trim()) {
            onRename(renameTargetId, renameTitleInput.trim());
        }
        setRenameModalVisible(false);
        setRenameTargetId(null);
    };

    return (
        <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
            <View style={styles.overlay}>
                <TouchableWithoutFeedback onPress={onClose}>
                    <View style={styles.backdrop} />
                </TouchableWithoutFeedback>

                <View style={[styles.drawer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
                    {/* Header */}
                    <View style={styles.header}>
                        <Text style={styles.headerTitle}>EdgeAnalyzer</Text>
                        <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                            <Text style={styles.closeBtnText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Top Workspace Navigator */}
                    <View style={styles.workspaceSection}>
                        <Text style={styles.sectionHeader}>WORKSPACES</Text>
                        <TouchableOpacity
                            style={[styles.workspaceItem, activeTab === 'chat' && styles.workspaceItemActive]}
                            onPress={() => {
                                onSelectTab('chat');
                                onClose();
                            }}
                        >
                            <Text style={styles.workspaceIcon}>💬</Text>
                            <Text style={[styles.workspaceText, activeTab === 'chat' && styles.workspaceTextActive]}>
                                Chat Assistant
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.workspaceItem, activeTab === 'studio' && styles.workspaceItemActive]}
                            onPress={() => {
                                onSelectTab('studio');
                                onClose();
                            }}
                        >
                            <Text style={styles.workspaceIcon}>🎨</Text>
                            <Text style={[styles.workspaceText, activeTab === 'studio' && styles.workspaceTextActive]}>
                                Visual Studio
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.workspaceItem, activeTab === 'mindspace' && styles.workspaceItemActive]}
                            onPress={() => {
                                onSelectTab('mindspace');
                                onClose();
                            }}
                        >
                            <Text style={styles.workspaceIcon}>📚</Text>
                            <Text style={[styles.workspaceText, activeTab === 'mindspace' && styles.workspaceTextActive]}>
                                MindSpace Notebooks
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.workspaceItem, activeTab === 'advisor' && styles.workspaceItemActive]}
                            onPress={() => {
                                onSelectTab('advisor');
                                onClose();
                            }}
                        >
                            <Text style={styles.workspaceIcon}>🤝</Text>
                            <Text style={[styles.workspaceText, activeTab === 'advisor' && styles.workspaceTextActive]}>
                                Message Advisor
                            </Text>
                        </TouchableOpacity>

                        {/* Compute Mesh Pairing Action */}
                        <View style={styles.meshDivider} />
                        <TouchableOpacity style={styles.meshBtn} onPress={() => setIsPairModalOpen(true)}>
                            <Text style={styles.workspaceIcon}>⚡</Text>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.meshBtnText}>Pair Desktop Node</Text>
                                <Text style={styles.meshBtnSub}>RTX 3060 / Ollama</Text>
                            </View>
                            <Text style={styles.meshArrow}>➔</Text>
                        </TouchableOpacity>

                        {/* Mobile Worker Server Toggle (Thick Mobile Only) */}
                        {deviceTier === 'thick_mobile' && (
                            <View style={styles.workerToggleRow}>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.workerToggleLabel}>Mobile Worker (Port 8765)</Text>
                                    <Text style={styles.workerToggleSub}>Serve local GPU to thin clients</Text>
                                </View>
                                <Switch
                                    value={isWorkerEnabled}
                                    onValueChange={handleToggleWorker}
                                    trackColor={{ false: '#334155', true: '#0284C7' }}
                                    thumbColor={isWorkerEnabled ? '#38BDF8' : '#94A3B8'}
                                />
                            </View>
                        )}
                    </View>

                    {/* New Chat Button */}
                    <TouchableOpacity style={styles.newChatBtn} onPress={onNew}>
                        <Text style={styles.newChatText}>+ New Conversation</Text>
                    </TouchableOpacity>

                    {/* Conversation History Section */}
                    <View style={styles.historySection}>
                        <Text style={styles.sectionHeader}>CONVERSATIONS</Text>
                        <FlatList
                            data={conversations}
                            keyExtractor={(item) => item.id}
                            contentContainerStyle={{ paddingBottom: 10 }}
                            renderItem={({ item }) => {
                                const isActive = item.id === activeId && activeTab === 'chat';
                                return (
                                    <TouchableOpacity
                                        style={[styles.convItem, isActive && styles.convItemActive]}
                                        onPress={() => {
                                            onSelectTab('chat');
                                            onSelect(item);
                                            onClose();
                                        }}
                                        onLongPress={() => handleLongPress(item)}
                                        delayLongPress={400}
                                    >
                                        <Text style={styles.convIcon}>🗨️</Text>
                                        <Text
                                            style={[styles.convTitle, isActive && styles.convTitleActive]}
                                            numberOfLines={1}
                                        >
                                            {item.title}
                                        </Text>
                                    </TouchableOpacity>
                                );
                            }}
                        />
                    </View>

                    {/* Drawer Footer: Integrated Search Settings */}
                    <View style={styles.footer}>
                        <TouchableOpacity style={styles.searchSettingBtn} onPress={onOpenSearchSettings}>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.searchSettingTitle}>Web Search Provider</Text>
                                <Text style={styles.searchSettingSubtitle}>
                                    {searchProvider === 'brave_custom' ? '⚡ Brave Pro (Custom Key)' : '🌐 Tavily Keyless'}
                                </Text>
                            </View>
                            <Text style={styles.searchSettingAction}>Configure ⚙</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Pair Desktop Modal */}
                    <PairDesktopModal
                        visible={isPairModalOpen}
                        onClose={() => setIsPairModalOpen(false)}
                        onPairSuccess={() => {
                            setIsPairModalOpen(false);
                            onClose();
                        }}
                    />

                    {/* Android & Cross-Platform Rename Modal */}
                    <Modal visible={renameModalVisible} transparent animationType="fade">
                        <View style={styles.renameOverlay}>
                            <View style={styles.renameCard}>
                                <Text style={styles.renameTitle}>Rename Conversation</Text>
                                <TextInput
                                    style={styles.renameInput}
                                    value={renameTitleInput}
                                    onChangeText={setRenameTitleInput}
                                    autoFocus
                                    selectTextOnFocus
                                    placeholder="Enter conversation title..."
                                    placeholderTextColor="#64748B"
                                />
                                <View style={styles.renameActionRow}>
                                    <TouchableOpacity
                                        style={styles.renameCancelBtn}
                                        onPress={() => setRenameModalVisible(false)}
                                    >
                                        <Text style={styles.renameCancelText}>Cancel</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.renameSaveBtn} onPress={submitRename}>
                                        <Text style={styles.renameSaveText}>Save</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        </View>
                    </Modal>
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: { flex: 1, flexDirection: 'row' },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
    drawer: {
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: '80%',
        maxWidth: 320,
        backgroundColor: '#0F172A',
        borderRightWidth: 1,
        borderRightColor: '#1E293B',
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    headerTitle: { color: '#F8FAFC', fontSize: 18, fontWeight: '800' },
    closeBtn: { padding: 4 },
    closeBtnText: { color: '#94A3B8', fontSize: 16, fontWeight: '700' },
    workspaceSection: {
        marginBottom: 16,
        backgroundColor: '#1E293B40',
        borderRadius: 8,
        padding: 8,
        borderWidth: 1,
        borderColor: '#1E293B',
    },
    sectionHeader: {
        color: '#64748B',
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.8,
        marginBottom: 6,
        paddingHorizontal: 4,
    },
    workspaceItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 10,
        borderRadius: 6,
        marginBottom: 2,
        gap: 8,
    },
    workspaceItemActive: { backgroundColor: '#2563EB25' },
    workspaceIcon: { fontSize: 15 },
    workspaceText: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
    workspaceTextActive: { color: '#38BDF8', fontWeight: '700' },
    meshDivider: {
        height: 1,
        backgroundColor: '#33415550',
        marginVertical: 6,
        marginHorizontal: 4,
    },
    meshBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: '#0284C715',
        borderWidth: 1,
        borderColor: '#0284C730',
        gap: 8,
    },
    meshBtnText: { color: '#38BDF8', fontSize: 12, fontWeight: '700' },
    meshBtnSub: { color: '#64748B', fontSize: 10 },
    meshArrow: { color: '#38BDF8', fontSize: 12, fontWeight: '700' },
    workerToggleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 8,
        paddingHorizontal: 8,
        paddingVertical: 6,
        backgroundColor: '#0F172A',
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#334155',
    },
    workerToggleLabel: { color: '#F8FAFC', fontSize: 11, fontWeight: '700' },
    workerToggleSub: { color: '#64748B', fontSize: 9 },
    newChatBtn: {
        backgroundColor: '#0284C7',
        paddingVertical: 10,
        borderRadius: 8,
        alignItems: 'center',
        marginBottom: 14,
    },
    newChatText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
    historySection: { flex: 1 },
    convItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 10,
        paddingHorizontal: 8,
        borderRadius: 6,
        marginBottom: 2,
        gap: 8,
    },
    convItemActive: { backgroundColor: '#1E293B' },
    convIcon: { fontSize: 14 },
    convTitle: { color: '#94A3B8', fontSize: 13, flex: 1 },
    convTitleActive: { color: '#F8FAFC', fontWeight: '600' },
    footer: {
        borderTopWidth: 1,
        borderTopColor: '#1E293B',
        paddingTop: 12,
        marginTop: 8,
    },
    searchSettingBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#1E293B',
        padding: 10,
        borderRadius: 8,
    },
    searchSettingTitle: { color: '#F8FAFC', fontSize: 12, fontWeight: '600' },
    searchSettingSubtitle: { color: '#38BDF8', fontSize: 10, marginTop: 1 },
    searchSettingAction: { color: '#94A3B8', fontSize: 11, fontWeight: '600' },
    renameOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        padding: 24,
    },
    renameCard: {
        backgroundColor: '#1E293B',
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: '#334155',
    },
    renameTitle: { color: '#F8FAFC', fontSize: 15, fontWeight: '700', marginBottom: 12 },
    renameInput: {
        backgroundColor: '#0F172A',
        color: '#F8FAFC',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 13,
        borderWidth: 1,
        borderColor: '#334155',
        marginBottom: 14,
    },
    renameActionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
    renameCancelBtn: { paddingVertical: 8, paddingHorizontal: 12 },
    renameCancelText: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
    renameSaveBtn: {
        backgroundColor: '#0284C7',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 6,
    },
    renameSaveText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
});
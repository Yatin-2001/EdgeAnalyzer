import React from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    TouchableWithoutFeedback,
    Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConversationRecord } from '../database/repository';
import { SearchProvider } from '../services/SecureStorageService';

interface Props {
    visible: boolean;
    conversations: ConversationRecord[];
    activeId: string | null;
    activeTab: 'chat' | 'studio' | 'mindspace';
    searchProvider: SearchProvider;
    onSelectTab: (tab: 'chat' | 'studio' | 'mindspace') => void;
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

    const handleLongPress = (item: ConversationRecord) => {
        Alert.alert(
            item.title,
            'Manage conversation thread',
            [
                {
                    text: 'Rename',
                    onPress: () => {
                        Alert.prompt(
                            'Rename Chat',
                            'Enter a new title:',
                            [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                    text: 'Save',
                                    onPress: (newTitle?: string) => {
                                        if (newTitle && newTitle.trim()) {
                                            onRename(item.id, newTitle.trim());
                                        }
                                    },
                                },
                            ],
                            'plain-text',
                            item.title
                        );
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
                            <Text
                                style={[
                                    styles.workspaceText,
                                    activeTab === 'chat' && styles.workspaceTextActive,
                                ]}
                            >
                                Chat Assistant
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[
                                styles.workspaceItem,
                                activeTab === 'studio' && styles.workspaceItemActive,
                            ]}
                            onPress={() => {
                                onSelectTab('studio');
                                onClose();
                            }}
                        >
                            <Text style={styles.workspaceIcon}>🎨</Text>
                            <Text
                                style={[
                                    styles.workspaceText,
                                    activeTab === 'studio' && styles.workspaceTextActive,
                                ]}
                            >
                                Visual Studio
                            </Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[
                                styles.workspaceItem,
                                activeTab === 'mindspace' && styles.workspaceItemActive,
                            ]}
                            onPress={() => {
                                onSelectTab('mindspace');
                                onClose();
                            }}
                        >
                            <Text style={styles.workspaceIcon}>📚</Text>
                            <Text
                                style={[
                                    styles.workspaceText,
                                    activeTab === 'mindspace' && styles.workspaceTextActive,
                                ]}
                            >
                                MindSpace Notebooks
                            </Text>
                        </TouchableOpacity>
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
});
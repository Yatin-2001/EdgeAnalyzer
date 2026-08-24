import React, { useState, useEffect } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    TextInput,
} from 'react-native';
import { ConversationRecord } from '../database/repository';
import {
    SemanticMemoryService,
    ConversationSearchResult,
} from '../services/SemanticMemoryService';

export interface ConversationDrawerProps {
    visible: boolean;
    conversations: ConversationRecord[];
    activeId: string | null;
    onSelect: (conv: ConversationRecord) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
    onRename: (id: string, newTitle: string) => void;
    onClose: () => void;
}

export const ConversationDrawer: React.FC<ConversationDrawerProps> = ({
                                                                          visible,
                                                                          conversations,
                                                                          activeId,
                                                                          onSelect,
                                                                          onNew,
                                                                          onDelete,
                                                                          onRename,
                                                                          onClose,
                                                                      }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const [editingConv, setEditingConv] = useState<ConversationRecord | null>(null);
    const [editTitleText, setEditTitleText] = useState('');

    const memoryService = SemanticMemoryService.getInstance();

    useEffect(() => {
        if (!searchQuery.trim()) {
            setSearchResults([]);
            setIsSearching(false);
            return;
        }

        const timer = setTimeout(async () => {
            setIsSearching(true);
            const res = await memoryService.searchConversations(searchQuery);
            setSearchResults(res);
            setIsSearching(false);
        }, 250);

        return () => clearTimeout(timer);
    }, [searchQuery]);

    const handleOpenRename = (conv: ConversationRecord) => {
        setEditingConv(conv);
        setEditTitleText(conv.title);
    };

    const handleSaveRename = () => {
        if (editingConv && editTitleText.trim()) {
            onRename(editingConv.id, editTitleText.trim());
            setEditingConv(null);
        }
    };

    return (
        <Modal visible={visible} animationType="fade" transparent>
            <View style={styles.overlay}>
                <View style={styles.drawerContainer}>
                    <View style={styles.header}>
                        <Text style={styles.title}>Chats & Memory</Text>
                        <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
                            <Text style={styles.closeText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    <TextInput
                        style={styles.searchBar}
                        placeholder="Search topic or context..."
                        placeholderTextColor="#64748B"
                        value={searchQuery}
                        onChangeText={setSearchQuery}
                    />

                    <TouchableOpacity style={styles.newChatBtn} onPress={onNew}>
                        <Text style={styles.newChatText}>+ New Chat</Text>
                    </TouchableOpacity>

                    {searchQuery.trim().length > 0 ? (
                        <FlatList
                            data={searchResults}
                            keyExtractor={(item) => item.conversation.id}
                            ListHeaderComponent={
                                <Text style={styles.sectionHeader}>
                                    {isSearching ? 'Searching...' : `Context Matches (${searchResults.length})`}
                                </Text>
                            }
                            renderItem={({ item }) => (
                                <View
                                    style={[
                                        styles.chatItem,
                                        item.conversation.id === activeId && styles.activeChatItem,
                                    ]}
                                >
                                    <TouchableOpacity
                                        style={{ flex: 1 }}
                                        onPress={() => {
                                            onSelect(item.conversation);
                                            onClose();
                                        }}
                                    >
                                        <Text style={styles.chatTitle} numberOfLines={1}>
                                            {item.conversation.title}
                                        </Text>
                                        <Text style={styles.snippetText} numberOfLines={2}>
                                            {item.relevanceSnippet}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        />
                    ) : (
                        <FlatList
                            data={conversations}
                            keyExtractor={(item) => item.id}
                            renderItem={({ item }) => (
                                <View
                                    style={[
                                        styles.chatItem,
                                        item.id === activeId && styles.activeChatItem,
                                    ]}
                                >
                                    <TouchableOpacity
                                        style={{ flex: 1 }}
                                        onPress={() => {
                                            onSelect(item);
                                            onClose();
                                        }}
                                    >
                                        <Text
                                            style={[
                                                styles.chatTitle,
                                                item.id === activeId && styles.activeChatTitle,
                                            ]}
                                            numberOfLines={1}
                                        >
                                            {item.title}
                                        </Text>
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        onPress={() => handleOpenRename(item)}
                                        style={styles.iconBtn}
                                    >
                                        <Text style={styles.icon}>✏️</Text>
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        onPress={() => onDelete(item.id)}
                                        style={styles.iconBtn}
                                    >
                                        <Text style={styles.icon}>🗑</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        />
                    )}

                    {editingConv && (
                        <Modal transparent animationType="fade">
                            <View style={styles.modalBackdrop}>
                                <View style={styles.renameCard}>
                                    <Text style={styles.renameHeader}>Rename Chat</Text>
                                    <TextInput
                                        style={styles.renameInput}
                                        value={editTitleText}
                                        onChangeText={setEditTitleText}
                                        autoFocus
                                    />
                                    <View style={styles.renameActions}>
                                        <TouchableOpacity
                                            onPress={() => setEditingConv(null)}
                                            style={styles.cancelBtn}
                                        >
                                            <Text style={styles.actionText}>Cancel</Text>
                                        </TouchableOpacity>
                                        <TouchableOpacity
                                            onPress={handleSaveRename}
                                            style={styles.saveBtn}
                                        >
                                            <Text style={styles.saveText}>Save</Text>
                                        </TouchableOpacity>
                                    </View>
                                </View>
                            </View>
                        </Modal>
                    )}
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.65)',
        flexDirection: 'row',
    },
    drawerContainer: {
        width: '80%',
        backgroundColor: '#0F172A',
        padding: 16,
        paddingTop: 48,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    title: { color: '#F8FAFC', fontSize: 18, fontWeight: '700' },
    closeText: { color: '#94A3B8', fontSize: 16 },
    searchBar: {
        backgroundColor: '#1E293B',
        color: '#F8FAFC',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 13,
        marginBottom: 12,
    },
    newChatBtn: {
        backgroundColor: '#0284C7',
        padding: 10,
        borderRadius: 8,
        alignItems: 'center',
        marginBottom: 16,
    },
    newChatText: { color: '#FFFFFF', fontWeight: '600' },
    sectionHeader: {
        color: '#38BDF8',
        fontSize: 12,
        fontWeight: '600',
        marginBottom: 8,
    },
    chatItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 10,
        borderRadius: 8,
        marginBottom: 4,
    },
    activeChatItem: { backgroundColor: '#1E293B' },
    chatTitle: { color: '#CBD5E1', fontSize: 14 },
    activeChatTitle: { color: '#38BDF8', fontWeight: '600' },
    snippetText: { color: '#64748B', fontSize: 11, marginTop: 2 },
    iconBtn: { padding: 6, marginLeft: 4 },
    icon: { fontSize: 13 },
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    renameCard: {
        width: '80%',
        backgroundColor: '#1E293B',
        borderRadius: 12,
        padding: 16,
    },
    renameHeader: {
        color: '#F8FAFC',
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 12,
    },
    renameInput: {
        backgroundColor: '#0F172A',
        color: '#FFFFFF',
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: 16,
    },
    renameActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
    },
    cancelBtn: { padding: 8 },
    saveBtn: {
        backgroundColor: '#2563EB',
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 6,
    },
    actionText: { color: '#94A3B8' },
    saveText: { color: '#FFFFFF', fontWeight: '600' },
});
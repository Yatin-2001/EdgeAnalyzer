import React from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
} from 'react-native';
import { ConversationRecord } from '../database/repository';

interface Props {
    visible: boolean;
    conversations: ConversationRecord[];
    activeId: string | null;
    onSelect: (conv: ConversationRecord) => void;
    onNew: () => void;
    onDelete: (id: string) => void;
    onClose: () => void;
}

export const ConversationDrawer: React.FC<Props> = ({
                                                        visible,
                                                        conversations,
                                                        activeId,
                                                        onSelect,
                                                        onNew,
                                                        onDelete,
                                                        onClose,
                                                    }) => {
    return (
        <Modal visible={visible} animationType="fade" transparent>
            <View style={styles.overlay}>
                <View style={styles.drawerContainer}>
                    <View style={styles.header}>
                        <Text style={styles.title}>Chats</Text>
                        <TouchableOpacity onPress={onClose}>
                            <Text style={styles.closeText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    <TouchableOpacity style={styles.newChatBtn} onPress={onNew}>
                        <Text style={styles.newChatText}>+ New Chat</Text>
                    </TouchableOpacity>

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
                                    onPress={() => onDelete(item.id)}
                                    style={styles.deleteBtn}
                                >
                                    <Text style={styles.deleteIcon}>🗑</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                    />
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.6)',
        flexDirection: 'row',
    },
    drawerContainer: {
        width: '75%',
        backgroundColor: '#0F172A',
        padding: 16,
        paddingTop: 48,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    title: { color: '#F8FAFC', fontSize: 20, fontWeight: '700' },
    closeText: { color: '#94A3B8', fontSize: 18, padding: 4 },
    newChatBtn: {
        backgroundColor: '#2563EB',
        padding: 10,
        borderRadius: 8,
        alignItems: 'center',
        marginBottom: 16,
    },
    newChatText: { color: '#FFFFFF', fontWeight: '600' },
    chatItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        marginBottom: 4,
    },
    activeChatItem: { backgroundColor: '#1E293B' },
    chatTitle: { color: '#94A3B8', fontSize: 14 },
    activeChatTitle: { color: '#38BDF8', fontWeight: '600' },
    deleteBtn: { padding: 4, marginLeft: 8 },
    deleteIcon: { fontSize: 14 },
});
import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    Modal,
    TextInput,
    Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    getAllNotebooks,
    createNotebook,
    deleteNotebook,
    NotebookRecord,
} from '../../database/repository';

interface Props {
    onSelectNotebook: (notebookId: string) => void;
    onBackToChat?: () => void;
}

const COLOR_TAGS = ['#3B82F6', '#10B981', '#8B5CF6', '#F59E0B', '#EF4444'];

export const MindspaceHomeScreen: React.FC<Props> = ({
                                                         onSelectNotebook,
                                                         onBackToChat,
                                                     }) => {
    const insets = useSafeAreaInsets();
    const [notebooks, setNotebooks] = useState<
        Array<NotebookRecord & { asset_count: number }>
    >([]);
    const [isCreateModalOpen, setCreateModalOpen] = useState(false);
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [selectedColor, setSelectedColor] = useState(COLOR_TAGS[0]);

    const loadNotebooks = async () => {
        const list = await getAllNotebooks();
        setNotebooks(list);
    };

    useEffect(() => {
        loadNotebooks();
    }, []);

    const handleCreateNotebook = async () => {
        if (!title.trim()) {
            Alert.alert('Required', 'Please enter a notebook title.');
            return;
        }

        try {
            const created = await createNotebook(
                title.trim(),
                description.trim() || null,
                selectedColor
            );
            setTitle('');
            setDescription('');
            setCreateModalOpen(false);
            await loadNotebooks();
            onSelectNotebook(created.id);
        } catch (err) {
            Alert.alert('Error', 'Failed to create notebook.');
        }
    };

    const handleDeleteNotebook = (nb: NotebookRecord) => {
        Alert.alert('Delete Notebook', `Delete "${nb.title}" and all attached assets?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    await deleteNotebook(nb.id);
                    await loadNotebooks();
                },
            },
        ]);
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
                    <Text style={styles.headerTitle}>📚 MindSpace Notebooks</Text>
                </View>
                <TouchableOpacity
                    style={styles.newBtn}
                    onPress={() => setCreateModalOpen(true)}
                >
                    <Text style={styles.newBtnText}>+ New</Text>
                </TouchableOpacity>
            </View>

            {/* Notebook Grid */}
            <FlatList
                data={notebooks}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyIcon}>📚</Text>
                        <Text style={styles.emptyTitle}>No Notebooks Yet</Text>
                        <Text style={styles.emptyDesc}>
                            Create a notebook (e.g. "Phone Buying Research", "Receipts") to ingest
                            screenshots, photos, and notes with on-device Dual-Tier RAG.
                        </Text>
                        <TouchableOpacity
                            style={styles.emptyCreateBtn}
                            onPress={() => setCreateModalOpen(true)}
                        >
                            <Text style={styles.emptyCreateBtnText}>Create First Notebook</Text>
                        </TouchableOpacity>
                    </View>
                }
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={[styles.card, { borderLeftColor: item.color_tag }]}
                        onPress={() => onSelectNotebook(item.id)}
                        onLongPress={() => handleDeleteNotebook(item)}
                        activeOpacity={0.7}
                    >
                        <View style={styles.cardHeader}>
                            <Text style={styles.cardTitle} numberOfLines={1}>
                                {item.title}
                            </Text>
                            <View style={styles.badge}>
                                <Text style={styles.badgeText}>{item.asset_count} Assets</Text>
                            </View>
                        </View>

                        {item.description && (
                            <Text style={styles.cardDesc} numberOfLines={2}>
                                {item.description}
                            </Text>
                        )}

                        <View style={styles.cardFooter}>
                            <Text style={styles.cardDate}>
                                Modified {new Date(item.updated_at).toLocaleDateString()}
                            </Text>
                            <Text style={styles.cardAction}>Open ➔</Text>
                        </View>
                    </TouchableOpacity>
                )}
            />

            {/* Create Notebook Modal */}
            <Modal visible={isCreateModalOpen} animationType="slide" transparent>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>New MindSpace Notebook</Text>

                        <TextInput
                            style={styles.modalInput}
                            placeholder="Notebook Title (e.g., OnePlus Research)"
                            placeholderTextColor="#64748B"
                            value={title}
                            onChangeText={setTitle}
                        />

                        <TextInput
                            style={[styles.modalInput, { height: 80 }]}
                            placeholder="Description / Goal (optional)"
                            placeholderTextColor="#64748B"
                            value={description}
                            onChangeText={setDescription}
                            multiline
                        />

                        {/* Color Tags */}
                        <Text style={styles.colorLabel}>Notebook Color Tag:</Text>
                        <View style={styles.colorRow}>
                            {COLOR_TAGS.map((c) => (
                                <TouchableOpacity
                                    key={c}
                                    style={[
                                        styles.colorCircle,
                                        { backgroundColor: c },
                                        selectedColor === c && styles.colorCircleActive,
                                    ]}
                                    onPress={() => setSelectedColor(c)}
                                />
                            ))}
                        </View>

                        <View style={styles.modalActions}>
                            <TouchableOpacity
                                style={styles.cancelBtn}
                                onPress={() => setCreateModalOpen(false)}
                            >
                                <Text style={styles.cancelBtnText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.createBtn}
                                onPress={handleCreateNotebook}
                            >
                                <Text style={styles.createBtnText}>Create Notebook</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: '#0F172A' },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#1E293B',
    },
    backBtn: { paddingVertical: 4, paddingHorizontal: 6 },
    backBtnText: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
    headerCenter: { flex: 1, alignItems: 'center' },
    headerTitle: { color: '#F8FAFC', fontSize: 17, fontWeight: '700' },
    newBtn: {
        backgroundColor: '#2563EB',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
    },
    newBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
    listContent: { padding: 16 },
    card: {
        backgroundColor: '#1E293B',
        borderRadius: 10,
        padding: 14,
        marginBottom: 12,
        borderLeftWidth: 5,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 6,
    },
    cardTitle: { color: '#F8FAFC', fontSize: 15, fontWeight: '700', flex: 1 },
    badge: {
        backgroundColor: '#0F172A',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
    },
    badgeText: { color: '#38BDF8', fontSize: 11, fontWeight: '600' },
    cardDesc: { color: '#94A3B8', fontSize: 12, lineHeight: 18, marginBottom: 10 },
    cardFooter: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    cardDate: { color: '#64748B', fontSize: 11 },
    cardAction: { color: '#38BDF8', fontSize: 12, fontWeight: '600' },
    emptyContainer: { alignItems: 'center', marginTop: 60, paddingHorizontal: 24 },
    emptyIcon: { fontSize: 48, marginBottom: 12 },
    emptyTitle: { color: '#F8FAFC', fontSize: 18, fontWeight: '700', marginBottom: 8 },
    emptyDesc: { color: '#64748B', fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
    emptyCreateBtn: {
        backgroundColor: '#2563EB',
        paddingHorizontal: 20,
        paddingVertical: 12,
        borderRadius: 8,
    },
    emptyCreateBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 14 },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        padding: 20,
    },
    modalContent: {
        backgroundColor: '#1E293B',
        borderRadius: 12,
        padding: 20,
    },
    modalTitle: { color: '#F8FAFC', fontSize: 17, fontWeight: '700', marginBottom: 14 },
    modalInput: {
        backgroundColor: '#0F172A',
        color: '#F8FAFC',
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
        marginBottom: 12,
    },
    colorLabel: { color: '#94A3B8', fontSize: 12, marginBottom: 8 },
    colorRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
    colorCircle: { width: 28, height: 28, borderRadius: 14 },
    colorCircleActive: { borderWidth: 2, borderColor: '#FFFFFF' },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
    cancelBtn: { paddingVertical: 10, paddingHorizontal: 14 },
    cancelBtnText: { color: '#94A3B8', fontSize: 13, fontWeight: '600' },
    createBtn: {
        backgroundColor: '#2563EB',
        paddingVertical: 10,
        paddingHorizontal: 16,
        borderRadius: 8,
    },
    createBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
});
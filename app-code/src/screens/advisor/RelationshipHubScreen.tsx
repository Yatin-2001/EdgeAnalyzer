import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    TextInput,
    Modal,
    Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    getAllContacts,
    createContact,
    deleteContact,
    ContactRecord,
    RelationshipType,
    CommunicationPlatform,
} from '../../database/repository';

interface Props {
    onSelectContact: (contactId: string) => void;
    onOpenAnonymousAdvisor: () => void;
    onBackToChat?: () => void;
}

const RELATIONSHIP_TYPES: RelationshipType[] = [
    'Friend',
    'Colleague',
    'Manager',
    'Dating',
    'Family',
    'Client',
];

const PLATFORMS: CommunicationPlatform[] = [
    'whatsapp',
    'instagram',
    'slack',
    'email',
    'imessage',
    'linkedin',
];

const AVATAR_COLORS = ['#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EC4899', '#6366F1'];

export const RelationshipHubScreen: React.FC<Props> = ({
                                                           onSelectContact,
                                                           onOpenAnonymousAdvisor,
                                                           onBackToChat,
                                                       }) => {
    const insets = useSafeAreaInsets();
    const [contacts, setContacts] = useState<Array<ContactRecord & { interaction_count: number }>>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [isCreateModalOpen, setCreateModalOpen] = useState(false);

    // Form State
    const [name, setName] = useState('');
    const [handle, setHandle] = useState('');
    const [relationship, setRelationship] = useState<RelationshipType>('Friend');
    const [platform, setPlatform] = useState<CommunicationPlatform>('whatsapp');
    const [styleNotes, setStyleNotes] = useState('');
    const [selectedColor, setSelectedColor] = useState(AVATAR_COLORS[0]);

    const loadContacts = async () => {
        const list = await getAllContacts();
        setContacts(list);
    };

    useEffect(() => {
        loadContacts();
    }, []);

    const handleCreateContact = async () => {
        if (!name.trim()) {
            Alert.alert('Name Required', 'Please enter a contact name.');
            return;
        }
        try {
            const created = await createContact(
                name.trim(),
                relationship,
                platform,
                handle.trim() || null,
                styleNotes.trim() || null,
                selectedColor
            );
            setCreateModalOpen(false);
            setName('');
            setHandle('');
            setStyleNotes('');
            await loadContacts();
            onSelectContact(created.id);
        } catch {
            Alert.alert('Error', 'Failed to create contact.');
        }
    };

    const handleDeleteContact = (contact: ContactRecord) => {
        Alert.alert('Delete Contact', `Delete profile and memory history for "${contact.name}"?`, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                    await deleteContact(contact.id);
                    await loadContacts();
                },
            },
        ]);
    };

    const filteredContacts = contacts.filter(
        (c) =>
            c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            c.relationship_type.toLowerCase().includes(searchQuery.toLowerCase()) ||
            c.default_platform.toLowerCase().includes(searchQuery.toLowerCase())
    );

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
                    <Text style={styles.headerTitle}>🤝 Message Advisor</Text>
                </View>
                <TouchableOpacity style={styles.newBtn} onPress={() => setCreateModalOpen(true)}>
                    <Text style={styles.newBtnText}>+ New</Text>
                </TouchableOpacity>
            </View>

            {/* Anonymous Quick Mode Banner */}
            <TouchableOpacity style={styles.anonBanner} onPress={onOpenAnonymousAdvisor}>
                <View style={styles.anonIconWrap}>
                    <Text style={styles.anonIcon}>⚡</Text>
                </View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.anonTitle}>Anonymous Quick Mode</Text>
                    <Text style={styles.anonSub}>Upload screenshot or text scenario without saving history</Text>
                </View>
                <Text style={styles.anonArrow}>Start ➔</Text>
            </TouchableOpacity>

            {/* Search Bar */}
            <View style={styles.searchBar}>
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search contacts by name, role, or platform..."
                    placeholderTextColor="#64748B"
                    value={searchQuery}
                    onChangeText={setSearchQuery}
                />
            </View>

            {/* Contacts List */}
            <FlatList
                data={filteredContacts}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.listContent}
                ListEmptyComponent={
                    <View style={styles.emptyWrap}>
                        <Text style={styles.emptyIcon}>👤</Text>
                        <Text style={styles.emptyTitle}>No Contact Profiles Yet</Text>
                        <Text style={styles.emptyDesc}>
                            Create a profile (e.g. "Priya - Manager", "Alex - Friend") to track communication styles,
                            subtext dynamics, and historical facts.
                        </Text>
                    </View>
                }
                renderItem={({ item }) => (
                    <TouchableOpacity
                        style={styles.contactCard}
                        onPress={() => onSelectContact(item.id)}
                        onLongPress={() => handleDeleteContact(item)}
                        activeOpacity={0.7}
                    >
                        <View style={[styles.avatar, { backgroundColor: item.avatar_color }]}>
                            <Text style={styles.avatarText}>
                                {item.name.substring(0, 2).toUpperCase()}
                            </Text>
                        </View>

                        <View style={styles.cardInfo}>
                            <View style={styles.cardTitleRow}>
                                <Text style={styles.contactName} numberOfLines={1}>
                                    {item.name}
                                </Text>
                                <View style={styles.roleBadge}>
                                    <Text style={styles.roleBadgeText}>{item.relationship_type}</Text>
                                </View>
                            </View>

                            <Text style={styles.platformText}>
                                {item.default_platform.toUpperCase()}
                                {item.platform_handle ? ` • ${item.platform_handle}` : ''}
                            </Text>

                            {item.communication_style ? (
                                <Text style={styles.styleSnippet} numberOfLines={1}>
                                    Style: {item.communication_style}
                                </Text>
                            ) : null}
                        </View>

                        <View style={styles.cardMeta}>
                            <Text style={styles.interactionCount}>
                                {item.interaction_count} logs
                            </Text>
                            <Text style={styles.arrowIcon}>➔</Text>
                        </View>
                    </TouchableOpacity>
                )}
            />

            {/* Create Contact Modal */}
            <Modal visible={isCreateModalOpen} animationType="slide" transparent>
                <View style={styles.modalOverlay}>
                    <View style={styles.modalContent}>
                        <Text style={styles.modalTitle}>New Contact Profile</Text>

                        <TextInput
                            style={styles.input}
                            placeholder="Name (e.g., Priya Sharma)"
                            placeholderTextColor="#64748B"
                            value={name}
                            onChangeText={setName}
                        />

                        <TextInput
                            style={styles.input}
                            placeholder="Handle / Email (optional)"
                            placeholderTextColor="#64748B"
                            value={handle}
                            onChangeText={setHandle}
                        />

                        <Text style={styles.label}>Relationship:</Text>
                        <View style={styles.chipRow}>
                            {RELATIONSHIP_TYPES.map((r) => (
                                <TouchableOpacity
                                    key={r}
                                    style={[styles.chip, relationship === r && styles.chipActive]}
                                    onPress={() => setRelationship(r)}
                                >
                                    <Text style={[styles.chipText, relationship === r && styles.chipTextActive]}>
                                        {r}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <Text style={styles.label}>Default Platform:</Text>
                        <View style={styles.chipRow}>
                            {PLATFORMS.map((p) => (
                                <TouchableOpacity
                                    key={p}
                                    style={[styles.chip, platform === p && styles.chipActive]}
                                    onPress={() => setPlatform(p)}
                                >
                                    <Text style={[styles.chipText, platform === p && styles.chipTextActive]}>
                                        {p}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>

                        <TextInput
                            style={[styles.input, { height: 60 }]}
                            placeholder="Communication Style notes (optional)"
                            placeholderTextColor="#64748B"
                            value={styleNotes}
                            onChangeText={setStyleNotes}
                            multiline
                        />

                        <View style={styles.modalActions}>
                            <TouchableOpacity style={styles.cancelBtn} onPress={() => setCreateModalOpen(false)}>
                                <Text style={styles.cancelBtnText}>Cancel</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={styles.createBtn} onPress={handleCreateContact}>
                                <Text style={styles.createBtnText}>Save Profile</Text>
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
    newBtn: { backgroundColor: '#8B5CF6', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
    newBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
    anonBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#8B5CF618',
        margin: 14,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: '#8B5CF630',
        gap: 10,
    },
    anonIconWrap: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: '#8B5CF630',
        justifyContent: 'center',
        alignItems: 'center',
    },
    anonIcon: { fontSize: 18 },
    anonTitle: { color: '#F8FAFC', fontSize: 14, fontWeight: '700' },
    anonSub: { color: '#94A3B8', fontSize: 11, marginTop: 1 },
    anonArrow: { color: '#8B5CF6', fontSize: 12, fontWeight: '700' },
    searchBar: { paddingHorizontal: 14, marginBottom: 8 },
    searchInput: {
        backgroundColor: '#1E293B',
        color: '#F8FAFC',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 13,
    },
    listContent: { paddingHorizontal: 14, paddingBottom: 20 },
    contactCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#1E293B',
        padding: 12,
        borderRadius: 10,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#334155',
    },
    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 12,
    },
    avatarText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    cardInfo: { flex: 1 },
    cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
    contactName: { color: '#F8FAFC', fontSize: 14, fontWeight: '700', flexShrink: 1 },
    roleBadge: { backgroundColor: '#0F172A', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
    roleBadgeText: { color: '#38BDF8', fontSize: 10, fontWeight: '600' },
    platformText: { color: '#64748B', fontSize: 11 },
    styleSnippet: { color: '#94A3B8', fontSize: 11, marginTop: 3 },
    cardMeta: { alignItems: 'flex-end', marginLeft: 8 },
    interactionCount: { color: '#64748B', fontSize: 10 },
    arrowIcon: { color: '#38BDF8', fontSize: 14, marginTop: 4 },
    emptyWrap: { alignItems: 'center', marginTop: 50, paddingHorizontal: 20 },
    emptyIcon: { fontSize: 44, marginBottom: 8 },
    emptyTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', marginBottom: 4 },
    emptyDesc: { color: '#64748B', fontSize: 12, textAlign: 'center', lineHeight: 18 },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', padding: 18 },
    modalContent: { backgroundColor: '#1E293B', borderRadius: 12, padding: 18 },
    modalTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', marginBottom: 12 },
    input: {
        backgroundColor: '#0F172A',
        color: '#F8FAFC',
        borderRadius: 8,
        padding: 10,
        fontSize: 13,
        marginBottom: 10,
    },
    label: { color: '#94A3B8', fontSize: 11, fontWeight: '600', marginBottom: 6 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    chip: {
        backgroundColor: '#0F172A',
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#334155',
    },
    chipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
    chipText: { color: '#94A3B8', fontSize: 11, fontWeight: '500' },
    chipTextActive: { color: '#FFFFFF', fontWeight: '700' },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
    cancelBtn: { paddingVertical: 8, paddingHorizontal: 12 },
    cancelBtnText: { color: '#94A3B8', fontSize: 12 },
    createBtn: { backgroundColor: '#8B5CF6', paddingVertical: 8, paddingHorizontal: 14, borderRadius: 6 },
    createBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
});
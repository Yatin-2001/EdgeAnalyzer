import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    FlatList,
    Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    getContactById,
    getInteractionsByContact,
    getContactFacts,
    ContactRecord,
    ContactInteractionRecord,
    ContactFactRecord,
} from '../../database/repository';

interface Props {
    contactId: string;
    onBack: () => void;
    onOpenAdvisor: (contactId: string) => void;
}

export const ContactDetailScreen: React.FC<Props> = ({
                                                         contactId,
                                                         onBack,
                                                         onOpenAdvisor,
                                                     }) => {
    const insets = useSafeAreaInsets();
    const [contact, setContact] = useState<ContactRecord | null>(null);
    const [interactions, setInteractions] = useState<ContactInteractionRecord[]>([]);
    const [facts, setFacts] = useState<ContactFactRecord[]>([]);

    const loadData = async () => {
        const c = await getContactById(contactId);
        const inters = await getInteractionsByContact(contactId, 20);
        const fts = await getContactFacts(contactId);
        setContact(c);
        setInteractions(inters);
        setFacts(fts);
    };

    useEffect(() => {
        loadData();
    }, [contactId]);

    if (!contact) return null;

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity style={styles.backBtn} onPress={onBack}>
                    <Text style={styles.backBtnText}>‹ Contacts</Text>
                </TouchableOpacity>
                <Text style={styles.headerTitle} numberOfLines={1}>
                    {contact.name}
                </Text>
                <TouchableOpacity
                    style={styles.analyzeBtn}
                    onPress={() => onOpenAdvisor(contact.id)}
                >
                    <Text style={styles.analyzeBtnText}>⚡ Analyze</Text>
                </TouchableOpacity>
            </View>

            <FlatList
                data={interactions}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.scrollContent}
                ListHeaderComponent={
                    <View>
                        {/* Contact Profile Card */}
                        <View style={styles.profileCard}>
                            <View style={[styles.avatar, { backgroundColor: contact.avatar_color }]}>
                                <Text style={styles.avatarText}>
                                    {contact.name.substring(0, 2).toUpperCase()}
                                </Text>
                            </View>

                            <View style={{ flex: 1 }}>
                                <Text style={styles.name}>{contact.name}</Text>
                                <Text style={styles.subMeta}>
                                    {contact.relationship_type} • {contact.default_platform.toUpperCase()}
                                </Text>
                                {contact.platform_handle ? (
                                    <Text style={styles.handleText}>{contact.platform_handle}</Text>
                                ) : null}
                            </View>
                        </View>

                        {/* Communication Dynamics */}
                        <View style={styles.section}>
                            <Text style={styles.sectionHeader}>COMMUNICATION DYNAMICS</Text>
                            <Text style={styles.styleText}>
                                {contact.communication_style || 'Analyzing conversational style as you interact...'}
                            </Text>
                        </View>

                        {/* Key Facts Tags */}
                        {facts.length > 0 && (
                            <View style={styles.section}>
                                <Text style={styles.sectionHeader}>LEARNED FACTS & CONTEXT</Text>
                                <View style={styles.factsWrap}>
                                    {facts.map((f) => (
                                        <View key={f.id} style={styles.factBadge}>
                                            <Text style={styles.factText}>📌 {f.fact_text}</Text>
                                        </View>
                                    ))}
                                </View>
                            </View>
                        )}

                        <Text style={[styles.sectionHeader, { marginTop: 12, marginBottom: 8 }]}>
                            INTERACTION HISTORY TIMELINE
                        </Text>
                    </View>
                }
                ListEmptyComponent={
                    <View style={styles.emptyWrap}>
                        <Text style={styles.emptyText}>
                            No interactions analyzed yet. Tap "⚡ Analyze" to upload a screenshot or scenario.
                        </Text>
                    </View>
                }
                renderItem={({ item }) => (
                    <View style={styles.timelineCard}>
                        <View style={styles.timelineHeader}>
                            <Text style={styles.sentimentBadge}>
                                {item.detected_sentiment ? item.detected_sentiment.toUpperCase() : 'CHAT'}
                            </Text>
                            <Text style={styles.timelineDate}>
                                {new Date(item.created_at).toLocaleDateString()}
                            </Text>
                        </View>

                        {item.situation_summary ? (
                            <Text style={styles.situationText}>{item.situation_summary}</Text>
                        ) : null}

                        {item.custom_reply_feedback ? (
                            <View style={styles.feedbackBox}>
                                <Text style={styles.feedbackLabel}>You Sent:</Text>
                                <Text style={styles.feedbackText}>{item.custom_reply_feedback}</Text>
                            </View>
                        ) : item.selected_reply ? (
                            <View style={styles.feedbackBox}>
                                <Text style={styles.feedbackLabel}>Selected Reply:</Text>
                                <Text style={styles.feedbackText}>{item.selected_reply}</Text>
                            </View>
                        ) : null}
                    </View>
                )}
            />
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
    headerTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'center' },
    analyzeBtn: { backgroundColor: '#8B5CF6', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
    analyzeBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
    scrollContent: { padding: 16 },
    profileCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#1E293B',
        padding: 14,
        borderRadius: 10,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#334155',
    },
    avatar: {
        width: 48,
        height: 48,
        borderRadius: 24,
        justifyContent: 'center',
        alignItems: 'center',
        marginRight: 12,
    },
    avatarText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
    name: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
    subMeta: { color: '#38BDF8', fontSize: 12, marginTop: 2 },
    handleText: { color: '#64748B', fontSize: 11, marginTop: 2 },
    section: {
        backgroundColor: '#1E293B40',
        padding: 12,
        borderRadius: 8,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#1E293B',
    },
    sectionHeader: { color: '#64748B', fontSize: 10, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 },
    styleText: { color: '#F8FAFC', fontSize: 13, lineHeight: 18 },
    factsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
    factBadge: { backgroundColor: '#0F172A', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
    factText: { color: '#38BDF8', fontSize: 11 },
    timelineCard: {
        backgroundColor: '#1E293B',
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#334155',
    },
    timelineHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
    sentimentBadge: { color: '#8B5CF6', fontSize: 10, fontWeight: '700' },
    timelineDate: { color: '#64748B', fontSize: 10 },
    situationText: { color: '#F8FAFC', fontSize: 12, lineHeight: 18, marginBottom: 6 },
    feedbackBox: { backgroundColor: '#0F172A', padding: 8, borderRadius: 6 },
    feedbackLabel: { color: '#10B981', fontSize: 10, fontWeight: '700', marginBottom: 2 },
    feedbackText: { color: '#94A3B8', fontSize: 12 },
    emptyWrap: { alignItems: 'center', marginTop: 20 },
    emptyText: { color: '#64748B', fontSize: 12, textAlign: 'center' },
});
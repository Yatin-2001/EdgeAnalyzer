import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    ScrollView,
    TextInput,
    Image,
    Alert,
    ActivityIndicator,
    Modal,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import {
    getAllContacts,
    getContactById,
    createContact,
    ContactRecord,
} from '../../database/repository';
import {
    CommunicationAdvisorService,
    AdvisoryResult,
} from '../../services/CommunicationAdvisorService';

interface Props {
    initialContactId?: string | null;
    onBack: () => void;
}

const TONE_PRESETS = [
    'Casual',
    'Witty / Banter',
    'Firm Professional',
    'Diplomatic / Soft',
    'De-escalate',
];

export const AdvisorWorkspaceScreen: React.FC<Props> = ({
                                                            initialContactId = null,
                                                            onBack,
                                                        }) => {
    const insets = useSafeAreaInsets();
    const advisorService = CommunicationAdvisorService.getInstance();

    const [contactId, setContactId] = useState<string | null>(initialContactId);
    const [activeContact, setActiveContact] = useState<ContactRecord | null>(null);
    const [allContacts, setAllContacts] = useState<ContactRecord[]>([]);

    // Input Mode
    const [inputMode, setInputMode] = useState<'screenshot' | 'manual_text'>('screenshot');
    const [screenshotUri, setScreenshotUri] = useState<string | null>(null);
    const [transcriptText, setTranscriptText] = useState('');
    const [selectedPresetTone, setSelectedPresetTone] = useState<string | null>(null);
    const [customGoal, setCustomGoal] = useState('');

    // Processing & Advisory Results
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [result, setResult] = useState<AdvisoryResult | null>(null);

    // Contact Matching Confirmation Modal
    const [matchModalVisible, setMatchModalVisible] = useState(false);
    const [detectedName, setDetectedName] = useState('');
    const [detectedPlatform, setDetectedPlatform] = useState('whatsapp');

    // Custom Sent Message Box State
    const [customSentText, setCustomSentText] = useState('');
    const [feedbackSaved, setFeedbackSaved] = useState(false);

    useEffect(() => {
        (async () => {
            const contacts = await getAllContacts();
            setAllContacts(contacts);
            if (contactId && contactId !== 'anonymous') {
                const c = await getContactById(contactId);
                setActiveContact(c);
            }
        })();
    }, [contactId]);

    // Handle Screenshot Upload
    const handlePickScreenshot = async () => {
        const res = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.9,
        });

        if (!res.canceled && res.assets[0]) {
            const uri = res.assets[0].uri;
            setScreenshotUri(uri);
            setIsAnalyzing(true);
            setResult(null);

            try {
                const parsed = await advisorService.parseScreenshotDialogue(uri);
                setTranscriptText(parsed.rawTranscript);
                setDetectedPlatform(parsed.detectedPlatform);

                // Prompt user for contact confirmation if not already linked
                if (!contactId || contactId === 'anonymous') {
                    if (parsed.detectedName) {
                        setDetectedName(parsed.detectedName);
                        setMatchModalVisible(true);
                    }
                }
            } catch (err) {
                Alert.alert('OCR Failed', 'Could not extract text from screenshot.');
            } finally {
                setIsAnalyzing(false);
            }
        }
    };

    // Execute Analysis
    const handleRunAdvice = async () => {
        if (!transcriptText.trim()) {
            Alert.alert('Input Required', 'Please upload a screenshot or enter a conversation scenario.');
            return;
        }

        setIsAnalyzing(true);
        setResult(null);
        setFeedbackSaved(false);

        try {
            const res = await advisorService.generateCommunicationAdvice(
                contactId,
                transcriptText.trim(),
                customGoal.trim() || null,
                selectedPresetTone,
                inputMode,
                screenshotUri
            );
            setResult(res);
        } catch (err) {
            Alert.alert('Analysis Failed', String(err));
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleCopyReply = async (text: string) => {
        await Clipboard.setStringAsync(text);
        Alert.alert('Copied', 'Reply copied to clipboard.');
    };

    const handleMarkAsSent = async (replyText: string) => {
        if (!result) return;
        await advisorService.recordUserFeedback(
            result.interactionId,
            contactId,
            replyText,
            null
        );
        setFeedbackSaved(true);
        Alert.alert('Recorded', 'Marked as sent. Future advice will adapt to this precedent.');
    };

    const handleSaveCustomSent = async () => {
        if (!result || !customSentText.trim()) return;
        await advisorService.recordUserFeedback(
            result.interactionId,
            contactId,
            null,
            customSentText.trim()
        );
        setFeedbackSaved(true);
        Alert.alert('Style Updated', 'Your custom response was ingested into this contact\'s style memory.');
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Top Header */}
            <View style={styles.header}>
                <TouchableOpacity style={styles.backBtn} onPress={onBack}>
                    <Text style={styles.backBtnText}>‹ Back</Text>
                </TouchableOpacity>

                <View style={styles.headerCenter}>
                    <Text style={styles.headerTitle}>Advisor Workspace</Text>
                    <Text style={styles.headerSubtitle}>
                        {activeContact
                            ? `👤 ${activeContact.name} (${activeContact.relationship_type})`
                            : '⚡ Anonymous Quick Mode'}
                    </Text>
                </View>
                <View style={{ width: 40 }} />
            </View>

            <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>
                {/* Input Switcher */}
                <View style={styles.inputSwitcher}>
                    <TouchableOpacity
                        style={[styles.switchBtn, inputMode === 'screenshot' && styles.switchBtnActive]}
                        onPress={() => setInputMode('screenshot')}
                    >
                        <Text style={[styles.switchText, inputMode === 'screenshot' && styles.switchTextActive]}>
                            📸 Screenshot
                        </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={[styles.switchBtn, inputMode === 'manual_text' && styles.switchBtnActive]}
                        onPress={() => setInputMode('manual_text')}
                    >
                        <Text style={[styles.switchText, inputMode === 'manual_text' && styles.switchTextActive]}>
                            ✍ Text Scenario
                        </Text>
                    </TouchableOpacity>
                </View>

                {/* Input Container */}
                {inputMode === 'screenshot' ? (
                    <View style={styles.screenshotSection}>
                        <TouchableOpacity style={styles.uploadCard} onPress={handlePickScreenshot}>
                            {screenshotUri ? (
                                <Image source={{ uri: screenshotUri }} style={styles.thumbImage} />
                            ) : (
                                <View style={styles.uploadPlaceholder}>
                                    <Text style={styles.uploadIcon}>🖼️</Text>
                                    <Text style={styles.uploadText}>Select Chat Screenshot (OCR)</Text>
                                    <Text style={styles.uploadSub}>WhatsApp, Instagram, Slack, Email</Text>
                                </View>
                            )}
                        </TouchableOpacity>

                        {transcriptText ? (
                            <View style={styles.transcriptWrap}>
                                <Text style={styles.transcriptHeader}>Extracted Dialogue:</Text>
                                <TextInput
                                    style={styles.transcriptInput}
                                    value={transcriptText}
                                    onChangeText={setTranscriptText}
                                    multiline
                                />
                            </View>
                        ) : null}
                    </View>
                ) : (
                    <View style={styles.manualSection}>
                        <TextInput
                            style={styles.manualInput}
                            placeholder="Describe what happened or paste text (e.g., 'Rahul said: Are you available for a quick sync tonight?')"
                            placeholderTextColor="#64748B"
                            value={transcriptText}
                            onChangeText={setTranscriptText}
                            multiline
                        />
                    </View>
                )}

                {/* Tone Preset Chips */}
                <Text style={styles.sectionLabel}>Desired Tone or Strategy:</Text>
                <View style={styles.toneRow}>
                    {TONE_PRESETS.map((tone) => (
                        <TouchableOpacity
                            key={tone}
                            style={[styles.toneChip, selectedPresetTone === tone && styles.toneChipActive]}
                            onPress={() =>
                                setSelectedPresetTone((prev) => (prev === tone ? null : tone))
                            }
                        >
                            <Text
                                style={[
                                    styles.toneChipText,
                                    selectedPresetTone === tone && styles.toneChipTextActive,
                                ]}
                            >
                                {tone}
                            </Text>
                        </TouchableOpacity>
                    ))}
                </View>

                {/* Custom Goal Input */}
                <TextInput
                    style={styles.goalInput}
                    placeholder="Or enter custom goal (e.g., 'Decline politely without sounding rude')..."
                    placeholderTextColor="#64748B"
                    value={customGoal}
                    onChangeText={setCustomGoal}
                />

                {/* Analyze Button */}
                <TouchableOpacity
                    style={[styles.analyzeBtn, isAnalyzing && styles.disabledBtn]}
                    onPress={handleRunAdvice}
                    disabled={isAnalyzing}
                >
                    {isAnalyzing ? (
                        <ActivityIndicator color="#FFFFFF" size="small" />
                    ) : (
                        <Text style={styles.analyzeBtnText}>⚡ Get Subtext & Tailored Replies</Text>
                    )}
                </TouchableOpacity>

                {/* Results Section */}
                {result && (
                    <View style={styles.resultsContainer}>
                        {/* Subtext Analysis Card */}
                        <View style={styles.adviceCard}>
                            <View style={styles.adviceHeader}>
                                <Text style={styles.adviceTitle}>🧠 Subtext & Dynamics</Text>
                                <Text style={styles.sentimentBadge}>
                                    {result.detectedSentiment.toUpperCase()}
                                </Text>
                            </View>
                            <Text style={styles.subtextText}>{result.subtextAnalysis}</Text>
                            <Text style={styles.strategicText}>{result.strategicAdvice}</Text>
                        </View>

                        {/* 3-Tier Reply Cards */}
                        <Text style={[styles.sectionLabel, { marginTop: 14 }]}>
                            Strategic Reply Options:
                        </Text>
                        {result.replies.map((rep, idx) => (
                            <View key={idx} style={styles.replyCard}>
                                <View style={styles.replyCardHeader}>
                                    <Text style={styles.replyLabel}>{rep.label}</Text>
                                    <Text style={styles.replyIntent}>{rep.tone_intent}</Text>
                                </View>
                                <Text style={styles.replyText}>{rep.text}</Text>

                                <View style={styles.replyActions}>
                                    <TouchableOpacity
                                        style={styles.copyBtn}
                                        onPress={() => handleCopyReply(rep.text)}
                                    >
                                        <Text style={styles.copyBtnText}>📋 Copy</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={styles.sentBtn}
                                        onPress={() => handleMarkAsSent(rep.text)}
                                    >
                                        <Text style={styles.sentBtnText}>✓ Mark as Sent</Text>
                                    </TouchableOpacity>
                                </View>
                            </View>
                        ))}

                        {/* Custom Sent Message Reinforcement */}
                        <View style={styles.customFeedbackBox}>
                            <Text style={styles.customFeedbackTitle}>
                                Sent something different?
                            </Text>
                            <TextInput
                                style={styles.customFeedbackInput}
                                placeholder="Paste what you actually sent to evolve future advice..."
                                placeholderTextColor="#64748B"
                                value={customSentText}
                                onChangeText={setCustomSentText}
                            />
                            <TouchableOpacity
                                style={[
                                    styles.saveFeedbackBtn,
                                    !customSentText.trim() && styles.disabledBtn,
                                ]}
                                onPress={handleSaveCustomSent}
                                disabled={!customSentText.trim()}
                            >
                                <Text style={styles.saveFeedbackText}>Update My Style</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                )}
            </ScrollView>

            {/* Contact Association Modal */}
            <Modal visible={matchModalVisible} animationType="slide" transparent>
                <View style={styles.modalOverlay}>
                    <View style={styles.matchModal}>
                        <Text style={styles.matchTitle}>Link Conversation to Contact</Text>
                        <Text style={styles.matchDesc}>
                            Detected header name: <Text style={{ color: '#38BDF8', fontWeight: '700' }}>"{detectedName}"</Text>
                        </Text>

                        <ScrollView style={{ maxHeight: 180, marginVertical: 10 }}>
                            <Text style={styles.matchSectionLabel}>Link with existing contact:</Text>
                            {allContacts.map((c) => (
                                <TouchableOpacity
                                    key={c.id}
                                    style={styles.matchContactRow}
                                    onPress={() => {
                                        setContactId(c.id);
                                        setActiveContact(c);
                                        setMatchModalVisible(false);
                                    }}
                                >
                                    <Text style={styles.matchContactName}>{c.name}</Text>
                                    <Text style={styles.matchContactRole}>{c.relationship_type}</Text>
                                </TouchableOpacity>
                            ))}
                        </ScrollView>

                        <View style={styles.matchActions}>
                            <TouchableOpacity
                                style={styles.createContactBtn}
                                onPress={async () => {
                                    const created = await createContact(
                                        detectedName,
                                        'Friend',
                                        detectedPlatform as any
                                    );
                                    setContactId(created.id);
                                    setActiveContact(created);
                                    setMatchModalVisible(false);
                                }}
                            >
                                <Text style={styles.createContactText}>+ Create "{detectedName}"</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                                style={styles.stayAnonBtn}
                                onPress={() => {
                                    setContactId('anonymous');
                                    setActiveContact(null);
                                    setMatchModalVisible(false);
                                }}
                            >
                                <Text style={styles.stayAnonText}>Keep Anonymous</Text>
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
    headerTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
    headerSubtitle: { color: '#8B5CF6', fontSize: 11, fontWeight: '600', marginTop: 1 },
    scrollArea: { flex: 1 },
    scrollContent: { padding: 16, paddingBottom: 40 },
    inputSwitcher: {
        flexDirection: 'row',
        backgroundColor: '#1E293B',
        borderRadius: 8,
        padding: 3,
        marginBottom: 12,
    },
    switchBtn: { flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 6 },
    switchBtnActive: { backgroundColor: '#8B5CF6' },
    switchText: { color: '#94A3B8', fontSize: 12, fontWeight: '600' },
    switchTextActive: { color: '#FFFFFF', fontWeight: '700' },
    screenshotSection: { marginBottom: 12 },
    uploadCard: {
        height: 140,
        backgroundColor: '#1E293B',
        borderRadius: 8,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: '#334155',
    },
    thumbImage: { width: '100%', height: '100%', resizeMode: 'cover' },
    uploadPlaceholder: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 4 },
    uploadIcon: { fontSize: 28 },
    uploadText: { color: '#F8FAFC', fontSize: 13, fontWeight: '600' },
    uploadSub: { color: '#64748B', fontSize: 11 },
    transcriptWrap: { marginTop: 10 },
    transcriptHeader: { color: '#64748B', fontSize: 11, fontWeight: '700', marginBottom: 4 },
    transcriptInput: {
        backgroundColor: '#1E293B',
        color: '#F8FAFC',
        borderRadius: 8,
        padding: 10,
        fontSize: 12,
        maxHeight: 100,
    },
    manualSection: { marginBottom: 12 },
    manualInput: {
        backgroundColor: '#1E293B',
        color: '#F8FAFC',
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
        minHeight: 110,
        textAlignVertical: 'top',
    },
    sectionLabel: { color: '#94A3B8', fontSize: 11, fontWeight: '700', marginBottom: 6 },
    toneRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    toneChip: {
        backgroundColor: '#1E293B',
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: '#334155',
    },
    toneChipActive: { backgroundColor: '#8B5CF6', borderColor: '#8B5CF6' },
    toneChipText: { color: '#94A3B8', fontSize: 11, fontWeight: '600' },
    toneChipTextActive: { color: '#FFFFFF', fontWeight: '700' },
    goalInput: {
        backgroundColor: '#1E293B',
        color: '#F8FAFC',
        borderRadius: 8,
        padding: 10,
        fontSize: 12,
        marginBottom: 14,
    },
    analyzeBtn: {
        backgroundColor: '#8B5CF6',
        paddingVertical: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    analyzeBtnText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
    disabledBtn: { opacity: 0.5 },
    resultsContainer: { marginTop: 16 },
    adviceCard: {
        backgroundColor: '#1E293B',
        borderRadius: 10,
        padding: 14,
        borderLeftWidth: 4,
        borderLeftColor: '#8B5CF6',
        marginBottom: 10,
    },
    adviceHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
    adviceTitle: { color: '#F8FAFC', fontSize: 14, fontWeight: '700' },
    sentimentBadge: { color: '#8B5CF6', fontSize: 10, fontWeight: '700' },
    subtextText: { color: '#F8FAFC', fontSize: 13, lineHeight: 19, marginBottom: 6 },
    strategicText: { color: '#38BDF8', fontSize: 12, lineHeight: 18 },
    replyCard: {
        backgroundColor: '#1E293B',
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: '#334155',
    },
    replyCardHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
    replyLabel: { color: '#8B5CF6', fontSize: 12, fontWeight: '700' },
    replyIntent: { color: '#64748B', fontSize: 10 },
    replyText: { color: '#F8FAFC', fontSize: 13, lineHeight: 19, marginVertical: 4 },
    replyActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 6 },
    copyBtn: { backgroundColor: '#334155', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4 },
    copyBtnText: { color: '#F8FAFC', fontSize: 11, fontWeight: '600' },
    sentBtn: { backgroundColor: '#10B98125', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 4 },
    sentBtnText: { color: '#10B981', fontSize: 11, fontWeight: '700' },
    customFeedbackBox: {
        backgroundColor: '#1E293B50',
        padding: 12,
        borderRadius: 8,
        marginTop: 12,
        borderWidth: 1,
        borderColor: '#334155',
    },
    customFeedbackTitle: { color: '#94A3B8', fontSize: 11, fontWeight: '700', marginBottom: 6 },
    customFeedbackInput: {
        backgroundColor: '#0F172A',
        color: '#F8FAFC',
        borderRadius: 6,
        padding: 8,
        fontSize: 12,
        marginBottom: 8,
    },
    saveFeedbackBtn: {
        backgroundColor: '#334155',
        paddingVertical: 6,
        borderRadius: 6,
        alignItems: 'center',
    },
    saveFeedbackText: { color: '#38BDF8', fontSize: 11, fontWeight: '600' },
    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'center', padding: 20 },
    matchModal: { backgroundColor: '#1E293B', borderRadius: 12, padding: 16 },
    matchTitle: { color: '#F8FAFC', fontSize: 16, fontWeight: '700', marginBottom: 4 },
    matchDesc: { color: '#94A3B8', fontSize: 12, marginBottom: 8 },
    matchSectionLabel: { color: '#64748B', fontSize: 10, fontWeight: '700', marginBottom: 4 },
    matchContactRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: '#334155',
    },
    matchContactName: { color: '#F8FAFC', fontSize: 13 },
    matchContactRole: { color: '#38BDF8', fontSize: 11 },
    matchActions: { gap: 6, marginTop: 10 },
    createContactBtn: { backgroundColor: '#8B5CF6', paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
    createContactText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
    stayAnonBtn: { backgroundColor: '#334155', paddingVertical: 8, borderRadius: 6, alignItems: 'center' },
    stayAnonText: { color: '#94A3B8', fontSize: 12 },
});
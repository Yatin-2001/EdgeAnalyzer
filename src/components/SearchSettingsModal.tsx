import React, { useState, useEffect } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    ScrollView,
    Alert,
    KeyboardAvoidingView,
    Platform,
    TouchableWithoutFeedback,
    Keyboard,
} from 'react-native';
import {
    SecureStorageService,
    SearchProvider,
} from '../services/SecureStorageService';

interface Props {
    visible: boolean;
    onClose: () => void;
    onProviderChanged?: (provider: SearchProvider) => void;
}

export const SearchSettingsModal: React.FC<Props> = ({
                                                         visible,
                                                         onClose,
                                                         onProviderChanged,
                                                     }) => {
    const [provider, setProvider] = useState<SearchProvider>('tavily_keyless');
    const [maskedKey, setMaskedKey] = useState<string | null>(null);
    const [inputKey, setInputKey] = useState('');
    const [isEditingKey, setIsEditingKey] = useState(false);

    const loadSettings = async () => {
        const activeProvider = await SecureStorageService.getActiveSearchProvider();
        const keyPreview = await SecureStorageService.getMaskedBraveApiKey();
        setProvider(activeProvider);
        setMaskedKey(keyPreview);
        setInputKey('');
        setIsEditingKey(false);
    };

    useEffect(() => {
        if (visible) loadSettings();
    }, [visible]);

    const handleSaveKey = async () => {
        if (!inputKey.trim()) {
            Alert.alert('Error', 'Please enter a valid Brave Search API Key.');
            return;
        }
        try {
            await SecureStorageService.saveBraveApiKey(inputKey.trim());
            await SecureStorageService.setActiveSearchProvider('brave_custom');
            setProvider('brave_custom');
            onProviderChanged?.('brave_custom');
            Keyboard.dismiss();
            await loadSettings();
            Alert.alert(
                'Saved & Encrypted',
                'Brave Search API Key encrypted and stored in Android Keystore.'
            );
        } catch (e) {
            Alert.alert('Save Failed', String(e));
        }
    };

    const handleRemoveKey = async () => {
        Alert.alert(
            'Remove API Key',
            'Remove your Brave Search API Key and revert to keyless search?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                        await SecureStorageService.deleteBraveApiKey();
                        await SecureStorageService.setActiveSearchProvider('tavily_keyless');
                        setProvider('tavily_keyless');
                        onProviderChanged?.('tavily_keyless');
                        await loadSettings();
                    },
                },
            ]
        );
    };

    const handleSelectProvider = async (selected: SearchProvider) => {
        if (selected === 'brave_custom' && !maskedKey) {
            Alert.alert('Key Required', 'Please add and save a Brave Search API key first.');
            return;
        }
        await SecureStorageService.setActiveSearchProvider(selected);
        setProvider(selected);
        onProviderChanged?.(selected);
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent
            onRequestClose={onClose}
        >
            <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
                <View style={styles.overlay}>
                    <KeyboardAvoidingView
                        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                        style={styles.keyboardAvoid}
                    >
                        <View style={styles.modalCard}>
                            <View style={styles.header}>
                                <Text style={styles.headerTitle}>Search Engine & API Config</Text>
                                <TouchableOpacity onPress={onClose}>
                                    <Text style={styles.doneText}>Done</Text>
                                </TouchableOpacity>
                            </View>

                            <ScrollView
                                style={styles.scrollArea}
                                contentContainerStyle={styles.scrollContent}
                                keyboardShouldPersistTaps="handled"
                                showsVerticalScrollIndicator={false}
                            >
                                <View style={styles.infoBox}>
                                    <Text style={styles.infoTitle}>
                                        💡 Why Switch from Keyless to Brave Search API?
                                    </Text>
                                    <Text style={styles.infoBody}>
                                        • <Text style={styles.boldText}>Context Density & Token Savings:</Text>{' '}
                                        Keyless search returns raw web snippets. Brave's API delivers dense,
                                        pre-summarized facts that keep prompt sizes well under token limits.{'\n'}
                                        • <Text style={styles.boldText}>Accuracy & Freshness:</Text> Keyless
                                        tiers have strict IP caps. Brave Search queries an independent 30B+ page
                                        index with strict recency parameters.{'\n'}
                                        • <Text style={styles.boldText}>Hardware-Backed Security:</Text> Your API
                                        key is encrypted using AES-256 via the hardware-backed Android Keystore.
                                    </Text>
                                </View>

                                <Text style={styles.sectionHeader}>Active Search Engine</Text>

                                <TouchableOpacity
                                    style={[
                                        styles.providerCard,
                                        provider === 'tavily_keyless' && styles.providerCardActive,
                                    ]}
                                    onPress={() => handleSelectProvider('tavily_keyless')}
                                >
                                    <View style={styles.providerRow}>
                                        <Text style={styles.providerTitle}>🌐 Tavily Keyless (Default)</Text>
                                        <Text style={styles.badge}>
                                            {provider === 'tavily_keyless' ? 'ACTIVE' : 'SELECT'}
                                        </Text>
                                    </View>
                                    <Text style={styles.providerDesc}>
                                        Free shared tier. Subject to rate limits and broader snippets.
                                    </Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={[
                                        styles.providerCard,
                                        provider === 'brave_custom' && styles.providerCardActive,
                                    ]}
                                    onPress={() => handleSelectProvider('brave_custom')}
                                >
                                    <View style={styles.providerRow}>
                                        <Text style={styles.providerTitle}>⚡ Brave Search API (Pro Answers)</Text>
                                        <Text style={styles.badgePro}>
                                            {provider === 'brave_custom' ? 'ACTIVE' : 'SELECT'}
                                        </Text>
                                    </View>
                                    <Text style={styles.providerDesc}>
                                        Direct AI summaries, higher rate limits, and accurate real-time queries.
                                    </Text>
                                </TouchableOpacity>

                                <Text style={styles.sectionHeader}>Brave API Key Configuration</Text>
                                {maskedKey && !isEditingKey ? (
                                    <View style={styles.keyDisplayCard}>
                                        <View>
                                            <Text style={styles.keyLabel}>Stored Keystore Token</Text>
                                            <Text style={styles.maskedKeyText}>{maskedKey}</Text>
                                        </View>
                                        <View style={styles.keyActions}>
                                            <TouchableOpacity
                                                style={styles.editBtn}
                                                onPress={() => setIsEditingKey(true)}
                                            >
                                                <Text style={styles.btnText}>Change</Text>
                                            </TouchableOpacity>
                                            <TouchableOpacity
                                                style={styles.removeBtn}
                                                onPress={handleRemoveKey}
                                            >
                                                <Text style={styles.removeText}>Remove</Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                ) : (
                                    <View style={styles.inputWrap}>
                                        <TextInput
                                            style={styles.keyInput}
                                            placeholder="Enter Brave Search API Token (BSA...)"
                                            placeholderTextColor="#64748B"
                                            value={inputKey}
                                            onChangeText={setInputKey}
                                            secureTextEntry
                                            autoCapitalize="none"
                                            returnKeyType="done"
                                        />
                                        <View style={styles.saveActions}>
                                            {maskedKey && (
                                                <TouchableOpacity
                                                    style={styles.cancelBtn}
                                                    onPress={() => setIsEditingKey(false)}
                                                >
                                                    <Text style={styles.cancelText}>Cancel</Text>
                                                </TouchableOpacity>
                                            )}
                                            <TouchableOpacity
                                                style={styles.saveBtn}
                                                onPress={handleSaveKey}
                                            >
                                                <Text style={styles.saveBtnText}>Encrypt & Save</Text>
                                            </TouchableOpacity>
                                        </View>
                                    </View>
                                )}
                            </ScrollView>
                        </View>
                    </KeyboardAvoidingView>
                </View>
            </TouchableWithoutFeedback>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    keyboardAvoid: {
        width: '100%',
        maxHeight: '90%',
    },
    modalCard: {
        backgroundColor: '#0F172A',
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        padding: 16,
        maxHeight: '100%',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    headerTitle: { color: '#F8FAFC', fontSize: 18, fontWeight: '700' },
    doneText: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
    scrollArea: { flexShrink: 1 },
    scrollContent: { paddingBottom: 32 },
    infoBox: {
        backgroundColor: '#1E293B',
        padding: 14,
        borderRadius: 8,
        borderLeftWidth: 4,
        borderLeftColor: '#38BDF8',
        marginBottom: 16,
    },
    infoTitle: { color: '#F8FAFC', fontSize: 13, fontWeight: '700', marginBottom: 6 },
    infoBody: { color: '#94A3B8', fontSize: 12, lineHeight: 18 },
    boldText: { color: '#E2E8F0', fontWeight: '600' },
    sectionHeader: {
        color: '#38BDF8',
        fontSize: 13,
        fontWeight: '600',
        marginBottom: 8,
        marginTop: 4,
    },
    providerCard: {
        backgroundColor: '#1E293B',
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    providerCardActive: { borderColor: '#38BDF8', backgroundColor: '#0284C715' },
    providerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    providerTitle: { color: '#F8FAFC', fontSize: 14, fontWeight: '600' },
    providerDesc: { color: '#94A3B8', fontSize: 12, marginTop: 4 },
    badge: { color: '#64748B', fontSize: 11, fontWeight: '700' },
    badgePro: { color: '#10B981', fontSize: 11, fontWeight: '700' },
    keyDisplayCard: {
        backgroundColor: '#1E293B',
        padding: 12,
        borderRadius: 8,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    keyLabel: { color: '#64748B', fontSize: 11 },
    maskedKeyText: {
        color: '#F8FAFC',
        fontFamily: 'monospace',
        fontSize: 13,
        marginTop: 2,
    },
    keyActions: { flexDirection: 'row', gap: 8 },
    editBtn: {
        backgroundColor: '#334155',
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
    },
    removeBtn: {
        backgroundColor: '#EF444420',
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
    },
    btnText: { color: '#FFFFFF', fontSize: 12 },
    removeText: { color: '#EF4444', fontSize: 12, fontWeight: '600' },
    inputWrap: { backgroundColor: '#1E293B', padding: 12, borderRadius: 8 },
    keyInput: {
        backgroundColor: '#0F172A',
        color: '#FFFFFF',
        borderRadius: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        fontSize: 13,
        marginBottom: 10,
    },
    saveActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
    cancelBtn: { padding: 8 },
    cancelText: { color: '#94A3B8', fontSize: 13 },
    saveBtn: {
        backgroundColor: '#2563EB',
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 6,
    },
    saveBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
});
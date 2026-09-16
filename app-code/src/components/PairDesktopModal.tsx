import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Modal,
    TextInput,
    TouchableOpacity,
    ActivityIndicator,
    Alert,
} from 'react-native';
import * as SecureStore from 'expo-secure-store';
import MeshClientService from '../services/MeshClientService';

interface Props {
    visible: boolean;
    onClose: () => void;
    onPairSuccess: () => void;
}

// Persistent device identifier without requiring expo-application
async function getOrCreateDeviceId(): Promise<string> {
    const KEY = 'mesh_persistent_device_id';
    let deviceId = await SecureStore.getItemAsync(KEY);
    if (!deviceId) {
        deviceId = `dev_mobile_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 7)}`;
        await SecureStore.setItemAsync(KEY, deviceId);
    }
    return deviceId;
}

export const PairDesktopModal: React.FC<Props> = ({
                                                      visible,
                                                      onClose,
                                                      onPairSuccess,
                                                  }) => {
    const [desktopIp, setDesktopIp] = useState('');
    const [port, setPort] = useState('8080');
    const [pin, setPin] = useState('');
    const [isPairing, setIsPairing] = useState(false);

    const handlePair = async () => {
        if (!desktopIp.trim() || !pin.trim()) {
            Alert.alert('Missing Fields', 'Please enter both the Desktop IP and the 6-digit PIN.');
            return;
        }

        setIsPairing(true);
        try {
            const meshService = MeshClientService.getInstance();
            const deviceId = await getOrCreateDeviceId();
            const deviceName = 'OnePlus 15';

            await meshService.pairWithDesktop(
                desktopIp.trim(),
                parseInt(port.trim(), 10) || 8080,
                pin.trim().replace('-', ''),
                deviceId,
                deviceName
            );

            Alert.alert('Paired Successfully', 'Connected to Desktop RTX 3060 compute node.');
            onPairSuccess();
            onClose();
        } catch (err: any) {
            Alert.alert('Pairing Failed', err.message || 'Check PIN or ensure Desktop Daemon is running.');
        } finally {
            setIsPairing(false);
        }
    };

    return (
        <Modal visible={visible} animationType="fade" transparent>
            <View style={styles.overlay}>
                <View style={styles.modalCard}>
                    <Text style={styles.title}>💻 Pair Desktop Node</Text>
                    <Text style={styles.description}>
                        Enter the host IP and the 6-digit PIN displayed on your Desktop Admin Dashboard.
                    </Text>

                    <Text style={styles.label}>Desktop Host IP:</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="e.g. 192.168.1.100"
                        placeholderTextColor="#64748B"
                        value={desktopIp}
                        onChangeText={setDesktopIp}
                        keyboardType="numeric"
                        autoCapitalize="none"
                    />

                    <View style={styles.row}>
                        <View style={{ flex: 1, marginRight: 8 }}>
                            <Text style={styles.label}>Port:</Text>
                            <TextInput
                                style={styles.input}
                                placeholder="8080"
                                placeholderTextColor="#64748B"
                                value={port}
                                onChangeText={setPort}
                                keyboardType="numeric"
                            />
                        </View>
                        <View style={{ flex: 2 }}>
                            <Text style={styles.label}>6-Digit PIN:</Text>
                            <TextInput
                                style={[styles.input, styles.pinInput]}
                                placeholder="749218"
                                placeholderTextColor="#64748B"
                                value={pin}
                                onChangeText={setPin}
                                keyboardType="numeric"
                                maxLength={6}
                            />
                        </View>
                    </View>

                    <View style={styles.actionRow}>
                        <TouchableOpacity
                            style={styles.cancelBtn}
                            onPress={onClose}
                            disabled={isPairing}
                        >
                            <Text style={styles.cancelText}>Cancel</Text>
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={[styles.pairBtn, isPairing && styles.disabledBtn]}
                            onPress={handlePair}
                            disabled={isPairing}
                        >
                            {isPairing ? (
                                <ActivityIndicator color="#FFFFFF" size="small" />
                            ) : (
                                <Text style={styles.pairText}>Authenticate & Pair</Text>
                            )}
                        </TouchableOpacity>
                    </View>
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        justifyContent: 'center',
        padding: 20,
    },
    modalCard: {
        backgroundColor: '#1E293B',
        borderRadius: 14,
        padding: 20,
        borderWidth: 1,
        borderColor: '#334155',
    },
    title: {
        color: '#F8FAFC',
        fontSize: 17,
        fontWeight: '700',
        marginBottom: 6,
    },
    description: {
        color: '#94A3B8',
        fontSize: 12,
        lineHeight: 18,
        marginBottom: 16,
    },
    label: {
        color: '#CBD5E1',
        fontSize: 11,
        fontWeight: '600',
        marginBottom: 4,
    },
    input: {
        backgroundColor: '#0F172A',
        color: '#F8FAFC',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 9,
        fontSize: 13,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: '#334155',
    },
    pinInput: {
        letterSpacing: 4,
        fontWeight: '700',
        textAlign: 'center',
    },
    row: {
        flexDirection: 'row',
    },
    actionRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: 10,
        marginTop: 8,
    },
    cancelBtn: {
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 8,
    },
    cancelText: {
        color: '#94A3B8',
        fontSize: 13,
        fontWeight: '600',
    },
    pairBtn: {
        backgroundColor: '#0284C7',
        paddingVertical: 10,
        paddingHorizontal: 18,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pairText: {
        color: '#FFFFFF',
        fontSize: 13,
        fontWeight: '700',
    },
    disabledBtn: {
        opacity: 0.6,
    },
});
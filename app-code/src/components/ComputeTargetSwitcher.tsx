import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { MeshConnectionStatus, HeartbeatTelemetry } from '../services/MeshClientService';
import MeshClientService from '../services/MeshClientService';

export type ComputeTarget = 'desktop' | 'local';

interface Props {
    selectedTarget: ComputeTarget;
    onTargetChange: (target: ComputeTarget) => void;
}

export const ComputeTargetSwitcher: React.FC<Props> = ({ selectedTarget, onTargetChange }) => {
    const [meshStatus, setMeshStatus] = useState<MeshConnectionStatus>('DISCONNECTED');
    const [telemetry, setTelemetry] = useState<HeartbeatTelemetry | null>(null);

    useEffect(() => {
        const mesh = MeshClientService.getInstance();
        const unsub = mesh.subscribe((status, tel) => {
            setMeshStatus(status);
            if (tel) setTelemetry(tel);
        });
        return unsub;
    }, []);

    return (
        <View style={styles.container}>
            <TouchableOpacity
                style={[styles.tab, selectedTarget === 'desktop' && styles.tabActive]}
                onPress={() => onTargetChange('desktop')}
                disabled={meshStatus === 'OFFLINE' || meshStatus === 'DISCONNECTED'}
            >
                <View style={styles.row}>
                    <Text style={[styles.tabText, selectedTarget === 'desktop' && styles.tabTextActive]}>
                        💻 Desktop: RTX 3060
                    </Text>
                    <View
                        style={[
                            styles.statusDot,
                            meshStatus === 'ONLINE'
                                ? styles.dotOnline
                                : meshStatus === 'DEGRADED'
                                    ? styles.dotDegraded
                                    : styles.dotOffline,
                        ]}
                    />
                </View>
                {telemetry && meshStatus === 'ONLINE' && (
                    <Text style={styles.subText}>{telemetry.latencyMs}ms • {telemetry.activeModel || 'Idle'}</Text>
                )}
            </TouchableOpacity>

            <TouchableOpacity
                style={[styles.tab, selectedTarget === 'local' && styles.tabActive]}
                onPress={() => onTargetChange('local')}
            >
                <Text style={[styles.tabText, selectedTarget === 'local' && styles.tabTextActive]}>
                    📱 Local: Snapdragon 8 Elite
                </Text>
                <Text style={styles.subText}>Llama 3.2 1B (On-Device)</Text>
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        backgroundColor: '#0F172A',
        borderRadius: 8,
        padding: 3,
        marginHorizontal: 12,
        marginVertical: 6,
    },
    tab: {
        flex: 1,
        paddingVertical: 6,
        paddingHorizontal: 8,
        borderRadius: 6,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabActive: {
        backgroundColor: '#1E293B',
        borderWidth: 1,
        borderColor: '#38BDF8',
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    tabText: { color: '#64748B', fontSize: 11, fontWeight: '600' },
    tabTextActive: { color: '#F8FAFC', fontWeight: '700' },
    subText: { color: '#94A3B8', fontSize: 9, marginTop: 1 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    dotOnline: { backgroundColor: '#10B981' },
    dotDegraded: { backgroundColor: '#F59E0B' },
    dotOffline: { backgroundColor: '#EF4444' },
});
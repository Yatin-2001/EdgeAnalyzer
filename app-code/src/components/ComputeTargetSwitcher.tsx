import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import {
    MeshClientService,
    MeshNodeEndpoint,
    UnifiedComputeTarget,
} from '../services/MeshClientService';
import { UniversalNodePickerModal } from './UniversalNodePickerModal';
import { TelemetryInspectorScreen } from '../screens/TelemetryInspectorScreen';

export const ComputeTargetSwitcher: React.FC = () => {
    const mesh = MeshClientService.getInstance();
    const [selectedTarget, setSelectedTarget] = useState<UnifiedComputeTarget>(
        mesh.getSelectedTarget()
    );
    const [nodes, setNodes] = useState<MeshNodeEndpoint[]>([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isTelemetryOpen, setIsTelemetryOpen] = useState(false);

    useEffect(() => {
        mesh.scanAndSyncPeers();

        const unsub = mesh.subscribe(() => {
            setSelectedTarget(mesh.getSelectedTarget());
            setNodes(mesh.getActiveNodes());
        });

        const interval = setInterval(() => mesh.scanAndSyncPeers(), 10000);

        return () => {
            unsub();
            clearInterval(interval);
        };
    }, []);

    return (
        <View style={styles.container}>
            <View style={styles.row}>
                <TouchableOpacity
                    style={styles.triggerButton}
                    onPress={() => setIsModalOpen(true)}
                    activeOpacity={0.8}
                >
                    <View style={styles.labelRow}>
                        <Text style={styles.prefixText}>COMPUTE TARGET:</Text>
                        <Text style={styles.targetName} numberOfLines={1}>
                            {selectedTarget.displayName}
                        </Text>
                    </View>
                    <Text style={styles.arrowIcon}>▾</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.telemetryButton}
                    onPress={() => setIsTelemetryOpen(true)}
                    activeOpacity={0.8}
                >
                    <Text style={styles.telemetryIcon}>📊</Text>
                </TouchableOpacity>
            </View>

            <UniversalNodePickerModal
                visible={isModalOpen}
                nodes={nodes}
                selectedTarget={selectedTarget}
                onSelectTarget={(target) => mesh.setSelectedTarget(target)}
                onClose={() => setIsModalOpen(false)}
            />

            <Modal
                visible={isTelemetryOpen}
                animationType="slide"
                presentationStyle="fullScreen"
                onRequestClose={() => setIsTelemetryOpen(false)}
            >
                <TelemetryInspectorScreen onBack={() => setIsTelemetryOpen(false)} />
            </Modal>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        marginHorizontal: 12,
        marginVertical: 4,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    triggerButton: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#1E293B',
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#334155',
    },
    telemetryButton: {
        backgroundColor: '#1E293B',
        paddingHorizontal: 11,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#334155',
        alignItems: 'center',
        justifyContent: 'center',
    },
    telemetryIcon: {
        fontSize: 13,
    },
    labelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        flex: 1,
    },
    prefixText: {
        color: '#64748B',
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 0.6,
    },
    targetName: {
        color: '#38BDF8',
        fontSize: 12,
        fontWeight: '700',
        flexShrink: 1,
    },
    arrowIcon: {
        color: '#94A3B8',
        fontSize: 14,
        fontWeight: '700',
        marginLeft: 6,
    },
});
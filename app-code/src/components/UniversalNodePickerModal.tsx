import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    Modal,
    TouchableOpacity,
    ScrollView,
} from 'react-native';
import {
    MeshNodeEndpoint,
    UnifiedComputeTarget,
} from '../services/MeshClientService';
import { MeshIdentityService } from '../services/MeshIdentityService';

interface Props {
    visible: boolean;
    nodes: MeshNodeEndpoint[];
    selectedTarget: UnifiedComputeTarget;
    onSelectTarget: (target: UnifiedComputeTarget) => void;
    onClose: () => void;
}

export const UniversalNodePickerModal: React.FC<Props> = ({
                                                              visible,
                                                              nodes,
                                                              selectedTarget,
                                                              onSelectTarget,
                                                              onClose,
                                                          }) => {
    const [localNodeName, setLocalNodeName] = useState('This Device');
    const [localTier, setLocalTier] = useState<string>('thick_mobile');

    useEffect(() => {
        (async () => {
            const identity = await MeshIdentityService.getInstance().getOrCreateIdentity();
            setLocalNodeName(identity.node_name);
            setLocalTier(identity.node_tier);
        })();
    }, [visible]);

    // Only compute provider nodes (Desktops and Mobile Workers) can be selected as inference targets
    const computeProviderNodes = nodes.filter(
        (n) => n.deviceTier === 'thick_desktop' || n.deviceTier === 'thick_mobile'
    );

    return (
        <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
            <View style={styles.overlay}>
                <View style={styles.modalCard}>
                    <View style={styles.header}>
                        <Text style={styles.title}>Compute Nodes & Models</Text>
                        <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                            <Text style={styles.closeText}>✕</Text>
                        </TouchableOpacity>
                    </View>

                    <ScrollView style={styles.scrollArea}>
                        {/* 1. This Device Target */}
                        <Text style={styles.categoryTitle}>THIS DEVICE</Text>
                        <TouchableOpacity
                            style={[
                                styles.itemCard,
                                selectedTarget.nodeId === 'local_engine' && styles.itemCardActive,
                                localTier === 'thin' && styles.disabledCard,
                            ]}
                            disabled={localTier === 'thin'}
                            onPress={() => {
                                onSelectTarget({
                                    nodeId: 'local_engine',
                                    modelName: 'Local GGUF',
                                    displayName: `📱 Local: ${localNodeName}`,
                                    deviceTier: localTier as any,
                                });
                                onClose();
                            }}
                        >
                            <View style={{ flex: 1 }}>
                                <Text style={styles.itemName}>
                                    📱 {localNodeName} {localTier === 'thin' ? '(Thin Client)' : '(Direct JNI)'}
                                </Text>
                                <Text style={styles.itemMeta}>
                                    {localTier === 'thin'
                                        ? 'No local model loaded • Select a mesh node below'
                                        : 'Hardware Accelerated • Offline Inference'}
                                </Text>
                            </View>
                            {selectedTarget.nodeId === 'local_engine' && localTier !== 'thin' && (
                                <Text style={styles.checkmark}>✓</Text>
                            )}
                        </TouchableOpacity>

                        {/* 2. Discovered Mesh Compute Nodes */}
                        <Text style={[styles.categoryTitle, { marginTop: 14 }]}>
                            MESH COMPUTE PROVIDERS (LOCAL SUBNET)
                        </Text>

                        {computeProviderNodes.length === 0 ? (
                            <View style={styles.emptyWrap}>
                                <Text style={styles.emptyText}>No other compute nodes active.</Text>
                                <Text style={styles.emptySub}>
                                    Start your Desktop Daemon or enable Mobile Worker on your phone.
                                </Text>
                            </View>
                        ) : (
                            computeProviderNodes.map((node) => {
                                const icon = node.deviceTier === 'thick_desktop' ? '💻' : '📱';
                                return (
                                    <View key={node.nodeId} style={styles.nodeBlock}>
                                        <View style={styles.nodeHeader}>
                                            <Text style={styles.nodeName}>
                                                {icon} {node.nodeName}
                                            </Text>
                                            <View style={styles.nodeStatus}>
                                                <View
                                                    style={[
                                                        styles.statusDot,
                                                        node.isOnline ? styles.dotOnline : styles.dotOffline,
                                                    ]}
                                                />
                                                <Text style={styles.latencyText}>
                                                    {node.isOnline ? `${node.latencyMs}ms` : 'Offline'}
                                                </Text>
                                            </View>
                                        </View>

                                        {node.isOnline && node.models.length > 0 ? (
                                            node.models.map((m) => {
                                                const isSelected =
                                                    selectedTarget.nodeId === node.nodeId &&
                                                    selectedTarget.modelName === m.name;

                                                return (
                                                    <TouchableOpacity
                                                        key={m.name}
                                                        style={[styles.modelItem, isSelected && styles.modelItemActive]}
                                                        onPress={() => {
                                                            onSelectTarget({
                                                                nodeId: node.nodeId,
                                                                modelName: m.name,
                                                                displayName: `${icon} ${node.nodeName} (${m.name})`,
                                                                deviceTier: node.deviceTier,
                                                            });
                                                            onClose();
                                                        }}
                                                    >
                                                        <View style={{ flex: 1 }}>
                                                            <Text
                                                                style={[
                                                                    styles.modelTitle,
                                                                    isSelected && styles.modelTitleActive,
                                                                ]}
                                                            >
                                                                {m.name}
                                                            </Text>
                                                            <Text style={styles.modelParam}>Params: {m.parameterSize}</Text>
                                                        </View>
                                                        {isSelected && <Text style={styles.checkmark}>✓</Text>}
                                                    </TouchableOpacity>
                                                );
                                            })
                                        ) : (
                                            <Text style={styles.noModelsText}>
                                                {node.isOnline ? 'No models loaded on this node.' : 'Node is currently unreachable on LAN.'}
                                            </Text>
                                        )}
                                    </View>
                                );
                            })
                        )}
                    </ScrollView>
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
        padding: 16,
        maxHeight: '80%',
        borderWidth: 1,
        borderColor: '#334155',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingBottom: 10,
        borderBottomWidth: 1,
        borderBottomColor: '#334155',
    },
    title: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
    closeBtn: { padding: 4 },
    closeText: { color: '#94A3B8', fontSize: 16, fontWeight: '700' },
    scrollArea: { marginTop: 10 },
    categoryTitle: { color: '#64748B', fontSize: 10, fontWeight: '700', marginBottom: 6 },
    itemCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#0F172A',
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#334155',
    },
    itemCardActive: { borderColor: '#38BDF8', backgroundColor: '#0284C715' },
    disabledCard: { opacity: 0.6 },
    itemName: { color: '#F8FAFC', fontSize: 13, fontWeight: '700' },
    itemMeta: { color: '#64748B', fontSize: 11, marginTop: 2 },
    nodeBlock: {
        backgroundColor: '#0F172A',
        borderRadius: 8,
        padding: 10,
        marginBottom: 10,
        borderWidth: 1,
        borderColor: '#334155',
    },
    nodeHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 8,
    },
    nodeName: { color: '#38BDF8', fontSize: 13, fontWeight: '700' },
    nodeStatus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    dotOnline: { backgroundColor: '#10B981' },
    dotOffline: { backgroundColor: '#EF4444' },
    latencyText: { color: '#94A3B8', fontSize: 11 },
    modelItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderTopWidth: 1,
        borderTopColor: '#1E293B',
    },
    modelItemActive: { backgroundColor: '#0284C720', borderRadius: 6 },
    modelTitle: { color: '#F8FAFC', fontSize: 12, fontWeight: '600' },
    modelTitleActive: { color: '#38BDF8', fontWeight: '700' },
    modelParam: { color: '#64748B', fontSize: 10 },
    checkmark: { color: '#38BDF8', fontSize: 16, fontWeight: '700' },
    emptyWrap: { padding: 16, alignItems: 'center' },
    emptyText: { color: '#F8FAFC', fontSize: 12, fontWeight: '600' },
    emptySub: { color: '#64748B', fontSize: 11, textAlign: 'center', marginTop: 2 },
    noModelsText: { color: '#64748B', fontSize: 11, paddingVertical: 4 },
});
import React, { useState } from 'react';
import { View, Text, Switch, StyleSheet, Alert } from 'react-native';
import { MobileWorkerService } from '../services/MobileWorkerService';

export const MobileWorkerToggle: React.FC = () => {
    const worker = MobileWorkerService.getInstance();
    const [isEnabled, setIsEnabled] = useState<boolean>(worker.getWorkerStatus());

    const handleToggle = async (value: boolean) => {
        try {
            if (value) {
                await worker.startWorker();
            } else {
                await worker.stopWorker();
            }
            setIsEnabled(value);
        } catch (err: any) {
            Alert.alert('Worker Toggle Error', err.message);
            setIsEnabled(false);
        }
    };

    return (
        <View style={styles.card}>
            <View style={styles.textContainer}>
                <Text style={styles.title}>Mobile Compute Worker</Text>
                <Text style={styles.subtitle}>
                    Allow thin-client tablets to run inference via this phone's Snapdragon GPU
                </Text>
            </View>
            <Switch
                value={isEnabled}
                onValueChange={handleToggle}
                trackColor={{ false: '#334155', true: '#38BDF8' }}
                thumbColor={isEnabled ? '#FFFFFF' : '#94A3B8'}
            />
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: '#1E293B',
        padding: 14,
        borderRadius: 10,
        marginHorizontal: 12,
        marginVertical: 6,
        borderWidth: 1,
        borderColor: '#334155',
    },
    textContainer: { flex: 1, paddingRight: 10 },
    title: { color: '#F8FAFC', fontSize: 13, fontWeight: '700' },
    subtitle: { color: '#94A3B8', fontSize: 11, marginTop: 2, lineHeight: 16 },
});
import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { File } from 'expo-file-system';
import {
  NotebookAssetRecord,
  updateAssetNote,
  deleteNotebookAsset,
} from '../../database/repository';
import { MindspaceIngestionService } from '../../services/MindspaceIngestionService';
import { LLMService } from '../../services/LLMService';

interface Props {
  visible: boolean;
  asset: NotebookAssetRecord | null;
  onClose: () => void;
  onAssetUpdated?: () => void;
  onAssetDeleted?: () => void;
}

export const AssetViewerModal: React.FC<Props> = ({
                                                    visible,
                                                    asset,
                                                    onClose,
                                                    onAssetUpdated,
                                                    onAssetDeleted,
                                                  }) => {
  // 1. All hooks declared at top level unconditionally
  const llm = LLMService.getInstance();
  const ingestionService = MindspaceIngestionService.getInstance();

  const [activeTab, setActiveTab] = useState<'card' | 'ocr' | 'note'>('card');
  const [structuredCard, setStructuredCard] = useState('');
  const [userNote, setUserNote] = useState('');
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isReanalyzing, setIsReanalyzing] = useState(false);

  // Synchronize state when an asset is opened or updated
  useEffect(() => {
    if (asset) {
      setStructuredCard(asset.structured_card || '');
      setUserNote(asset.user_note || '');
    } else {
      setStructuredCard('');
      setUserNote('');
    }
  }, [asset]);

  // 2. Safe early return AFTER all hook declarations
  if (!visible || !asset) return null;

  const handleSaveNote = async () => {
    setIsSavingNote(true);
    try {
      await updateAssetNote(asset.id, userNote.trim());
      onAssetUpdated?.();
      Alert.alert('Saved', 'Asset notes updated.');
    } catch {
      Alert.alert('Error', 'Failed to save note.');
    } finally {
      setIsSavingNote(false);
    }
  };

  const handleReanalyze = async () => {
    if (!llm.isReady()) {
      Alert.alert('No Model Loaded', 'Please load a model first.');
      return;
    }
    setIsReanalyzing(true);
    try {
      const updatedCard = await ingestionService.reanalyzeAsset(asset);
      setStructuredCard(updatedCard);
      onAssetUpdated?.();
      Alert.alert('Analysis Complete', 'Knowledge card updated with the active model.');
    } catch (err) {
      Alert.alert('Re-analysis Failed', String(err));
    } finally {
      setIsReanalyzing(false);
    }
  };

  const handleDelete = () => {
    Alert.alert(
        'Delete Asset',
        `Permanently delete "${asset.title}" and free storage?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                if (asset.file_uri && asset.file_uri.startsWith('file://')) {
                  const f = new File(asset.file_uri);
                  if (f.exists) f.delete();
                }
                await deleteNotebookAsset(asset.id);
                onAssetDeleted?.();
                onClose();
              } catch (err) {
                Alert.alert('Delete Failed', String(err));
              }
            },
          },
        ]
    );
  };

  return (
      <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
        <View style={styles.overlay}>
          <View style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
              <View style={styles.titleWrap}>
                <Text style={styles.title} numberOfLines={1}>
                  {asset.title}
                </Text>
                <Text style={styles.subtitle}>{asset.type.toUpperCase()}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>Done</Text>
              </TouchableOpacity>
            </View>

            {/* Asset Preview */}
            {asset.file_uri && (asset.type === 'screenshot' || asset.type === 'image') && (
                <View style={styles.imageContainer}>
                  <Image source={{ uri: asset.file_uri }} style={styles.previewImage} />
                </View>
            )}

            {/* Segmented Control */}
            <View style={styles.segmentBar}>
              <TouchableOpacity
                  style={[styles.segmentBtn, activeTab === 'card' && styles.segmentBtnActive]}
                  onPress={() => setActiveTab('card')}
              >
                <Text
                    style={[styles.segmentText, activeTab === 'card' && styles.segmentTextActive]}
                >
                  🧠 Knowledge Card
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                  style={[styles.segmentBtn, activeTab === 'ocr' && styles.segmentBtnActive]}
                  onPress={() => setActiveTab('ocr')}
              >
                <Text
                    style={[styles.segmentText, activeTab === 'ocr' && styles.segmentTextActive]}
                >
                  📄 OCR / Text
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                  style={[styles.segmentBtn, activeTab === 'note' && styles.segmentBtnActive]}
                  onPress={() => setActiveTab('note')}
              >
                <Text
                    style={[styles.segmentText, activeTab === 'note' && styles.segmentTextActive]}
                >
                  ✏️ Notes
                </Text>
              </TouchableOpacity>
            </View>

            {/* Content Area */}
            <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>
              {activeTab === 'card' && (
                  <View>
                    <Text style={styles.cardText}>
                      {structuredCard || 'No structured knowledge card available.'}
                    </Text>
                    <TouchableOpacity
                        style={[styles.reanalyzeBtn, isReanalyzing && styles.disabledBtn]}
                        onPress={handleReanalyze}
                        disabled={isReanalyzing}
                    >
                      {isReanalyzing ? (
                          <ActivityIndicator color="#FFFFFF" size="small" />
                      ) : (
                          <Text style={styles.reanalyzeBtnText}>
                            ⚡ Re-Analyze with Active Model
                          </Text>
                      )}
                    </TouchableOpacity>
                  </View>
              )}

              {activeTab === 'ocr' && (
                  <Text style={styles.ocrText}>
                    {asset.extracted_text || 'No text extracted from this asset via OCR.'}
                  </Text>
              )}

              {activeTab === 'note' && (
                  <View style={styles.noteContainer}>
                    <TextInput
                        style={styles.noteInput}
                        placeholder="Attach research notes, prices, or observations to this asset..."
                        placeholderTextColor="#64748B"
                        value={userNote}
                        onChangeText={setUserNote}
                        multiline
                    />
                    <TouchableOpacity
                        style={[styles.saveBtn, isSavingNote && styles.disabledBtn]}
                        onPress={handleSaveNote}
                        disabled={isSavingNote}
                    >
                      <Text style={styles.saveBtnText}>
                        {isSavingNote ? 'Saving...' : 'Save Notes'}
                      </Text>
                    </TouchableOpacity>
                  </View>
              )}
            </ScrollView>

            {/* Footer Delete Button */}
            <View style={styles.footer}>
              <TouchableOpacity style={styles.deleteAssetBtn} onPress={handleDelete}>
                <Text style={styles.deleteAssetText}>🗑️ Delete Asset</Text>
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
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: '#0F172A',
    height: '88%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  titleWrap: { flex: 1, marginRight: 12 },
  title: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
  subtitle: { color: '#38BDF8', fontSize: 11, fontWeight: '600', marginTop: 2 },
  closeBtn: { padding: 4 },
  closeBtnText: { color: '#38BDF8', fontSize: 16, fontWeight: '600' },
  imageContainer: {
    height: 150,
    backgroundColor: '#1E293B',
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 12,
  },
  previewImage: { width: '100%', height: '100%', resizeMode: 'contain' },
  segmentBar: {
    flexDirection: 'row',
    backgroundColor: '#1E293B',
    borderRadius: 8,
    padding: 3,
    marginBottom: 12,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentBtnActive: { backgroundColor: '#2563EB' },
  segmentText: { color: '#94A3B8', fontSize: 12, fontWeight: '600' },
  segmentTextActive: { color: '#FFFFFF' },
  scrollArea: {
    flex: 1,
    backgroundColor: '#1E293B40',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#1E293B',
  },
  scrollContent: { padding: 14 },
  cardText: { color: '#F8FAFC', fontSize: 13, lineHeight: 22 },
  reanalyzeBtn: {
    marginTop: 14,
    backgroundColor: '#334155',
    paddingVertical: 8,
    borderRadius: 6,
    alignItems: 'center',
  },
  reanalyzeBtnText: { color: '#38BDF8', fontSize: 12, fontWeight: '600' },
  ocrText: { color: '#94A3B8', fontSize: 12, lineHeight: 20, fontFamily: 'monospace' },
  noteContainer: { gap: 10 },
  noteInput: {
    backgroundColor: '#1E293B',
    color: '#F8FAFC',
    borderRadius: 8,
    padding: 12,
    fontSize: 13,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  saveBtn: {
    backgroundColor: '#059669',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  saveBtnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
  footer: {
    marginTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    paddingTop: 8,
    alignItems: 'center',
  },
  deleteAssetBtn: {
    backgroundColor: '#EF444420',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  deleteAssetText: { color: '#EF4444', fontSize: 12, fontWeight: '600' },
  disabledBtn: { opacity: 0.5 },
});
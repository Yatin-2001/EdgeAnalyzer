import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  StatusBar,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  LLMService,
  LLMStatus,
  PerformanceMetrics,
} from '@/src/services/LLMService';
import { ModelManager, ModelInfo } from '@/src/services/ModelManager';
import { ContextManager } from '@/src/services/ContextManager';
import {
  getAllConversations,
  getConversationById,
  createConversation,
  deleteConversation,
  getMessagesByConversation,
  insertMessage,
  updateConversationTitle,
  getDefaultModel,
  getModelById,
  ConversationRecord,
  MessageRecord,
  ModelRecord,
} from '@/src/database/repository';
import { ModelRegistryModal } from '@/src/components/ModelRegistryModal';
import { ConversationDrawer } from '@/src/components/ConversationDrawer';

export default function ChatScreen() {
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConv, setActiveConv] = useState<ConversationRecord | null>(null);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [streamingContent, setStreamingContent] = useState('');

  const [status, setStatus] = useState<LLMStatus>('UNLOADED');
  const [loadProgress, setLoadProgress] = useState(0);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [prompt, setPrompt] = useState('');

  const [isRegistryOpen, setRegistryOpen] = useState(false);
  const [isDrawerOpen, setDrawerOpen] = useState(false);

  const insets = useSafeAreaInsets();
  const llm = useRef(LLMService.getInstance()).current;
  const modelManager = useRef(ModelManager.getInstance()).current;
  const flatListRef = useRef<FlatList>(null);

  // Initialize DB & load latest conversation
  useEffect(() => {
    (async () => {
      const allConvs = await getAllConversations();
      setConversations(allConvs);

      if (allConvs.length > 0) {
        await switchConversation(allConvs[0]);
      } else {
        await handleNewConversation();
      }
    })();

    return () => {
      llm.unloadModel().catch(() => {});
      modelManager.deleteWorkingCopy().catch(() => {});
    };
  }, []);

  const switchConversation = async (conv: ConversationRecord) => {
    setActiveConv(conv);
    const msgs = await getMessagesByConversation(conv.id);
    setMessages(msgs);
    setStreamingContent('');
    await ensureModelLoaded(conv.model_id);
  };

  const handleNewConversation = async () => {
    const defaultMod = await getDefaultModel();
    const created = await createConversation('New Chat', defaultMod?.id || null);
    setConversations((prev) => [created, ...prev]);
    await switchConversation(created);
    setDrawerOpen(false);
  };

  const handleDeleteConversation = async (id: string) => {
    await deleteConversation(id);
    const updated = await getAllConversations();
    setConversations(updated);
    if (activeConv?.id === id) {
      if (updated.length > 0) {
        await switchConversation(updated[0]);
      } else {
        await handleNewConversation();
      }
    }
  };

  /**
   * Gated model loading logic.
   */
  const ensureModelLoaded = async (targetModelId: string | null) => {
    try {
      let selectedRecord: ModelRecord | null = null;
      if (targetModelId) {
        selectedRecord = await getModelById(targetModelId);
      }
      if (!selectedRecord) {
        selectedRecord = await getDefaultModel();
      }

      if (!selectedRecord) {
        setStatus('UNLOADED');
        return;
      }

      const activeModelInfo = modelManager.getCurrentModel();
      if (
          activeModelInfo?.originalUri === selectedRecord.original_uri &&
          llm.isReady()
      ) {
        setStatus('READY');
        return;
      }

      setStatus('LOADING');
      setLoadProgress(0);

      const prepared = await modelManager.prepareModelFromRecord(selectedRecord);
      if (!prepared.workingUri) throw new Error('Working model copy missing.');

      await llm.loadModel(
          prepared.workingUri,
          prepared.originalName,
          (progress) => setLoadProgress(Math.round(progress * 100))
      );

      setStatus(llm.getStatus());
    } catch (error) {
      setStatus('ERROR');
      Alert.alert(
          'Model Load Failed',
          error instanceof Error ? error.message : String(error)
      );
    }
  };

  const handleSendMessage = async () => {
    if (!prompt.trim() || !activeConv || !llm.isReady()) return;

    const userText = prompt.trim();
    setPrompt('');

    const userMsg = await insertMessage(activeConv.id, 'user', userText);
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    // Build context window
    const formattedPrompt = ContextManager.buildSlidingContextPrompt(
        updatedMessages,
        activeConv.system_prompt || undefined,
        'llama3'
    );

    setStatus('GENERATING');
    setStreamingContent('');

    try {
      const { fullText, metrics: genMetrics } = await llm.streamCompletion(
          formattedPrompt,
          {
            onToken: (token) => {
              setStreamingContent((prev) => prev + token);
            },
            onMetrics: (m) => setMetrics(m),
          }
      );

      const assistantMsg = await insertMessage(
          activeConv.id,
          'assistant',
          fullText,
          genMetrics.totalTokens
      );

      setMessages((prev) => [...prev, assistantMsg]);
      setStreamingContent('');
      setStatus(llm.getStatus());

      // Auto-title generation after the first turn
      if (messages.length === 0) {
        const title = await llm.generateTitle(userText);
        await updateConversationTitle(activeConv.id, title);
        setActiveConv((prev) => (prev ? { ...prev, title } : null));
        setConversations(await getAllConversations());
      }
    } catch (error) {
      setStatus(llm.getStatus());
      Alert.alert('Inference Error', String(error));
    }
  };

  return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

        {/* Top Navigation Bar */}
        <View style={styles.topBar}>
          <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => setDrawerOpen(true)}
          >
            <Text style={styles.iconText}>☰</Text>
          </TouchableOpacity>

          <View style={styles.headerTitleWrap}>
            <Text style={styles.chatTitleText} numberOfLines={1}>
              {activeConv?.title || 'Chat'}
            </Text>
            <TouchableOpacity onPress={() => setRegistryOpen(true)}>
              <Text style={styles.modelSubtext}>
                {llm.getLoadedModel()?.name || 'No Model Loaded ▾'}
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
              style={styles.iconBtn}
              onPress={() => setRegistryOpen(true)}
          >
            <Text style={styles.iconText}>⚙</Text>
          </TouchableOpacity>
        </View>

        {/* Inline Gated Loading Progress Bar */}
        {status === 'LOADING' && (
            <View style={styles.loadingBanner}>
              <ActivityIndicator size="small" color="#38BDF8" />
              <Text style={styles.loadingText}>
                Loading Engine & Weights: {loadProgress}%
              </Text>
            </View>
        )}

        {/* Telemetry Bar */}
        {metrics && status !== 'LOADING' && (
            <View style={styles.telemetryBar}>
              <Text style={styles.telemetryText}>
                Speed: {metrics.tokensPerSecond} t/s | TTFT: {metrics.ttftMs}ms | Tokens: {metrics.totalTokens}
              </Text>
            </View>
        )}

        {/* Chat Messages and Input Container */}
        <KeyboardAvoidingView
            style={styles.flexFill}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
        >
          <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={(item) => item.id}
              style={styles.messageList}
              contentContainerStyle={[
                styles.messageListContent,
                { paddingBottom: 16 },
              ]}
              onContentSizeChange={() =>
                  flatListRef.current?.scrollToEnd({ animated: true })
              }
              renderItem={({ item }) => (
                  <View
                      style={[
                        styles.bubble,
                        item.role === 'user' ? styles.userBubble : styles.assistantBubble,
                      ]}
                  >
                    <Text style={styles.bubbleText}>{item.content}</Text>
                  </View>
              )}
              ListFooterComponent={
                streamingContent ? (
                    <View style={[styles.bubble, styles.assistantBubble]}>
                      <Text style={styles.bubbleText}>{streamingContent}</Text>
                    </View>
                ) : null
              }
          />

          {/* Dynamic Prompt Box */}
          <View
              style={[
                styles.inputContainer,
                { paddingBottom: Math.max(insets.bottom, 10) },
              ]}
          >
            <TextInput
                style={styles.textInput}
                placeholder={
                  status === 'READY'
                      ? 'Type message...'
                      : status === 'LOADING'
                          ? `Loading Model (${loadProgress}%)...`
                          : 'Select/Load a model to chat...'
                }
                placeholderTextColor="#64748B"
                value={prompt}
                onChangeText={setPrompt}
                editable={status === 'READY'}
                multiline
            />

            {status === 'GENERATING' ? (
                <TouchableOpacity
                    style={styles.stopBtn}
                    onPress={() => llm.stopCompletion()}
                >
                  <Text style={styles.btnText}>Stop</Text>
                </TouchableOpacity>
            ) : (
                <TouchableOpacity
                    style={[
                      styles.sendBtn,
                      (!prompt.trim() || status !== 'READY') && styles.disabledBtn,
                    ]}
                    onPress={handleSendMessage}
                    disabled={!prompt.trim() || status !== 'READY'}
                >
                  <Text style={styles.btnText}>Send</Text>
                </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>

        {/* Drawers & Modals */}
        <ConversationDrawer
            visible={isDrawerOpen}
            conversations={conversations}
            activeId={activeConv?.id || null}
            onSelect={switchConversation}
            onNew={handleNewConversation}
            onDelete={handleDeleteConversation}
            onClose={() => setDrawerOpen(false)}
        />

        <ModelRegistryModal
            visible={isRegistryOpen}
            onClose={() => setRegistryOpen(false)}
            onSelectModel={(mod) => {
              if (activeConv) {
                ensureModelLoaded(mod.id);
              }
            }}
        />
      </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0F172A' },
  flexFill: { flex: 1 },
  topBar: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  headerTitleWrap: { flex: 1, alignItems: 'center' },
  chatTitleText: { color: '#F8FAFC', fontSize: 16, fontWeight: '700' },
  modelSubtext: { color: '#38BDF8', fontSize: 12, marginTop: 2 },
  iconBtn: { padding: 8 },
  iconText: { color: '#94A3B8', fontSize: 20 },
  loadingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1E293B',
    paddingVertical: 8,
    gap: 8,
  },
  loadingText: { color: '#38BDF8', fontSize: 12, fontWeight: '600' },
  telemetryBar: {
    backgroundColor: '#0284C720',
    paddingVertical: 4,
    alignItems: 'center',
  },
  telemetryText: { color: '#38BDF8', fontSize: 11, fontFamily: 'monospace' },
  messageList: { flex: 1, paddingHorizontal: 16 },
  messageListContent: { paddingTop: 16 },
  bubble: {
    maxWidth: '85%',
    padding: 12,
    borderRadius: 12,
    marginBottom: 10,
  },
  userBubble: {
    backgroundColor: '#2563EB',
    alignSelf: 'flex-end',
    borderBottomRightRadius: 2,
  },
  assistantBubble: {
    backgroundColor: '#1E293B',
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 2,
  },
  bubbleText: { color: '#F8FAFC', fontSize: 14, lineHeight: 20 },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: '#0F172A',
    borderTopWidth: 1,
    borderTopColor: '#1E293B',
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1E293B',
    color: '#F8FAFC',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 14,
    maxHeight: 100,
  },
  sendBtn: {
    backgroundColor: '#2563EB',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  stopBtn: {
    backgroundColor: '#DC2626',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  disabledBtn: { opacity: 0.4 },
  btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
});
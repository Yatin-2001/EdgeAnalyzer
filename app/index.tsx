import React, { useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  StatusBar,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  getAllConversations,
  createConversation,
  updateConversationTitle,
  deleteConversation,
  getMessagesByConversation,
  insertMessage,
  getDefaultChatModel,
  getModelById,
  ConversationRecord,
  MessageRecord,
  ModelRecord,
} from '../src/database/repository';

import { LLMService, LLMStatus, PerformanceMetrics } from '../src/services/LLMService';
import { ModelManager } from '../src/services/ModelManager';
import { EmbeddingService } from '../src/services/EmbeddingService';
import { SemanticMemoryService } from '../src/services/SemanticMemoryService';
import { ToolOrchestrator } from '../src/services/ToolOrchestrator';
import { ContextManager } from '../src/services/ContextManager';
import { SecureStorageService, SearchProvider } from '../src/services/SecureStorageService';

import { ConversationDrawer } from '../src/components/ConversationDrawer';
import { ModelRegistryModal } from '../src/components/ModelRegistryModal';
import { SearchSettingsModal } from '../src/components/SearchSettingsModal';

import { StudioScreen } from '../src/screens/StudioScreen';
import { MindspaceHomeScreen } from '../src/screens/mindspace/MindspaceHomeScreen';
import { NotebookDetailScreen } from '../src/screens/mindspace/NotebookDetailScreen';

export default function ChatScreen() {
  const [activeTab, setActiveTab] = useState<'chat' | 'studio' | 'mindspace'>('chat');
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
  const [isSearchConfigOpen, setSearchConfigOpen] = useState(false);
  const [searchProvider, setSearchProvider] = useState<SearchProvider>('tavily_keyless');

  const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);

  const insets = useSafeAreaInsets();
  const llm = useRef(LLMService.getInstance()).current;
  const modelManager = useRef(ModelManager.getInstance()).current;
  const embeddingService = useRef(EmbeddingService.getInstance()).current;
  const memoryService = useRef(SemanticMemoryService.getInstance()).current;
  const toolOrchestrator = useRef(ToolOrchestrator.getInstance()).current;
  const flatListRef = useRef<FlatList>(null);

  useEffect(() => {
    (async () => {
      await embeddingService.initialize();
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
      modelManager.deleteWorkingCopy('chat').catch(() => {});
    };
  }, []);

  useEffect(() => {
    (async () => {
      const activeSearch = await SecureStorageService.getActiveSearchProvider();
      setSearchProvider(activeSearch);
    })();
  }, []);

  const switchConversation = async (conv: ConversationRecord) => {
    setActiveConv(conv);
    const msgs = await getMessagesByConversation(conv.id);
    setMessages(msgs);
    setStreamingContent('');
    await ensureModelLoaded(conv.model_id);
  };

  const handleNewConversation = async () => {
    const defaultMod = await getDefaultChatModel();
    const created = await createConversation('New Chat', defaultMod?.id || null);
    setConversations((prev) => [created, ...prev]);
    await switchConversation(created);
    setDrawerOpen(false);
  };

  const handleRenameConversation = async (id: string, newTitle: string) => {
    await updateConversationTitle(id, newTitle, true);
    setConversations(await getAllConversations());
    if (activeConv?.id === id) {
      setActiveConv((prev) => (prev ? { ...prev, title: newTitle, is_custom_title: 1 } : null));
    }
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

  const ensureModelLoaded = async (targetModelId: string | null) => {
    try {
      let selectedRecord: ModelRecord | null = null;
      if (targetModelId) {
        selectedRecord = await getModelById(targetModelId);
      }
      if (!selectedRecord) {
        selectedRecord = await getDefaultChatModel();
      }

      if (!selectedRecord) {
        setStatus('UNLOADED');
        return;
      }

      const activeModelInfo = modelManager.getCurrentModel('chat');
      if (
          activeModelInfo?.originalUri === selectedRecord.original_uri &&
          llm.isReady()
      ) {
        setStatus('READY');
        return;
      }

      setStatus('LOADING');
      setLoadProgress(0);

      // 1. Prepare Base Model slot
      const prepared = await modelManager.prepareModelFromRecord(
          selectedRecord,
          'chat'
      );
      if (!prepared.workingUri) throw new Error('Working copy missing.');

      // 2. Prepare Companion mmproj slot if Vision Model
      let mmprojWorkingPath: string | undefined;
      if (selectedRecord.modality === 'vision' && selectedRecord.mmproj_uri) {
        const mmprojInfo = await modelManager.selectModel(
            selectedRecord.mmproj_uri,
            selectedRecord.mmproj_filename || 'mmproj.gguf',
            'mmproj'
        );
        mmprojWorkingPath = mmprojInfo.workingUri || undefined;
      }

      // 3. Load on GPU
      await llm.loadModel(
          prepared.workingUri,
          prepared.originalName,
          (progress) => setLoadProgress(Math.round(progress * 100)),
          { nGpuLayers: 99 },
          mmprojWorkingPath
      );

      setStatus(llm.getStatus());
    } catch (error) {
      setStatus('ERROR');
      Alert.alert('Model Load Failed', error instanceof Error ? error.message : String(error));
    }
  };

  const handleSendMessage = async () => {
    if (!prompt.trim() || !activeConv || !llm.isReady()) return;

    const userText = prompt.trim();
    setPrompt('');

    const userMsg = await insertMessage(activeConv.id, 'user', userText);
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    // 1. Cross-Session Memory Recall
    const memoryContext = await memoryService.retrieveRelevantMemory(
        userText,
        activeConv.id
    );

    const baseSystem =
        (activeConv.system_prompt ||
            'You are a helpful, concise AI assistant running locally on-device.') +
        memoryContext.formattedSystemContext;

    // 2. Inject Tool Schema
    const systemWithTools = toolOrchestrator.formatSystemPromptWithTools(
        baseSystem,
        userText
    );

    const formattedPrompt = ContextManager.buildSlidingContextPrompt(
        updatedMessages,
        systemWithTools,
        'llama3'
    );

    setStatus('GENERATING');
    setStreamingContent('');

    try {
      const { fullText, metrics: genMetrics } = await toolOrchestrator.executeAgentLoop(
          formattedPrompt,
          userText,
          {
            onToken: (token) => setStreamingContent((prev) => prev + token),
            onMetrics: (m) => setMetrics(m),
            onToolCallDetected: (toolName, _, step) => {
              setStreamingContent((prev) => prev + `⚙️ [Step ${step}] Executing: ${toolName}...\n`);
            },
            onToolExecutionCompleted: (toolName, res, step) => {
              setStreamingContent(
                  (prev) => prev + `✓ [Step ${step}] ${toolName} finished (${res.executionTimeMs}ms)\n\n`
              );
            },
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

      // Auto-title update
      if (activeConv.is_custom_title === 0) {
        const turnCount = updatedMessages.filter((m) => m.role === 'user').length;
        if (turnCount === 1 || turnCount === 3) {
          const autoTitle = await llm.generateTitle(userText);
          await updateConversationTitle(activeConv.id, autoTitle, false);
          setActiveConv((prev) => (prev ? { ...prev, title: autoTitle } : null));
          setConversations(await getAllConversations());
        }
      }

      memoryService.ingestTurnAsync(
          userMsg.id,
          assistantMsg.id,
          activeConv.id,
          userText,
          fullText
      );
    } catch (error) {
      setStatus(llm.getStatus());
      Alert.alert('Inference Error', String(error));
    }
  };

  // Studio Screen Routing
  if (activeTab === 'studio') {
    return (
        <StudioScreen
            onBackToChat={() => setActiveTab('chat')}
            onSelectModel={async (model) => {
              await ensureModelLoaded(model.id);
            }}
        />
    );
  }

// MindSpace Screen Tab Routing
  if (activeTab === 'mindspace') {
    if (activeNotebookId) {
      return (
          <NotebookDetailScreen
              notebookId={activeNotebookId}
              onBack={() => setActiveNotebookId(null)}
              onSelectModel={async (model) => {
                await ensureModelLoaded(model.id);
              }}
          />
      );
    }
    return (
        <MindspaceHomeScreen
            onSelectNotebook={(id) => setActiveNotebookId(id)}
            onBackToChat={() => setActiveTab('chat')}
        />
    );
  }

  // Clean Main Chat Screen
  return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

        {/* Clean Top Bar: Drawer (☰) | Title & Model Selector | Settings (⚙) */}
        <View style={styles.topBar}>
          <TouchableOpacity style={styles.iconBtn} onPress={() => setDrawerOpen(true)}>
            <Text style={styles.iconText}>☰</Text>
          </TouchableOpacity>

          <View style={styles.headerTitleWrap}>
            <Text style={styles.chatTitleText} numberOfLines={1}>
              {activeConv?.title || 'Chat'}
            </Text>
            <TouchableOpacity onPress={() => setRegistryOpen(true)} activeOpacity={0.7}>
              <Text style={styles.modelSubtext} numberOfLines={1}>
                {llm.getLoadedModel()?.name || 'No Model Loaded ▾'}
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.iconBtn} onPress={() => setRegistryOpen(true)}>
            <Text style={styles.iconText}>⚙</Text>
          </TouchableOpacity>
        </View>

        {/* Model Loading Banner */}
        {status === 'LOADING' && (
            <View style={styles.loadingBanner}>
              <ActivityIndicator size="small" color="#38BDF8" />
              <Text style={styles.loadingText}>Loading Weights: {loadProgress}%</Text>
            </View>
        )}

        {/* Telemetry Bar */}
        {metrics && status !== 'LOADING' && (
            <View style={styles.telemetryBar}>
              <Text style={styles.telemetryText}>
                ⚡ {metrics.tokensPerSecond} t/s | TTFT: {metrics.ttftMs}ms | Generated: {metrics.totalTokens} tokens
              </Text>
            </View>
        )}

        {/* Message Feed */}
        <KeyboardAvoidingView
            style={styles.flexFill}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <FlatList
              ref={flatListRef}
              data={messages}
              keyExtractor={(item) => item.id}
              style={styles.messageList}
              contentContainerStyle={[styles.messageListContent, { paddingBottom: 16 }]}
              onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
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

          {/* Input Bar */}
          <View style={[styles.inputContainer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
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
                <TouchableOpacity style={styles.stopBtn} onPress={() => llm.stopCompletion()}>
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

        {/* Navigation Drawer */}
        <ConversationDrawer
            visible={isDrawerOpen}
            conversations={conversations}
            activeId={activeConv?.id || null}
            activeTab={activeTab}
            searchProvider={searchProvider}
            onSelectTab={(tab) => {
              setActiveNotebookId(null);
              setActiveTab(tab);
            }}
            onSelect={switchConversation}
            onNew={handleNewConversation}
            onDelete={handleDeleteConversation}
            onRename={handleRenameConversation}
            onOpenSearchSettings={() => {
              setDrawerOpen(false);
              setSearchConfigOpen(true);
            }}
            onClose={() => setDrawerOpen(false)}
        />

        {/* Model Registry Modal */}
        <ModelRegistryModal
            visible={isRegistryOpen}
            onClose={() => setRegistryOpen(false)}
            onSelectChatModel={(mod) => {
              if (activeConv) {
                ensureModelLoaded(mod.id);
              }
            }}
        />

        {/* Search Settings Modal */}
        <SearchSettingsModal
            visible={isSearchConfigOpen}
            onClose={() => setSearchConfigOpen(false)}
            onProviderChanged={(p) => setSearchProvider(p)}
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
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  iconBtn: { padding: 8 },
  iconText: { color: '#38BDF8', fontSize: 20, fontWeight: '700' },
  headerTitleWrap: { flex: 1, alignItems: 'center', marginHorizontal: 8 },
  chatTitleText: { color: '#F8FAFC', fontSize: 15, fontWeight: '700' },
  modelSubtext: { color: '#38BDF8', fontSize: 11, fontWeight: '600', marginTop: 1 },
  loadingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0284C720',
    paddingVertical: 6,
    gap: 8,
  },
  loadingText: { color: '#38BDF8', fontSize: 12, fontWeight: '600' },
  telemetryBar: {
    backgroundColor: '#0284C715',
    paddingVertical: 4,
    alignItems: 'center',
  },
  telemetryText: { color: '#38BDF8', fontSize: 11, fontFamily: 'monospace' },
  messageList: { flex: 1, paddingHorizontal: 12 },
  messageListContent: { paddingTop: 12 },
  bubble: { maxWidth: '85%', padding: 12, borderRadius: 12, marginBottom: 10 },
  userBubble: { backgroundColor: '#2563EB', alignSelf: 'flex-end', borderBottomRightRadius: 2 },
  assistantBubble: { backgroundColor: '#1E293B', alignSelf: 'flex-start', borderBottomLeftRadius: 2 },
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
    maxHeight: 90,
  },
  sendBtn: { backgroundColor: '#2563EB', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  stopBtn: { backgroundColor: '#DC2626', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 8 },
  disabledBtn: { opacity: 0.4 },
  btnText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13 },
});
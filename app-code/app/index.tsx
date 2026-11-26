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
  getAllModels
} from '@/src/database/repository';

import { LLMService, LLMStatus, PerformanceMetrics } from '@/src/services/LLMService';
import { ModelManager } from '@/src/services/ModelManager';
import { EmbeddingService } from '@/src/services/EmbeddingService';
import { SemanticMemoryService } from '@/src/services/SemanticMemoryService';
import { ToolOrchestrator } from '@/src/services/ToolOrchestrator';
import { ContextManager } from '@/src/services/ContextManager';
import { SecureStorageService, SearchProvider } from '@/src/services/SecureStorageService';

import { ConversationDrawer } from '@/src/components/ConversationDrawer';
import { ModelRegistryModal } from '@/src/components/ModelRegistryModal';
import { SearchSettingsModal } from '@/src/components/SearchSettingsModal';

import { StudioScreen } from '@/src/screens/StudioScreen';
import { MindspaceHomeScreen } from '@/src/screens/mindspace/MindspaceHomeScreen';
import { NotebookDetailScreen } from '@/src/screens/mindspace/NotebookDetailScreen';
import { TelemetryInspectorScreen } from '@/src/screens/TelemetryInspectorScreen';
import { AgentsHubScreen } from '@/src/screens/agents/AgentsHubScreen';
import { AgentRunScreen } from '@/src/screens/agents/AgentRunScreen';
import type { AgentRunDTO, RegisteredAgentDTO } from '@/src/types/agentTypes';

import { AdvisorWorkspaceScreen } from '@/src/screens/advisor/AdvisorWorkspaceScreen';
import { ContactDetailScreen } from '@/src/screens/advisor/ContactDetailScreen';
import { RelationshipHubScreen } from '@/src/screens/advisor/RelationshipHubScreen';

import { ComputeTargetSwitcher } from '@/src/components/ComputeTargetSwitcher';
import { MeshClientService, UnifiedComputeTarget } from '@/src/services/MeshClientService';
import ModelFile from '@/modules/model-file/src/ModelFileModule';

import { TelemetryService } from '@/src/services/TelemetryService';

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
  const [isSearchConfigOpen, setSearchConfigOpen] = useState(false);
  const [searchProvider, setSearchProvider] = useState<SearchProvider>('tavily_keyless');

  const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);

  const [selectedAdvisorContactId, setSelectedAdvisorContactId] = useState<string | null>(null);
  const [isAdvisorWorkspaceOpen, setIsAdvisorWorkspaceOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<
      'chat' | 'studio' | 'mindspace' | 'advisor' | 'telemetry' | 'agents'
  >('chat');

  const [selectedAgentForRun, setSelectedAgentForRun] = useState<RegisteredAgentDTO | null>(null);
  const [selectedAgentRun, setSelectedAgentRun] = useState<AgentRunDTO | null>(null);
  const [telemetryFilterTraceId, setTelemetryFilterTraceId] = useState<string | null>(null);
  const [telemetryFilterSessionId, setTelemetryFilterSessionId] = useState<string | null>(null);

  const insets = useSafeAreaInsets();
  const llm = useRef(LLMService.getInstance()).current;
  const modelManager = useRef(ModelManager.getInstance()).current;
  const embeddingService = useRef(EmbeddingService.getInstance()).current;
  const memoryService = useRef(SemanticMemoryService.getInstance()).current;
  const toolOrchestrator = useRef(ToolOrchestrator.getInstance()).current;
  const flatListRef = useRef<FlatList>(null);

  const mesh = useRef(MeshClientService.getInstance()).current;
  const [currentTarget, setCurrentTarget] = useState<UnifiedComputeTarget>(mesh.getSelectedTarget());

  useEffect(() => {
    const unsub = mesh.subscribe(() => {
      setCurrentTarget(mesh.getSelectedTarget());
    });
    return unsub;
  }, []);

  const isRemoteTarget = currentTarget.nodeId !== 'local_engine';

  useEffect(() => {
    (async () => {
      await embeddingService.initialize();
      await syncInstalledModelsToWorker();
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
      ModelFile.setWorkerActiveModel('No Model Loaded').catch(() => {});
    };
  }, []);

  useEffect(() => {
    (async () => {
      const activeSearch = await SecureStorageService.getActiveSearchProvider();
      setSearchProvider(activeSearch);
    })();
  }, []);

  // Listen for remote inference requests arriving from thin clients over port 8082
  useEffect(() => {
    const subscription = ModelFile.addListener(
        'onWorkerInferenceRequest',
        async (event: { requestId: string; prompt: string }) => {
          const { requestId, prompt: incomingPrompt } = event;
          try {
            if (!llm.isReady()) {
              await ModelFile.pushWorkerToken(requestId, '[Error: Host model is not ready]');
              await ModelFile.finishWorkerInference(requestId);
              return;
            }

            // Execute inference on Snapdragon GPU and stream tokens back to the native SSE response
            await llm.streamCompletion(
                incomingPrompt,
                {
                  onToken: (token: string) => {
                    ModelFile.pushWorkerToken(requestId, token).catch(() => {});
                  },
                }
            );
          } catch (err: any) {
            await ModelFile.pushWorkerToken(requestId, `[Inference Error: ${err.message}]`);
          } finally {
            await ModelFile.finishWorkerInference(requestId);
          }
        }
    );

    return () => {
      subscription.remove();
    };
  }, [llm]);

  // Listen for MVP 4 OpenAI-compatible edge chat requests arriving on port 8765 (/v1/edge/chat)
  useEffect(() => {
    const subscription = ModelFile.addListener(
        'onWorkerEdgeChatRequest',
        async (event: { requestId: string; payloadJson: string }) => {
          const { requestId, payloadJson } = event;
          try {
            const payload = JSON.parse(payloadJson || '{}');
            const requestedModel =
                typeof payload.model === 'string' ? payload.model.trim() : '';

            const currentLoaded = llm.getLoadedModel();
            const needsSwap =
                requestedModel.length > 0 &&
                (!currentLoaded ||
                    currentLoaded.name.toLowerCase() !== requestedModel.toLowerCase());
            const needsColdLoad = !requestedModel && !llm.isReady();

            if (needsSwap || needsColdLoad) {
              if (llm.getStatus() === 'GENERATING' || llm.getStatus() === 'LOADING') {
                await ModelFile.pushWorkerSseEvent?.(
                    requestId,
                    'error',
                    JSON.stringify({
                      message: `Mobile worker busy (${llm.getStatus()})`,
                      code: 'WORKER_BUSY',
                    })
                );
                return;
              }

              const allModels = await getAllModels();
              const targetRecord = needsSwap
                  ? allModels.find(
                  (m) =>
                      m.is_embedding === 0 &&
                      m.original_name.toLowerCase() === requestedModel.toLowerCase()
              ) || null
                  : await getDefaultChatModel();

              if (!targetRecord) {
                await ModelFile.pushWorkerSseEvent?.(
                    requestId,
                    'error',
                    JSON.stringify({
                      message: `Requested model "${requestedModel || 'default'}" not found on mobile worker`,
                      code: 'MODEL_NOT_FOUND',
                    })
                );
                return;
              }

              const previousModelName = currentLoaded?.name || 'None';
              const previousRecord = currentLoaded
                  ? allModels.find(
                  (m) => m.original_name.toLowerCase() === currentLoaded.name.toLowerCase()
              ) || null
                  : null;

              const switchMsg = `Switching mobile model to ${targetRecord.original_name} (expect 5-10s delay)...`;
              setWorkerSwitchStatus(`🔄 ${switchMsg}`);

              // Pre-stream status event: keeps connection alive without blocking Desktop pre-stream failover
              await ModelFile.pushWorkerSseEvent?.(
                  requestId,
                  'status',
                  JSON.stringify({
                    type: 'model_switching',
                    from: previousModelName,
                    to: targetRecord.original_name,
                    message: switchMsg,
                  })
              );

              try {
                const ok = await ensureModelLoaded(targetRecord.id, {
                  throwOnError: true,
                  suppressAlert: true,
                });
                if (!ok || !llm.isReady()) {
                  throw new Error(`Model "${targetRecord.original_name}" did not reach READY state`);
                }
              } catch (swapErr: any) {
                const swapErrMsg = swapErr?.message || String(swapErr);
                await ModelFile.pushWorkerSseEvent?.(
                    requestId,
                    'error',
                    JSON.stringify({
                      message: `Model hot-swap to "${targetRecord.original_name}" failed: ${swapErrMsg}`,
                      code: 'MODEL_SWITCH_FAILED',
                    })
                );
                // Best-effort background recovery back to previous model
                if (previousRecord && !llm.isReady()) {
                  ensureModelLoaded(previousRecord.id, { suppressAlert: true }).catch(() => {});
                }
                return;
              } finally {
                setWorkerSwitchStatus(null);
              }
            }

            if (!llm.isReady()) {
              await ModelFile.pushWorkerSseEvent?.(
                  requestId,
                  'error',
                  JSON.stringify({ message: 'Host model is not ready', code: 'NO_MODEL_LOADED' })
              );
              return;
            }

            const loaded = llm.getLoadedModel();
            const estimatedTokens = Math.ceil(
                (JSON.stringify(payload.messages || []).length +
                    JSON.stringify(payload.tools || []).length) /
                3.8
            );

            if (loaded && estimatedTokens > loaded.nCtx) {
              await ModelFile.pushWorkerSseEvent?.(
                  requestId,
                  'error',
                  JSON.stringify({
                    message: `Prompt (~${estimatedTokens} tok) exceeds loaded n_ctx (${loaded.nCtx})`,
                    code: 'CTX_EXCEEDED',
                  })
              );
              return;
            }

            const result = await llm.streamOpenAIChat(
                {
                  messages: Array.isArray(payload.messages) ? payload.messages : [],
                  tools: Array.isArray(payload.tools) ? payload.tools : undefined,
                  tool_choice: payload.tool_choice,
                  response_format: payload.response_format,
                  temperature: payload.temperature,
                  max_tokens: payload.max_tokens,
                },
                {
                  onDelta: (delta) => {
                    ModelFile.pushWorkerSseEvent?.(
                        requestId,
                        'delta',
                        JSON.stringify(delta)
                    ).catch(() => {});
                  },
                  onToolCalls: (toolCalls) => {
                    ModelFile.pushWorkerSseEvent?.(
                        requestId,
                        'tool_calls',
                        JSON.stringify({ tool_calls: toolCalls })
                    ).catch(() => {});
                  },
                }
            );

            await ModelFile.pushWorkerSseEvent?.(
                requestId,
                'done',
                JSON.stringify({
                  finish_reason: result.finishReason,
                  usage: result.usage,
                  metrics: {
                    ttft_ms: result.metrics.ttftMs,
                    tok_per_sec: result.metrics.tokensPerSecond,
                    thermal_state: payload._workerThermalState || 'nominal',
                  },
                })
            );
          } catch (err: any) {
            const msg = err?.message || String(err);
            const code = /out of memory|oom/i.test(msg)
                ? 'OOM'
                : /context|n_ctx/i.test(msg)
                    ? 'CTX_EXCEEDED'
                    : 'INTERNAL';
            await ModelFile.pushWorkerSseEvent?.(
                requestId,
                'error',
                JSON.stringify({ message: msg, code })
            ).catch(() => {});
          } finally {
            setWorkerSwitchStatus(null);
            await ModelFile.finishWorkerInference(requestId).catch(() => {});
          }
        }
    );

    return () => {
      subscription.remove();
    };
  }, [llm]);

  const switchConversation = async (conv: ConversationRecord) => {
    setActiveConv(conv);
    TelemetryService.getInstance().setActiveSessionId(conv.id);
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

  const ensureModelLoaded = async (
      targetModelId: string | null,
      opts: { throwOnError?: boolean; suppressAlert?: boolean } = {}
  ): Promise<boolean> => {
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
        ModelFile.setWorkerActiveModel('No Model Loaded').catch(() => {});
        return false;
      }

      const activeModelInfo = modelManager.getCurrentModel('chat');
      if (
          activeModelInfo?.originalUri === selectedRecord.original_uri &&
          llm.isReady()
      ) {
        setStatus('READY');
        ModelFile.setWorkerActiveModel(selectedRecord.original_name).catch(() => {});
        return true;
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
      ModelFile.setWorkerActiveModel(prepared.originalName).catch(() => {});
      return true;
    } catch (error) {
      setStatus('ERROR');
      ModelFile.setWorkerActiveModel('No Model Loaded').catch(() => {});
      if (!opts.suppressAlert) {
        Alert.alert('Model Load Failed', error instanceof Error ? error.message : String(error));
      }
      if (opts.throwOnError) {
        throw error;
      }
      return false;
    }
  };

  const handleSendMessage = async () => {
    if (!prompt.trim() || !activeConv) return;

    if (!isRemoteTarget && !llm.isReady()) {
      Alert.alert('Model Not Loaded', 'Please load a local model or select a remote mesh node.');
      return;
    }

    const userText = prompt.trim();
    setPrompt('');

    const userMsg = await insertMessage(activeConv.id, 'user', userText);
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);

    setStatus('GENERATING');
    setStreamingContent('');

    try {
      const telemetry = TelemetryService.getInstance();
      const traceContext = await telemetry.createTurnTraceContext(activeConv.id, currentTarget.nodeId);

      // 1. Record client.context_assembly span (FTS5 + Vector Memory)
      const ctxSpan = telemetry.startSpan({
        traceId: traceContext.trace_id,
        sessionId: activeConv.id,
        name: 'client.context_assembly',
        observationType: 'retriever',
        targetDevice: 'local_snapdragon',
        attributes: {
          'rag.query': userText.substring(0, 100),
          'rag.scope': 'conversation_memory',
        },
      });

      const memoryContext = await memoryService.retrieveRelevantMemory(userText, activeConv.id);
      const baseSystem =
          (activeConv.system_prompt || 'You are a helpful, concise AI assistant running locally on-device.') +
          memoryContext.formattedSystemContext;

      const systemWithTools = toolOrchestrator.formatSystemPromptWithTools(baseSystem, userText);
      const formattedPrompt = ContextManager.buildSlidingContextPrompt(updatedMessages, systemWithTools, 'llama3');

      await telemetry.endSpan(ctxSpan, { status: 'OK' });

      // 2. Execute the ReAct loop with TraceContext & Desktop Queue status feedback
      const result = await toolOrchestrator.executeAgentLoop(
          formattedPrompt,
          userText,
          {
            onToken: (token) => setStreamingContent((prev) => prev + token),
            onMetrics: (m) => setMetrics(m),
            onQueueStatusChange: (qStatus) => setStreamingContent((prev) => prev + `${qStatus}\n`),
            onToolCallDetected: (toolName, _, step) => {
              setStreamingContent((prev) => prev + `⚙️ [Step ${step}] Executing: ${toolName}...\n`);
            },
            onToolExecutionCompleted: (toolName, res, step) => {
              setStreamingContent((prev) => prev + `✓ [Step ${step}] ${toolName} finished (${res.executionTimeMs}ms)\n\n`);
            },
          },
          {
            sessionId: activeConv.id,
            traceContext,
            priority: 1,
          }
      );

      const fullText = result.fullText;
      const generatedTokens = result.metrics.totalTokens;

      const assistantMsg = await insertMessage(activeConv.id, 'assistant', fullText, generatedTokens);
      setMessages((prev) => [...prev, assistantMsg]);
      setStreamingContent('');
      setStatus(isRemoteTarget ? 'READY' : llm.getStatus());

      // Auto-title update
      if (activeConv.is_custom_title === 0) {
        const turnCount = updatedMessages.filter((m) => m.role === 'user').length;
        if (turnCount === 1 || turnCount === 3) {
          const autoTitle = isRemoteTarget ? 'Mesh Chat' : await llm.generateTitle(userText);
          await updateConversationTitle(activeConv.id, autoTitle, false);
          setActiveConv((prev) => (prev ? { ...prev, title: autoTitle } : null));
          setConversations(await getAllConversations());
        }
      }

      memoryService.ingestTurnAsync(userMsg.id, assistantMsg.id, activeConv.id, userText, fullText);
    } catch (error: any) {
      setStatus(isRemoteTarget ? 'READY' : llm.getStatus());
      Alert.alert('Inference Error', error?.message || String(error));
    }
  };

  const [workerSwitchStatus, setWorkerSwitchStatus] = useState<string | null>(null);

  const syncInstalledModelsToWorker = async () => {
    try {
      const allModels = await getAllModels();
      const catalog = allModels
          .filter((m) => m.is_embedding === 0)
          .map((m) => ({
            id: m.id,
            name: m.original_name,
            modality: m.modality || 'text',
            size: m.size_bytes || 0,
          }));
      await ModelFile.setWorkerInstalledModels?.(JSON.stringify(catalog));
    } catch (err) {
      console.warn('[WorkerCatalog] Failed to sync installed models:', err);
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

  // Advisor Routing
  if (activeTab === 'advisor') {
    if (isAdvisorWorkspaceOpen) {
      return (
          <AdvisorWorkspaceScreen
              initialContactId={selectedAdvisorContactId}
              onBack={() => setIsAdvisorWorkspaceOpen(false)}
          />
      );
    }

    if (selectedAdvisorContactId && selectedAdvisorContactId !== 'anonymous') {
      return (
          <ContactDetailScreen
              contactId={selectedAdvisorContactId}
              onBack={() => setSelectedAdvisorContactId(null)}
              onOpenAdvisor={(id) => {
                setSelectedAdvisorContactId(id);
                setIsAdvisorWorkspaceOpen(true);
              }}
          />
      );
    }

    return (
        <RelationshipHubScreen
            onSelectContact={(id) => setSelectedAdvisorContactId(id)}
            onOpenAnonymousAdvisor={() => {
              setSelectedAdvisorContactId('anonymous');
              setIsAdvisorWorkspaceOpen(true);
            }}
            onBackToChat={() => setActiveTab('chat')}
        />
    );
  }

  // Agents Control Plane Routing (MVP 4)
  if (activeTab === 'agents') {
    return (
        <View
            style={{
              flex: 1,
              backgroundColor: '#0F172A',
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
            }}
        >
          <StatusBar barStyle="light-content" backgroundColor="#0F172A" />
          {selectedAgentForRun || selectedAgentRun ? (
              <AgentRunScreen
                  agent={selectedAgentForRun ?? undefined}
                  initialRun={selectedAgentRun ?? undefined}
                  onBack={() => {
                    setSelectedAgentForRun(null);
                    setSelectedAgentRun(null);
                  }}
                  onInspectTrace={(traceId) => {
                    setTelemetryFilterTraceId(traceId);
                    setTelemetryFilterSessionId(selectedAgentRun?.sessionId ?? null);
                    setSelectedAgentForRun(null);
                    setSelectedAgentRun(null);
                    setActiveTab('telemetry');
                  }}
              />
          ) : (
              <AgentsHubScreen
                  onBack={() => setActiveTab('chat')}
                  onSelectAgentToLaunch={(agent) => {
                    setSelectedAgentRun(null);
                    setSelectedAgentForRun(agent);
                  }}
                  onOpenRun={(run, agent) => {
                    setSelectedAgentForRun(agent ?? null);
                    setSelectedAgentRun(run);
                  }}
              />
          )}
        </View>
    );
  }

  // Telemetry Inspector Screen Routing
  if (activeTab === 'telemetry') {
    return (
        <TelemetryInspectorScreen
            initialSessionId={telemetryFilterSessionId}
            initialTraceId={telemetryFilterTraceId}
            onBack={() => {
              setTelemetryFilterTraceId(null);
              setTelemetryFilterSessionId(null);
              setActiveTab('chat');
            }}
        />
    );
  }

  return (
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

        {/* Top Bar */}
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
                {isRemoteTarget ? currentTarget.displayName : (llm.getLoadedModel()?.name || 'No Model Loaded ▾')}
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.iconBtn} onPress={() => setRegistryOpen(true)}>
            <Text style={styles.iconText}>⚙</Text>
          </TouchableOpacity>
        </View>

        {/* Compute Target Switcher */}
        <ComputeTargetSwitcher />

        {/* Loading Banner */}
        {status === 'LOADING' && !isRemoteTarget && (
            <View style={styles.loadingBanner}>
              <ActivityIndicator size="small" color="#38BDF8" />
              <Text style={styles.loadingText}>Loading Weights: {loadProgress}%</Text>
            </View>
        )}

        {/* Remote Mesh Hot-Swap Notification Banner */}
        {workerSwitchStatus && (
            <View style={styles.switchBanner}>
              <ActivityIndicator size="small" color="#FBBF24" />
              <Text style={styles.switchBannerText} numberOfLines={2}>
                {workerSwitchStatus}
              </Text>
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
                  isRemoteTarget
                      ? `Message ${currentTarget.displayName}...`
                      : status === 'READY'
                          ? 'Type message...'
                          : 'Select/Load a model to chat...'
                }
                placeholderTextColor="#64748B"
                value={prompt}
                onChangeText={setPrompt}
                editable={status !== 'GENERATING'}
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
                      (!prompt.trim() || (!isRemoteTarget && status !== 'READY')) && styles.disabledBtn,
                    ]}
                    onPress={handleSendMessage}
                    disabled={!prompt.trim() || (!isRemoteTarget && status !== 'READY')}
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
              setSelectedAgentForRun(null);
              setSelectedAgentRun(null);
              setTelemetryFilterTraceId(null);
              setTelemetryFilterSessionId(null);
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
            onClose={() => {
              setRegistryOpen(false);
              syncInstalledModelsToWorker();
            }}
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
  switchBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F59E0B20',
    paddingVertical: 6,
    paddingHorizontal: 12,
    gap: 8,
  },
  switchBannerText: { color: '#FBBF24', fontSize: 12, fontWeight: '600', flexShrink: 1 },
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
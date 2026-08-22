import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StatusBar,
  ActivityIndicator,
  Alert,
} from 'react-native';

import { File } from 'expo-file-system';

import {
  LLMService,
  LLMStatus,
  PerformanceMetrics,
} from '@/src/services/LLMService';

import {
  ModelManager,
  ModelInfo,
} from '@/src/services/ModelManager';

import {
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

const PRESET_PROMPTS = [
  'Explain how an engine turbocharger works in 2 concise sentences.',
  'List 3 key differences between OpenCL and Vulkan compute pipelines.',
  'Generate a JSON profile containing id, name, and 3 security roles.',
];

export default function App() {
  const [status, setStatus] = useState<LLMStatus>('UNLOADED');
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);

  const insets = useSafeAreaInsets();

  const llm = useRef(
      LLMService.getInstance()
  ).current;

  const modelManager = useRef(
      ModelManager.getInstance()
  ).current;

  const scrollViewRef = useRef<ScrollView>(null);

  /*
   * Cleanup when the screen/app is unmounted.
   *
   * Important:
   * 1. Release native llama context first.
   * 2. Then remove the working model copy.
   *
   * The original user-selected model is never deleted.
   */
  useEffect(() => {
    return () => {
      const cleanup = async () => {
        try {
          await llm.unloadModel();
        } catch (error) {
          console.error(
              '[UI] Failed to unload model during cleanup:',
              error,
          );
        }

        try {
          await modelManager.deleteWorkingCopy();
        } catch (error) {
          console.error(
              '[UI] Failed to delete working model during cleanup:',
              error,
          );
        }
      };

      cleanup();
    };
  }, []);

  /**
   * Opens Android's native file picker and loads the selected GGUF.
   */
  const handlePickModel = async () => {
    if (status === 'LOADING' || status === 'GENERATING') {
      return;
    }

    try {
      /*
       * Open Android's native file picker.
       *
       * No MANAGE_EXTERNAL_STORAGE permission is required.
       */
      const pickedFile = await File.pickFileAsync(
          undefined,
          '*/*',
      );

      if (!pickedFile) {
        console.log('[UI] Model selection cancelled.');
        return;
      }

      /*
       * Expo's API can represent the result as File | File[].
       * We only support selecting one model.
       */
      if (!(pickedFile instanceof File)) {
        console.error(
            '[UI] Model selection failed: expected a single File.',
        );
        return;
      }

      console.log(
          '[UI] Selected model URI:',
          pickedFile.uri,
      );

      console.log(
          '[UI] Selected model name:',
          pickedFile.name,
      );


      /*
         '[UI] Selected model URI:', 'content://com.android.providers.downloads.documents/document/msf%3A18903'
         '[UI] Selected model name:', 'msf:18903'

         We get File Id from picker not the exact File Location or Name.
       */

      /*
       * If another model is currently loaded, unload it before
       * replacing the working copy.
       */
      if (llm.isReady()) {
        await llm.unloadModel();
        await modelManager.deleteWorkingCopy();
      }

      setStatus('LOADING');
      setLoadProgress(0);
      setOutput('');
      setMetrics(null);

      /*
       * ModelManager owns the storage lifecycle.
       *
       * Input:
       *   content://... / file://...
       *
       * Output:
       *   ModelInfo containing the app-private working URI.
       */
      console.log('[UI] Preparing selected model...');

      const preparedModel = await modelManager.selectModel(
          pickedFile.uri,
          pickedFile.name,
      );

      console.log(
          '[UI] Model prepared:',
          preparedModel,
      );

      setModel(preparedModel);

      /*
       * IMPORTANT:
       *
       * LLMService receives ONLY the working copy.
       *
       * It should never directly access the original model selected
       * by the user.
       */
      if (!preparedModel.workingUri) {
        throw new Error(
            'ModelManager did not provide a working model URI.',
        );
      }

      console.log(
          '[UI] Loading working model:',
          preparedModel.workingUri,
      );

      await llm.loadModel(
          preparedModel.workingUri,
          preparedModel.originalName,
          (progress) => {
            setLoadProgress(
                Math.round(progress * 100),
            );
          },
      );

      const finalStatus = llm.getStatus();

      setStatus(finalStatus);

      console.log(
          '[UI] Model loading completed. Status:',
          finalStatus,
      );

    } catch (error) {
      console.error(
          '[UI] Model selection/loading failed:',
          error,
      );

      /*
       * Make sure the native context is not left partially loaded.
       */
      try {
        await llm.unloadModel();
      } catch (cleanupError) {
        console.error(
            '[UI] Failed to cleanup LLM after load failure:',
            cleanupError,
        );
      }

      /*
       * Remove the working copy if model loading failed.
       * The original model remains untouched.
       */
      try {
        await modelManager.deleteWorkingCopy();
      } catch (cleanupError) {
        console.error(
            '[UI] Failed to cleanup working model:',
            cleanupError,
        );
      }

      setModel(null);
      setStatus('ERROR');
      setLoadProgress(0);

      Alert.alert(
          'Model Load Failed',
          error instanceof Error
              ? error.message
              : String(error),
      );
    }
  };

  /**
   * Unloads the current model and removes the working copy.
   *
   * The original model selected by the user is NEVER deleted.
   */
  const handleUnloadModel = async () => {
    if (status === 'GENERATING') {
      return;
    }

    try {
      setStatus('LOADING');

      /*
       * Native llama context must be released first.
       */
      await llm.unloadModel();

      /*
       * Only the temporary working copy is deleted.
       */
      await modelManager.deleteWorkingCopy();

      setModel(null);
      setStatus('UNLOADED');
      setOutput('');
      setMetrics(null);
      setLoadProgress(0);

    } catch (error) {
      console.error(
          '[UI] Failed to unload model:',
          error,
      );

      setStatus(llm.getStatus());

      Alert.alert(
          'Unload Failed',
          error instanceof Error
              ? error.message
              : String(error),
      );
    }
  };

  /**
   * Sends a prompt to the currently loaded model.
   */
  const handleSend = async () => {
    if (!prompt.trim() || !llm.isReady()) {
      return;
    }

    setOutput('');
    setMetrics(null);
    setStatus('GENERATING');

    try {
      await llm.streamCompletion(
          prompt,
          {
            onToken: (token) => {
              setOutput((prev) => prev + token);

              scrollViewRef.current?.scrollToEnd({
                animated: false,
              });
            },

            onMetrics: (m) => {
              setMetrics(m);
              setStatus(llm.getStatus());
            },
          },
      );

      /*
       * streamCompletion normally transitions back to READY.
       * Explicitly synchronize the UI state.
       */
      setStatus(llm.getStatus());

    } catch (error) {
      console.error(
          '[UI] Inference failed:',
          error,
      );

      setStatus(llm.getStatus());

      Alert.alert(
          'Inference Error',
          error instanceof Error
              ? error.message
              : String(error),
      );
    }
  };

  /**
   * Stops active generation.
   */
  const handleStop = async () => {
    try {
      await llm.stopCompletion();
      setStatus(llm.getStatus());
    } catch (error) {
      console.error(
          '[UI] Failed to stop generation:',
          error,
      );

      Alert.alert(
          'Stop Failed',
          error instanceof Error
              ? error.message
              : String(error),
      );
    }
  };

  const getStatusBadgeColor = () => {
    switch (status) {
      case 'READY':
        return '#10B981';

      case 'GENERATING':
        return '#3B82F6';

      case 'LOADING':
        return '#F59E0B';

      case 'ERROR':
        return '#EF4444';

      default:
        return '#64748B';
    }
  };

  /*
   * Human-readable model name for the UI.
   */
  const modelName = model?.originalName || 'No model selected';

  return (
      <View
          style={[
            styles.container,
            {
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
            },
          ]}
      >
        <StatusBar
            barStyle="light-content"
            backgroundColor="#0F172A"
        />

        {/* Header & Status Section */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>
              LLM Models On-Device
            </Text>

            <Text style={styles.subtitle}>
              OnePlus 15 • Adreno Hardware Acceleration
            </Text>
          </View>

          <View
              style={[
                styles.badge,
                {
                  backgroundColor:
                      getStatusBadgeColor(),
                },
              ]}
          >
            <Text style={styles.badgeText}>
              {status}
            </Text>
          </View>
        </View>

        {/* Model Controls */}
        <View style={styles.card}>
          <Text style={styles.metricLabel}>
            MODEL
          </Text>

          <Text
              style={[
                styles.outputText,
                {
                  fontSize: 12,
                  marginTop: 4,
                  marginBottom: 10,
                },
              ]}
              numberOfLines={2}
          >
            {model
                ? model.originalName
                : 'No GGUF model selected'}
          </Text>

          <View style={styles.actionRow}>
            {status === 'UNLOADED' ||
            status === 'ERROR' ? (
                <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={handlePickModel}
                >
                  <Text style={styles.buttonText}>
                    Select GGUF Model
                  </Text>
                </TouchableOpacity>
            ) : status === 'READY' ? (
                <View
                    style={{
                      flexDirection: 'row',
                      gap: 8,
                    }}
                >
                  <TouchableOpacity
                      style={styles.primaryButton}
                      onPress={handlePickModel}
                  >
                    <Text style={styles.buttonText}>
                      Change Model
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                      style={styles.dangerButton}
                      onPress={handleUnloadModel}
                  >
                    <Text style={styles.buttonText}>
                      Unload Model
                    </Text>
                  </TouchableOpacity>
                </View>
            ) : (
                <TouchableOpacity
                    style={[
                      styles.dangerButton,
                      styles.disabledButton,
                    ]}
                    disabled
                >
                  <Text style={styles.buttonText}>
                    {status === 'LOADING'
                        ? 'Loading...'
                        : 'Generating...'}
                  </Text>
                </TouchableOpacity>
            )}
          </View>

          {status === 'LOADING' && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator
                    color="#38BDF8"
                    size="small"
                />

                <Text style={styles.loadingText}>
                  Initializing Context & Offloading:{' '}
                  {loadProgress}%
                </Text>
              </View>
          )}
        </View>

        {/* Telemetry Dashboard */}
        <View style={styles.metricsContainer}>
          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>
              Throughput
            </Text>

            <Text style={styles.metricValue}>
              {metrics
                  ? `${metrics.tokensPerSecond} t/s`
                  : '--'}
            </Text>
          </View>

          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>
              TTFT
            </Text>

            <Text style={styles.metricValue}>
              {metrics
                  ? `${metrics.ttftMs} ms`
                  : '--'}
            </Text>
          </View>

          <View style={styles.metricBox}>
            <Text style={styles.metricLabel}>
              Tokens
            </Text>

            <Text style={styles.metricValue}>
              {metrics
                  ? `${metrics.totalTokens}`
                  : '--'}
            </Text>
          </View>
        </View>

        {/* Output Console */}
        <View style={styles.outputCard}>
          <ScrollView
              ref={scrollViewRef}
              style={styles.outputScroll}
              contentContainerStyle={
                styles.outputScrollContent
              }
          >
            <Text style={styles.outputText}>
              {output ||
                  (status === 'READY'
                      ? 'Ready for inference. Select a prompt below or type your own.'
                      : 'Model not loaded.')}
            </Text>
          </ScrollView>
        </View>

        {/* Preset Chips */}
        <View style={styles.presetsContainer}>
          <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
          >
            {PRESET_PROMPTS.map((p, idx) => (
                <TouchableOpacity
                    key={idx}
                    style={styles.chip}
                    onPress={() => setPrompt(p)}
                    disabled={status !== 'READY'}
                >
                  <Text
                      style={styles.chipText}
                      numberOfLines={1}
                  >
                    {p}
                  </Text>
                </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Input Bar */}
        <View style={styles.inputContainer}>
          <TextInput
              style={styles.textInput}
              placeholder="Enter prompt..."
              placeholderTextColor="#64748B"
              value={prompt}
              onChangeText={setPrompt}
              editable={status === 'READY'}
              multiline
          />

          {status === 'GENERATING' ? (
              <TouchableOpacity
                  style={styles.stopButton}
                  onPress={handleStop}
              >
                <Text style={styles.buttonText}>
                  Stop
                </Text>
              </TouchableOpacity>
          ) : (
              <TouchableOpacity
                  style={[
                    styles.sendButton,
                    (!prompt.trim() ||
                        status !== 'READY') &&
                    styles.disabledButton,
                  ]}
                  onPress={handleSend}
                  disabled={
                      !prompt.trim() ||
                      status !== 'READY'
                  }
              >
                <Text style={styles.buttonText}>
                  Send
                </Text>
              </TouchableOpacity>
          )}
        </View>
      </View>
  );
}


const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    color: '#F8FAFC',
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
    color: '#64748B',
    fontSize: 12,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 11,
  },
  card: {
    backgroundColor: '#1E293B',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  pathInput: {
    backgroundColor: '#0F172A',
    color: '#E2E8F0',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 12,
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  primaryButton: {
    backgroundColor: '#0284C7',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  dangerButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 6,
  },
  disabledButton: {
    opacity: 0.5,
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 13,
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    gap: 8,
  },
  loadingText: {
    color: '#38BDF8',
    fontSize: 12,
  },
  metricsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 8,
  },
  metricBox: {
    flex: 1,
    backgroundColor: '#1E293B',
    padding: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  metricLabel: {
    color: '#94A3B8',
    fontSize: 11,
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  metricValue: {
    color: '#38BDF8',
    fontSize: 16,
    fontWeight: '700',
  },
  outputCard: {
    flex: 1,
    backgroundColor: '#1E293B',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  outputScroll: {
    flex: 1,
  },
  outputScrollContent: {
    flexGrow: 1,
  },
  outputText: {
    color: '#E2E8F0',
    fontSize: 14,
    lineHeight: 20,
  },
  presetsContainer: {
    marginBottom: 8,
    height: 36,
  },
  chip: {
    backgroundColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    marginRight: 8,
    justifyContent: 'center',
    maxWidth: 220,
  },
  chipText: {
    color: '#CBD5E1',
    fontSize: 12,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1E293B',
    color: '#F8FAFC',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    maxHeight: 90,
  },
  sendButton: {
    backgroundColor: '#2563EB',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
  stopButton: {
    backgroundColor: '#DC2626',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
  },
});
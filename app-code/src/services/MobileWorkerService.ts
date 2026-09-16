import { NativeModules, Platform } from 'react-native';
import { LLMService } from './LLMService';

export class MobileWorkerService {
    private static instance: MobileWorkerService;
    private isRunning = false;
    private llm = LLMService.getInstance();

    private constructor() {}

    public static getInstance(): MobileWorkerService {
        if (!MobileWorkerService.instance) {
            MobileWorkerService.instance = new MobileWorkerService();
        }
        return MobileWorkerService.instance;
    }

    public async startWorker(): Promise<void> {
        if (this.isRunning) return;

        if (Platform.OS === 'android') {
            const { EdgeComputeWorkerModule } = NativeModules;
            EdgeComputeWorkerModule?.startService();
        }

        this.isRunning = true;
        console.log('[Mobile Worker] Native service started and locks acquired.');
    }

    public async stopWorker(): Promise<void> {
        if (!this.isRunning) return;

        if (Platform.OS === 'android') {
            const { EdgeComputeWorkerModule } = NativeModules;
            EdgeComputeWorkerModule?.stopService();
        }

        this.isRunning = false;
        console.log('[Mobile Worker] Native service stopped.');
    }

    public getWorkerStatus(): boolean {
        return this.isRunning;
    }

    // Invoked when an incoming MCP query is received from a thin client over the local network
    public async handleClientInference(
        prompt: string,
        onToken: (tok: string) => void
    ): Promise<string> {
        if (!this.llm.isReady()) {
            throw new Error('Local llama.rn weights not loaded on phone');
        }

        const result = await this.llm.streamCompletion(
            {
                prompt,
                nPredict: 512,
                temperature: 0.2,
            },
            { onToken }
        );

        return result.fullText;
    }
}
import {
    getNotebookById,
    getAssetsByNotebook,
    updateNotebookNotes,
} from '../database/repository';
import { LLMService } from './LLMService';
import { ToolOrchestrator } from './ToolOrchestrator';
import { MeshClientService } from './MeshClientService';

export interface SynthesisProgressCallback {
    onStatusUpdate: (statusText: string) => void;
    onPartialReport?: (chunk: string) => void;
}

export class MindspaceSynthesisService {
    private static instance: MindspaceSynthesisService;
    private llm = LLMService.getInstance();
    private orchestrator = ToolOrchestrator.getInstance();
    private mesh = MeshClientService.getInstance();

    private constructor() {}

    public static getInstance(): MindspaceSynthesisService {
        if (!MindspaceSynthesisService.instance) {
            MindspaceSynthesisService.instance = new MindspaceSynthesisService();
        }
        return MindspaceSynthesisService.instance;
    }

    /**
     * Two-Stage Synthesis Pipeline:
     * 1. Live Web Research (Tool Calling Enabled if local, or skipped on remote thin client)
     * 2. Full Markdown Report Generation (nPredict: 2048)
     */
    public async synthesizeNotebookToScratchpad(
        notebookId: string,
        callbacks: SynthesisProgressCallback
    ): Promise<string> {
        const target = this.mesh.getSelectedTarget();
        const isRemoteTarget = target.nodeId !== 'local_engine';

        if (!isRemoteTarget && !this.llm.isReady()) {
            throw new Error('Please load a local model or select a remote compute node.');
        }

        const notebook = await getNotebookById(notebookId);
        if (!notebook) throw new Error('Notebook not found.');

        const assets = await getAssetsByNotebook(notebookId);
        if (assets.length === 0) {
            throw new Error('Please add at least one screenshot or document before synthesizing.');
        }

        callbacks.onStatusUpdate('Analyzing notebook assets & knowledge cards...');

        // 1. Assemble Asset Dossier
        let assetBriefs = `### NOTEBOOK ASSETS FOR "${notebook.title}":\n\n`;
        assets.forEach((asset, idx) => {
            assetBriefs += `[Asset ${idx + 1}: "${asset.title}" (${asset.type.toUpperCase()})]\n`;
            if (asset.structured_card) {
                assetBriefs += `${asset.structured_card}\n`;
            }
            if (asset.user_note) {
                assetBriefs += `User Note: ${asset.user_note}\n`;
            }
            if (asset.extracted_text && !asset.structured_card) {
                assetBriefs += `Extracted Text: ${asset.extracted_text.substring(0, 500)}\n`;
            }
            assetBriefs += '\n';
        });

        // =========================================================================
        // STAGE 1: Live Web Research Phase
        // =========================================================================
        let gatheredResearch = '';

        if (!isRemoteTarget && this.llm.isReady()) {
            callbacks.onStatusUpdate('Running live web research for missing facts & pricing...');

            const researchQuery = `Search web for latest release dates, confirmed platforms, and pricing for: ${notebook.title}`;
            const researchSystem = this.orchestrator.formatSystemPromptWithTools(
                'You are a research bot. If needed, call web_search to find facts not in the assets.',
                researchQuery
            );

            const researchPrompt =
                `<|im_start|>system\n${researchSystem}\n\n${assetBriefs}<|im_end|>\n` +
                `<|im_start|>user\nFind any missing specs or details online for ${notebook.title}.<|im_end|>\n` +
                `<|im_start|>assistant\n`;

            try {
                const researchRes = await this.orchestrator.executeAgentLoop(
                    researchPrompt,
                    researchQuery,
                    {
                        onToken: () => {},
                        onToolCallDetected: (tool, params) => {
                            const query = params?.query || params?.expression || '';
                            callbacks.onStatusUpdate(`Searching web: "${String(query).substring(0, 35)}..."`);
                        },
                        onToolExecutionCompleted: () => {
                            callbacks.onStatusUpdate('Processing web search results...');
                        },
                    }
                );
                gatheredResearch = researchRes.fullText.trim();
            } catch {
                gatheredResearch = 'Web research skipped.';
            }
        } else {
            gatheredResearch = 'Grounding on attached notebook assets and knowledge cards.';
        }

        // =========================================================================
        // STAGE 2: Clean Markdown Report Generation
        // =========================================================================
        const finalDraftSystem =
            `You are an expert analytical report writer. Write a detailed, clean Markdown report synthesizing the assets and live research below.\n` +
            `Do NOT simulate tool calls, code execution, or internal monologues.\n` +
            `Format strictly with:\n` +
            `# Executive Summary\n` +
            `## Feature & Spec Comparison Table\n` +
            `## Key Findings & Trade-offs\n` +
            `## Recommendations & Next Steps`;

        const finalDraftPrompt =
            `<|im_start|>system\n${finalDraftSystem}\n\n${assetBriefs}\n### LIVE RESEARCH CONTEXT:\n${gatheredResearch}<|im_end|>\n` +
            `<|im_start|>user\nGenerate the complete Markdown synthesis report now.<|im_end|>\n` +
            `<|im_start|>assistant\n`;

        let finalReport = '';

        if (isRemoteTarget) {
            callbacks.onStatusUpdate(`Synthesizing comprehensive report on ${target.displayName}...`);
            await this.mesh.streamChat(
                [{ role: 'user', content: finalDraftPrompt }],
                (tok) => {
                    finalReport += tok;
                    callbacks.onPartialReport?.(tok);
                }
            );
            finalReport = finalReport.trim();
        } else {
            callbacks.onStatusUpdate('Compiling comprehensive report to Scratchpad...');
            const reportRes = await this.llm.streamCompletion(
                {
                    prompt: finalDraftPrompt,
                    nPredict: 2048,
                    temperature: 0.2,
                },
                {
                    onToken: (tok) => callbacks.onPartialReport?.(tok),
                }
            );
            finalReport = reportRes.fullText.trim();
        }

        await updateNotebookNotes(notebookId, finalReport);
        callbacks.onStatusUpdate('Report generated and saved to Scratchpad!');

        return finalReport;
    }
}
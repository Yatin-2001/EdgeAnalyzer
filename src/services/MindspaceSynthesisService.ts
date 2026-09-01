import {
    getNotebookById,
    getAssetsByNotebook,
    updateNotebookNotes,
} from '../database/repository';
import { LLMService } from './LLMService';
import { ToolOrchestrator } from './ToolOrchestrator';

export interface SynthesisProgressCallback {
    onStatusUpdate: (statusText: string) => void;
    onPartialReport?: (chunk: string) => void;
}

export class MindspaceSynthesisService {
    private static instance: MindspaceSynthesisService;
    private llm = LLMService.getInstance();
    private orchestrator = ToolOrchestrator.getInstance();

    private constructor() {}

    public static getInstance(): MindspaceSynthesisService {
        if (!MindspaceSynthesisService.instance) {
            MindspaceSynthesisService.instance = new MindspaceSynthesisService();
        }
        return MindspaceSynthesisService.instance;
    }

    /**
     * Synthesizes all notebook assets, runs web research for missing facts/prices,
     * and writes the final markdown report directly into the Notebook Scratchpad.
     */
    public async synthesizeNotebookToScratchpad(
        notebookId: string,
        callbacks: SynthesisProgressCallback
    ): Promise<string> {
        const notebook = await getNotebookById(notebookId);
        if (!notebook) throw new Error('Notebook not found.');

        const assets = await getAssetsByNotebook(notebookId);
        if (assets.length === 0) {
            throw new Error('Please add at least one screenshot or document before synthesizing.');
        }

        callbacks.onStatusUpdate('Analyzing all notebook assets & knowledge cards...');

        // 1. Assemble Full Asset Dossier
        let assetDossier = `### NOTEBOOK TOPIC: "${notebook.title}"\n\n`;
        assets.forEach((asset, idx) => {
            assetDossier += `--- ASSET [${idx + 1}]: "${asset.title}" (${asset.type.toUpperCase()}) ---\n`;
            if (asset.structured_card) {
                assetDossier += `Structured Knowledge:\n${asset.structured_card}\n`;
            }
            if (asset.user_note) {
                assetDossier += `User Notes: ${asset.user_note}\n`;
            }
            if (asset.extracted_text) {
                assetDossier += `OCR / Document Text:\n${asset.extracted_text.substring(0, 800)}\n`;
            }
            assetDossier += '\n';
        });

        callbacks.onStatusUpdate('Identifying missing specs & querying live web data...');

        // 2. Build Autonomous Research Prompt
        const baseSystem =
            `You are MindSpace Deep Research Agent.\n` +
            `Your task is to analyze all assets in this research notebook, identify comparison criteria, invoke 'web_search' for missing technical specs, pricing, or reviews, and compile a comprehensive synthesis report.\n` +
            `The final report MUST be formatted in clean Markdown with:\n` +
            `1. # Executive Summary\n` +
            `2. ## Feature & Spec Comparison Table\n` +
            `3. ## Key Findings & Trade-offs\n` +
            `4. ## Recommendations & Next Steps`;

        const userPrompt =
            `Synthesize all assets in notebook "${notebook.title}". Cross-reference all specs and prices with live web data where needed.`;

        const formattedSystem = this.orchestrator.formatSystemPromptWithTools(baseSystem, userPrompt);

        const fullPrompt =
            `<|im_start|>system\n${formattedSystem}\n\n${assetDossier}<|im_end|>\n` +
            `<|im_start|>user\n${userPrompt}<|im_end|>\n` +
            `<|im_start|>assistant\n`;

        // 3. Execute Autonomous Agentic Loop
        let generatedReport = '';
        const result = await this.orchestrator.executeAgentLoop(
            fullPrompt,
            userPrompt,
            {
                onToken: (tok) => {
                    generatedReport += tok;
                    callbacks.onPartialReport?.(tok);
                },
                onToolCallDetected: (toolName, params) => {
                    const query = params.query || params.expression || '';
                    callbacks.onStatusUpdate(`Searching web: "${query.substring(0, 35)}..."`);
                },
                onToolExecutionCompleted: () => {
                    callbacks.onStatusUpdate('Synthesizing comparison tables & findings...');
                },
            }
        );

        const finalReport = result.fullText.trim();

        // 4. Automatically persist directly to Notebook Scratchpad in SQLite
        await updateNotebookNotes(notebookId, finalReport);
        callbacks.onStatusUpdate('Report generated and saved to Scratchpad!');

        return finalReport;
    }
}
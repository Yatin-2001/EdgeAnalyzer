import { MessageRecord } from '../database/repository';

export type ChatTemplate = 'llama3' | 'chatml' | 'raw';

export interface BudgetConfig {
    maxContextTokens: number;
    maxPredictTokens: number;
    systemPromptTokensBudget: number;
}

export class ContextManager {
    private static readonly CHARS_PER_TOKEN_ESTIMATE = 3.8;

    public static estimateTokens(text: string): number {
        if (!text) return 0;
        return Math.ceil(text.length / ContextManager.CHARS_PER_TOKEN_ESTIMATE);
    }

    /**
     * Applies the sliding window algorithm and builds the formatted prompt.
     */
    public static buildSlidingContextPrompt(
        messages: MessageRecord[],
        systemPrompt: string = 'You are a helpful, concise AI assistant running locally on-device.',
        template: ChatTemplate = 'llama3',
        config: BudgetConfig = {
            maxContextTokens: 2048,
            maxPredictTokens: 512,
            systemPromptTokensBudget: 256,
        }
    ): string {
        const usableContextBudget =
            config.maxContextTokens - config.maxPredictTokens - 64; // Safety buffer
        const systemTokens = this.estimateTokens(systemPrompt);
        let remainingBudget = usableContextBudget - systemTokens;

        const includedMessages: MessageRecord[] = [];

        // Traverse turns backwards to preserve the most recent exchanges
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            if (msg.role === 'system') continue;

            const msgTokens =
                msg.tokens_count > 0
                    ? msg.tokens_count
                    : this.estimateTokens(msg.content);

            if (remainingBudget - msgTokens < 0) {
                break;
            }

            remainingBudget -= msgTokens;
            includedMessages.unshift(msg);
        }

        return this.formatTemplate(systemPrompt, includedMessages, template);
    }

    private static formatTemplate(
        systemPrompt: string,
        messages: MessageRecord[],
        template: ChatTemplate
    ): string {
        if (template === 'llama3') {
            let prompt = `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n${systemPrompt}<|eot_id|>`;
            for (const msg of messages) {
                prompt += `<|start_header_id|>${msg.role}<|end_header_id|>\n\n${msg.content}<|eot_id|>`;
            }
            prompt += `<|start_header_id|>assistant<|end_header_id|>\n\n`;
            return prompt;
        }

        if (template === 'chatml') {
            let prompt = `<|im_start|>system\n${systemPrompt}<|im_end|>\n`;
            for (const msg of messages) {
                prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
            }
            prompt += `<|im_start|>assistant\n`;
            return prompt;
        }

        // Raw fallback
        let prompt = `System: ${systemPrompt}\n\n`;
        for (const msg of messages) {
            prompt += `${msg.role.toUpperCase()}: ${msg.content}\n\n`;
        }
        prompt += `ASSISTANT: `;
        return prompt;
    }
}
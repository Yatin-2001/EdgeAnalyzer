import TextRecognition from '@react-native-ml-kit/text-recognition';
import * as ImageManipulator from 'expo-image-manipulator';
import {
    ContactRecord,
    ContactInteractionRecord,
    getAllContacts,
    getContactById,
    getInteractionsByContact,
    getContactFacts,
    insertContactInteraction,
    updateInteractionSelectedReply,
    insertContactFact,
    updateContact,
    blobToVector,
    cosineSimilarity,
} from '../database/repository';
import { LLMService } from './LLMService';
import { EmbeddingService } from './EmbeddingService';

export interface AdviceOption {
    label: string;
    text: string;
    tone_intent: string;
}

export interface AdvisoryResult {
    interactionId: string;
    detectedContactName: string | null;
    detectedPlatform: string | null;
    detectedSentiment: string;
    subtextAnalysis: string;
    strategicAdvice: string;
    replies: AdviceOption[];
    rawTranscript: string;
}

export class CommunicationAdvisorService {
    private static instance: CommunicationAdvisorService;
    private llm = LLMService.getInstance();
    private embeddingService = EmbeddingService.getInstance();

    private constructor() {}

    public static getInstance(): CommunicationAdvisorService {
        if (!CommunicationAdvisorService.instance) {
            CommunicationAdvisorService.instance = new CommunicationAdvisorService();
        }
        return CommunicationAdvisorService.instance;
    }

    /**
     * 1. Inspect Screenshot & Extract OCR Dialogue
     */
    public async parseScreenshotDialogue(imageUri: string): Promise<{
        rawTranscript: string;
        detectedName: string | null;
        detectedPlatform: string;
        downscaledUri: string;
    }> {
        let extractedText = '';

        // Ensure the URI has a valid file:// scheme for Android's ContentResolver
        const formattedUri =
            imageUri.startsWith('file://') || imageUri.startsWith('content://')
                ? imageUri
                : `file://${imageUri}`;

        try {
            const ocrRes = await TextRecognition.recognize(formattedUri);
            extractedText = ocrRes?.text ? ocrRes.text.trim() : '';
        } catch (err1) {
            // Fallback: try raw path if the native binding expects an unadorned filesystem path
            try {
                const cleanPath = formattedUri.replace('file://', '');
                const ocrRes = await TextRecognition.recognize(cleanPath);
                extractedText = ocrRes?.text ? ocrRes.text.trim() : '';
            } catch (err2) {
                console.warn('[AdvisorService] OCR error:', err2);
            }
        }

        let downscaledUri = formattedUri;
        try {
            const manip = await ImageManipulator.manipulateAsync(
                formattedUri,
                [{ resize: { width: 448 } }],
                { compress: 0.75, format: ImageManipulator.SaveFormat.JPEG }
            );
            if (manip?.uri) downscaledUri = manip.uri;
        } catch {}

        // Detect Platform & Contact Name from top OCR lines
        const lines = extractedText.split('\n').map((l) => l.trim()).filter(Boolean);
        let detectedPlatform = 'whatsapp';
        const lower = extractedText.toLowerCase();

        if (lower.includes('instagram') || lower.includes('direct') || lower.includes('message...')) {
            detectedPlatform = 'instagram';
        } else if (lower.includes('slack') || lower.includes('#')) {
            detectedPlatform = 'slack';
        } else if (lower.includes('subject:') || lower.includes('gmail') || lower.includes('inbox')) {
            detectedPlatform = 'email';
        } else if (lower.includes('imessage')) {
            detectedPlatform = 'imessage';
        }

        // Name heuristic: Inspect top 4 lines ignoring status bar timestamps/network info
        let detectedName: string | null = null;
        for (let i = 0; i < Math.min(lines.length, 4); i++) {
            const line = lines[i];
            if (
                !/(\d{1,2}:\d{2}|online|typing|today|yesterday|am|pm|lte|5g|wifi)/i.test(line) &&
                line.length > 2 &&
                line.length < 30
            ) {
                detectedName = line.replace(/[^a-zA-Z0-9\s]/g, '').trim();
                break;
            }
        }

        return {
            rawTranscript: extractedText,
            detectedName,
            detectedPlatform,
            downscaledUri,
        };
    }


    /**
     * 2. Generate Strategic Advice & 3-Tier Reply Options
     */
    public async generateCommunicationAdvice(
        contactId: string | null,
        rawTranscriptOrScenario: string,
        userCustomGoal: string | null,
        selectedPresetTone: string | null,
        sourceType: 'screenshot' | 'manual_text' = 'screenshot',
        screenshotUri: string | null = null
    ): Promise<AdvisoryResult> {
        if (!this.llm.isReady()) {
            throw new Error('Please load a model first in the Settings modal.');
        }

        let contact: ContactRecord | null = null;
        let relevantFacts: string[] = [];
        let pastSummaries: string[] = [];

        // Retrieve Persona Context if linked to an entity
        if (contactId && contactId !== 'anonymous') {
            contact = await getContactById(contactId);
            if (contact) {
                const facts = await getContactFacts(contactId);
                if (this.embeddingService.isReady() && facts.length > 0) {
                    try {
                        const queryVec = await this.embeddingService.getEmbedding(rawTranscriptOrScenario);
                        relevantFacts = facts
                            .map((f) => ({
                                text: f.fact_text,
                                sim: cosineSimilarity(queryVec, blobToVector(f.embedding)),
                            }))
                            .sort((a, b) => b.sim - a.sim)
                            .slice(0, 4)
                            .map((f) => f.text);
                    } catch {
                        relevantFacts = facts.slice(0, 3).map((f) => f.fact_text);
                    }
                }

                const pastInteractions = await getInteractionsByContact(contactId, 3);
                pastSummaries = pastInteractions
                    .filter((i) => i.situation_summary || i.selected_reply || i.custom_reply_feedback)
                    .map((i) => {
                        const outcome = i.custom_reply_feedback
                            ? `User sent: "${i.custom_reply_feedback}"`
                            : i.selected_reply
                                ? `User selected: "${i.selected_reply}"`
                                : 'Analyzed scenario';
                        return `- ${i.situation_summary || 'Chat'} -> (${outcome})`;
                    });
            }
        }

        // Dynamic Tone & Goal Resolution
        let effectiveGoal = userCustomGoal?.trim();
        if (!effectiveGoal && selectedPresetTone) {
            effectiveGoal = `Match this desired style: ${selectedPresetTone}`;
        }
        if (!effectiveGoal && contact?.communication_style) {
            effectiveGoal = `Align naturally with past relationship style: ${contact.communication_style}`;
        }
        if (!effectiveGoal) {
            effectiveGoal = 'Provide natural, emotionally intelligent, and contextually appropriate options.';
        }

        // Build Advisory Grounding Prompt
        const systemPrompt =
            `You are an expert interpersonal advisor and communication strategist.\n` +
            `Analyze conversation dynamics, breakdown underlying subtext, and produce 3 distinct, tailored reply suggestions.\n\n` +
            `### Relationship Context:\n` +
            `- Entity: ${contact ? `${contact.name} (${contact.relationship_type})` : 'Anonymous / General Contact'}\n` +
            `- Platform: ${contact ? contact.default_platform : 'Messaging App'}\n` +
            `- Historical Dynamics: ${contact?.communication_style || 'Not established yet'}\n` +
            `- Known Facts: ${relevantFacts.length > 0 ? relevantFacts.join('; ') : 'None'}\n` +
            `- Recent Interaction Precedents:\n${pastSummaries.length > 0 ? pastSummaries.join('\n') : 'No past history'}\n\n` +
            `### Directives:\n` +
            `1. Breakdown subtext and identify emotional tone (e.g., playful, tense, neutral, urgent).\n` +
            `2. Formulate 3 distinct replies:\n` +
            `   - Option 1: Direct & Clear\n` +
            `   - Option 2: Witty, Playful, or Warm\n` +
            `   - Option 3: Diplomatic, Soft, or Boundary-setting\n` +
            `3. Output strictly valid JSON matching this structure:\n` +
            `{\n` +
            `  "detected_sentiment": "playful | neutral | tense | urgent | warm",\n` +
            `  "subtext_analysis": "Concise breakdown of underlying tone, subtext, and expectations.",\n` +
            `  "strategic_advice": "Actionable guidance on handling this message.",\n` +
            `  "replies": [\n` +
            `    { "label": "Direct", "text": "...", "tone_intent": "Clear and straightforward" },\n` +
            `    { "label": "Witty / Playful", "text": "...", "tone_intent": "Banter / lighthearted" },\n` +
            `    { "label": "Diplomatic", "text": "...", "tone_intent": "Soft and polite" }\n` +
            `  ]\n` +
            `}`;

        const promptPayload =
            `<|im_start|>system\n${systemPrompt}<|im_end|>\n` +
            `<|im_start|>user\n` +
            `### CONVERSATION / SCENARIO:\n${rawTranscriptOrScenario}\n\n` +
            `### DESIRED GOAL / TONE:\n${effectiveGoal}<|im_end|>\n` +
            `<|im_start|>assistant\n`;

        const response = await this.llm.streamCompletion(
            {
                prompt: promptPayload,
                nPredict: 450,
                temperature: 0.2,
            },
            { onToken: () => {} }
        );

        const parsed = this.parseAdvisoryJson(response.fullText);

        // Persist Interaction Log
        const interaction = await insertContactInteraction(
            contactId && contactId !== 'anonymous' ? contactId : null,
            sourceType,
            rawTranscriptOrScenario,
            parsed.strategicAdvice,
            parsed.detected_sentiment,
            effectiveGoal,
            screenshotUri
        );

        // Evolve Profile Asynchronously (Non-blocking)
        if (contactId && contactId !== 'anonymous' && contact) {
            this.evolveContactMemoryAsync(contact, rawTranscriptOrScenario, parsed.subtextAnalysis);
        }

        return {
            interactionId: interaction.id,
            detectedContactName: contact?.name || null,
            detectedPlatform: contact?.default_platform || 'whatsapp',
            detectedSentiment: parsed.detected_sentiment,
            subtextAnalysis: parsed.subtextAnalysis,
            strategicAdvice: parsed.strategicAdvice,
            replies: parsed.replies,
            rawTranscript: rawTranscriptOrScenario,
        };
    }

    /**
     * 3. Record User Selection or Custom Sent Message to Evolve Context
     */
    public async recordUserFeedback(
        interactionId: string,
        contactId: string | null,
        selectedReplyText: string | null,
        customFeedbackText: string | null
    ): Promise<void> {
        await updateInteractionSelectedReply(
            interactionId,
            selectedReplyText,
            customFeedbackText
        );

        // Ingest custom user response into relationship memory
        if (contactId && contactId !== 'anonymous' && customFeedbackText) {
            const contact = await getContactById(contactId);
            if (contact) {
                this.ingestCustomStyleAsync(contact, customFeedbackText);
            }
        }
    }

    /**
     * Asynchronous Memory & Fact Extraction
     */
    private async evolveContactMemoryAsync(
        contact: ContactRecord,
        dialogue: string,
        subtext: string
    ): Promise<void> {
        try {
            const prompt =
                `<|im_start|>system\n` +
                `Extract 1-2 concise personal facts or relationship dynamics from this dialogue about ${contact.name}.\n` +
                `Output ONLY short facts separated by newlines, or 'NONE' if no new personal facts exist.<|im_end|>\n` +
                `<|im_start|>user\nDialogue:\n${dialogue.substring(0, 1000)}\nSubtext: ${subtext}<|im_end|>\n` +
                `<|im_start|>assistant\n`;

            const factsText = await this.llm.completeNonStreaming(prompt, 80);
            const factLines = factsText
                .split('\n')
                .map((l) => l.replace(/^[-*•]\s*/, '').trim())
                .filter((l) => l.length > 5 && !l.toUpperCase().includes('NONE'));

            for (const fact of factLines) {
                let vec = new Float32Array(0);
                if (this.embeddingService.isReady()) {
                    const rawVec = await this.embeddingService.getEmbedding(fact);
                    vec = new Float32Array(rawVec);
                }
                await insertContactFact(contact.id, fact, vec);
            }
        } catch (err) {
            console.warn('[AdvisorService] Async evolution skipped:', err);
        }
    }

    private async ingestCustomStyleAsync(
        contact: ContactRecord,
        customSentMessage: string
    ): Promise<void> {
        try {
            const currentStyle = contact.communication_style || 'Natural, direct';
            const prompt =
                `<|im_start|>system\n` +
                `Given the user's sent message to ${contact.name}, update the 1-sentence description of the user's communication style with this person.\n` +
                `Current Style: ${currentStyle}\n` +
                `User Sent: "${customSentMessage}"\n` +
                `Output ONLY the updated 1-sentence style description.<|im_end|>\n` +
                `<|im_start|>assistant\n`;

            const updated = await this.llm.completeNonStreaming(prompt, 60);
            const cleanStyle = updated.replace(/["\n]/g, '').trim();
            if (cleanStyle.length > 5) {
                await updateContact(
                    contact.id,
                    contact.name,
                    contact.relationship_type,
                    contact.default_platform,
                    cleanStyle,
                    contact.profile_summary
                );
            }
        } catch (err) {
            console.warn('[AdvisorService] Custom style ingestion skipped:', err);
        }
    }

    private parseAdvisoryJson(text: string): {
        detected_sentiment: string;
        subtextAnalysis: string;
        strategicAdvice: string;
        replies: AdviceOption[];
    } {
        try {
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                const jsonStr = text.substring(firstBrace, lastBrace + 1);
                const parsed = JSON.parse(jsonStr);
                return {
                    detected_sentiment: parsed.detected_sentiment || 'neutral',
                    subtextAnalysis: parsed.subtext_analysis || 'Direct conversational exchange.',
                    strategicAdvice: parsed.strategic_advice || 'Respond clearly and concisely.',
                    replies: Array.isArray(parsed.replies)
                        ? parsed.replies
                        : [
                            { label: 'Direct', text: 'Sounds good, let me know!', tone_intent: 'Direct' },
                            { label: 'Casual', text: 'Cool, works for me.', tone_intent: 'Casual' },
                            { label: 'Soft', text: 'Thanks for letting me know!', tone_intent: 'Polite' },
                        ],
                };
            }
        } catch {}

        // Fallback extraction
        return {
            detected_sentiment: 'neutral',
            subtextAnalysis: 'Direct conversational statement without deep underlying subtext.',
            strategicAdvice: 'Keep the response aligned with your primary objective.',
            replies: [
                { label: 'Option 1 (Direct)', text: 'Got it, let me review and get back to you shortly.', tone_intent: 'Direct' },
                { label: 'Option 2 (Casual)', text: 'Sounds great! Will keep you posted.', tone_intent: 'Friendly' },
                { label: 'Option 3 (Polite)', text: 'Thank you for the update. Let me check my schedule.', tone_intent: 'Diplomatic' },
            ],
        };
    }
}
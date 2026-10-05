import { IAiProvider, AiGenerateRequest, AiGenerateResult, DEFAULT_JARVIS_SYSTEM_PROMPT } from './aiProvider';
import { config } from '../core/config';
import { db } from '../database/database';

export class GeminiProvider implements IAiProvider {
  public readonly providerName = 'GeminiProvider';
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(apiKey?: string, model?: string, timeoutMs?: number) {
    this.apiKey = apiKey || config.GEMINI_API_KEY;
    this.model = model || config.GEMINI_MODEL || 'gemini-3.1-flash-lite';
    this.timeoutMs = timeoutMs || config.AI_TIMEOUT_MS;
  }

  public async generateResponse(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startTime = Date.now();

    if (!this.apiKey) {
      throw new Error('[GeminiProvider] GEMINI_API_KEY is not configured in .env or database');
    }

    const systemPrompt = request.systemPrompt || db.getSetting('system_prompt') || DEFAULT_JARVIS_SYSTEM_PROMPT;

    // Build the user message combining context, metadata & batch messages
    const formattedMessages = request.messages.map((m, idx) => `[Message ${idx + 1}]: ${m}`).join('\n');
    const contactMeta: string[] = [];
    if (request.relationship) {
      contactMeta.push(`Verified Relationship: The user is the account owner's ${request.relationship}.`);
    } else {
      contactMeta.push(`Verified Relationship: None (Address the user neutrally and politely. Do NOT assume or invent any relationship).`);
    }
    if (request.description) {
      contactMeta.push(`Contact Notes / Guidance: ${request.description}`);
    }

    let memoryStatusBlock = '';
    if (request.memoryEvidence) {
      if (request.memoryEvidence.status === 'CONFIRMED') {
        memoryStatusBlock = `[MEMORY STATUS: CONFIRMED]\nVerified conversation memory was found. You may refer to the retrieved memory.\n\n`;
      } else if (request.memoryEvidence.status === 'UNKNOWN') {
        memoryStatusBlock = `[MEMORY STATUS: UNKNOWN]\nNo verified conversation memory evidence was found for this query. You MUST NOT pretend to remember or manufacture a topic. Ask the user naturally for clarification.\n\n`;
      }
    }

    const userPrompt = `Contact Information:
Name: "${request.contactName}" (ID: ${request.contactId})
${contactMeta.join('\n')}

Incoming message(s):
${formattedMessages}

${memoryStatusBlock}${request.ragContext ? `${request.ragContext}\n\n` : ''}${request.conversationContext ? `Recent conversation context:\n${request.conversationContext}\n\n` : ''}Please provide a concise, natural, and helpful WhatsApp reply as JARVIS adhering to the above contact rules.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    // List of candidate models in case the chosen model is temporarily unavailable (e.g. 503 spike or 404 deprecated)
    const modelsToTry = [this.model, 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.8-flash'].filter(
      (m, idx, arr) => arr.indexOf(m) === idx
    );

    let lastError: Error | null = null;

    for (const currentModel of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${this.apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: `${systemPrompt}\n\n---\n\n${userPrompt}` }]
              }
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 800
            }
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`[GEMINI] HTTP ${response.status} error for model ${currentModel}: ${errorText}`);
          lastError = new Error(`[GeminiProvider] HTTP ${response.status}: ${errorText}`);
          if (response.status === 404 || response.status === 503) {
            // Try fallback model if available
            continue;
          }
          throw lastError;
        }

        const data = (await response.json()) as any;
        const candidate = data.candidates?.[0];
        const textPart = candidate?.content?.parts?.[0]?.text;
        const reply = (typeof textPart === 'string' ? textPart : '').trim();

        const isValid = Boolean(reply && reply.length > 0);

        console.log(`\n[GEMINI]\nmodel: ${currentModel}\nresponse valid: ${isValid}\nresponse length: ${reply.length}\n`);

        if (!isValid) {
          throw new Error(`[GeminiProvider] Model ${currentModel} returned empty response`);
        }

        clearTimeout(timeout);
        const latencyMs = Date.now() - startTime;

        return {
          reply,
          model: currentModel,
          provider: 'gemini',
          latencyMs
        };
      } catch (err: any) {
        if (err.name === 'AbortError') {
          clearTimeout(timeout);
          console.log(`\n[GEMINI]\nmodel: ${currentModel}\nresponse valid: false\nerror: Request timed out after ${this.timeoutMs}ms\n`);
          throw new Error(`[GeminiProvider] Request timed out after ${this.timeoutMs}ms`);
        }
        lastError = err;
      }
    }

    clearTimeout(timeout);
    throw lastError || new Error(`[GeminiProvider] Failed to generate response from Gemini`);
  }
}

import { IAiProvider, AiGenerateRequest, AiGenerateResult, DEFAULT_JARVIS_SYSTEM_PROMPT } from './aiProvider';
import { config } from '../core/config';
import { db } from '../database/database';

export class GroqProvider implements IAiProvider {
  public readonly providerName = 'GroqProvider';
  private apiKey: string;
  private model: string;
  private timeoutMs: number;

  constructor(apiKey?: string, model?: string, timeoutMs?: number) {
    this.apiKey = apiKey || config.GROQ_API_KEY;
    this.model = model || config.GROQ_MODEL || 'openai/gpt-oss-120b';
    this.timeoutMs = timeoutMs || config.AI_TIMEOUT_MS;
  }

  public async generateResponse(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startTime = Date.now();

    if (!this.apiKey) {
      throw new Error('[GroqProvider] GROQ_API_KEY is not configured in .env or database');
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

    const userPrompt = `Contact Information:
Name: "${request.contactName}" (ID: ${request.contactId})
${contactMeta.join('\n')}

Incoming message(s):
${formattedMessages}

${request.ragContext ? `${request.ragContext}\n\n` : ''}${request.conversationContext ? `Recent conversation context:\n${request.conversationContext}\n\n` : ''}Please provide a concise, natural, and helpful WhatsApp reply as JARVIS adhering to the above contact and language rules.`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    console.log(`\n[GROQ DEBUG]\nrequest started: ${new Date(startTime).toISOString()}\nmodel: ${this.model}`);

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7,
          max_tokens: 800
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      console.log(`HTTP status: ${response.status} ${response.statusText}`);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`API error: HTTP ${response.status} - ${errorText}`);
        throw new Error(`[GroqProvider] API error HTTP ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as any;
      const choice = data.choices?.[0];
      const messageObj = choice?.message;
      const contentStr = typeof messageObj?.content === 'string' ? messageObj.content : '';
      const reply = contentStr.trim();
      const finishReason = choice?.finish_reason || 'stop';

      console.log(`response received: true\nchoices exists: ${Boolean(data.choices)}\nchoices length: ${data.choices ? data.choices.length : 0}\nmessage exists: ${Boolean(messageObj)}\ncontent exists: ${Boolean(contentStr)}\ncontent length: ${reply.length}\nfinish_reason: ${finishReason}\nAPI error: none`);

      if (!reply) {
        throw new Error(`[GroqProvider] Empty response received from model ${this.model} (finish_reason: ${finishReason})`);
      }

      const latencyMs = Date.now() - startTime;
      const tokenUsage = data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens
      } : null;

      return {
        reply,
        model: this.model,
        provider: 'groq',
        latencyMs,
        tokenUsage,
        finishReason
      };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        console.log(`API error: Request timed out after ${this.timeoutMs}ms`);
        throw new Error(`[GroqProvider] Request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }
}

import { IAiProvider, AiGenerateRequest, AiGenerateResult, DEFAULT_JARVIS_SYSTEM_PROMPT } from './aiProvider';
import { config } from '../core/config';
import { db } from '../database/database';

export class LMStudioProvider implements IAiProvider {
  public readonly providerName = 'LMStudioProvider';
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(baseUrl?: string, model?: string, timeoutMs?: number) {
    this.baseUrl = (baseUrl || config.LMSTUDIO_URL).replace(/\/$/, '');
    this.model = model || config.LMSTUDIO_MODEL;
    this.timeoutMs = timeoutMs || config.AI_TIMEOUT_MS;
  }

  public async generateResponse(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startTime = Date.now();
    const systemPrompt = request.systemPrompt || db.getSetting('system_prompt') || DEFAULT_JARVIS_SYSTEM_PROMPT;
    const formattedMessages = request.messages.map((m, idx) => `[Message ${idx + 1}]: ${m}`).join('\n');
    const userPrompt = `Incoming message(s) from "${request.contactName}":\n\n${formattedMessages}\n\n${request.conversationContext ? `Context:\n${request.conversationContext}\n\n` : ''}Reply as JARVIS:`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.7
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`LM Studio API error HTTP ${response.status}`);
      }

      const data = (await response.json()) as any;
      return {
        reply: data.choices?.[0]?.message?.content?.trim() || '',
        model: this.model,
        provider: 'lmstudio',
        latencyMs: Date.now() - startTime
      };
    } catch (error: any) {
      clearTimeout(timeout);
      throw error;
    }
  }
}

import { IAiProvider, AiGenerateRequest, AiGenerateResult, DEFAULT_JARVIS_SYSTEM_PROMPT } from './aiProvider';
import { config } from '../core/config';
import { db } from '../database/database';

export class OllamaProvider implements IAiProvider {
  public readonly providerName = 'OllamaProvider';
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(baseUrl?: string, model?: string, timeoutMs?: number) {
    this.baseUrl = baseUrl || config.OLLAMA_URL;
    this.model = model || config.OLLAMA_MODEL;
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
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: `${systemPrompt}\n\nUser: ${userPrompt}\n\nAssistant:`,
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Ollama API error HTTP ${response.status}`);
      }

      const data = (await response.json()) as any;
      return {
        reply: data.response?.trim() || '',
        model: this.model,
        provider: 'ollama',
        latencyMs: Date.now() - startTime
      };
    } catch (error: any) {
      clearTimeout(timeout);
      throw error;
    }
  }
}

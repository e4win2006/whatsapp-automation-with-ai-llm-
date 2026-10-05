import { IAiProvider, AiGenerateRequest, AiGenerateResult } from './aiProvider';
import { GroqProvider } from './groqProvider';
import { GeminiProvider } from './geminiProvider';

export class FailoverAiProvider implements IAiProvider {
  public readonly providerName = 'FailoverAiProvider';
  private groqProvider: GroqProvider;
  private geminiProvider: GeminiProvider;

  constructor(groqProvider?: GroqProvider, geminiProvider?: GeminiProvider) {
    this.groqProvider = groqProvider || new GroqProvider();
    this.geminiProvider = geminiProvider || new GeminiProvider();
  }

  public async generateResponse(request: AiGenerateRequest): Promise<AiGenerateResult> {
    console.log(`\n[AI PROVIDER]\nPrimary: Groq\nBackup: Gemini\n`);

    // 1. Attempt Primary Provider: Groq
    try {
      const groqResult = await this.groqProvider.generateResponse(request);
      const isGroqValid = Boolean(groqResult && groqResult.reply && groqResult.reply.trim().length > 0);

      console.log(`\n[GROQ]\nstatus: success\nresponse valid: ${isGroqValid}\nresponse length: ${groqResult.reply.length}\n`);

      if (isGroqValid) {
        console.log(`\n[AI FINAL]\nprovider used: groq\nresponse length: ${groqResult.reply.length}\n`);
        return groqResult;
      }
      throw new Error('[GroqProvider] Returned empty reply content');
    } catch (groqError: any) {
      console.log(`\n[GROQ]\nstatus: failed\nresponse valid: false\nresponse length: 0\n`);
      console.log(`\n[AI FAILOVER]\nGroq failed/empty\nSwitching to Gemini\nReason: ${groqError.message || groqError}\n`);

      // 2. Attempt Backup Provider: Gemini
      try {
        const geminiResult = await this.geminiProvider.generateResponse(request);
        const isGeminiValid = Boolean(geminiResult && geminiResult.reply && geminiResult.reply.trim().length > 0);

        if (isGeminiValid) {
          console.log(`\n[AI FINAL]\nprovider used: gemini\nresponse length: ${geminiResult.reply.length}\n`);
          return geminiResult;
        }
        throw new Error('[GeminiProvider] Returned empty reply content');
      } catch (geminiError: any) {
        console.error(`[AI FAILOVER ERROR] Gemini backup failed: ${geminiError.message || geminiError}`);
        console.log(`\n[AI FINAL]\nprovider used: fallback\nresponse length: 65\n`);

        return {
          reply: 'I apologize, but I could not formulate a response at this moment.',
          model: 'fallback',
          provider: 'fallback',
          latencyMs: 0
        };
      }
    }
  }
}

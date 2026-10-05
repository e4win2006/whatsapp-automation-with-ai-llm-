import { IAiProvider, AiGenerateRequest, AiGenerateResult } from './aiProvider';

export class MockAiProvider implements IAiProvider {
  public readonly providerName = 'MockAiProvider';

  public async generateResponse(request: AiGenerateRequest): Promise<AiGenerateResult> {
    const startTime = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50)); // simulate brief latency

    const lastMsg = request.messages[request.messages.length - 1] || '';
    const lower = lastMsg.toLowerCase();

    let reply = `Hello ${request.contactName}! I received your message.`;

    // Natural human-like mock responses based on language and content
    if (lower === 'da') {
      reply = 'Hmm da, paray 😄';
    } else if (lower.includes('entha cheyyunne') || lower.includes('entha')) {
      reply = 'Onnum illa, ivde thanne 😄';
    } else if (lower.includes('food kazhicho')) {
      reply = 'Ippo kazhichilla 😂';
    } else if (lower.includes('innale paranja karyam') || (request.ragContext && request.ragContext.toLowerCase().includes('project'))) {
      reply = 'Athe, project update ready aayi.';
    } else if (/[\u0D00-\u0D7F]/.test(lastMsg)) {
      // Malayalam script
      reply = 'ശരി, ഞാൻ നോക്കാം.';
    } else if (lower.includes('where are you') || lower.includes('evideya')) {
      reply = 'ivide thanne da 😄';
    } else {
      reply = `Hi ${request.contactName}, got your message: "${lastMsg}".`;
    }

    return {
      reply,
      model: 'mock-jarvis-v1',
      provider: 'mock',
      latencyMs: Date.now() - startTime,
      finishReason: 'stop',
      tokenUsage: { promptTokens: 25, completionTokens: 10, totalTokens: 35 }
    };
  }
}

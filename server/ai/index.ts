import { IAiProvider } from './aiProvider';
import { GroqProvider } from './groqProvider';
import { GeminiProvider } from './geminiProvider';
import { FailoverAiProvider } from './failoverProvider';
import { OllamaProvider } from './ollamaProvider';
import { LMStudioProvider } from './lmstudioProvider';
import { MockAiProvider } from './mockProvider';
import { config } from '../core/config';
import { db } from '../database/database';

export * from './aiProvider';
export * from './groqProvider';
export * from './geminiProvider';
export * from './failoverProvider';
export * from './ollamaProvider';
export * from './lmstudioProvider';
export * from './mockProvider';

export function getAiProvider(providerOverride?: string): IAiProvider {
  const selected = providerOverride || db.getSetting('ai_provider') || config.AI_PROVIDER;

  switch (selected.toLowerCase()) {
    case 'failover':
      return new FailoverAiProvider();
    case 'groq':
      return new GroqProvider();
    case 'gemini':
      return new GeminiProvider();
    case 'ollama':
      return new OllamaProvider();
    case 'lmstudio':
      return new LMStudioProvider();
    case 'mock':
      return new MockAiProvider();
    default:
      return new FailoverAiProvider();
  }
}

import { DbContact, AiCapabilities, parseAiCapabilities, DEFAULT_AI_CAPABILITIES } from '../database/database';

export interface CapabilityCheckResult {
  allowed: boolean;
  requiredCapability: keyof AiCapabilities;
  refusalMessage?: string;
  reason?: string;
}

export class CapabilityGuard {
  private static readonly STANDARD_CAPABILITY_REFUSAL = "Sorry, JARVIS isn't configured to help with that for this contact.";

  /**
   * Classify the requested capability from incoming message text.
   */
  public static classifyRequestedCapability(text: string): keyof AiCapabilities {
    const clean = text.toLowerCase().trim();

    // 1. Coding & Programming Requests
    if (this.isCodingQuery(clean)) {
      return 'coding';
    }

    // 2. Translation Requests
    if (this.isTranslationQuery(clean)) {
      return 'translation';
    }

    // 3. Summarization Requests
    if (this.isSummarizationQuery(clean)) {
      return 'summarization';
    }

    // 4. Web Search / Real-time info
    if (this.isWebSearchQuery(clean)) {
      return 'webSearch';
    }

    // 5. General AI Q&A vs Casual Chat
    if (this.isGeneralAIQuery(clean)) {
      return 'generalAI';
    }

    return 'chat';
  }

  /**
   * Checks if a contact is authorized to use the required AI capability.
   * Blocks restricted requests BEFORE sending to AI provider.
   */
  public static checkCapability(
    messages: string[],
    contact: DbContact | null
  ): CapabilityCheckResult {
    const combinedText = messages.join(' ');
    const requiredCapability = this.classifyRequestedCapability(combinedText);

    // If contact is not provided or has no capabilities set, use defaults
    const capabilities: AiCapabilities = contact
      ? parseAiCapabilities(contact.ai_capabilities)
      : { ...DEFAULT_AI_CAPABILITIES };

    // Check specific capability permission
    if (requiredCapability === 'coding' && !capabilities.coding) {
      console.log(`[CAPABILITY GUARD] Blocked coding request for ${contact?.name || 'unknown'}: coding capability is OFF`);
      return {
        allowed: false,
        requiredCapability: 'coding',
        reason: 'CAPABILITY_CODING_DISABLED',
        refusalMessage: this.STANDARD_CAPABILITY_REFUSAL
      };
    }

    if (requiredCapability === 'translation' && !capabilities.translation) {
      console.log(`[CAPABILITY GUARD] Blocked translation request for ${contact?.name || 'unknown'}: translation capability is OFF`);
      return {
        allowed: false,
        requiredCapability: 'translation',
        reason: 'CAPABILITY_TRANSLATION_DISABLED',
        refusalMessage: this.STANDARD_CAPABILITY_REFUSAL
      };
    }

    if (requiredCapability === 'summarization' && !capabilities.summarization) {
      console.log(`[CAPABILITY GUARD] Blocked summarization request for ${contact?.name || 'unknown'}: summarization capability is OFF`);
      return {
        allowed: false,
        requiredCapability: 'summarization',
        reason: 'CAPABILITY_SUMMARIZATION_DISABLED',
        refusalMessage: this.STANDARD_CAPABILITY_REFUSAL
      };
    }

    if (requiredCapability === 'webSearch' && !capabilities.webSearch) {
      console.log(`[CAPABILITY GUARD] Blocked webSearch request for ${contact?.name || 'unknown'}: webSearch capability is OFF`);
      return {
        allowed: false,
        requiredCapability: 'webSearch',
        reason: 'CAPABILITY_WEBSEARCH_DISABLED',
        refusalMessage: this.STANDARD_CAPABILITY_REFUSAL
      };
    }

    if (requiredCapability === 'generalAI' && !capabilities.generalAI) {
      console.log(`[CAPABILITY GUARD] Blocked generalAI request for ${contact?.name || 'unknown'}: generalAI capability is OFF`);
      return {
        allowed: false,
        requiredCapability: 'generalAI',
        reason: 'CAPABILITY_GENERAL_AI_DISABLED',
        refusalMessage: this.STANDARD_CAPABILITY_REFUSAL
      };
    }

    if (requiredCapability === 'chat' && !capabilities.chat) {
      console.log(`[CAPABILITY GUARD] Blocked chat request for ${contact?.name || 'unknown'}: chat capability is OFF`);
      return {
        allowed: false,
        requiredCapability: 'chat',
        reason: 'CAPABILITY_CHAT_DISABLED',
        refusalMessage: this.STANDARD_CAPABILITY_REFUSAL
      };
    }

    return {
      allowed: true,
      requiredCapability
    };
  }

  // --- Classification Pattern Matchers ---

  private static isCodingQuery(text: string): boolean {
    const patterns = [
      /\b(write|create|generate|give me|make)\s+(a\s+)?(python|java|javascript|typescript|c\+\+|c#|c|golang|rust|php|ruby|swift|kotlin|sql|html|css|bash|powershell|script|code|program|function|class|algorithm|regex)\b/i,
      /\b(debug|fix|explain|refactor|optimize|review)\s+(this|my|the)?\s*(code|script|program|function|error|bug|exception|traceback|c program|python program|java program|c\+\+ program)\b/i,
      /\b(def |function\s*\(|class |import (sys|os|numpy|pandas|react|torch)|void main|int main|#include\s*<|public static void main)\b/i,
      /\b(write code|write a script|write a program|write python|write java|write c program|solve leetcode|coding problem|syntax error|stack trace)\b/i,
      /\b(explain linked list|explain binary search|implement linked list|implement stack|implement queue|implement sorting|bubble sort|quick sort|merge sort)\b/i
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isTranslationQuery(text: string): boolean {
    const patterns = [
      /\b(translate|translation|how to say|what does .* mean in)\b/i,
      /\b(translate this|translate to english|translate to malayalam|translate to hindi|translate to spanish|translate to french|translate to german|translate to russian|translate to chinese)\b/i
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isSummarizationQuery(text: string): boolean {
    const patterns = [
      /\b(summarize|summarise|summary of|give me a summary|tldr|tl;dr|key points of|brief overview of)\b/i
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isWebSearchQuery(text: string): boolean {
    const patterns = [
      /\b(search the web|google this|latest news on|current stock price|today's weather in|live score of)\b/i
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isGeneralAIQuery(text: string): boolean {
    const patterns = [
      /\b(what is|what are|who is|who was|explain|why does|how does|when did|calculate|how many|difference between|compare)\b/i
    ];
    return patterns.some((p) => p.test(text));
  }
}

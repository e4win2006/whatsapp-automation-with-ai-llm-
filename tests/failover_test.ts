import dotenv from 'dotenv';
dotenv.config();

import { FailoverAiProvider } from '../server/ai/failoverProvider';
import { GroqProvider } from '../server/ai/groqProvider';
import { GeminiProvider } from '../server/ai/geminiProvider';
import { AiGenerateRequest, AiGenerateResult } from '../server/ai/aiProvider';
import assert from 'assert';

async function testFailover() {
  console.log('================================================================');
  console.log('🧪 TESTING AI PROVIDER FAILOVER SYSTEM');
  console.log('================================================================\n');

  // 1. Test Normal Primary (Groq / Mocked Primary) Path
  console.log('--- Case 1: Primary Working Normally ---');
  class MockWorkingPrimary extends GroqProvider {
    public override async generateResponse(_request: AiGenerateRequest): Promise<AiGenerateResult> {
      return {
        reply: '20',
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        durationMs: 45
      };
    }
  }

  const workingFailover = new FailoverAiProvider(new MockWorkingPrimary() as any, new GeminiProvider() as any);
  const res1 = await workingFailover.generateResponse({
    contactName: 'Test Contact Alpha',
    contactId: '910000000001@c.us',
    messages: ['Hi Jarvis, what is 10 + 10?'],
    triggerType: 'wake_phrase'
  });

  console.log('Result 1 Provider:', res1.provider);
  console.log('Result 1 Reply:', res1.reply);
  assert(res1.provider === 'groq', 'Should use Groq when Groq succeeds');
  assert(Boolean(res1.reply && res1.reply.length > 0), 'Reply should not be empty');
  console.log('✅ [PASS] Case 1: Groq succeeded without invoking Gemini\n');

  // 2. Test Groq Failing -> Automatic Failover to Gemini
  console.log('--- Case 2: Groq Fails -> Automatic Failover to Gemini ---');
  class MockFailingGroq extends GroqProvider {
    public override async generateResponse(_request: AiGenerateRequest): Promise<AiGenerateResult> {
      console.log('[MOCK GROQ] Simulating Groq API 500 error / rate-limit failure...');
      throw new Error('Groq simulated 500 internal server error');
    }
  }

  class MockWorkingGemini extends GeminiProvider {
    public override async generateResponse(_request: AiGenerateRequest): Promise<AiGenerateResult> {
      return {
        reply: 'Recursion is a technique where a function calls itself.',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        durationMs: 60
      };
    }
  }

  const failoverWithBrokenGroq = new FailoverAiProvider(
    new MockFailingGroq() as any,
    new MockWorkingGemini() as any
  );

  const res2 = await failoverWithBrokenGroq.generateResponse({
    contactName: 'Test Contact Alpha',
    contactId: '910000000001@c.us',
    messages: ['Explain recursion in one sentence.'],
    triggerType: 'normal_message'
  });

  console.log('Result 2 Provider:', res2.provider);
  console.log('Result 2 Reply:', res2.reply);
  assert(res2.provider === 'gemini', 'Should failover to Gemini when Groq throws');
  assert(Boolean(res2.reply && res2.reply.length > 0), 'Gemini reply should be valid');
  console.log('✅ [PASS] Case 2: Successfully failed over to Gemini\n');

  // 3. Test Both Failing -> Safe Fallback
  console.log('--- Case 3: Both Groq & Gemini Fail -> Return Fallback Message ---');
  class MockFailingGemini extends GeminiProvider {
    public override async generateResponse(_request: AiGenerateRequest): Promise<AiGenerateResult> {
      console.log('[MOCK GEMINI] Simulating Gemini network timeout...');
      throw new Error('Gemini simulated timeout error');
    }
  }

  const failoverWithBothBroken = new FailoverAiProvider(
    new MockFailingGroq() as any,
    new MockFailingGemini() as any
  );

  const res3 = await failoverWithBothBroken.generateResponse({
    contactName: 'Test Contact Alpha',
    contactId: '910000000001@c.us',
    messages: ['What is the weather today?'],
    triggerType: 'normal_message'
  });

  console.log('Result 3 Provider:', res3.provider);
  console.log('Result 3 Reply:', res3.reply);
  assert(res3.provider === 'fallback', 'Should use fallback provider when both fail');
  assert(res3.reply === 'I apologize, but I could not formulate a response at this moment.', 'Should return generic fallback text');
  console.log('✅ [PASS] Case 3: Returned fallback message when both fail\n');

  console.log('================================================================');
  console.log('🎉 ALL AI FAILOVER TESTS PASSED 100%');
  console.log('================================================================');
}

testFailover().catch((err) => {
  console.error('❌ [FAIL] Failover test failed:', err);
  process.exit(1);
});

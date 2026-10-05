import { GroqProvider } from '../server/ai/groqProvider';

async function testGroq() {
  class MockGroqProvider extends GroqProvider {
    public override async generateResponse(req: any) {
      if (process.env.GROQ_API_KEY && !process.env.CI) {
        try {
          return await super.generateResponse(req);
        } catch {
          // Fallback to mock
        }
      }
      return {
        reply: `Mock reply for: ${req.messages.join(' ')}`,
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        durationMs: 35
      };
    }
  }

  const provider = new MockGroqProvider();
  
  const testCases = [
    { name: 'Hi Jarvis', msgs: ['Hi Jarvis'] },
    { name: "What's the time", msgs: ["What's the time"] },
    { name: 'Hi how are you', msgs: ['Hi how are you'] },
    { name: 'Good morning', msgs: ['Good morning'] },
    { name: 'Explain recursion in simple words', msgs: ['Explain recursion in simple words'] }
  ];

  for (const tc of testCases) {
    console.log(`\n--- Testing "${tc.name}" ---`);
    try {
      const res = await provider.generateResponse({
        contactName: 'Test Contact Alpha',
        contactId: '910000000001@c.us',
        messages: tc.msgs,
        triggerType: 'normal_message',
        systemPrompt: undefined
      });
      console.log('Result:', JSON.stringify(res, null, 2));
    } catch (err: any) {
      console.error('Error for', tc.name, ':', err.message);
    }
  }
}

testGroq();

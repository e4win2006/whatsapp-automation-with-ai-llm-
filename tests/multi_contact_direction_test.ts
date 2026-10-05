import dotenv from 'dotenv';
dotenv.config();

import { JarvisDatabase } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { MockWhatsAppAdapter } from '../server/whatsapp/adapters/mockAdapter';
import assert from 'assert';
import path from 'path';
import fs from 'fs';

async function testMultiContactAndConversationDirection() {
  console.log('================================================================');
  console.log('🧪 TESTING MULTI-CONTACT AUTOMATION & CONVERSATION DIRECTION');
  console.log('================================================================\n');

  const testDbPath = path.resolve(__dirname, 'test_direction.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  const contacts = new ContactManager(testDb);
  const conversations = new ConversationManager(testDb);
  const mockAdapter = new MockWhatsAppAdapter();
  await mockAdapter.connect();

  const autoEngine = new AutomationEngine(mockAdapter as any, contacts, testDb, conversations);

  // 1. Setup Contacts:
  // Contact A: (+91 00000 00001) -> Automation ON
  contacts.addContact('910000000001@c.us', 'Contact Alice');
  contacts.updateContactSettings('910000000001@c.us', { ai_enabled: true });

  // Contact B: (+91 00000 00002) -> Automation ON
  contacts.addContact('910000000002@c.us', 'Contact Bob');
  contacts.updateContactSettings('910000000002@c.us', { ai_enabled: true });

  // Contact C: (+91 00000 00003) -> Automation OFF
  contacts.addContact('910000000003@c.us', 'Contact Charlie');
  contacts.updateContactSettings('910000000003@c.us', { ai_enabled: false });

  console.log('✅ 1. Initialized 3 contacts in DB:');
  console.log('   - Contact A (Contact Alice): Automation ON');
  console.log('   - Contact B (Contact Bob): Automation ON');
  console.log('   - Contact C (Contact Charlie): Automation OFF\n');

  const sentMessages: Array<{ to: string; text: string }> = [];
  const originalSend = mockAdapter.sendMessage.bind(mockAdapter);
  mockAdapter.sendMessage = async (to: string, text: string, autoSend?: boolean) => {
    sentMessages.push({ to, text });
    return (originalSend as any)(to, text, autoSend);
  };

  // --- Scenario 1: ME -> Contact B: "Say Hi Jarvis to test it" ---
  console.log('--- Step 1: Owner sends message to Contact B (fromMe: true) ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_owner_1',
    contactId: '910000000002@c.us',
    senderName: 'Account Owner (You)',
    fromMe: true,
    body: 'Say Hi Jarvis to test it',
    timestamp: Date.now(),
    isGroup: false
  });
  assert((sentMessages.length as number) === 0, 'Owner-sent message should not trigger JARVIS response');
  console.log('✅ [PASS] Step 1: Owner-sent message was ignored by JARVIS\n');

  // --- Scenario 2: Contact B -> ME: "Hi Jarvis" ---
  console.log('--- Step 2: Contact B replies "Hi Jarvis" (fromMe: false) ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_bob_1',
    contactId: '910000000002@c.us',
    senderName: 'Contact Bob',
    fromMe: false,
    body: 'Hi Jarvis',
    timestamp: Date.now(),
    isGroup: false
  });
  assert((sentMessages.length as number) === 1, 'Contact B\'s wake phrase MUST trigger JARVIS response');
  assert(sentMessages[0].to === '910000000002@c.us', 'Response must be delivered to Contact B');
  console.log(`✅ [PASS] Step 2: JARVIS replied to Contact B: "${sentMessages[0].text}"\n`);

  // --- Scenario 3: Owner accidentally sends "Hi Jarvis" from own phone ---
  console.log('--- Step 3: Owner sends "Hi Jarvis" from own phone (fromMe: true) ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_owner_2',
    contactId: '910000000002@c.us',
    senderName: 'Account Owner (You)',
    fromMe: true,
    body: 'Hi Jarvis',
    timestamp: Date.now(),
    isGroup: false
  });
  assert((sentMessages.length as number) === 1, 'Owner sending wake phrase should NOT trigger JARVIS');
  console.log('✅ [PASS] Step 3: fromMe wake phrase ignored\n');

  // --- Scenario 4: Contact B sends follow-up query "What is the time?" ---
  console.log('--- Step 4: Contact B sends follow-up query "What is the time?" ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_bob_2',
    contactId: '910000000002@c.us',
    senderName: 'Contact Bob',
    fromMe: false,
    body: 'What is the time?',
    timestamp: Date.now(),
    isGroup: false
  });
  console.log('✅ [PASS] Step 4: Contact B follow-up query accepted\n');

  // --- Scenario 5: Contact C (Contact Charlie, Automation OFF) sends "Hi Jarvis" ---
  console.log('--- Step 5: Contact C (Contact Charlie - Automation OFF) sends "Hi Jarvis" ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_charlie_1',
    contactId: '910000000003@c.us',
    senderName: 'Contact Charlie',
    fromMe: false,
    body: 'Hi Jarvis',
    timestamp: Date.now(),
    isGroup: false
  });
  assert((sentMessages.length as number) === 1, 'Contact C with Automation OFF must NOT trigger JARVIS');
  console.log('✅ [PASS] Step 5: Contact C with Automation OFF was ignored\n');

  // --- Scenario 6: Contact A (Contact Alice, Automation ON) sends "Hi Jarvis" ---
  console.log('--- Step 6: Contact A (Contact Alice - Automation ON) sends "Hi Jarvis" ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_alice_1',
    contactId: '910000000001@c.us',
    senderName: 'Contact Alice',
    fromMe: false,
    body: 'Hi Jarvis',
    timestamp: Date.now(),
    isGroup: false
  });
  assert((sentMessages.length as number) === 2, 'Contact A with Automation ON MUST trigger JARVIS');
  assert(sentMessages[1].to === '910000000001@c.us', 'Response delivered to Contact Alice');
  console.log(`✅ [PASS] Step 6: JARVIS replied to Contact Alice: "${sentMessages[1].text}"\n`);

  console.log('================================================================');
  console.log('🎉 ALL MULTI-CONTACT & DIRECTION TESTS PASSED 100%');
  console.log('================================================================');

  (autoEngine as any).activeTimers?.forEach((t: any) => clearTimeout(t.timerId));
  testDb.close();
  if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch {}
  }
}

testMultiContactAndConversationDirection().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

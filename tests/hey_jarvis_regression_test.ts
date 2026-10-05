import { JarvisDatabase } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { MockWhatsAppAdapter } from '../server/whatsapp/adapters/mockAdapter';
import { WhatsAppManager } from '../server/whatsapp/client';
import path from 'path';
import fs from 'fs';

async function runHeyJarvisRegressionTests() {
  console.log('================================================================');
  console.log('🧪 VERIFYING HEY JARVIS END-TO-END PIPELINE & REGRESSION TESTS');
  console.log('================================================================\n');

  const testDbPath = path.resolve(process.cwd(), 'data/test_hey_jarvis.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  const contactMgr = new ContactManager(testDb);
  const convMgr = new ConversationManager(testDb);

  const mockAdapter = new MockWhatsAppAdapter();
  await mockAdapter.connect();
  const whatsappMgr = new WhatsAppManager(mockAdapter, testDb);
  const autoEngine = new AutomationEngine(whatsappMgr, contactMgr, testDb, convMgr);

  try {
    // -------------------------------------------------------------
    // SETUP APPROVED CONTACT: Test User 1 (910000000001@c.us, LID 100000000001@lid)
    // -------------------------------------------------------------
    testDb.upsertContact({
      id: '910000000001@c.us',
      name: 'Test Contact 1',
      phone_number: '+910000000001',
      whatsapp_phone_id: '910000000001@c.us',
      whatsapp_id: '100000000001@lid',
      alternate_names: ['Tester'],
      is_approved: true,
      ai_enabled: true,
      wake_phrase_only: true,
      respond_normal_messages: false,
      response_delay_seconds: 0
    });

    // SETUP CONTACT WITH CODING DISABLED: Bob (910000000002@c.us)
    testDb.upsertContact({
      id: '910000000002@c.us',
      name: 'Bob NoCode',
      phone_number: '+910000000002',
      whatsapp_phone_id: '910000000002@c.us',
      is_approved: true,
      ai_enabled: true,
      permissions: JSON.stringify({
        useJarvis: true,
        chat: true,
        coding: false,
        programmingHelp: false,
        viewMessages: false,
        viewNotifications: false,
        viewContacts: false,
        viewCalendar: false,
        viewFiles: false,
        viewLocation: false,
        viewPersonalInformation: false
      }),
      wake_phrase_only: true,
      respond_normal_messages: false,
      response_delay_seconds: 0
    });

    // SETUP INDEPENDENT CONTACT: Alice (910000000003@c.us)
    testDb.upsertContact({
      id: '910000000003@c.us',
      name: 'Alice Clean',
      phone_number: '+910000000003',
      whatsapp_phone_id: '910000000003@c.us',
      is_approved: true,
      ai_enabled: true,
      wake_phrase_only: true,
      respond_normal_messages: false,
      response_delay_seconds: 0
    });

    process.env.DEBUG_RESPONSE_DELAY = '0';

    // -------------------------------------------------------------
    // TEST 1: "Hey Jarvis" from LID -> Immediate Reply
    // -------------------------------------------------------------
    console.log('--- TEST 1: "Hey Jarvis" Incoming from LID ---');
    mockAdapter.clearSentMessages();
    await autoEngine.handleIncomingMessage({
      id: 'msg_test_1',
      contactId: '100000000001@lid',
      whatsappLid: '100000000001@lid',
      whatsappPhoneId: '910000000001@c.us',
      senderName: 'Test Contact 1',
      phoneNumber: '+910000000001',
      fromMe: false,
      body: 'Hey Jarvis',
      timestamp: Date.now(),
      isGroup: false
    });

    await new Promise((r) => setTimeout(r, 200));
    const sent1 = mockAdapter.getSentMessages();
    if (sent1.length === 0) {
      throw new Error('TEST 1 FAILED: No reply sent for "Hey Jarvis"');
    }
    console.log('✅ TEST 1 PASSED: Immediate reply delivered:', `"${sent1[0].message}"\n`);

    // -------------------------------------------------------------
    // TEST 2: "Hey Jarvis, hi" -> Immediate Reply
    // -------------------------------------------------------------
    console.log('--- TEST 2: "Hey Jarvis, hi" Incoming from Phone ID ---');
    mockAdapter.clearSentMessages();
    await autoEngine.handleIncomingMessage({
      id: 'msg_test_2',
      contactId: '910000000001@c.us',
      whatsappPhoneId: '910000000001@c.us',
      senderName: 'Test Contact 1',
      phoneNumber: '+910000000001',
      fromMe: false,
      body: 'Hey Jarvis, hi',
      timestamp: Date.now(),
      isGroup: false
    });

    await new Promise((r) => setTimeout(r, 200));
    const sent2 = mockAdapter.getSentMessages();
    if (sent2.length === 0) {
      throw new Error('TEST 2 FAILED: No reply sent for "Hey Jarvis, hi"');
    }
    console.log('✅ TEST 2 PASSED: Immediate reply delivered:', `"${sent2[0].message}"\n`);

    // -------------------------------------------------------------
    // TEST 3: "Jarvis" Single Word Wake Detection
    // -------------------------------------------------------------
    console.log('--- TEST 3: "Jarvis" Single Word Wake Detection ---');
    mockAdapter.clearSentMessages();
    await autoEngine.handleIncomingMessage({
      id: 'msg_test_3',
      contactId: '910000000001@c.us',
      whatsappPhoneId: '910000000001@c.us',
      senderName: 'Test Contact 1',
      phoneNumber: '+910000000001',
      fromMe: false,
      body: 'Jarvis',
      timestamp: Date.now(),
      isGroup: false
    });

    await new Promise((r) => setTimeout(r, 200));
    const sent3 = mockAdapter.getSentMessages();
    if (sent3.length === 0) {
      throw new Error('TEST 3 FAILED: No reply sent for "Jarvis"');
    }
    console.log('✅ TEST 3 PASSED: Wake detected and reply delivered:', `"${sent3[0].message}"\n`);

    // -------------------------------------------------------------
    // TEST 4: Normal follow-up after active conversation
    // -------------------------------------------------------------
    console.log('--- TEST 4: Normal Follow-up in Active Conversation ---');
    mockAdapter.clearSentMessages();
    await autoEngine.handleIncomingMessage({
      id: 'msg_test_4',
      contactId: '910000000001@c.us',
      whatsappPhoneId: '910000000001@c.us',
      senderName: 'Test Contact 1',
      phoneNumber: '+910000000001',
      fromMe: false,
      body: 'Can you tell me what time it is?',
      timestamp: Date.now(),
      isGroup: false
    });

    await new Promise((r) => setTimeout(r, 200));
    const sent4 = mockAdapter.getSentMessages();
    if (sent4.length === 0) {
      throw new Error('TEST 4 FAILED: Follow-up message not answered in active conversation');
    }
    console.log('✅ TEST 4 PASSED: Active conversation follow-up replied:', `"${sent4[0].message}"\n`);

    // -------------------------------------------------------------
    // TEST 5: Contact with coding disabled
    // -------------------------------------------------------------
    console.log('--- TEST 5A: Coding Refusal when Coding Disabled ---');
    mockAdapter.clearSentMessages();
    await autoEngine.handleIncomingMessage({
      id: 'msg_test_5a',
      contactId: '910000000002@c.us',
      whatsappPhoneId: '910000000002@c.us',
      senderName: 'Bob NoCode',
      phoneNumber: '+910000000002',
      fromMe: false,
      body: 'Hey Jarvis, write Python code to calculate prime numbers',
      timestamp: Date.now(),
      isGroup: false
    });

    await new Promise((r) => setTimeout(r, 200));
    const sent5a = mockAdapter.getSentMessages();
    if (sent5a.length === 0) {
      throw new Error('TEST 5A FAILED: No response sent for coding request');
    }
    if (!sent5a[0].message.toLowerCase().includes('not authorized') && !sent5a[0].message.toLowerCase().includes('coding') && !sent5a[0].message.toLowerCase().includes('configured')) {
      throw new Error(`TEST 5A FAILED: Expected coding refusal message, got: ${sent5a[0].message}`);
    }
    console.log('✅ TEST 5A PASSED: Coding request correctly refused:', `"${sent5a[0].message}"`);

    console.log('--- TEST 5B: Normal Chat Allowed for Same Contact ---');
    mockAdapter.clearSentMessages();
    await autoEngine.handleIncomingMessage({
      id: 'msg_test_5b',
      contactId: '910000000002@c.us',
      whatsappPhoneId: '910000000002@c.us',
      senderName: 'Bob NoCode',
      phoneNumber: '+910000000002',
      fromMe: false,
      body: 'Hey Jarvis, how are you?',
      timestamp: Date.now(),
      isGroup: false
    });

    await new Promise((r) => setTimeout(r, 200));
    const sent5b = mockAdapter.getSentMessages();
    if (sent5b.length === 0) {
      throw new Error('TEST 5B FAILED: Normal chat blocked for contact with coding disabled');
    }
    console.log('✅ TEST 5B PASSED: Normal chat replied successfully:', `"${sent5b[0].message}"\n`);

    // -------------------------------------------------------------
    // TEST 6: Multi-Contact State Isolation
    // -------------------------------------------------------------
    console.log('--- TEST 6: Multi-Contact State Isolation ---');
    mockAdapter.clearSentMessages();
    await autoEngine.handleIncomingMessage({
      id: 'msg_test_6',
      contactId: '910000000003@c.us',
      whatsappPhoneId: '910000000003@c.us',
      senderName: 'Alice Clean',
      phoneNumber: '+910000000003',
      fromMe: false,
      body: 'Hey Jarvis',
      timestamp: Date.now(),
      isGroup: false
    });

    await new Promise((r) => setTimeout(r, 200));
    const sent6 = mockAdapter.getSentMessages();
    if (sent6.length === 0 || sent6[0].contactId !== '910000000003@c.us') {
      throw new Error('TEST 6 FAILED: Alice reply sent to wrong contact or missing');
    }
    console.log('✅ TEST 6 PASSED: Independent contact received isolated reply:', `"${sent6[0].message}"\n`);

    console.log('================================================================');
    console.log('🎉 ALL HEY JARVIS END-TO-END REGRESSION TESTS PASSED (6/6)');
    console.log('================================================================\n');
  } finally {
    testDb.close();
    try { fs.unlinkSync(testDbPath); } catch {}
  }
}

runHeyJarvisRegressionTests().catch((err) => {
  console.error('Fatal test failure:', err);
  process.exit(1);
});

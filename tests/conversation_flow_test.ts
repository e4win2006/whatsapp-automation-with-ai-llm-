import { JarvisDatabase } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import path from 'path';
import fs from 'fs';

async function runConversationFlowTest() {
  console.log('================================================================');
  console.log('🧪 TESTING JARVIS CONVERSATION FLOW (WAKE PHRASE & 60S QUERIES)');
  console.log('================================================================\n');

  const testDbPath = path.resolve(process.cwd(), 'data/conv_flow_test.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  const contactMgr = new ContactManager(testDb);

  // 1. Initialize approved contact for Test User Alpha (+910000000001 / 100000000001@lid)
  const approvedContact = testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'Test Contact Alpha',
    phone_number: '+910000000001',
    whatsapp_id: '100000000001@lid',
    whatsapp_phone_id: '910000000001@c.us',
    is_approved: true,
    ai_enabled: true,
    response_delay_seconds: 60,
    respond_normal_messages: true
  });
  console.log('✅ 1. Initialized approved contact with 60s normal delay in DB');

  const deliveredMessages: Array<{ to: string; text: string }> = [];
  const mockWhatsapp = {
    sendMessage: async (contactId: string, text: string) => {
      deliveredMessages.push({ to: contactId, text });
      console.log(`[TEST WHATSAPP] Delivered reply to ${contactId}: "${text}"`);
      return { messageId: `msg_${Date.now()}`, timestamp: Date.now(), success: true };
    },
    getStatus: () => 'connected',
    getAdapter: () => ({ adapterName: 'MockWhatsAppAdapter' })
  } as any;

  const convMgr = new ConversationManager(testDb);
  const autoEngine = new AutomationEngine(mockWhatsapp, contactMgr, testDb, convMgr);

  // --- Step 1: User sends "Hi Jarvis" ---
  console.log('\n--- Step 1: Send Wake Phrase "Hi Jarvis" ---');
  delete process.env.DEBUG_RESPONSE_DELAY;

  await autoEngine.handleIncomingMessage({
    id: 'msg_wake_1',
    contactId: '100000000001@lid',
    senderName: 'Test Contact Alpha',
    phoneNumber: '+910000000001',
    whatsappPhoneId: '910000000001@c.us',
    fromMe: false,
    body: 'Hi Jarvis',
    timestamp: Date.now(),
    isGroup: false
  });

  // Give AI a moment to respond immediately
  await new Promise((r) => setTimeout(r, 400));

  if (deliveredMessages.length !== 1) {
    throw new Error(`Expected 1 immediate response to wake phrase, got ${deliveredMessages.length}`);
  }
  console.log('✅ [PASS] Wake phrase responded immediately without 60s delay');

  // Verify timer is not active for wake phrase
  const activeTimersAfterWake = autoEngine.getActiveTimers();
  if (activeTimersAfterWake.length > 0) {
    throw new Error('Expected 0 active timers after immediate wake phrase reply');
  }

  // --- Step 2: User sends normal query 1: "What is 25 * 4?" ---
  console.log('\n--- Step 2: Send Query 1 ("What is 25 * 4?") ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_query_1',
    contactId: '100000000001@lid',
    senderName: 'Test Contact Alpha',
    phoneNumber: '+910000000001',
    whatsappPhoneId: '910000000001@c.us',
    fromMe: false,
    body: 'What is 25 * 4?',
    timestamp: Date.now(),
    isGroup: false
  });

  let timers = autoEngine.getActiveTimers();
  if (timers.length !== 1) {
    throw new Error('Expected 1 active timer for normal query 1');
  }
  const timer1ExpiresAt = timers[0].expiresAt;
  console.log('✅ [PASS] 60-second message collection timer started for Query 1');

  // Wait 100ms
  await new Promise((r) => setTimeout(r, 100));

  // --- Step 3: User sends query 2: "And what is 100 / 5?" ---
  console.log('\n--- Step 3: Send Query 2 ("And what is 100 / 5?") ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_query_2',
    contactId: '100000000001@lid',
    senderName: 'Test Contact Alpha',
    phoneNumber: '+910000000001',
    whatsappPhoneId: '910000000001@c.us',
    fromMe: false,
    body: 'And what is 100 / 5?',
    timestamp: Date.now(),
    isGroup: false
  });

  timers = autoEngine.getActiveTimers();
  if (timers.length !== 1 || timers[0].expiresAt <= timer1ExpiresAt) {
    throw new Error('Expected timer to be reset with a later expiration timestamp');
  }
  const timer2ExpiresAt = timers[0].expiresAt;
  console.log('✅ [PASS] Timer reset upon receiving Query 2');

  // Wait 100ms
  await new Promise((r) => setTimeout(r, 100));

  // --- Step 4: User sends query 3: "Explain both answers." ---
  console.log('\n--- Step 4: Send Query 3 ("Explain both answers.") ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_query_3',
    contactId: '100000000001@lid',
    senderName: 'Test Contact Alpha',
    phoneNumber: '+910000000001',
    whatsappPhoneId: '910000000001@c.us',
    fromMe: false,
    body: 'Explain both answers.',
    timestamp: Date.now(),
    isGroup: false
  });

  timers = autoEngine.getActiveTimers();
  if (timers.length !== 1 || timers[0].expiresAt <= timer2ExpiresAt) {
    throw new Error('Expected timer to be reset with a later expiration timestamp');
  }
  console.log('✅ [PASS] Timer reset upon receiving Query 3');

  // --- Step 5: Expire timer and execute response for all 3 collected queries ---
  console.log('\n--- Step 5: Expire Timer & Execute AI Response for Collected Queries ---');
  const activeTimer = timers[0];
  autoEngine.cancelAllPendingTimers('Expiring timer for test');

  await autoEngine.executeResponse(
    activeTimer.contactId,
    activeTimer.contactName,
    activeTimer.conversationId,
    activeTimer.pendingId,
    activeTimer.triggerType,
    '100000000001@lid'
  );

  if ((deliveredMessages as any).length !== 2) {
    throw new Error(`Expected 2 total delivered messages (1 wake + 1 multi-query reply), got ${deliveredMessages.length}`);
  }

  const multiReply = deliveredMessages[1];
  console.log(`\n✅ [PASS] Second response successfully delivered to ${multiReply.to}: "${multiReply.text}"`);

  // Cleanup
  testDb.close();
  try { fs.unlinkSync(testDbPath); } catch {}

  console.log('\n================================================================');
  console.log('🎉 ALL CONVERSATION FLOW TESTS PASSED 100%');
  console.log('================================================================\n');
}

runConversationFlowTest().catch((err) => {
  console.error('Fatal test failure:', err);
  process.exit(1);
});

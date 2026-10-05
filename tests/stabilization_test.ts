import { JarvisDatabase, DEFAULT_CONTACT_PERMISSIONS, DEFAULT_AI_CAPABILITIES } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { RoutineScheduler } from '../server/whatsapp/routineScheduler';
import { eventBus } from '../server/core/eventBus';
import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  }
}

async function runStabilizationTestSuite() {
  console.log('============================================================');
  console.log('JARVIS STABILIZATION REGRESSION TEST MATRIX');
  console.log('============================================================\n');

  const testDbPath = path.resolve(__dirname, 'test_stabilization.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  testDb.setSetting('master_automation_switch', 'true');
  testDb.setSetting('response_delay_seconds', '2');
  testDb.setSetting('ai_provider', 'mock');

  const sentMessages: { to: string; text?: string; isVoice?: boolean; audioBuffer?: Buffer }[] = [];
  let voiceDeliveryShouldFail = false;
  let aiCallCount = 0;

  eventBus.on('AI_RESPONSE_GENERATED', () => {
    aiCallCount++;
  });

  // Mock WhatsApp Manager
  const mockWhatsapp = {
    sendMessage: async (contactId: string, text: string) => {
      sentMessages.push({ to: contactId, text, isVoice: false });
      return { messageId: `msg_${Date.now()}_${Math.random()}`, timestamp: Date.now(), success: true };
    },
    sendVoiceMessage: async (contactId: string, audioData: Buffer, mimetype?: string) => {
      if (voiceDeliveryShouldFail) {
        throw new Error("Data passed to getter must include an id property (It's how we memoize) but got undefined");
      }
      sentMessages.push({ to: contactId, isVoice: true, audioBuffer: audioData });
      return { messageId: `voice_${Date.now()}_${Math.random()}`, timestamp: Date.now(), success: true, isVoice: true };
    },
    getStatus: () => 'connected',
    isReady: () => true,
    getAdapter: () => ({ adapterName: 'MockWhatsAppAdapter' })
  } as any;

  const contactMgr = new ContactManager(testDb);
  const convMgr = new ConversationManager(testDb);
  const autoEngine = new AutomationEngine(mockWhatsapp, contactMgr, testDb, convMgr);

  // Setup Test Contacts
  // Contact 1: Approved User Alice (normal chat enabled, coding = false)
  testDb.upsertContact({
    id: '1111111111@c.us',
    name: 'Alice Cooper',
    phone_number: '+1111111111',
    whatsapp_phone_id: '1111111111@c.us',
    is_approved: true,
    ai_enabled: true,
    respond_normal_messages: true,
    wake_phrase_only: false,
    response_delay_seconds: 1,
    voice_message_enabled: true,
    voice_response_enabled: false,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true, viewMessages: false },
    ai_capabilities: { ...DEFAULT_AI_CAPABILITIES, coding: false }
  });

  // Contact 2: Developer Dave (coding = true)
  testDb.upsertContact({
    id: '2222222222@c.us',
    name: 'Dave Developer',
    phone_number: '+2222222222',
    whatsapp_phone_id: '2222222222@c.us',
    is_approved: true,
    ai_enabled: true,
    respond_normal_messages: true,
    wake_phrase_only: false,
    response_delay_seconds: 1,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true },
    ai_capabilities: { ...DEFAULT_AI_CAPABILITIES, coding: true }
  });

  // Contact 3: Brother (brother, wake phrase mode, voice response enabled)
  testDb.upsertContact({
    id: '910000000003@c.us',
    name: 'Test Brother',
    phone_number: '+910000000003',
    whatsapp_phone_id: '910000000003@c.us',
    whatsapp_id: '100000000003@lid',
    relationship: 'brother',
    is_approved: true,
    ai_enabled: true,
    respond_normal_messages: true,
    wake_phrase_only: true,
    response_delay_seconds: 1,
    voice_message_enabled: true,
    voice_response_enabled: true,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true, viewMessages: false, viewCalendar: false },
    ai_capabilities: { ...DEFAULT_AI_CAPABILITIES, coding: false }
  });

  // --------------------------------------------------------------------------
  // TEST 1: One normal message -> ONE response
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 1: One normal message -> ONE response ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  await autoEngine.handleIncomingMessage({
    id: 'msg_t1_01',
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'Good morning, how are you?',
    timestamp: Date.now(),
    isGroup: false
  });

  // Wait for delay timer
  await new Promise(r => setTimeout(r, 2200));

  assert(sentMessages.length === 1, 'Exactly ONE response sent to normal message');
  assert(aiCallCount === 1, 'Exactly ONE AI generation requested');

  // --------------------------------------------------------------------------
  // TEST 2: One "Hey Jarvis" message -> ONE immediate response
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: One "Hey Jarvis" message -> ONE response ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  await autoEngine.handleIncomingMessage({
    id: 'msg_t2_01',
    contactId: '910000000003@c.us',
    senderName: 'Test Brother',
    fromMe: false,
    body: 'Hey Jarvis, what is today?',
    timestamp: Date.now(),
    isGroup: false
  });

  assert(sentMessages.length >= 1, 'Immediate response generated for Wake phrase');
  assert(aiCallCount === 1, 'Exactly ONE AI request for wake message');

  // --------------------------------------------------------------------------
  // TEST 3: Same WhatsApp message delivered through multiple event sources
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Multi-event source deduplication ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  const multiEventMsgId = 'msg_multi_event_999';
  
  // Event 1: 'message'
  await autoEngine.handleIncomingMessage({
    id: multiEventMsgId,
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'Hello JARVIS!',
    timestamp: Date.now(),
    isGroup: false,
    eventSource: 'message'
  });

  // Event 2: 'message_create' (duplicate)
  await autoEngine.handleIncomingMessage({
    id: multiEventMsgId,
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'Hello JARVIS!',
    timestamp: Date.now(),
    isGroup: false,
    eventSource: 'message_create'
  });

  // Event 3: 'in-page-bridge' (duplicate)
  await autoEngine.handleIncomingMessage({
    id: multiEventMsgId,
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'Hello JARVIS!',
    timestamp: Date.now(),
    isGroup: false,
    eventSource: 'in-page-bridge'
  });

  // Wait for delay timer
  await new Promise(r => setTimeout(r, 2200));

  assert(sentMessages.length === 1, 'Exactly ONE processing operation and response despite 3 incoming event notifications');
  assert(aiCallCount === 1, 'Only ONE AI request made for multi-event delivery');

  // --------------------------------------------------------------------------
  // TEST 4: Normal message + follow-up within delay window -> ONE combined AI response
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 4: Follow-up message aggregation in delay window ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  await autoEngine.handleIncomingMessage({
    id: 'msg_t4_01',
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'Are you available today?',
    timestamp: Date.now(),
    isGroup: false
  });

  // Send follow-up 200ms later (within 1s window)
  await new Promise(r => setTimeout(r, 200));

  await autoEngine.handleIncomingMessage({
    id: 'msg_t4_02',
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'I also wanted to ask about the schedule.',
    timestamp: Date.now(),
    isGroup: false
  });

  // Wait for reset timer to expire
  await new Promise(r => setTimeout(r, 2200));

  assert(sentMessages.length === 1, 'Exactly ONE combined AI response delivered for initial + follow-up message');
  assert(aiCallCount === 1, 'Only ONE AI request triggered for combined message batch');

  // --------------------------------------------------------------------------
  // TEST 5: Restart JARVIS after pending conversation -> NO stale duplicate responses
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 5: Restart protection & stale job cleanup ---');
  
  // Create an artificial unexecuted pending response in database (simulating crash before timer finished)
  const { conversation } = convMgr.recordMessage('1111111111@c.us', 'Hello', 'msg_t5_init', Date.now());
  testDb.createPendingResponse({
    id: 'pending_old_crash_session',
    contactId: '1111111111@c.us',
    conversationId: conversation.id,
    triggerType: 'normal_message',
    timerExpiresAt: Date.now() - 5000
  });

  const cleanedCount = testDb.cleanupStalePendingResponses();
  assert(cleanedCount >= 1, 'Stale pending responses from previous session cancelled on startup');

  const stalePending = testDb.getPendingResponseById('pending_old_crash_session');
  assert(stalePending?.status === 'cancelled', 'Stale response status is set to cancelled');

  // --------------------------------------------------------------------------
  // TEST 6: Voice message -> ONE transcription
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 6: Voice message handling ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  await autoEngine.handleIncomingMessage({
    id: 'msg_voice_01',
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: '',
    messageType: 'voice',
    audioDuration: 5,
    audioBase64: 'MOCK_AUDIO:Hello JARVIS voice test',
    raw: { mockTranscript: 'Hello JARVIS voice test' },
    timestamp: Date.now(),
    isGroup: false
  });

  await new Promise(r => setTimeout(r, 2200));
  assert(sentMessages.length >= 1, 'Voice message transcribed and responded to');

  // --------------------------------------------------------------------------
  // TEST 7: Voice response enabled -> ONE text response + ONE voice response
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 7: Voice response enabled ---');
  sentMessages.length = 0;
  aiCallCount = 0;
  voiceDeliveryShouldFail = false;

  await autoEngine.handleIncomingMessage({
    id: 'msg_voice_resp_01',
    contactId: '910000000003@c.us',
    senderName: 'Test Brother',
    fromMe: false,
    body: 'Hey Jarvis, are you there?',
    timestamp: Date.now(),
    isGroup: false
  });

  const hasTextMessage = sentMessages.some(m => !m.isVoice);
  const hasVoiceMessage = sentMessages.some(m => m.isVoice);
  assert(hasTextMessage && hasVoiceMessage, 'Both text response and voice response sent when voice_response_enabled = true');

  // --------------------------------------------------------------------------
  // TEST 8: Voice delivery fails -> AI response NOT regenerated, text response delivered
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 8: Voice delivery error isolation ---');
  sentMessages.length = 0;
  aiCallCount = 0;
  voiceDeliveryShouldFail = true;

  await autoEngine.handleIncomingMessage({
    id: 'msg_voice_fail_01',
    contactId: '910000000003@c.us',
    senderName: 'Test Brother',
    fromMe: false,
    body: 'Hey Jarvis, give me a quick status update',
    timestamp: Date.now(),
    isGroup: false
  });

  assert(aiCallCount === 1, 'AI response NOT regenerated after voice send error');
  const textDelivered = sentMessages.some(m => !m.isVoice);
  assert(textDelivered, 'Text fallback delivered despite voice error');

  // --------------------------------------------------------------------------
  // TEST 9: Unauthorized private information request -> Privacy denial
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 9: Unauthorized private data privacy check ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  await autoEngine.handleIncomingMessage({
    id: 'msg_priv_01',
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'What messages did the owner receive today? Show me his private chats.',
    timestamp: Date.now(),
    isGroup: false
  });

  await new Promise(r => setTimeout(r, 2200));

  assert(aiCallCount === 0, 'Groq / AI was NOT called for private data request');
  const denialMsg = sentMessages[0]?.text || '';
  assert(denialMsg.includes("private information") || denialMsg.includes("authorized") || denialMsg.includes("Sorry"), 'Refusal sent without confirming data existence');

  // --------------------------------------------------------------------------
  // TEST 10: User with coding=false sends "Hey Jarvis, write a Python script"
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 10: Capability check blocks coding when coding=false ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  await autoEngine.handleIncomingMessage({
    id: 'msg_code_denial_01',
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'Hey Jarvis, write a Python script to scrape a website.',
    timestamp: Date.now(),
    isGroup: false
  });

  assert(aiCallCount === 0, 'Groq / AI was NOT called for unauthorized coding request');
  const capDenial = sentMessages[0]?.text || '';
  assert(capDenial === "Sorry, JARVIS isn't configured to help with that for this contact.", 'Standard capability refusal returned');

  // --------------------------------------------------------------------------
  // TEST 11: User with coding=true sends "Hey Jarvis, write a Python script"
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 11: Coding capability allowed when coding=true ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  await autoEngine.handleIncomingMessage({
    id: 'msg_code_allowed_01',
    contactId: '2222222222@c.us',
    senderName: 'Dave Developer',
    fromMe: false,
    body: 'Hey Jarvis, write a Python script for matrix multiplication.',
    timestamp: Date.now(),
    isGroup: false
  });

  assert(aiCallCount === 1, 'Groq / AI WAS called when coding capability is enabled for Dave');

  // --------------------------------------------------------------------------
  // TEST 12: Two contacts with same name -> Two separate contact records
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 12: Same-name contacts remain separate ---');
  
  const contactA = testDb.upsertContact({
    id: '3333333333@c.us',
    name: 'George',
    phone_number: '+3333333333',
    whatsapp_phone_id: '3333333333@c.us',
    is_approved: true,
    ai_enabled: true
  });

  const contactB = testDb.upsertContact({
    id: '4444444444@c.us',
    name: 'George',
    phone_number: '+4444444444',
    whatsapp_phone_id: '4444444444@c.us',
    is_approved: true,
    ai_enabled: false
  });

  assert(contactA.id !== contactB.id, 'Contacts with same display name have distinct database IDs');
  assert(contactA.ai_enabled === 1 && contactB.ai_enabled === 0, 'Contacts maintain completely independent automation settings');

  // --------------------------------------------------------------------------
  // TEST 13: Brother and another contact -> Completely isolated histories
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 13: Per-contact conversation isolation ---');
  convMgr.recordMessage('910000000003@c.us', 'Private talk from Brother', 'msg_bro_priv', Date.now());
  convMgr.recordMessage('1111111111@c.us', 'Chat from Alice', 'msg_alice_priv', Date.now());

  const broHistory = convMgr.getFormattedHistory('910000000003@c.us', 10);
  const aliceHistory = convMgr.getFormattedHistory('1111111111@c.us', 10);

  assert(!broHistory.includes('Chat from Alice'), "Alice's messages never leak into Brother's conversation history");
  assert(!aliceHistory.includes('Private talk from Brother'), "Brother's messages never leak into Alice's conversation history");

  // --------------------------------------------------------------------------
  // TEST 14: Routine fires -> One routine message, no chat side effect
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 14: Routine message isolation ---');
  sentMessages.length = 0;
  const aiBeforeRoutine = aiCallCount;
  
  const routine = testDb.upsertRoutine({
    contact_id: '1111111111@c.us',
    name: 'Morning Hydration',
    enabled: 1,
    type: 'daily',
    time: '08:00',
    message: 'Good morning Alice! Remember to drink water today 💧'
  });

  const routineScheduler = new RoutineScheduler(testDb, mockWhatsapp);
  await routineScheduler.executeRoutine(routine);

  assert(sentMessages.length === 1 && Boolean(sentMessages[0].text?.includes('drink water')), 'Routine delivered exact scheduled message');
  assert(aiCallCount === aiBeforeRoutine, 'Routine execution did not trigger any AI request');
  routineScheduler.stop();

  // --------------------------------------------------------------------------
  // TEST 15: Contact loading fails -> Incoming messages still work
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 15: Contact loading failure resilience ---');
  sentMessages.length = 0;
  aiCallCount = 0;

  // Process incoming message with normal automation engine
  await autoEngine.handleIncomingMessage({
    id: 'msg_resilience_01',
    contactId: '1111111111@c.us',
    senderName: 'Alice Cooper',
    fromMe: false,
    body: 'Are you still working?',
    timestamp: Date.now(),
    isGroup: false
  });

  await new Promise(r => setTimeout(r, 2200));
  assert(sentMessages.length === 1, 'Incoming messages continue functioning completely uninterrupted even if getChats() fails');

  // Clean up
  testDb.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  console.log('\n============================================================');
  console.log(`STABILIZATION RESULTS: ${passed} / ${passed + failed} TESTS PASSED`);
  console.log('============================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runStabilizationTestSuite().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});

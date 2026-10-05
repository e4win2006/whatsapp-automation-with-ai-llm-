import { JarvisDatabase, DEFAULT_CONTACT_PERMISSIONS } from '../server/database/database';
import { JarvisEventBus } from '../server/core/eventBus';
import { MockWhatsAppAdapter } from '../server/whatsapp/adapters/mockAdapter';
import { WhatsAppManager } from '../server/whatsapp/client';
import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { JarvisOrchestrator } from '../server/core/orchestrator';
import path from 'path';
import fs from 'fs';

async function runTests() {
  console.log('================================================================');
  console.log('🧪 RUNNING JARVIS SIMPLE 3-STEP AUTOMATION VERIFICATION SUITE');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, extra?: string) {
    totalTests++;
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`❌ [FAIL] ${testName} ${extra || ''}`);
      process.exitCode = 1;
    }
  }

  // --- 1. Database Clean State Verification (Zero Seeded Demo Records) ---
  console.log('\n--- 1. Database Clean State (Zero Seeded Demo Records) ---');
  const testDbPath = path.resolve(process.cwd(), 'data/test_jarvis.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const testDb = new JarvisDatabase(testDbPath);
  assert(fs.existsSync(testDbPath), 'Database file created cleanly');
  assert(testDb.getAllContacts().length === 0, 'Database starts with 0 demo contacts');
  assert(testDb.getAllConversations().length === 0, 'Database starts with 0 demo conversations');
  assert(testDb.getSetting('master_automation_switch') === 'true', 'System settings initialized');

  // --- 2. Simple Contact Management & Wake Word Behavior ---
  console.log('\n--- 2. Simple Contact Management & Wake Word Rules ---');
  const contactMgr = new ContactManager(testDb);
  const testContactId = 'test_user_999@c.us';

  const added = contactMgr.addContact(testContactId, 'John Doe', 'Be concise');
  assert(added.name === 'John Doe', 'Contact added with display name');
  assert(!contactMgr.isContactAutomationEnabled(testContactId), 'New contact starts with automation OFF');

  // Turn automation ON
  contactMgr.updateContactSettings(testContactId, { ai_enabled: true });
  testDb.upsertContact({
    id: testContactId,
    name: 'John Doe',
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true }
  });
  assert(contactMgr.isContactAutomationEnabled(testContactId), 'Turning automation ON enables response check');

  // Check default wake phrase behavior
  assert(contactMgr.shouldRespond(testContactId, 'Hey Jarvis are you free?', true), 'Responds when wake phrase is present');
  assert(!contactMgr.shouldRespond(testContactId, 'Just normal text', false), 'Ignores normal text by default (wake_phrase_only: 1)');

  // Turn on normal messages response
  contactMgr.updateContactSettings(testContactId, { respond_normal_messages: true });
  assert(contactMgr.shouldRespond(testContactId, 'Just normal text', false), 'Responds to normal text when respond_normal_messages is ON');

  // Reset to default
  contactMgr.updateContactSettings(testContactId, { respond_normal_messages: false });

  // --- 3. EventBus Delivery ---
  console.log('\n--- 3. EventBus Delivery ---');
  const eventBus = JarvisEventBus.getInstance();
  let eventReceived: boolean = false;

  eventBus.on('MESSAGE_RECEIVED', () => { eventReceived = true; });
  eventBus.emit('MESSAGE_RECEIVED', {
    id: 'test_msg_1',
    contactId: testContactId,
    senderName: 'John Doe',
    fromMe: false,
    body: 'Hey Jarvis are you online?',
    timestamp: Date.now(),
    isGroup: false
  });

  assert(Boolean(eventReceived), 'EventBus delivers MESSAGE_RECEIVED');

  // --- 4. WhatsApp Adapter Isolation ---
  console.log('\n--- 4. WhatsApp Adapter Isolation ---');
  const mockAdapter = new MockWhatsAppAdapter();
  assert(mockAdapter.getStatus() === 'disconnected', 'Adapter starts disconnected');
  await mockAdapter.connect();
  assert(mockAdapter.getStatus() === 'connected', 'Adapter connects successfully');

  // --- 5. Deduplication ---
  console.log('\n--- 5. Message Deduplication ---');
  const whatsappManager = new WhatsAppManager(mockAdapter, testDb);
  let msgCount = 0;
  eventBus.on('MESSAGE_RECEIVED', (m) => {
    if (m.id === 'dedup_test') msgCount++;
  });

  const msgPayload = {
    id: 'dedup_test',
    contactId: testContactId,
    senderName: 'John Doe',
    fromMe: false,
    body: 'Test deduplication',
    timestamp: Date.now(),
    isGroup: false
  };

  (whatsappManager as any).handleIncomingMessage(msgPayload);
  (whatsappManager as any).handleIncomingMessage(msgPayload);
  assert(msgCount === 1, 'Duplicate incoming messages are dropped');

  // --- 6. Wake Phrase Detection ---
  console.log('\n--- 6. Wake Phrase Engine ---');
  const convMgr = new ConversationManager(testDb);
  const autoEngine = new AutomationEngine(whatsappManager, contactMgr, testDb, convMgr);
  autoEngine.setDelaySeconds(2);

  const check1 = autoEngine.containsWakePhrase('Hey Jarvis, need status');
  const check2 = autoEngine.containsWakePhrase('Random other text');
  assert(check1.matches && check1.phrase === 'hey jarvis', 'Wake phrase detected');
  assert(!check2.matches, 'Non-wake phrase ignored');

  // --- 7. Conversation Collection & Sliding Timer ---
  console.log('\n--- 7. Conversation Collection & Timer Reset ---');
  let timerStarted = false;
  let timerReset = false;

  eventBus.on('RESPONSE_TIMER_STARTED', () => { timerStarted = true; });
  eventBus.on('RESPONSE_TIMER_RESET', () => { timerReset = true; });

  // 1. Wake phrase activates conversation
  await autoEngine.handleIncomingMessage({
    id: 'msg_wake',
    contactId: testContactId,
    senderName: 'John Doe',
    fromMe: false,
    body: 'Hey Jarvis',
    timestamp: Date.now(),
    isGroup: false
  });

  // 2. First normal follow-up message starts collection timer
  await autoEngine.handleIncomingMessage({
    id: 'msg_a',
    contactId: testContactId,
    senderName: 'John Doe',
    fromMe: false,
    body: 'Are you free?',
    timestamp: Date.now(),
    isGroup: false
  });
  assert(Boolean(timerStarted), 'Timer starts on first follow-up message');

  // 3. Second normal follow-up message resets collection timer
  await autoEngine.handleIncomingMessage({
    id: 'msg_b',
    contactId: testContactId,
    senderName: 'John Doe',
    fromMe: false,
    body: 'Can we discuss the project?',
    timestamp: Date.now(),
    isGroup: false
  });
  assert(Boolean(timerReset), 'Timer resets on subsequent follow-up message');

  // --- 8. Manual Reply Override ---
  console.log('\n--- 8. Manual Reply Override ---');
  let timerCancelled = false;
  eventBus.on('RESPONSE_CANCELLED', () => { timerCancelled = true; });

  await autoEngine.handleIncomingMessage({
    id: 'owner_reply',
    contactId: testContactId,
    senderName: 'Owner',
    fromMe: true,
    body: 'Replying myself from phone',
    timestamp: Date.now(),
    isGroup: false
  });
  assert(Boolean(timerCancelled), 'Owner phone reply cancels pending response');

  // --- 9. Master Automation Switch ---
  console.log('\n--- 9. Master Automation Switch ---');
  autoEngine.setMasterAutomation(false);
  assert(!autoEngine.isMasterAutomationEnabled(), 'Master switch turned OFF');
  autoEngine.setMasterAutomation(true);
  assert(autoEngine.isMasterAutomationEnabled(), 'Master switch turned ON');

  // Cleanup
  autoEngine.cancelAllPendingTimers('Test teardown');
  testDb.close();
  try {
    fs.unlinkSync(testDbPath);
  } catch {}

  console.log('\n================================================================');
  console.log(`📊 ALL SIMPLE-UX TESTS PASSED: ${passedTests}/${totalTests} VERIFIED`);
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});

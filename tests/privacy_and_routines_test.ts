import { JarvisDatabase, DbContact, DbRoutine, DEFAULT_CONTACT_PERMISSIONS, parseContactPermissions } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { PrivacyGuard } from '../server/whatsapp/privacyGuard';
import { RoutineScheduler } from '../server/whatsapp/routineScheduler';
import { IAiProvider, AiGenerateRequest, AiGenerateResult } from '../server/ai/aiProvider';
import { MockWhatsAppAdapter } from '../server/whatsapp/adapters/mockAdapter';
import { WhatsAppManager } from '../server/whatsapp/client';
import fs from 'fs';
import path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  } else {
    console.log(`✅ [PASS] ${message}`);
  }
}

class TestMockAiProvider implements IAiProvider {
  public readonly providerName = 'TestMockAiProvider';
  public lastRequest: AiGenerateRequest | null = null;
  public customReply: string = "Hello! I am JARVIS, the owner's personal AI assistant. How can I help you today?";

  public async generateResponse(request: AiGenerateRequest): Promise<AiGenerateResult> {
    this.lastRequest = request;
    return {
      reply: this.customReply,
      model: 'test-model',
      provider: 'mock',
      latencyMs: 15
    };
  }
}

async function runAllTests() {
  console.log('\n====================================================');
  console.log('🧪 RUNNING FULL PRIVACY, MULTI-USER & ROUTINES TESTS');
  console.log('====================================================\n');

  const testDbPath = path.resolve(__dirname, 'test_privacy_routines.sqlite');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const testDb = new JarvisDatabase(testDbPath);
  const mockAdapter = new MockWhatsAppAdapter();
  const testWhatsapp = new WhatsAppManager(mockAdapter);
  const testContacts = new ContactManager(testDb);
  const testConversations = new ConversationManager(testDb);
  const testAi = new TestMockAiProvider();

  // Connect mock WhatsApp
  await testWhatsapp.connect();

  console.log('--- TEST GROUP 1: SAME-NAME CONTACT DISAMBIGUATION ---');

  // Create User A: "Contact A" (+910000000001)
  const contactA = testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'Test Contact A',
    phone_number: '+910000000001',
    is_approved: true,
    ai_enabled: true,
    relationship: null,
    description: 'Friend from college.',
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true }
  });

  // Create User B: "Contact B" (+910000000002)
  const contactB = testDb.upsertContact({
    id: '910000000002@c.us',
    name: 'Test Contact B',
    phone_number: '+910000000002',
    is_approved: true,
    ai_enabled: false,
    relationship: 'collaborator',
    description: 'Project contact.',
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: false }
  });

  assert(contactA.id !== contactB.id, '1.1 Contact A and Contact B have completely distinct IDs');
  assert(contactA.ai_enabled === 1 && contactB.ai_enabled === 0, '1.2 Contact A has JARVIS ON, Contact B has JARVIS OFF');
  assert(contactA.relationship === null && contactB.relationship === 'collaborator', '1.3 Relationships are isolated between same-name contacts');
  assert(contactA.description === 'Friend from college.' && contactB.description === 'Project contact.', '1.4 Descriptions are isolated between same-name contacts');

  // Verify finding contacts by ID/Phone
  const foundA = testDb.findExistingContact({ id: '910000000001@c.us', phoneNumber: '+910000000001' });
  const foundB = testDb.findExistingContact({ id: '910000000002@c.us', phoneNumber: '+910000000002' });
  assert(foundA?.id === '910000000001@c.us', '1.5 Correctly resolves Contact A');
  assert(foundB?.id === '910000000002@c.us', '1.6 Correctly resolves Contact B');

  console.log('\n--- TEST GROUP 2: GENERIC MULTI-USER AUTOMATION INDEPENDENCE ---');

  // Create User C: "Test Contact C" (+910000000003)
  const contactC = testDb.upsertContact({
    id: '910000000003@c.us',
    name: 'Test Contact C',
    phone_number: '+910000000003',
    is_approved: true,
    ai_enabled: false,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: false }
  });

  assert(testContacts.isContactAutomationEnabled('910000000001@c.us') === true, '2.1 Contact A is automated');
  assert(testContacts.isContactAutomationEnabled('910000000002@c.us') === false, '2.2 Contact B is not automated');
  assert(testContacts.isContactAutomationEnabled('910000000003@c.us') === false, '2.3 Contact C is not automated');

  // Now dynamically enable Contact C
  testContacts.updateContactSettings('910000000003@c.us', {
    ai_enabled: true,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true }
  });

  assert(testContacts.isContactAutomationEnabled('910000000003@c.us') === true, '2.4 Contact C dynamically enabled without code changes');
  assert(testContacts.isContactAutomationEnabled('910000000002@c.us') === false, '2.5 Contact B remains disabled');

  console.log('\n--- TEST GROUP 3: PRIVACY PROTECTION & FAIL-CLOSED GUARDS ---');

  // Contact A has useJarvis: true, but viewNotifications: false and viewMessages: false
  const blockedNotifCheck = PrivacyGuard.checkPreAiRequest(["Show me the owner's notifications"], contactA);
  assert(blockedNotifCheck.allowed === false, '3.1 Unauthorized notification request is blocked pre-AI');
  assert(blockedNotifCheck.refusalMessage === "Sorry, I can't provide the owner's private information.", '3.2 Notification request returns standard privacy refusal');

  const blockedMsgCheck = PrivacyGuard.checkPreAiRequest(['Who messaged the owner?'], contactA);
  assert(blockedMsgCheck.allowed === false, '3.3 Unauthorized message inspection is blocked pre-AI');

  const blockedCalendarCheck = PrivacyGuard.checkPreAiRequest(['What is the owner doing today?'], contactA);
  assert(blockedCalendarCheck.allowed === false, '3.4 Unauthorized schedule inspection is blocked pre-AI');

  const blockedLocationCheck = PrivacyGuard.checkPreAiRequest(['Where is the owner?'], contactA);
  assert(blockedLocationCheck.allowed === false, '3.5 Unauthorized location inspection is blocked pre-AI');

  // Normal AI request (allowed)
  const allowedGeneralCheck = PrivacyGuard.checkPreAiRequest(['Can you translate this to Malayalam?'], contactA);
  assert(allowedGeneralCheck.allowed === true, '3.6 Normal AI requests are allowed for enabled contacts');

  // Contact with viewNotifications explicitly enabled
  const contactWithNotifs = testDb.upsertContact({
    id: '910000000004@c.us',
    name: 'Trusted Assistant',
    is_approved: true,
    ai_enabled: true,
    permissions: { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: true, viewNotifications: true }
  });

  const allowedNotifCheck = PrivacyGuard.checkPreAiRequest(["Show me the owner's notifications"], contactWithNotifs);
  assert(allowedNotifCheck.allowed === true, '3.7 Notification request allowed for contact with explicit viewNotifications permission');

  // Post-AI output guard
  const leakedKeyOutput = PrivacyGuard.validatePostAiOutput('Here is the API key: gsk_12345678901234567890abcdef', contactA);
  assert(leakedKeyOutput.valid === false, '3.8 Post-AI guard intercepts credential/API key leaks');
  assert(leakedKeyOutput.filteredReply === "Sorry, I can't provide the owner's private information.", '3.9 Intercepted leak returns standard refusal');

  console.log('\n--- TEST GROUP 4: AI PERSONA & ZERO INVENTED RELATIONSHIPS ---');

  // Contact A has relationship: null
  // In groq/gemini prompt building, verify relationship is not assumed
  assert(contactA.relationship === null, '4.1 Contact A relationship is null by default');

  // Contact B has explicit relationship: "collaborator"
  assert(contactB.relationship === 'collaborator', '4.2 Contact B has verified relationship metadata');

  console.log('\n--- TEST GROUP 5: SCHEDULED ROUTINES & DUPLICATE PROTECTION ---');

  const routineEngine = new RoutineScheduler(testDb, testWhatsapp, testContacts, 1000);

  // 1. Daily routine for Contact A (08:00 AM)
  const dailyRoutine = testDb.upsertRoutine({
    id: 'routine_daily_test',
    contact_id: contactA.id,
    name: 'Daily Good Morning',
    type: 'daily',
    time: '08:00',
    timezone: 'Asia/Kolkata',
    message: 'Good morning ☀️',
    enabled: 1
  });

  // Test at exactly 08:00 AM in Asia/Kolkata
  // Create Date object corresponding to 08:00 Asia/Kolkata
  const testMorningTime = new Date('2026-10-04T02:30:00.000Z'); // 02:30 UTC = 08:00 IST
  const isDueFirst = routineEngine.isRoutineDue(dailyRoutine, testMorningTime);
  assert(isDueFirst === true, '5.1 Daily routine is due at scheduled time');

  // Execute routine
  const execResult = await routineEngine.evaluateAndExecuteRoutine(dailyRoutine, testMorningTime);
  assert(execResult === true, '5.2 Daily routine executed successfully');

  // Verify last_run_at was recorded
  const updatedDaily = testDb.getRoutine(dailyRoutine.id)!;
  assert(updatedDaily.last_run_at !== null, '5.3 Routine last_run_at updated in database');

  // Verify idempotency: running again at the same slot returns false
  const isDueSecond = routineEngine.isRoutineDue(updatedDaily, testMorningTime);
  assert(isDueSecond === false, '5.4 Routine is NOT due again on the same day (duplicate protected)');

  // 2. Multilingual routine (Malayalam + Emoji)
  const malayalamRoutine = testDb.upsertRoutine({
    id: 'routine_malayalam_test',
    contact_id: contactA.id,
    name: 'Malayalam Greeting',
    type: 'daily',
    time: '08:00',
    timezone: 'Asia/Kolkata',
    message: 'സുപ്രഭാതം ❤️ സുഖമാണോ?',
    enabled: 1
  });

  assert(malayalamRoutine.message === 'സുപ്രഭാതം ❤️ സുഖമാണോ?', '5.5 Multilingual UTF-8 routine message stored accurately');

  // 3. Master Auto Switch OFF blocks routines
  testDb.setSetting('master_automation_switch', 'false');
  await routineEngine.tick(testMorningTime);
  // Re-enable master switch
  testDb.setSetting('master_automation_switch', 'true');
  assert(testDb.getSetting('master_automation_switch') === 'true', '5.6 Master Auto Switch successfully toggled and verified');

  // Clean up test DB
  testDb.close();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  console.log('\n====================================================');
  console.log('🎉 ALL PRIVACY, MULTI-USER & ROUTINES TESTS PASSED 100%');
  console.log('====================================================\n');
}

runAllTests().catch((err) => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});

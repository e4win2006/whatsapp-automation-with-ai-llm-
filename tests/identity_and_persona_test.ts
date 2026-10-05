import { JarvisDatabase } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { DEFAULT_JARVIS_SYSTEM_PROMPT } from '../server/ai/aiProvider';
import fs from 'fs';
import path from 'path';

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING COMPREHENSIVE IDENTITY & PERSONA TEST SUITE');
  console.log('====================================================\n');

  const testDbPath = path.resolve(__dirname, '../data/test_identity_persona.db');
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  const testDb = new JarvisDatabase(testDbPath);
  const contactMgr = new ContactManager(testDb);
  const convMgr = new ConversationManager(testDb);

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string) {
    if (condition) {
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${name}`);
      failed++;
    }
  }

  // --- TEST 1: Two users with different phone IDs and different names ---
  console.log('\n--- TEST 1: Two users with different phone IDs ---');
  const userA = testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'Test Contact A',
    phone_number: '+910000000001',
    whatsapp_id: '100000000001@lid',
    whatsapp_phone_id: '910000000001@c.us',
    is_approved: true,
    ai_enabled: true
  });

  const userB = testDb.upsertContact({
    id: '910000000002@c.us',
    name: 'Test Contact B',
    phone_number: '+910000000002',
    whatsapp_id: '100000000002@lid',
    whatsapp_phone_id: '910000000002@c.us',
    is_approved: false,
    ai_enabled: false
  });

  assert(userA.id !== userB.id, 'User A and User B have separate IDs');
  assert(userA.phone_number !== userB.phone_number, 'User A and User B have separate phone numbers');
  assert(testDb.getAllContacts().length === 2, 'Database contains 2 distinct contacts');

  // --- TEST 2: Two users with the EXACT SAME DISPLAY NAME ---
  console.log('\n--- TEST 2: Two users with EXACT SAME NAME ("Test Contact B") ---');
  const sameNameContact2 = testDb.upsertContact({
    id: '910000000003@c.us',
    name: 'Test Contact B',
    phone_number: '+910000000003',
    whatsapp_phone_id: '910000000003@c.us',
    is_approved: true,
    ai_enabled: true
  });

  const allContacts = testDb.getAllContacts();
  assert(allContacts.length === 3, 'Database now contains 3 contacts (2 separate same-name contacts)');
  const sameNameContact1 = testDb.getContact('910000000002@c.us')!;
  assert(sameNameContact1.id !== sameNameContact2.id, 'Same-name contacts have separate internal IDs');
  assert(sameNameContact1.ai_enabled === 0 && sameNameContact2.ai_enabled === 1, 'Same-name contacts have independent automation settings');

  // --- TEST 3: Same pushname lookup does not merge ---
  console.log('\n--- TEST 3: Same pushname / alias lookup does not cross-merge ---');
  const resolved1 = contactMgr.resolveApprovedContact({
    contactId: '910000000002@c.us',
    senderName: 'Test Contact B',
    whatsappPhoneId: '910000000002@c.us'
  });
  const resolved2 = contactMgr.resolveApprovedContact({
    contactId: '910000000003@c.us',
    senderName: 'Test Contact B',
    whatsappPhoneId: '910000000003@c.us'
  });
  assert(resolved1?.id === '910000000002@c.us', 'Resolved Contact 1 is Contact B #1');
  assert(resolved2?.id === '910000000003@c.us', 'Resolved Contact 2 is Contact B #2');
  assert(resolved1?.id !== resolved2?.id, 'Resolvers do not conflate identical names');

  // --- TEST 4: LID + Phone ID for the SAME person resolves to ONE contact ---
  console.log('\n--- TEST 4: LID + Phone ID for the same user resolves to ONE contact ---');
  const resolvedByLid = contactMgr.resolveApprovedContact({
    contactId: '100000000001@lid',
    senderName: 'Alias User A',
    whatsappPhoneId: '910000000001@c.us'
  });
  assert(resolvedByLid?.id === '910000000001@c.us', 'LID 100000000001@lid resolved to 910000000001@c.us');
  assert(testDb.getAllContacts().length === 3, 'No spurious duplicate contact created for same user');

  // --- TEST 5: Different LIDs resolve to different phone IDs ---
  console.log('\n--- TEST 5: Different LIDs resolve to different phone IDs ---');
  testDb.saveLidMapping('100000000001@lid', '910000000001@c.us', '+910000000001');
  testDb.saveLidMapping('100000000002@lid', '910000000002@c.us', '+910000000002');
  const lidA = testDb.getLidMapping('100000000001@lid');
  const lidB = testDb.getLidMapping('100000000002@lid');
  assert(lidA?.whatsapp_phone_id === '910000000001@c.us', 'LID A maps to 910000000001@c.us');
  assert(lidB?.whatsapp_phone_id === '910000000002@c.us', 'LID B maps to 910000000002@c.us');
  assert(lidA?.whatsapp_phone_id !== lidB?.whatsapp_phone_id, 'LID mappings remain strictly distinct');

  // --- TEST 6: Independent automation check ---
  console.log('\n--- TEST 6: Independent Automation Setting Check ---');
  const auto1 = contactMgr.isContactAutomationEnabled('910000000002@c.us');
  const auto2 = contactMgr.isContactAutomationEnabled('910000000003@c.us');
  assert(auto1 === false, 'Contact B #1 automation is OFF');
  assert(auto2 === true, 'Contact B #2 automation is ON');

  // --- TEST 7: Independent Conversation State & History ---
  console.log('\n--- TEST 7: Conversation state isolation ---');
  convMgr.recordMessage('910000000002@c.us', 'Oii from Contact B 1', 'msg_c1_1');
  convMgr.recordMessage('910000000003@c.us', 'Hello from Contact B 2', 'msg_c2_1');

  const history1 = convMgr.getFormattedHistory('910000000002@c.us');
  const history2 = convMgr.getFormattedHistory('910000000003@c.us');
  assert(history1.includes('Oii from Contact B 1'), 'History 1 contains Contact B 1 message');
  assert(!history1.includes('Hello from Contact B 2'), 'History 1 does NOT leak Contact B 2 message');
  assert(history2.includes('Hello from Contact B 2'), 'History 2 contains Contact B 2 message');
  assert(!history2.includes('Oii from Contact B 1'), 'History 2 does NOT leak Contact B 1 message');

  // --- TEST 8: Account Owner (You) alias protection ---
  console.log('\n--- TEST 8: Account Owner protection ---');
  testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'Test Contact A',
    alternate_names: ['Alias A', 'Account Owner (You)', 'You', 'Primary Contact']
  });
  const updatedUserA = testDb.getContact('910000000001@c.us')!;
  const alts = JSON.parse(updatedUserA.alternate_names || '[]');
  assert(!alts.includes('Account Owner (You)'), 'Account Owner (You) filtered from alternate names');
  assert(!alts.includes('You'), '"You" filtered from alternate names');
  assert(alts.includes('Alias A') && alts.includes('Primary Contact'), 'Legitimate aliases preserved');

  // --- TEST 9: AI System Prompt persona integrity ---
  console.log('\n--- TEST 9: AI System Prompt persona integrity ---');
  assert((DEFAULT_JARVIS_SYSTEM_PROMPT.includes("relationship to the account owner") || DEFAULT_JARVIS_SYSTEM_PROMPT.includes("relationship")) && DEFAULT_JARVIS_SYSTEM_PROMPT.includes("Never assume"), 'System prompt strictly forbids assuming relationships');
  assert(!DEFAULT_JARVIS_SYSTEM_PROMPT.toLowerCase().includes('hey dad i am edwins ai'), 'System prompt contains no hardcoded "hey dad" introductions');

  // --- TEST 10: Database Migration & Repair of Corrupted Records ---
  console.log('\n--- TEST 10: Database Migration & Repair ---');
  // Inject a simulated corrupted prompt
  testDb['db'].prepare(`
    UPDATE contacts SET
      custom_system_prompt = 'hey this i s my mom so start with hey dad i am edwins ai'
    WHERE id = '910000000001@c.us'
  `).run();

  // Run repair
  testDb.migrateAndCleanIdentities();

  const repairedUserA = testDb.getContact('910000000001@c.us')!;
  assert(repairedUserA.custom_system_prompt === null, 'Corrupt prompt removed from User A');

  // Clean up
  testDb.close();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }

  console.log('\n====================================================');
  console.log(`🏁 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});

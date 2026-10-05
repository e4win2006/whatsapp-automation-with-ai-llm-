import { JarvisDatabase } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { normalizePhoneNumber } from '../server/utils/phoneUtils';
import path from 'path';
import fs from 'fs';

async function runIdentityInvariantsTests() {
  console.log('================================================================');
  console.log('🧪 VERIFYING CONTACT IDENTITY INVARIANTS & MERGE INTEGRITY');
  console.log('================================================================\n');

  const testDbPath = path.resolve(process.cwd(), 'data/test_identity_invariants.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  const contactMgr = new ContactManager(testDb);

  try {
    // -------------------------------------------------------------
    // Test 1: 910000000001@c.us and 100000000001@c.us DO NOT MERGE
    // -------------------------------------------------------------
    console.log('--- Test 1: Different Canonical Phone IDs (910000000001@c.us vs 100000000001@c.us) ---');
    testDb.upsertContact({
      id: '100000000001@c.us',
      name: 'Test Contact A',
      phone_number: '+100000000001',
      whatsapp_phone_id: '100000000001@c.us',
      is_approved: true,
      ai_enabled: true
    });

    testDb.upsertContact({
      id: '910000000001@c.us',
      name: 'Test Contact B',
      phone_number: '+910000000001',
      whatsapp_phone_id: '910000000001@c.us',
      is_approved: true,
      ai_enabled: true
    });

    const contactA = testDb.getContact('100000000001@c.us');
    const contactB = testDb.getContact('910000000001@c.us');

    if (!contactA || !contactB) {
      throw new Error('Test 1 Failed: One of the contacts was not saved!');
    }
    if (contactA.id === contactB.id) {
      throw new Error('Test 1 Failed: Contacts were incorrectly merged!');
    }
    if (contactA.whatsapp_phone_id !== '100000000001@c.us' || contactB.whatsapp_phone_id !== '910000000001@c.us') {
      throw new Error('Test 1 Failed: WhatsApp phone IDs were corrupted!');
    }
    console.log('✅ Test 1 PASSED: 910000000001@c.us and 100000000001@c.us remain completely separate contacts.\n');

    // -------------------------------------------------------------
    // Test 2: Conflicting phone IDs with same LID must DO NOT MERGE
    // -------------------------------------------------------------
    console.log('--- Test 2: Conflicting Phone IDs Sharing a LID (910000000001@c.us vs 910000000002@c.us) ---');
    // Contact A has phone 910000000001@c.us with LID 100000000001@lid
    testDb.upsertContact({
      id: '910000000001@c.us',
      name: 'Test User A',
      phone_number: '+910000000001',
      whatsapp_phone_id: '910000000001@c.us',
      whatsapp_id: '100000000001@lid',
      is_approved: true
    });

    // Now an upsert comes for a different phone 910000000002@c.us that claims the same LID
    testDb.upsertContact({
      id: '910000000002@c.us',
      name: 'Conflict Contact',
      phone_number: '+910000000002',
      whatsapp_phone_id: '910000000002@c.us',
      whatsapp_id: '100000000001@lid',
      is_approved: false
    });

    const cA = testDb.getContact('910000000001@c.us');
    const cB = testDb.getContact('910000000002@c.us');

    if (!cA || !cB) {
      throw new Error('Test 2 Failed: Expected both separate contacts to exist!');
    }
    if (cA.id === cB.id) {
      throw new Error('Test 2 Failed: Conflicting phone IDs with same LID were improperly merged!');
    }
    console.log('✅ Test 2 PASSED: Conflicting phone IDs with same LID remain separate records (no silent corruption).\n');

    // -------------------------------------------------------------
    // Test 3: Same canonical phone ID merges/resolves correctly
    // -------------------------------------------------------------
    console.log('--- Test 3: Same Canonical Phone ID (910000000001@c.us) Merges/Resolves Correctly ---');
    testDb.upsertContact({
      id: '910000000001@c.us',
      name: 'Alice Initial',
      phone_number: '+910000000001',
      whatsapp_phone_id: '910000000001@c.us',
      is_approved: true,
      ai_enabled: true
    });

    // Second update with same phone ID adds alternate name / updates metadata
    testDb.upsertContact({
      id: '910000000001@c.us',
      name: 'Alice Initial',
      phone_number: '+910000000001',
      whatsapp_phone_id: '910000000001@c.us',
      alternate_names: ['Ally'],
      is_approved: true,
      ai_enabled: true
    });

    const cAlice = testDb.getContact('910000000001@c.us');
    if (!cAlice) {
      throw new Error('Test 3 Failed: Alice contact missing!');
    }
    const altNames = JSON.parse(cAlice.alternate_names || '[]');
    if (!altNames.includes('Ally')) {
      throw new Error('Test 3 Failed: Metadata was not merged properly into same canonical identity!');
    }
    console.log('✅ Test 3 PASSED: Same canonical phone ID correctly resolves and updates existing identity.\n');

    // -------------------------------------------------------------
    // Test 4: Same name but different phone IDs remain separate contacts
    // -------------------------------------------------------------
    console.log('--- Test 4: Same Name ("John Doe") with Different Phone IDs ---');
    testDb.upsertContact({
      id: '910000000011@c.us',
      name: 'John Doe',
      phone_number: '+910000000011',
      whatsapp_phone_id: '910000000011@c.us',
      is_approved: true
    });

    testDb.upsertContact({
      id: '910000000012@c.us',
      name: 'John Doe',
      phone_number: '+910000000012',
      whatsapp_phone_id: '910000000012@c.us',
      is_approved: false
    });

    const cJohn1 = testDb.getContact('910000000011@c.us');
    const cJohn2 = testDb.getContact('910000000012@c.us');

    if (!cJohn1 || !cJohn2) {
      throw new Error('Test 4 Failed: One of the John Doe contacts was overwritten/missing!');
    }
    if (cJohn1.id === cJohn2.id) {
      throw new Error('Test 4 Failed: Different phone numbers with identical names were merged!');
    }
    console.log('✅ Test 4 PASSED: Same name with different phone IDs are strictly separate contacts.\n');

    // -------------------------------------------------------------
    // Test 5: Phone Normalization Integrity
    // -------------------------------------------------------------
    console.log('--- Test 5: Phone Normalization Integrity (No Mathematical Transformation) ---');
    const norm1 = normalizePhoneNumber('910000000001@c.us');
    const norm2 = normalizePhoneNumber('100000000001@c.us');

    if (norm1 === norm2) {
      throw new Error(`Test 5 Failed: ${norm1} and ${norm2} normalized to the same value!`);
    }
    if (norm1 !== '910000000001') {
      throw new Error(`Test 5 Failed: Expected 910000000001, got ${norm1}`);
    }
    if (norm2 !== '100000000001') {
      throw new Error(`Test 5 Failed: Expected 100000000001, got ${norm2}`);
    }
    console.log('✅ Test 5 PASSED: Canonical phone IDs retain their exact digit sequences without arbitrary mutation.\n');

    // -------------------------------------------------------------
    // Test 6: Voice Message & Response Settings Isolation
    // -------------------------------------------------------------
    console.log('--- Test 6: Voice Message & Response Per-Contact Settings Isolation ---');
    testDb.upsertContact({
      id: '919998887776@c.us',
      name: 'Voice Test User',
      phone_number: '+919998887776',
      whatsapp_phone_id: '919998887776@c.us',
      is_approved: true,
      ai_enabled: true,
      voice_message_enabled: true,
      voice_response_enabled: false
    });

    const voiceContact = testDb.getContact('919998887776@c.us');
    if (!voiceContact || voiceContact.voice_message_enabled !== 1 || voiceContact.voice_response_enabled !== 0) {
      throw new Error('Test 6 Failed: Voice settings were not accurately saved or isolated!');
    }
    console.log('✅ Test 6 PASSED: Voice message and voice response flags are properly separated.\n');

    console.log('================================================================');
    console.log('🎉 ALL CONTACT IDENTITY & VOICE SETTINGS TESTS PASSED (6/6)');
    console.log('================================================================\n');
  } finally {
    testDb.close();
    try { fs.unlinkSync(testDbPath); } catch {}
  }
}

runIdentityInvariantsTests().catch((err) => {
  console.error('Fatal test failure:', err);
  process.exit(1);
});

import { JarvisDatabase } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { normalizePhoneNumber, formatPhoneNumberForDisplay, parseAlternateNames, mergeAlternateNames } from '../server/utils/phoneUtils';
import path from 'path';
import fs from 'fs';

async function runMultiNameContactIdentityTests() {
  console.log('================================================================');
  console.log('🧪 VERIFYING MULTI-NAME WHATSAPP CONTACT IDENTITY & MERGE SYSTEM');
  console.log('================================================================\n');

  const testDbPath = path.resolve(process.cwd(), 'data/multiname_test.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  const contactMgr = new ContactManager(testDb);

  // --- 1. Test Phone Number Normalization ---
  console.log('--- 1. Testing Phone Normalization ---');
  const variations = [
    { input: '+91 00000 00001', expected: '910000000001' },
    { input: '910000000001', expected: '910000000001' },
    { input: '+910000000001', expected: '910000000001' },
    { input: '00000000001', expected: '910000000001' },
    { input: '910000000001@c.us', expected: '910000000001' }
  ];

  for (const v of variations) {
    const res = normalizePhoneNumber(v.input);
    if (res !== v.expected) {
      throw new Error(`Normalization failed for "${v.input}": got ${res}, expected ${v.expected}`);
    }
  }
  console.log('✅ [PASS] Phone numbers normalized accurately');

  // --- 2. Test Multi-Name Upsert & Merging into ONE Contact ---
  console.log('\n--- 2. Testing Multi-Name Upsert & Merging ---');
  testDb['db'].exec('DELETE FROM contacts;');

  // Step 2a: Add first representation: User One (+910000000001)
  const contact1 = testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'User One',
    phone_number: '+91 00000 00001',
    is_approved: true,
    ai_enabled: true
  });

  // Step 2b: Add second representation: User One Work (+910000000001)
  const contact2 = testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'User One Work',
    phone_number: '910000000001'
  });

  // Step 2c: Add third representation: User One Alias (+910000000001)
  const contact3 = testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'User One Alias',
    phone_number: '+910000000001'
  });

  // Step 2d: Add a separate person: User Two (+910000000002)
  const contactTwo = testDb.upsertContact({
    id: '910000000002@c.us',
    name: 'User Two',
    phone_number: '+91 00000 00002',
    is_approved: true,
    ai_enabled: true
  });

  const allContacts = testDb.getAllContacts();
  console.log(`Total database contacts: ${allContacts.length}`);

  if (allContacts.length !== 2) {
    throw new Error(`Expected exactly 2 contacts in DB, but found ${allContacts.length}`);
  }

  const userOne = allContacts.find((c) => normalizePhoneNumber(c.phone_number) === '910000000001');
  if (!userOne) throw new Error('Could not find merged User One contact');

  const alts = parseAlternateNames(userOne.alternate_names);
  console.log(`User One primary display name: "${userOne.name}"`);
  console.log(`User One alternate names: ${JSON.stringify(alts)}`);

  if (!alts.includes('User One Work') || !alts.includes('User One Alias')) {
    throw new Error(`Alternate names missing expected aliases: ${JSON.stringify(alts)}`);
  }
  console.log('✅ [PASS] 3 saved names merged into ONE WhatsApp contact with alternate names');

  // --- 3. Test JARVIS Approval Retention Across Renaming ---
  console.log('\n--- 3. Testing Automation Approval Retention Across Renaming ---');
  if (userOne.is_approved !== 1 || userOne.ai_enabled !== 1) {
    throw new Error('Automation settings were lost during multi-name merging');
  }

  // Rename contact with same phone number
  testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'User One Office',
    phone_number: '+91 00000 00001'
  });

  const reloadedUserOne = testDb.getContactByPhoneNumber('910000000001');
  if (!reloadedUserOne || reloadedUserOne.ai_enabled !== 1) {
    throw new Error('Automation was disabled when contact was renamed');
  }
  console.log('✅ [PASS] Automation remains ON after contact renaming');

  // --- 4. Test Incoming Message Resolution with @LID and Phone Priority ---
  console.log('\n--- 4. Testing Incoming Message Resolution via Phone & @LID ---');
  // Message arrives from @LID with phone number attached
  const resolvedByPhone = contactMgr.resolveApprovedContact('100000000001@lid', 'User One Work', '910000000001');
  if (!resolvedByPhone || normalizePhoneNumber(resolvedByPhone.phone_number) !== '910000000001' || resolvedByPhone.ai_enabled !== 1) {
    throw new Error('Failed to resolve incoming @LID message to approved contact');
  }
  console.log('✅ [PASS] Incoming @LID resolved to approved WhatsApp phone identity');

  // Cleanup
  testDb.close();
  try { fs.unlinkSync(testDbPath); } catch {}

  console.log('\n================================================================');
  console.log('🎉 ALL MULTI-NAME CONTACT IDENTITY TESTS PASSED 100%');
  console.log('================================================================\n');
}

runMultiNameContactIdentityTests().catch((err) => {
  console.error('Fatal error in multi-name test:', err);
  process.exit(1);
});

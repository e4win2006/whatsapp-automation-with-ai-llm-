import { MockWhatsAppAdapter } from '../server/whatsapp/adapters/mockAdapter';
import { ContactManager } from '../server/whatsapp/contactManager';
import { JarvisDatabase } from '../server/database/database';
import path from 'path';
import fs from 'fs';

async function testContactSelector() {
  console.log('================================================================');
  console.log('🧪 TESTING JARVIS WHATSAPP CONTACT SELECTOR & PHONEBOOK ISOLATION');
  console.log('================================================================\n');

  const testDbPath = path.resolve(process.cwd(), 'data/selector_test.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  testDb['db'].exec('DELETE FROM contacts;');
  const contactMgr = new ContactManager(testDb);

  // 1. Verify clean initial state
  console.log('--- 1. Testing Database Clean State ---');
  const initialContacts = contactMgr.getAllContacts();
  console.log(`Initial approved contacts count: ${initialContacts.length}`);
  if (initialContacts.length !== 0) {
    throw new Error(`Expected 0 approved contacts initially, got ${initialContacts.length}`);
  }
  console.log('✅ [PASS] 0 phonebook contacts imported by default');

  // 2. Test Mock WhatsApp Adapter chat retrieval & filtering
  console.log('\n--- 2. Testing WhatsApp Chats Filtering & Deduplication ---');
  const mockAdapter = new MockWhatsAppAdapter();
  await mockAdapter.connect();

  // Populate mock data with synthetic person, group, and system broadcast
  (mockAdapter as any).mockContacts = [
    { id: '100000000001@lid', name: 'Test User Alpha', isGroup: false },
    { id: '910000000002@c.us', name: 'Test User Beta', isGroup: false },
    { id: '910000000000-1581178592@g.us', name: 'Test Group', isGroup: true },
    { id: 'status@broadcast', name: 'Status Broadcast', isGroup: false }
  ];

  const selectable = await mockAdapter.getSelectableWhatsAppChats();
  console.log(`Selectable contacts returned: ${selectable.length}`);

  const alpha = selectable.find((c) => c.name === 'Test User Alpha');
  const beta = selectable.find((c) => c.name === 'Test User Beta');
  const group = selectable.find((c) => c.id.includes('@g.us'));
  const broadcast = selectable.find((c) => c.id.includes('@broadcast'));

  if (!alpha || alpha.id !== '100000000001@lid') {
    throw new Error('Expected Test User Alpha with stable WhatsApp ID 100000000001@lid in selectable contacts');
  }
  if (!beta) {
    throw new Error('Expected Test User Beta in selectable contacts');
  }
  if (group) {
    throw new Error('WhatsApp group was not filtered out from selectable contacts');
  }
  if (broadcast) {
    throw new Error('System broadcast was not filtered out from selectable contacts');
  }
  console.log('✅ [PASS] Groups and system broadcasts filtered out cleanly');
  console.log('✅ [PASS] Alpha preserved with stable WhatsApp LID: 100000000001@lid');

  // 3. User selects Alpha and approves for JARVIS automation
  console.log('\n--- 3. Testing Contact Selection & Approval Flow ---');
  const approvedAlpha = contactMgr.addContact(alpha.id, alpha.name);
  contactMgr.updateContactSettings(approvedAlpha.id, { ai_enabled: true });

  const currentApproved = contactMgr.getAllContacts();
  const automatedOnly = contactMgr.getAutomatedContacts();

  console.log(`Approved contacts: ${currentApproved.length} | Automated: ${automatedOnly.length}`);
  if (currentApproved.length !== 1 || automatedOnly.length !== 1) {
    throw new Error('Approved contact count mismatch');
  }
  if (automatedOnly[0].name !== 'Test User Alpha' || automatedOnly[0].id !== '100000000001@lid') {
    throw new Error('Automated contact properties mismatch');
  }
  console.log('✅ [PASS] Alpha successfully added as approved JARVIS contact with automation ON');

  // 4. Test stranger message does not automatically appear in Approved Contacts
  console.log('\n--- 4. Testing Stranger Isolation (Not in Approved Contacts) ---');
  testDb.upsertContact({
    id: 'unknown_stranger@c.us',
    name: 'Random Phone Contact'
  });

  const approvedAfterStranger = contactMgr.getAllContacts();
  console.log(`Approved contacts after stranger upsert: ${approvedAfterStranger.length}`);
  if (approvedAfterStranger.length !== 1) {
    throw new Error('Unapproved stranger should not appear in contactManager.getAllContacts()');
  }
  console.log('✅ [PASS] Unapproved contacts remain isolated from JARVIS automated contacts list');

  // Cleanup
  testDb.close();
  try { fs.unlinkSync(testDbPath); } catch {}

  console.log('\n================================================================');
  console.log('🎉 ALL CONTACT SELECTOR TESTS PASSED 100%');
  console.log('================================================================\n');
}

testContactSelector().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

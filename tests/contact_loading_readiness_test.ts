import { WhatsAppWebAdapter } from '../server/whatsapp/adapters/webAdapter';
import { ContactManager } from '../server/whatsapp/contactManager';
import { JarvisDatabase } from '../server/database/database';
import fs from 'fs';
import path from 'path';

function runTest(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
    } catch (err: any) {
      console.error(`❌ [FAIL] ${name}`);
      console.error(err);
      process.exit(1);
    }
  })();
}

async function main() {
  console.log('====================================================');
  console.log('🧪 RUNNING CONTACT LOADING & READINESS TEST SUITE');
  console.log('====================================================\n');

  const testDbPath = path.resolve(__dirname, 'test_contact_loading.sqlite');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  const testDb = new JarvisDatabase(testDbPath);
  const contactManager = new ContactManager(testDb);

  // Seed DB with approved contacts
  testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'Test Contact Alpha',
    phone_number: '+910000000001',
    whatsapp_phone_id: '910000000001@c.us',
    is_approved: true,
    ai_enabled: false
  });

  testDb.upsertContact({
    id: '910000000002@c.us',
    name: 'Test Contact Alpha',
    phone_number: '+910000000002',
    whatsapp_phone_id: '910000000002@c.us',
    is_approved: true,
    ai_enabled: true
  });

  // TEST 1: Readiness guard when WhatsAppWebAdapter is disconnected
  await runTest('1. Disconnected WhatsAppWebAdapter safely returns empty list without calling getChats', async () => {
    const adapter = new WhatsAppWebAdapter();
    // Adapter is disconnected by default
    const chats = await adapter.getSelectableWhatsAppChats();
    if (!Array.isArray(chats) || chats.length !== 0) {
      throw new Error(`Expected empty array from disconnected adapter, got: ${JSON.stringify(chats)}`);
    }

    const uiContacts = await contactManager.getContactsForUi(adapter);
    if (!Array.isArray(uiContacts) || uiContacts.length !== 2) {
      throw new Error(`Expected 2 existing DB contacts returned when adapter is disconnected, got: ${uiContacts.length}`);
    }
  });

  // TEST 2: Concurrent request coalescing (in-flight deduplication)
  await runTest('2. Multiple simultaneous getSelectableWhatsAppChats calls share 1 execution', async () => {
    const adapter = new WhatsAppWebAdapter();
    // Mock connected state & mock client
    (adapter as any).status = 'connected';
    let getChatsCallCount = 0;

    (adapter as any).client = {
      getState: async () => 'CONNECTED',
      getChats: async () => {
        getChatsCallCount++;
        // Simulate network / evaluate delay
        await new Promise((resolve) => setTimeout(resolve, 50));
        return [
          {
            id: { _serialized: '910000000001@c.us' },
            name: 'Test Contact Alpha (SIM 1)',
            isGroup: false,
            isBroadcast: false,
            timestamp: 1700000000
          },
          {
            id: { _serialized: '910000000002@c.us' },
            name: 'Test Contact Alpha (SIM 2)',
            isGroup: false,
            isBroadcast: false,
            timestamp: 1700000010
          }
        ];
      }
    };

    // Fire 5 concurrent requests
    const promises = [
      adapter.getSelectableWhatsAppChats(),
      adapter.getSelectableWhatsAppChats(),
      adapter.getSelectableWhatsAppChats(),
      adapter.getSelectableWhatsAppChats(),
      adapter.getSelectableWhatsAppChats()
    ];

    const results = await Promise.all(promises);
    if (getChatsCallCount !== 1) {
      throw new Error(`Expected getChats() to be called exactly 1 time due to deduplication, was called ${getChatsCallCount} times`);
    }

    if (results.length !== 5 || results[0].length !== 2) {
      throw new Error(`Expected all 5 callers to receive 2 contacts, got ${results[0]?.length}`);
    }
  });

  // TEST 3: Safe retry & error handling without crashing on getChats() error
  await runTest('3. Transient getChats() failure retries and recovers safely', async () => {
    const adapter = new WhatsAppWebAdapter();
    (adapter as any).status = 'connected';
    let attemptCount = 0;

    (adapter as any).client = {
      getState: async () => 'CONNECTED',
      getChats: async () => {
        attemptCount++;
        if (attemptCount === 1) {
          const err = new Error('r: r');
          err.name = 'EvaluationError';
          throw err;
        }
        return [
          {
            id: { _serialized: '910000000001@c.us' },
            name: 'Test Contact Alpha',
            isGroup: false,
            isBroadcast: false,
            timestamp: 1700000000
          }
        ];
      }
    };

    const contacts = await adapter.getSelectableWhatsAppChats(true);
    if (attemptCount !== 2) {
      throw new Error(`Expected 2 attempts (1 initial failure + 1 retry), got ${attemptCount}`);
    }
    if (contacts.length !== 1) {
      throw new Error(`Expected 1 contact returned after retry recovery, got ${contacts.length}`);
    }
  });

  // TEST 4: Malformed chat isolation
  await runTest('4. Malformed chat in chat list does not fail entire contact load', async () => {
    const adapter = new WhatsAppWebAdapter();
    (adapter as any).status = 'connected';

    (adapter as any).client = {
      getState: async () => 'CONNECTED',
      getChats: async () => [
        {
          id: { _serialized: '910000000001@c.us' },
          name: 'Test Contact Alpha',
          isGroup: false,
          isBroadcast: false,
          timestamp: 1700000000
        },
        {
          // Corrupted / malformed chat object with throwing properties
          get id() {
            throw new Error('Malformed chat property access');
          }
        },
        {
          id: { _serialized: '910000000002@c.us' },
          name: 'Test Contact Alpha 2',
          isGroup: false,
          isBroadcast: false,
          timestamp: 1700000010
        }
      ]
    };

    const contacts = await adapter.getSelectableWhatsAppChats(true);
    if (contacts.length !== 2) {
      throw new Error(`Expected 2 valid contacts returned despite 1 malformed chat, got ${contacts.length}`);
    }
  });

  // TEST 5: Same-name contacts remain completely distinct
  await runTest('5. Two contacts named Test Contact Alpha remain separate distinct records', async () => {
    const adapter = new WhatsAppWebAdapter();
    (adapter as any).status = 'connected';

    (adapter as any).client = {
      getState: async () => 'CONNECTED',
      getChats: async () => [
        {
          id: { _serialized: '910000000001@c.us' },
          name: 'Test Contact Alpha',
          isGroup: false,
          isBroadcast: false,
          timestamp: 1700000000
        },
        {
          id: { _serialized: '910000000002@c.us' },
          name: 'Test Contact Alpha',
          isGroup: false,
          isBroadcast: false,
          timestamp: 1700000010
        }
      ]
    };

    const contacts = await adapter.getSelectableWhatsAppChats(true);
    if (contacts.length !== 2) {
      throw new Error(`Expected 2 separate contacts with same name, got: ${contacts.length}`);
    }

    const ids = new Set(contacts.map((c) => c.id));
    if (ids.size !== 2) {
      throw new Error(`Contacts with same name did not maintain separate IDs`);
    }

    const uiContacts = await contactManager.getContactsForUi(adapter);
    const alpha1 = uiContacts.find((c) => c.id === '910000000001@c.us');
    const alpha2 = uiContacts.find((c) => c.id === '910000000002@c.us');

    if (!alpha1 || !alpha2) {
      throw new Error('Missing Alpha 1 or Alpha 2 in UI contact list');
    }
    if (alpha1.ai_enabled !== 0 || alpha2.ai_enabled !== 1) {
      throw new Error('Automation settings for separate contacts were corrupted');
    }
  });

  // TEST 6: Complete failure of getChats returns empty list without crashing UI
  await runTest('6. Total getChats failure logs safely and returns empty list', async () => {
    const adapter = new WhatsAppWebAdapter();
    (adapter as any).status = 'connected';

    (adapter as any).client = {
      getState: async () => 'CONNECTED',
      getChats: async () => {
        const err = new Error('r: r (Total connection failure)');
        err.name = 'FatalWWebError';
        throw err;
      }
    };

    const contacts = await adapter.getSelectableWhatsAppChats(true);
    if (!Array.isArray(contacts) || contacts.length !== 0) {
      throw new Error(`Expected empty list on fatal error, got: ${JSON.stringify(contacts)}`);
    }
  });

  // TEST 7: Resilient fallback to safe in-page evaluation when getChats() throws r: r
  await runTest('7. Direct in-page extraction succeeds when client.getChats() throws r: r', async () => {
    const adapter = new WhatsAppWebAdapter();
    (adapter as any).status = 'connected';

    (adapter as any).client = {
      getState: async () => 'CONNECTED',
      getChats: async () => {
        const err = new Error('r: r');
        err.name = 'EvaluationError';
        throw err;
      },
      pupPage: {
        isClosed: () => false,
        url: () => 'https://web.whatsapp.com',
        title: async () => 'WhatsApp',
        evaluate: async (fn: any) => {
          // Mock in-page fallback response
          return [
            {
              id: { _serialized: '910000000001@c.us', user: '910000000001', server: 'c.us' },
              name: 'Test Contact Alpha Live',
              isGroup: false,
              isBroadcast: false,
              timestamp: 1700000000,
              unreadCount: 0
            }
          ];
        }
      }
    };

    const contacts = await adapter.getSelectableWhatsAppChats(true);
    if (contacts.length !== 1 || contacts[0].id !== '910000000001@c.us') {
      throw new Error(`Expected fallback to recover 1 contact, got: ${JSON.stringify(contacts)}`);
    }
  });

  // Cleanup
  try {
    (testDb as any).db?.close?.();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch {}

  console.log('\n====================================================');
  console.log('🎉 ALL CONTACT LOADING & READINESS TESTS PASSED 100%');
  console.log('====================================================\n');
}

main().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});

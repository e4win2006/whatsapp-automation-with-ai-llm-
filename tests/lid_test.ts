import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { JarvisDatabase } from '../server/database/database';
import { eventBus } from '../server/core/eventBus';
import path from 'path';
import fs from 'fs';

async function runLidPipelineTest() {
  console.log('================================================================');
  console.log('🧪 VERIFYING @LID INCOMING MESSAGE PIPELINE & WAKE PHRASE FOR SYNTHETIC CONTACT');
  console.log('================================================================\n');

  const testDbPath = path.resolve(process.cwd(), 'data/lid_test.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  const contactMgr = new ContactManager(testDb);

  // 1. User approves contact with phone identity (e.g. 910000000001@c.us) in database
  testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'Test Contact A',
    phone_number: '+910000000001',
    whatsapp_id: '100000000001@lid',
    whatsapp_phone_id: '910000000001@c.us',
    is_approved: true,
    ai_enabled: true,
    voice_response_enabled: false,
    wake_phrase_only: true,
    respond_normal_messages: false,
    response_delay_seconds: 0 // 0s for immediate reply testing
  });

  console.log('✅ 1. Initialized approved contact "Test Contact A" with phone +910000000001 in database');

  // 2. Incoming message arrives from 100000000001@lid, resolved to 910000000001@c.us
  const incomingMsg = {
    id: 'lid_msg_001',
    contactId: '100000000001@lid',
    whatsappLid: '100000000001@lid',
    whatsappPhoneId: '910000000001@c.us',
    senderName: 'Test Contact A',
    phoneNumber: '+910000000001',
    alternateNames: ['Alias A'],
    fromMe: false,
    body: 'Hi Jarvis',
    timestamp: Date.now(),
    isGroup: false
  };

  // 3. Test resolveApprovedContact
  console.log('\n--- 2. Testing resolveApprovedContact with Resolved Phone Identity ---');
  const resolved = contactMgr.resolveApprovedContact(
    incomingMsg.contactId,
    incomingMsg.senderName,
    incomingMsg.phoneNumber,
    incomingMsg.whatsappPhoneId,
    incomingMsg.alternateNames
  );
  console.log('✅ resolveApprovedContact matched:', resolved?.name, '| ID:', resolved?.id, '| Approved:', resolved?.is_approved, '| AI:', resolved?.ai_enabled);

  if (!resolved || resolved.is_approved !== 1 || resolved.ai_enabled !== 1) {
    throw new Error('Failed to resolve @lid contact to approved record');
  }

  if (resolved.phone_number?.includes('100000000001')) {
    throw new Error('CRITICAL BUG: Numeric LID was mistakenly stored as phone number!');
  }

  // 4. Test Mock WhatsApp adapter & AutomationEngine
  let sentReply = '';
  const mockWhatsapp = {
    sendMessage: async (contactId: string, text: string) => {
      sentReply = text;
      console.log(`[TEST WHATSAPP] Delivered reply to ${contactId}: "${text}"`);
      return { messageId: 'test_rep_1', timestamp: Date.now(), success: true };
    },
    sendVoiceMessage: async (contactId: string, audioBuffer: Buffer) => {
      sentReply = '[Voice Message Sent]';
      console.log(`[TEST WHATSAPP] Delivered voice reply to ${contactId} (${audioBuffer.length} bytes)`);
      return { messageId: 'test_voice_1', timestamp: Date.now(), success: true };
    },
    getStatus: () => 'connected',
    getAdapter: () => ({ adapterName: 'MockWhatsAppAdapter' })
  } as any;

  // Set debug response delay to 0 for instant reply
  process.env.DEBUG_RESPONSE_DELAY = '0';

  const convMgr = new ConversationManager(testDb);
  const autoEngine = new AutomationEngine(mockWhatsapp, contactMgr, testDb, convMgr);

  console.log('\n--- 3. Testing AutomationEngine with Incoming Message from Test Contact A (Immediate Mode) ---');
  await autoEngine.handleIncomingMessage(incomingMsg);

  // Wait 200ms for async response execution
  await new Promise((r) => setTimeout(r, 200));

  if (!sentReply) {
    throw new Error('Automation failed to deliver reply for @lid message');
  }

  console.log('\n✅ 4. Automated response delivered successfully:', `"${sentReply}"`);

  // --- 4. Test 60-Second Timer Scheduling & Pending Response Insertion ---
  console.log('\n--- 4. Testing 60-Second Timer Scheduling & Foreign Key Integrity ---');
  process.env.DEBUG_RESPONSE_DELAY = '60';
  await autoEngine.handleIncomingMessage({
    ...incomingMsg,
    id: 'lid_msg_timer_test',
    body: 'Please schedule a timer'
  });

  const pending = testDb.getPendingResponseForContact(resolved.id);
  if (!pending) {
    throw new Error('Expected pending response to be inserted in database without FK failure');
  }
  console.log('✅ 5. 60-second pending response successfully created with FK valid contactId:', pending.contact_id);

  autoEngine.cancelAllPendingTimers('Test cleanup');

  // 5. Test stranger isolation (unknown @lid contact is NOT automated)
  console.log('\n--- 5. Testing Stranger Isolation for Unapproved @lid Contact ---');
  const strangerMsg = {
    id: 'lid_msg_stranger',
    contactId: '999999999999999@lid',
    senderName: 'Unknown Person',
    phoneNumber: undefined,
    whatsappPhoneId: undefined,
    fromMe: false,
    body: 'Hi Jarvis',
    timestamp: Date.now(),
    isGroup: false
  };
  sentReply = '';
  await autoEngine.handleIncomingMessage(strangerMsg);
  await new Promise((r) => setTimeout(r, 100));

  if (sentReply !== '') {
    throw new Error('Stranger message was incorrectly answered!');
  }
  console.log('✅ 5. Unknown @lid contact was correctly ignored (automation disabled)');

  // Cleanup
  testDb.close();
  try { fs.unlinkSync(testDbPath); } catch {}

  console.log('\n================================================================');
  console.log('🎉 @LID PIPELINE TEST PASSED 100%');
  console.log('================================================================\n');
}

runLidPipelineTest().catch((err) => {
  console.error('Fatal test failure:', err);
  process.exit(1);
});


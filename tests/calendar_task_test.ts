import { JarvisDatabase } from '../server/database/database';
import { ContactManager } from '../server/whatsapp/contactManager';
import { ConversationManager } from '../server/whatsapp/conversationManager';
import { AutomationEngine } from '../server/whatsapp/automationEngine';
import { TaskManager } from '../server/whatsapp/taskManager';
import { RoutineScheduler } from '../server/whatsapp/routineScheduler';
import path from 'path';
import fs from 'fs';

async function runCalendarAndTaskTests() {
  console.log('============================================================');
  console.log('🧪 RUNNING COMPREHENSIVE CALENDAR & DELEGATED TASK TESTS');
  console.log('============================================================\n');

  const testDbPath = path.resolve(process.cwd(), 'data/calendar_task_test.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const testDb = new JarvisDatabase(testDbPath);
  const contactMgr = new ContactManager(testDb);
  const convMgr = new ConversationManager(testDb);

  const sentMessages: Array<{ to: string; text?: string }> = [];

  const mockWhatsapp = {
    sendMessage: async (contactId: string, text: string) => {
      sentMessages.push({ to: contactId, text });
      return { messageId: `msg_${Date.now()}_${Math.random()}`, timestamp: Date.now(), success: true };
    },
    getStatus: () => 'connected',
    getAdapter: () => ({ adapterName: 'MockWhatsAppAdapter' })
  } as any;

  const autoEngine = new AutomationEngine(mockWhatsapp, contactMgr, testDb, convMgr);
  const routineScheduler = new RoutineScheduler(testDb, mockWhatsapp);

  // Setup test contacts
  // Contact 1: Authorized contact with createReminders = true, viewCalendar = false
  const authorizedContact = testDb.upsertContact({
    id: '910000000001@c.us',
    name: 'Authorized Test User',
    phone_number: '+910000000001',
    whatsapp_phone_id: '910000000001@c.us',
    whatsapp_id: '100000000001@lid',
    relationship: 'collaborator',
    is_approved: true,
    ai_enabled: true,
    birthday: '01-15',
    anniversary: '05-20',
    permissions: {
      useJarvis: true,
      createReminders: true,
      viewCalendar: false,
      createCalendarEvents: false,
      modifyCalendarEvents: false,
      deleteCalendarEvents: false
    }
  });

  // Contact 2: Stranger / Classmate with createReminders = false, viewCalendar = false
  const unauthorizedContact = testDb.upsertContact({
    id: '910000000002@c.us',
    name: 'Classmate Bob',
    phone_number: '+910000000002',
    whatsapp_phone_id: '910000000002@c.us',
    is_approved: true,
    ai_enabled: true,
    respond_normal_messages: true,
    permissions: {
      useJarvis: true,
      createReminders: false,
      viewCalendar: false,
      createCalendarEvents: false,
      modifyCalendarEvents: false,
      deleteCalendarEvents: false
    }
  });

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`✅ PASS: ${testName}`);
    } else {
      console.error(`❌ FAIL: ${testName}${detail ? ` - ${detail}` : ''}`);
    }
  }

  // --------------------------------------------------------------------------
  // TEST 1: Contact with createReminders=true asks: "Remind the owner to call me tomorrow at 6 PM"
  // --------------------------------------------------------------------------
  console.log('\n--- Test 1: Delegated Task Creation ---');
  sentMessages.length = 0;
  await autoEngine.handleIncomingMessage({
    id: 'msg_task_01',
    contactId: '910000000001@c.us',
    whatsappLid: '100000000001@lid',
    senderName: 'Authorized Test User',
    fromMe: false,
    body: 'Remind the owner to call me tomorrow at 6 PM',
    timestamp: Math.floor(Date.now() / 1000),
    isGroup: false
  });
  await autoEngine.flushPendingForContact('910000000001@c.us');

  const createdTasks = testDb.getTasksForContact('910000000001@c.us');
  assert(createdTasks.length === 1, 'Exactly one task created for requester', `Found ${createdTasks.length} tasks`);
  const task1 = createdTasks[0];
  assert(
    task1?.title?.toLowerCase().includes('call') && (task1?.title?.includes('Authorized Test User') || task1?.title?.includes('Authorized')),
    'Task title captures calling requester',
    `Title: ${task1?.title}`
  );
  assert(task1?.due_time === '18:00', 'Task due time parsed as 18:00', `Due time: ${task1?.due_time}`);
  assert(task1?.canonical_phone_id === '910000000001@c.us', 'Requester canonical phone ID stored correctly');
  assert(task1?.status === 'pending', 'Task status is pending');
  assert(
    sentMessages.some(m => m.text?.includes('call you tomorrow at 6:00 PM') || m.text?.toLowerCase().includes('remind')),
    'JARVIS confirmed task creation to requester'
  );

  // --------------------------------------------------------------------------
  // TEST 2: Duplicate message arrives with same source ID (Idempotency)
  // --------------------------------------------------------------------------
  console.log('\n--- Test 2: Idempotency Protection ---');
  await autoEngine.handleIncomingMessage({
    id: 'msg_task_01', // duplicate ID
    contactId: '910000000001@c.us',
    whatsappLid: '100000000001@lid',
    senderName: 'Authorized Test User',
    fromMe: false,
    body: 'Remind the owner to call me tomorrow at 6 PM',
    timestamp: Math.floor(Date.now() / 1000),
    isGroup: false
  });
  await autoEngine.flushPendingForContact('910000000001@c.us');

  const tasksAfterDup = testDb.getTasksForContact('910000000001@c.us');
  assert(tasksAfterDup.length === 1, 'No duplicate task created for duplicate message ID');

  // --------------------------------------------------------------------------
  // TEST 3: Follow-up message: "Actually make that 7 PM"
  // --------------------------------------------------------------------------
  console.log('\n--- Test 3: Follow-up Task Rescheduling ---');
  sentMessages.length = 0;
  await autoEngine.handleIncomingMessage({
    id: 'msg_task_02',
    contactId: '910000000001@c.us',
    whatsappLid: '100000000001@lid',
    senderName: 'Authorized Test User',
    fromMe: false,
    body: 'Actually make that 7 PM',
    timestamp: Math.floor(Date.now() / 1000) + 5,
    isGroup: false
  });
  await autoEngine.flushPendingForContact('910000000001@c.us');

  const tasksAfterUpdate = testDb.getTasksForContact('910000000001@c.us');
  assert(tasksAfterUpdate.length === 1, 'No second task created on follow-up change');
  const updatedTask = tasksAfterUpdate[0];
  assert(updatedTask?.due_time === '19:00', 'Task due time updated to 19:00 (7 PM)', `Time: ${updatedTask?.due_time}`);
  assert(
    sentMessages.some(m => m.text?.toLowerCase().includes('updated the reminder')),
    'JARVIS confirmed task update'
  );

  // --------------------------------------------------------------------------
  // TEST 4: Contact with createReminders=false asks for a reminder
  // --------------------------------------------------------------------------
  console.log('\n--- Test 4: createReminders=false Permission Refusal ---');
  sentMessages.length = 0;
  await autoEngine.handleIncomingMessage({
    id: 'msg_task_03',
    contactId: '910000000002@c.us',
    senderName: 'Classmate Bob',
    fromMe: false,
    body: 'Remind the owner to submit the project tomorrow',
    timestamp: Math.floor(Date.now() / 1000) + 10,
    isGroup: false
  });
  await autoEngine.flushPendingForContact('910000000002@c.us');

  const bobTasks = testDb.getTasksForContact('910000000002@c.us');
  assert(bobTasks.length === 0, 'No task created for unauthorized contact Bob');
  assert(
    sentMessages.some(m => m.text?.toLowerCase().includes("not authorized to create reminders")),
    'JARVIS replied with permission refusal'
  );

  // --------------------------------------------------------------------------
  // TEST 5: Contact with createReminders=true but viewCalendar=false asks for calendar
  // --------------------------------------------------------------------------
  console.log('\n--- Test 5: Calendar Privacy Isolation ---');
  sentMessages.length = 0;
  await autoEngine.handleIncomingMessage({
    id: 'msg_task_04',
    contactId: '910000000001@c.us',
    whatsappLid: '100000000001@lid',
    senderName: 'Authorized Test User',
    fromMe: false,
    body: 'What is the owner doing tomorrow? Show me his schedule',
    timestamp: Math.floor(Date.now() / 1000) + 15,
    isGroup: false
  });
  await autoEngine.flushPendingForContact('910000000001@c.us');

  const refused = sentMessages.some(m =>
    m.text?.toLowerCase().includes('private') ||
    m.text?.toLowerCase().includes('cannot share') ||
    m.text?.toLowerCase().includes('permission') ||
    m.text?.toLowerCase().includes('owner')
  );
  assert(refused, 'JARVIS gave privacy refusal for calendar inspection');

  // --------------------------------------------------------------------------
  // TEST 6: Task completion and snooze lifecycle
  // --------------------------------------------------------------------------
  console.log('\n--- Test 6: Task Status Lifecycle ---');
  const taskId = updatedTask.id;
  const snoozeSuccess = testDb.snoozeTask(taskId, 60);
  assert(Boolean(snoozeSuccess), 'Task successfully snoozed');
  const snoozedTask = testDb.getTask(taskId);
  assert(snoozedTask?.status === 'snoozed', 'Task status changed to snoozed');

  const completeSuccess = testDb.updateTaskStatus(taskId, 'completed');
  assert(Boolean(completeSuccess), 'Task successfully completed');
  const completedTask = testDb.getTask(taskId);
  assert(completedTask?.status === 'completed', 'Task status changed to completed');

  // --------------------------------------------------------------------------
  // TEST 7: Master Auto Switch Controls Reminders
  // --------------------------------------------------------------------------
  console.log('\n--- Test 7: Master Auto Switch Enforcement ---');
  // Create an overdue pending task
  const overdueTask = testDb.createTask({
    title: 'Urgent reminder',
    due_date: '2020-01-01',
    due_time: '09:00',
    requester_contact_id: '910000000001@c.us',
    owner_id: 'Owner'
  });

  // Turn Master Switch OFF
  testDb.setSetting('master_switch', 'false');
  sentMessages.length = 0;
  await routineScheduler.evaluateDueTasks(new Date());
  assert(sentMessages.length === 0, 'No automatic reminders sent while Master Switch is OFF');
  const taskStillPending = testDb.getTask(overdueTask.id);
  assert(taskStillPending?.reminder_sent === 0, 'Task reminder_sent remains 0');

  // --------------------------------------------------------------------------
  // TEST 8: Contact Important Dates Storage & Retrieval
  // --------------------------------------------------------------------------
  console.log('\n--- Test 8: Contact Important Dates ---');
  const contactDates = testDb.getContactImportantDates();
  const foundDates = contactDates.find(c => c.contact_id === '910000000001@c.us');
  assert(foundDates?.birthday === '01-15', 'Birthday retrieved correctly as 01-15');
  assert(foundDates?.anniversary === '05-20', 'Anniversary retrieved correctly as 05-20');

  // Clean up
  routineScheduler.stop();
  testDb.close();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  console.log('\n============================================================');
  console.log(`📊 RESULTS: ${passedTests} / ${totalTests} TESTS PASSED`);
  console.log('============================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runCalendarAndTaskTests().catch(err => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});

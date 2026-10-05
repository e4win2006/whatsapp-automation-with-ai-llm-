import { db, JarvisDatabase, DbRoutine, DbContact } from '../database/database';
import { whatsappManager, WhatsAppManager } from './client';
import { contactManager, ContactManager } from './contactManager';
import { normalizePhoneNumber } from '../utils/phoneUtils';
import { eventBus } from '../core/eventBus';

export class RoutineScheduler {
  private timer: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private database: JarvisDatabase;
  private whatsapp: WhatsAppManager;
  private contacts: ContactManager;
  private intervalMs: number;

  constructor(
    customDb?: JarvisDatabase,
    customWhatsapp?: WhatsAppManager,
    customContacts?: ContactManager,
    intervalMs: number = 20000 // Tick every 20 seconds
  ) {
    this.database = customDb || db;
    this.whatsapp = customWhatsapp || whatsappManager;
    this.contacts = customContacts || contactManager;
    this.intervalMs = intervalMs;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(`[ROUTINE SCHEDULER] Started with check interval ${this.intervalMs / 1000}s.`);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    // Trigger initial tick after short startup delay
    setTimeout(() => this.tick(), 2000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
    console.log('[ROUTINE SCHEDULER] Stopped.');
  }

  public async tick(nowDate: Date = new Date()): Promise<void> {
    try {
      // 1. Check Master Automation Switch
      const masterSetting = this.database.getSetting('master_automation_switch');
      const isMasterOn = masterSetting === null ? true : masterSetting === 'true';
      if (!isMasterOn) {
        return;
      }

      // 2. Fetch all enabled routines
      const enabledRoutines = this.database.getEnabledRoutines();

      for (const routine of enabledRoutines) {
        await this.evaluateAndExecuteRoutine(routine, nowDate);
      }

      // 3. Evaluate contact birthdays
      await this.evaluateContactBirthdays(nowDate);

      // 4. Evaluate due delegated tasks / reminders for Owner
      await this.evaluateDueTasks(nowDate);
    } catch (error: any) {
      console.error('[ROUTINE SCHEDULER ERROR] Tick evaluation failed:', error);
    }
  }

  public async evaluateAndExecuteRoutine(routine: DbRoutine, nowDate: Date): Promise<boolean> {
    if (routine.enabled !== 1) return false;

    // Check if routine is due to run at nowDate
    if (!this.isRoutineDue(routine, nowDate)) {
      return false;
    }

    return this.executeRoutine(routine, nowDate);
  }

  public async executeRoutine(routine: DbRoutine, nowDate: Date = new Date()): Promise<boolean> {
    // Safety checks
    const contact = this.database.getContact(routine.contact_id);
    if (!contact) {
      console.warn(`[ROUTINE] Blocked: Contact ${routine.contact_id} not found in database.`);
      return false;
    }

    // Check contact automation
    const isContactAutomated = contact.is_approved === 1 && contact.ai_enabled === 1;
    if (!isContactAutomated) {
      console.log(`[ROUTINE] Blocked: Contact ${contact.name} (${contact.id}) has automation disabled.`);
      return false;
    }

    // Determine target recipient canonical phone identity
    let targetRecipient = contact.whatsapp_phone_id || (contact.phone_number ? `${normalizePhoneNumber(contact.phone_number)}@c.us` : null);
    if (!targetRecipient && contact.id.endsWith('@c.us')) {
      targetRecipient = contact.id;
    }

    if (!targetRecipient) {
      console.warn(`[ROUTINE] Blocked: No canonical WhatsApp phone ID resolved for ${contact.name}.`);
      return false;
    }

    // Check WhatsApp connection
    if (!this.whatsapp.isReady()) {
      console.warn(`[ROUTINE] Skipped: WhatsApp client is not connected/ready.`);
      return false;
    }

    // Execute routine
    console.log(`\n[ROUTINE EXECUTION STARTED]\nroutineId: ${routine.id}\nroutineName: "${routine.name}"\ncontactId: ${contact.id}\ncontactName: "${contact.name}"\ntargetRecipient: ${targetRecipient}\nscheduledTime: ${routine.time}\n`);

    try {
      const sendResult = await this.whatsapp.sendMessage(targetRecipient, routine.message, false);
      const executionTimestamp = nowDate.getTime();

      // Mark executed and update last_run_at
      this.database.markRoutineExecuted(routine.id, executionTimestamp);

      this.database.addLog('info', 'RoutineScheduler', `Routine executed: "${routine.name}" for ${contact.name}`, {
        routineId: routine.id,
        contactId: contact.id,
        scheduledTime: routine.time,
        success: Boolean(sendResult)
      });

      console.log(`[ROUTINE EXECUTION COMPLETED]\nroutineId: ${routine.id}\nstatus: SUCCESS\n`);
      return true;
    } catch (err: any) {
      console.error(`[ROUTINE EXECUTION FAILED]\nroutineId: ${routine.id}\nerror: ${err.message || err}\n`);
      this.database.addLog('error', 'RoutineScheduler', `Routine execution failed: "${routine.name}" for ${contact.name}`, {
        routineId: routine.id,
        error: err.message || err
      });
      return false;
    }
  }

  public isRoutineDue(routine: DbRoutine, now: Date): boolean {
    const tz = routine.timezone || 'Asia/Kolkata';

    // Parse target hour and minute
    const [targetHourStr, targetMinuteStr] = routine.time.split(':');
    const targetHour = parseInt(targetHourStr, 10);
    const targetMinute = parseInt(targetMinuteStr, 10);

    if (isNaN(targetHour) || isNaN(targetMinute)) return false;

    // Convert `now` to the specified timezone
    const nowTzString = now.toLocaleString('en-US', { timeZone: tz });
    const nowTz = new Date(nowTzString);

    const currentHour = nowTz.getHours();
    const currentMinute = nowTz.getMinutes();

    // Must match the scheduled hour and minute
    if (currentHour !== targetHour || currentMinute !== targetMinute) {
      return false;
    }

    const currentYear = nowTz.getFullYear();
    const currentMonth = nowTz.getMonth() + 1; // 1-12
    const currentDay = nowTz.getDate(); // 1-31
    const currentDayOfWeek = nowTz.getDay(); // 0=Sunday..6=Saturday

    const lastRun = routine.last_run_at ? new Date(new Date(routine.last_run_at).toLocaleString('en-US', { timeZone: tz })) : null;

    switch (routine.type) {
      case 'daily': {
        // Run once per calendar day
        if (lastRun) {
          if (
            lastRun.getFullYear() === currentYear &&
            lastRun.getMonth() + 1 === currentMonth &&
            lastRun.getDate() === currentDay
          ) {
            return false; // Already ran today
          }
        }
        return true;
      }

      case 'weekly': {
        // Check day of week
        let days: string[] = [];
        if (routine.days_of_week) {
          try {
            days = JSON.parse(routine.days_of_week).map(String);
          } catch {
            days = [routine.days_of_week];
          }
        }
        // Match day: 0=Sun, 1=Mon, ..., 6=Sat or 7=Sun
        const dayMatch = days.some((d) => {
          const num = parseInt(d, 10);
          return num === currentDayOfWeek || (num === 7 && currentDayOfWeek === 0);
        });

        if (!dayMatch) return false;

        if (lastRun) {
          if (
            lastRun.getFullYear() === currentYear &&
            lastRun.getMonth() + 1 === currentMonth &&
            lastRun.getDate() === currentDay
          ) {
            return false; // Already ran today
          }
        }
        return true;
      }

      case 'monthly': {
        const targetDay = routine.day_of_month || 1;
        if (currentDay !== targetDay) return false;

        if (lastRun) {
          if (
            lastRun.getFullYear() === currentYear &&
            lastRun.getMonth() + 1 === currentMonth
          ) {
            return false; // Already ran this month
          }
        }
        return true;
      }

      case 'yearly': {
        const targetMonth = routine.month || 1;
        const targetDay = routine.day_of_month || 1;
        if (currentMonth !== targetMonth || currentDay !== targetDay) return false;

        if (lastRun) {
          if (lastRun.getFullYear() === currentYear) {
            return false; // Already ran this year
          }
        }
        return true;
      }

      case 'specific_date': {
        if (!routine.date) return false;
        const [rYearStr, rMonthStr, rDayStr] = routine.date.split('-');
        const rYear = parseInt(rYearStr, 10);
        const rMonth = parseInt(rMonthStr, 10);
        const rDay = parseInt(rDayStr, 10);

        if (currentYear !== rYear || currentMonth !== rMonth || currentDay !== rDay) {
          return false;
        }

        if (lastRun) {
          return false; // Specific date runs only once
        }
        return true;
      }

      default:
        return false;
    }
  }

  private async evaluateContactBirthdays(nowDate: Date): Promise<void> {
    const tz = 'Asia/Kolkata';
    const nowTz = new Date(nowDate.toLocaleString('en-US', { timeZone: tz }));

    // Birthday greetings trigger at 09:00 AM by default
    if (nowTz.getHours() !== 9 || nowTz.getMinutes() !== 0) {
      return;
    }

    const currentYear = nowTz.getFullYear();
    const currentMonth = nowTz.getMonth() + 1;
    const currentDay = nowTz.getDate();

    const contacts = this.database.getApprovedContacts();
    for (const contact of contacts) {
      if (!contact.birthday || !contact.birthday_message || contact.ai_enabled !== 1) {
        continue;
      }

      // Check if birthday matches today
      // Format can be "MM/DD", "MM-DD", or "YYYY-MM-DD"
      let bMonth: number | null = null;
      let bDay: number | null = null;

      const parts = contact.birthday.split(/[-/]/);
      if (parts.length === 2) {
        bMonth = parseInt(parts[0], 10);
        bDay = parseInt(parts[1], 10);
      } else if (parts.length === 3) {
        bMonth = parseInt(parts[1], 10);
        bDay = parseInt(parts[2], 10);
      }

      if (bMonth === currentMonth && bDay === currentDay) {
        // Synthesize virtual birthday routine check
        const birthdayRoutineId = `bday_${contact.id}`;
        let routine = this.database.getRoutine(birthdayRoutineId);
        if (!routine) {
          routine = this.database.upsertRoutine({
            id: birthdayRoutineId,
            contact_id: contact.id,
            name: `${contact.name}'s Birthday`,
            type: 'yearly',
            time: '09:00',
            month: currentMonth,
            day_of_month: currentDay,
            message: contact.birthday_message,
            enabled: 1
          });
        }
        await this.evaluateAndExecuteRoutine(routine, nowDate);
      }
    }
  }

  public async evaluateDueTasks(nowDate: Date = new Date()): Promise<void> {
    const dueTasks = this.database.getDueTasks(nowDate.getTime());
    for (const task of dueTasks) {
      try {
        this.database.markTaskReminderSent(task.id);
        const requesterInfo = task.requester_display_name ? `requested by ${task.requester_display_name}` : 'delegated task';
        console.log(`[TASK REMINDER] Reminder for Owner: "${task.title}" (${requesterInfo})`);

        eventBus.emit('TASK_REMINDER_DUE', {
          taskId: task.id,
          title: task.title,
          description: task.description,
          requesterName: task.requester_display_name,
          canonicalPhoneId: task.canonical_phone_id,
          dueDate: task.due_date,
          dueTime: task.due_time,
          timestamp: nowDate.getTime()
        });

        this.database.addLog('info', 'TaskManager', `Task reminder triggered: "${task.title}" (${requesterInfo})`, {
          taskId: task.id,
          dueDate: task.due_date,
          dueTime: task.due_time
        });
      } catch (err: any) {
        console.error(`[TASK REMINDER ERROR] Failed to trigger reminder for task ${task.id}:`, err);
      }
    }
  }
}

export const routineScheduler = new RoutineScheduler();

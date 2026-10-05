import { db, JarvisDatabase, DbTask, DbContact, ContactPermissions, parseContactPermissions } from '../database/database';
import { eventBus } from '../core/eventBus';

export interface TaskIntentResult {
  isTaskRequest: boolean;
  allowed: boolean;
  isFollowUp?: boolean;
  task?: DbTask | null;
  replyMessage?: string;
  refusalMessage?: string;
  error?: string;
}

export class TaskManager {
  private static readonly PERMISSION_REFUSAL = "Sorry, I am not authorized to create reminders or tasks for the owner.";

  /**
   * Evaluates if an incoming message is a delegated task/reminder request for the owner.
   * If createReminders is false, returns a polite refusal.
   * If createReminders is true, creates or updates the task and returns a confirmation reply.
   */
  public static processDelegatedTaskIntent(
    text: string,
    contact: DbContact | null,
    sourceMessageId?: string,
    dbInstance?: JarvisDatabase
  ): TaskIntentResult {
    const database = dbInstance || db;
    const trimmed = text.trim();
    if (!trimmed) return { isTaskRequest: false, allowed: true };

    const perms: ContactPermissions = contact
      ? parseContactPermissions(contact.permissions, contact.ai_enabled === 1)
      : { useJarvis: false, viewMessages: false, viewNotifications: false, viewContacts: false, viewCalendar: false, createReminders: false, createCalendarEvents: false, modifyCalendarEvents: false, deleteCalendarEvents: false, viewFiles: false, viewLocation: false, viewPersonalInformation: false };

    // 1. Check for follow-up reschedule / time adjustment on a recent pending task
    const followUpMatch = this.detectFollowUpIntent(trimmed);
    if (followUpMatch && contact) {
      // Check if there is an active pending task for this contact
      const pendingTask = database.getLatestPendingTaskForContact(contact.id);
      if (pendingTask) {
        // Must have createReminders permission to modify reminders
        if (!perms.createReminders) {
          return {
            isTaskRequest: true,
            allowed: false,
            refusalMessage: this.PERMISSION_REFUSAL
          };
        }

        const { dueDate, dueTime, reminderTime } = this.parseDateTime(followUpMatch.timeSpec, pendingTask.due_date);
        const updated = database.updateTask(pendingTask.id, {
          due_date: dueDate || pendingTask.due_date,
          due_time: dueTime || pendingTask.due_time,
          reminder_time: reminderTime || pendingTask.reminder_time,
          status: 'pending',
          reminder_sent: 0
        });

        eventBus.emit('TASK_UPDATED', updated);
        const timeDisplay = dueTime ? this.formatTime12h(dueTime) : (dueDate || 'the new time');
        return {
          isTaskRequest: true,
          allowed: true,
          isFollowUp: true,
          task: updated,
          replyMessage: `Got it, I've updated the reminder to ${timeDisplay}.`
        };
      }
    }

    // 2. Check for primary task / reminder creation intent
    const taskIntent = this.detectTaskCreationIntent(trimmed, contact?.name || 'you');
    if (!taskIntent) {
      return { isTaskRequest: false, allowed: true };
    }

    // Check permission
    if (!perms.createReminders) {
      console.log(`[TASK MANAGER] Blocked reminder creation for ${contact?.name || 'unknown'}: createReminders is false.`);
      return {
        isTaskRequest: true,
        allowed: false,
        refusalMessage: this.PERMISSION_REFUSAL
      };
    }

    // Idempotency: check if task already created with this sourceMessageId
    if (sourceMessageId) {
      const existingAll = database.getAllTasks();
      const duplicate = existingAll.find((t) => t.source_message_id === sourceMessageId);
      if (duplicate) {
        console.log(`[TASK MANAGER] Duplicate task request ignored for message ID ${sourceMessageId}.`);
        return {
          isTaskRequest: true,
          allowed: true,
          task: duplicate,
          replyMessage: this.buildConfirmationMessage(duplicate)
        };
      }
    }

    // Parse date & time
    const { dueDate, dueTime, reminderTime } = this.parseDateTime(taskIntent.rawDateTime);

    const requesterDisplayName = contact?.name || 'WhatsApp Contact';
    const requesterContactId = contact?.id || null;
    const canonicalPhoneId = contact?.whatsapp_phone_id || (contact?.id.endsWith('@c.us') ? contact.id : null);
    const whatsappLid = contact?.whatsapp_id || (contact?.id.endsWith('@lid') ? contact.id : null);

    const task = database.createTask({
      title: taskIntent.title,
      description: trimmed,
      requester_contact_id: requesterContactId,
      canonical_phone_id: canonicalPhoneId,
      whatsapp_lid: whatsappLid,
      requester_display_name: requesterDisplayName,
      owner_id: 'Owner',
      due_date: dueDate,
      due_time: dueTime,
      reminder_time: reminderTime,
      status: 'pending',
      source_message_id: sourceMessageId || null
    });

    eventBus.emit('TASK_CREATED', task);
    database.addLog('info', 'TaskManager', `Created delegated task "${task.title}" from ${requesterDisplayName}`, {
      taskId: task.id,
      dueDate,
      dueTime
    });

    console.log(`[TASK MANAGER] Delegated task created: "${task.title}" (Due: ${dueDate || 'Unscheduled'} ${dueTime || ''}) requested by ${requesterDisplayName}`);

    const confirmation = this.buildConfirmationMessage(task);
    return {
      isTaskRequest: true,
      allowed: true,
      task,
      replyMessage: confirmation
    };
  }

  /**
   * Helper to format time as 12-hour AM/PM string.
   */
  public static formatTime12h(time24: string): string {
    const [hStr, mStr] = time24.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr ? parseInt(mStr, 10) : 0;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;
    const minutePart = m > 0 ? `:${m < 10 ? '0' + m : m}` : '';
    return `${h}${minutePart} ${ampm}`;
  }

  private static buildConfirmationMessage(task: DbTask): string {
    let timeStr = '';
    if (task.due_date && task.due_time) {
      const isTomorrow = this.isTomorrow(task.due_date);
      const isToday = this.isToday(task.due_date);
      const dayLabel = isToday ? 'today' : (isTomorrow ? 'tomorrow' : `on ${task.due_date}`);
      timeStr = ` ${dayLabel} at ${this.formatTime12h(task.due_time)}`;
    } else if (task.due_date) {
      const isTomorrow = this.isTomorrow(task.due_date);
      const isToday = this.isToday(task.due_date);
      const dayLabel = isToday ? 'today' : (isTomorrow ? 'tomorrow' : `on ${task.due_date}`);
      timeStr = ` ${dayLabel}`;
    } else if (task.due_time) {
      timeStr = ` at ${this.formatTime12h(task.due_time)}`;
    }

    // Natural confirmation
    const actionPart = task.title.toLowerCase().startsWith('call')
      ? `to call you`
      : `to ${task.title.charAt(0).toLowerCase() + task.title.slice(1)}`;

    return `Sure, I'll remind the owner ${actionPart}${timeStr}.`;
  }

  private static isToday(dateStr: string): boolean {
    const today = new Date().toISOString().split('T')[0];
    return dateStr === today;
  }

  private static isTomorrow(dateStr: string): boolean {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return dateStr === tomorrow.toISOString().split('T')[0];
  }

  /**
   * Detects follow-up corrections like "Actually make that 7 PM", "Make it tomorrow at 6 PM".
   */
  private static detectFollowUpIntent(text: string): { timeSpec: string } | null {
    const patterns = [
      /^(?:actually\s+)?make\s+(?:that|it)\s+(?:at\s+)?(.+)/i,
      /^(?:change\s+(?:that|it)\s+to|reschedule\s+(?:it\s+)?to)\s+(.+)/i,
      /^(?:how\s+about|instead\s+of\s+.*,\s*(?:make\s+it\s+)?)(.+)/i,
    ];

    for (const pat of patterns) {
      const match = text.match(pat);
      if (match && match[1]) {
        return { timeSpec: match[1].trim() };
      }
    }
    return null;
  }

  /**
   * Detects explicit task creation intents like:
   * "Remind the owner to call me tomorrow at 6 PM"
   * "Tell him to bring the documents when he comes tomorrow"
   * "Remind him about my birthday next month"
   * "Ask owner to call me"
   * "Don't let him forget to call me tomorrow"
   */
  private static detectTaskCreationIntent(text: string, requesterName: string): { title: string; rawDateTime: string } | null {
    // Patterns matching delegating a task to the owner
    const patterns = [
      /(?:can\s+you\s+)?(?:please\s+)?remind\s+(?:the\s+owner|owner|edwin|him|her)\s+(?:to|about|that)?\s*(.+)/i,
      /(?:can\s+you\s+)?(?:please\s+)?tell\s+(?:the\s+owner|owner|edwin|him|her)\s+(?:to|about|that)?\s*(.+)/i,
      /(?:can\s+you\s+)?(?:please\s+)?ask\s+(?:the\s+owner|owner|edwin|him|her)\s+(?:to|about)?\s*(.+)/i,
      /don'?t\s+let\s+(?:the\s+owner|owner|edwin|him|her)\s+forget\s+(?:to|about)?\s*(.+)/i,
      /make\s+sure\s+(?:the\s+owner|owner|edwin|him|her)\s+(?:remembers\s+to\s+|doesn'?t\s+forget\s+to\s+)?(.+)/i,
      // Malayalam/Manglish patterns
      /(?:owner|edwin)(?:odu|od)\s+(?:para|paray|parayu|ormippikk|ormippikku)\s*(.+)/i,
      /(?:ormippikk|ormippikku)\b.*(?:owner|edwin)\s*(.+)/i
    ];

    for (const pat of patterns) {
      const match = text.match(pat);
      if (match && match[1]) {
        const fullClause = match[1].trim().replace(/[.!?]+$/, '');
        return this.extractTaskTitleAndDateTime(fullClause, requesterName);
      }
    }

    return null;
  }

  /**
   * Extracts clean title and raw date/time expressions from the clause.
   */
  private static extractTaskTitleAndDateTime(clause: string, requesterName: string): { title: string; rawDateTime: string } {
    let cleanClause = clause;
    // Replace 1st person pronouns ("me", "my") with the requester name when constructing title
    cleanClause = cleanClause.replace(/\bcall\s+me\b/i, `Call ${requesterName}`);
    cleanClause = cleanClause.replace(/\bmessage\s+me\b/i, `Message ${requesterName}`);
    cleanClause = cleanClause.replace(/\bmeet\s+me\b/i, `Meet ${requesterName}`);
    cleanClause = cleanClause.replace(/\bmy\s+birthday\b/i, `${requesterName}'s birthday`);
    cleanClause = cleanClause.replace(/\bme\b/i, requesterName);
    cleanClause = cleanClause.replace(/\bmy\b/i, `${requesterName}'s`);

    // Look for date/time indicators: "tomorrow at 6 PM", "tomorrow", "today at 8", "next month", "at 6 PM", etc.
    const timeRegex = /\b(?:tomorrow\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow|today\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|today|tonight|this\s+evening|next\s+month|next\s+week|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i;
    const timeMatch = cleanClause.match(timeRegex);

    let rawDateTime = '';
    let title = cleanClause;

    if (timeMatch) {
      rawDateTime = timeMatch[0];
      // Remove the matched time portion from the title
      title = cleanClause.replace(timeRegex, '').trim();
      title = title.replace(/\b(?:when\s+he\s+comes|when\s+you\s+can|please)\b/i, '').trim();
      title = title.replace(/^(?:to|about)\s+/i, '').trim();
    }

    // Capitalize first letter of title
    if (title.length > 0) {
      title = title.charAt(0).toUpperCase() + title.slice(1);
    } else {
      title = `Reminder from ${requesterName}`;
    }

    return { title, rawDateTime };
  }

  /**
   * Parses natural language date/time specifications into YYYY-MM-DD, HH:MM, and epoch timestamp ms.
   */
  public static parseDateTime(
    rawDateTime: string,
    existingDate?: string | null
  ): { dueDate: string | null; dueTime: string | null; reminderTime: number | null } {
    if (!rawDateTime) {
      return { dueDate: null, dueTime: null, reminderTime: null };
    }

    const lower = rawDateTime.toLowerCase().trim();
    const now = new Date();
    let targetDate = new Date();

    if (existingDate && /^\d{4}-\d{2}-\d{2}$/.test(existingDate)) {
      const [y, m, d] = existingDate.split('-').map(Number);
      targetDate = new Date(y, m - 1, d);
    }

    // Date parsing
    if (lower.includes('tomorrow')) {
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (lower.includes('today') || lower.includes('tonight') || lower.includes('this evening')) {
      targetDate = new Date();
    } else if (lower.includes('next month')) {
      targetDate = new Date();
      targetDate.setMonth(targetDate.getMonth() + 1);
    } else if (lower.includes('next week')) {
      targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 7);
    }

    // Time parsing: e.g. "6 PM", "6:30 PM", "18:00", "at 6", "7"
    let hours = 9; // default morning 9:00 AM if date is specified but no hour
    let minutes = 0;
    let hasExplicitTime = false;

    const hourMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (hourMatch) {
      let h = parseInt(hourMatch[1], 10);
      const m = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
      const meridiem = hourMatch[3]?.toLowerCase();

      if (meridiem === 'pm' && h < 12) h += 12;
      if (meridiem === 'am' && h === 12) h = 0;
      // If no meridiem specified, assume evening for 1..7 (e.g. "at 6" -> 18:00)
      if (!meridiem && h >= 1 && h <= 7) {
        h += 12;
      }

      hours = h;
      minutes = m;
      hasExplicitTime = true;
    } else if (lower.includes('tonight') || lower.includes('this evening')) {
      hours = 20; // 8:00 PM
      minutes = 0;
      hasExplicitTime = true;
    }

    const yyyy = targetDate.getFullYear();
    const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
    const dd = String(targetDate.getDate()).padStart(2, '0');
    const dueDate = `${yyyy}-${mm}-${dd}`;

    const hh = String(hours).padStart(2, '0');
    const min = String(minutes).padStart(2, '0');
    const dueTime = hasExplicitTime ? `${hh}:${min}` : '09:00';

    targetDate.setHours(hours, minutes, 0, 0);
    const reminderTime = targetDate.getTime();

    return {
      dueDate,
      dueTime: hasExplicitTime ? dueTime : null,
      reminderTime: reminderTime > now.getTime() ? reminderTime : targetDate.getTime()
    };
  }
}

import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import { config } from '../core/config';
import { normalizePhoneNumber, parseAlternateNames, mergeAlternateNames, getWhatsAppIdentityType } from '../utils/phoneUtils';
import { DEFAULT_JARVIS_SYSTEM_PROMPT } from '../ai/aiProvider';

export interface ContactPermissions {
  useJarvis: boolean;
  viewMessages: boolean;
  viewNotifications: boolean;
  viewContacts: boolean;
  viewCalendar: boolean;
  createReminders: boolean;       // Create reminders/tasks for the account owner
  createCalendarEvents: boolean;  // Create calendar events
  modifyCalendarEvents: boolean;  // Modify calendar events
  deleteCalendarEvents: boolean;  // Delete calendar events
  viewFiles: boolean;
  viewLocation: boolean;
  viewPersonalInformation: boolean;
}

export const DEFAULT_CONTACT_PERMISSIONS: ContactPermissions = {
  useJarvis: true,
  viewMessages: false,
  viewNotifications: false,
  viewContacts: false,
  viewCalendar: false,
  createReminders: false,
  createCalendarEvents: false,
  modifyCalendarEvents: false,
  deleteCalendarEvents: false,
  viewFiles: false,
  viewLocation: false,
  viewPersonalInformation: false
};

export function parseContactPermissions(permsJson?: string | null, aiEnabled: boolean = true): ContactPermissions {
  if (!permsJson) return { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: aiEnabled };
  try {
    const parsed = typeof permsJson === 'string' ? JSON.parse(permsJson) : permsJson;
    return {
      useJarvis: parsed.useJarvis !== undefined ? Boolean(parsed.useJarvis) : aiEnabled,
      viewMessages: Boolean(parsed.viewMessages),
      viewNotifications: Boolean(parsed.viewNotifications),
      viewContacts: Boolean(parsed.viewContacts),
      viewCalendar: Boolean(parsed.viewCalendar),
      createReminders: Boolean(parsed.createReminders),
      createCalendarEvents: Boolean(parsed.createCalendarEvents),
      modifyCalendarEvents: Boolean(parsed.modifyCalendarEvents),
      deleteCalendarEvents: Boolean(parsed.deleteCalendarEvents),
      viewFiles: Boolean(parsed.viewFiles),
      viewLocation: Boolean(parsed.viewLocation),
      viewPersonalInformation: Boolean(parsed.viewPersonalInformation)
    };
  } catch {
    return { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: aiEnabled };
  }
}

export interface AiCapabilities {
  chat: boolean;
  generalAI: boolean;
  coding: boolean;
  webSearch: boolean;
  summarization: boolean;
  translation: boolean;
  voice: boolean;
  routines: boolean;
  privateData: boolean;
  programmingHelp?: boolean;
  generalQuestions?: boolean;
  imageAnalysis?: boolean;
  documentAnalysis?: boolean;
  advancedAI?: boolean;
}

export const DEFAULT_AI_CAPABILITIES: AiCapabilities = {
  chat: true,
  generalAI: true,
  coding: false,
  webSearch: false,
  summarization: true,
  translation: true,
  voice: true,
  routines: true,
  privateData: false,
  programmingHelp: false,
  generalQuestions: true,
  imageAnalysis: false,
  documentAnalysis: false,
  advancedAI: false
};

export function parseAiCapabilities(capsJson?: string | null): AiCapabilities {
  if (!capsJson) return { ...DEFAULT_AI_CAPABILITIES };
  try {
    const parsed = typeof capsJson === 'string' ? JSON.parse(capsJson) : capsJson;
    return {
      chat: parsed.chat !== undefined ? Boolean(parsed.chat) : true,
      generalAI: parsed.generalAI !== undefined ? Boolean(parsed.generalAI) : (parsed.generalQuestions !== undefined ? Boolean(parsed.generalQuestions) : true),
      coding: Boolean(parsed.coding),
      webSearch: Boolean(parsed.webSearch),
      summarization: parsed.summarization !== undefined ? Boolean(parsed.summarization) : true,
      translation: parsed.translation !== undefined ? Boolean(parsed.translation) : true,
      voice: parsed.voice !== undefined ? Boolean(parsed.voice) : true,
      routines: parsed.routines !== undefined ? Boolean(parsed.routines) : true,
      privateData: Boolean(parsed.privateData),
      programmingHelp: Boolean(parsed.programmingHelp !== undefined ? parsed.programmingHelp : parsed.coding),
      generalQuestions: parsed.generalQuestions !== undefined ? Boolean(parsed.generalQuestions) : true,
      imageAnalysis: Boolean(parsed.imageAnalysis),
      documentAnalysis: Boolean(parsed.documentAnalysis),
      advancedAI: Boolean(parsed.advancedAI)
    };
  } catch {
    return { ...DEFAULT_AI_CAPABILITIES };
  }
}

export interface DbContact {
  id: string;
  name: string;
  phone_number: string | null;
  whatsapp_id?: string | null;
  whatsapp_phone_id?: string | null;
  alternate_names?: string | null; // JSON array string e.g. '["John Work","Joseph"]'
  relationship?: string | null;
  description?: string | null;
  birthday?: string | null;
  anniversary?: string | null;
  important_dates?: string | null;
  birthday_message?: string | null;
  permissions?: string | null; // JSON string of ContactPermissions
  ai_capabilities?: string | null; // JSON string of AiCapabilities
  profile_pic_url: string | null;
  is_approved: number;
  approved_for_jarvis?: number;
  ai_enabled: number;
  rag_enabled?: number;
  rag_namespace_status?: 'active' | 'disabled' | 'deleted';
  voice_message_enabled: number; // 1: ON, 0: OFF
  voice_response_enabled: number; // 1: ON, 0: OFF
  wake_phrase_only: number; // 1: Respond when "Jarvis" is mentioned
  respond_normal_messages: number; // 1: Auto-respond to all normal messages
  memory_enabled: number; // 1: Remember context
  response_delay_seconds: number; // Default: 180s (3 min)
  auto_send: number;
  priority: 'low' | 'normal' | 'high';
  custom_system_prompt: string | null;
  created_at: number;
  updated_at: number;
}

export interface DbCalendarEvent {
  id: string;
  title: string;
  description: string | null;
  date: string; // YYYY-MM-DD
  start_time: string | null; // HH:MM
  end_time: string | null; // HH:MM
  location: string | null;
  created_by: string; // 'Edwin' or contactId
  contact_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DbTask {
  id: string;
  title: string;
  description: string | null;
  requester_contact_id: string | null;
  canonical_phone_id: string | null;
  whatsapp_lid: string | null;
  requester_display_name: string | null;
  owner_id: string; // 'Edwin'
  due_date: string | null; // YYYY-MM-DD
  due_time: string | null; // HH:MM
  reminder_time: number | null; // epoch ms
  reminder_sent: number; // 0 or 1
  status: 'pending' | 'completed' | 'cancelled' | 'snoozed';
  source_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface DbRoutine {
  id: string;
  contact_id: string;
  name: string;
  enabled: number;
  type: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'specific_date';
  time: string; // "HH:MM" 24h format
  timezone: string;
  message: string;
  days_of_week?: string | null; // JSON array e.g. ["1","3","5"]
  day_of_month?: number | null;
  month?: number | null;
  date?: string | null; // "YYYY-MM-DD"
  last_run_at?: number | null;
  next_run_at?: number | null;
  created_at: number;
  updated_at: number;
}

export interface DbConversation {
  id: string;
  contact_id: string;
  status: 'active' | 'idle' | 'cancelled' | 'responded';
  started_at: number;
  last_message_at: number;
  message_count: number;
}

export interface DbMessage {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  direction: 'incoming' | 'outgoing';
  message_text: string;
  raw_payload: string | null;
  processed: number;
  trigger_type: string | null;
  is_manual_reply: number;
  timestamp: number;
}

export type MessageProcessingStatus =
  | 'RECEIVED'
  | 'CLASSIFIED'
  | 'PENDING'
  | 'PROCESSING'
  | 'RESPONDED'
  | 'IGNORED'
  | 'ALREADY_HANDLED'
  | 'OWNER_AVAILABLE'
  | 'UNAUTHORIZED'
  | 'PRIVACY_BLOCKED'
  | 'SEEN_BY_OWNER'
  | 'FAILED'
  | 'CANCELLED';

export interface DbMessageProcessingState {
  message_id: string;
  contact_id: string;
  canonical_phone_id: string | null;
  event_source: string;
  received_at: number;
  owner_seen_at: number | null;
  owner_replied_at: number | null;
  jarvis_replied_at: number | null;
  processed_at: number | null;
  status: MessageProcessingStatus;
  terminal_reason: string | null;
  boot_session_id: string;
  created_at: number;
  updated_at: number;
}

export interface DbContactMemoryChunk {
  id: string;
  contact_id: string;
  message_id?: string | null;
  direction: 'incoming' | 'outgoing';
  content: string;
  keywords?: string | null;
  importance_score?: number;
  timestamp: number;
  created_at: number;
}

export interface DbAiAuditLog {
  audit_event_id: string;
  timestamp: number;
  contact_id: string;
  canonical_phone_id?: string | null;
  message_id?: string | null;
  incoming_message: string;
  message_type: string;
  owner_availability: string;
  contact_permissions?: string | null;
  conversation_state?: string | null;
  rag_retrieval_metadata?: string | null;
  model: string;
  provider: string;
  config_version?: string;
  generated_response: string;
  latency_ms: number;
  token_usage?: string | null;
  finish_reason?: string | null;
  delivery_result: string;
  error_information?: string | null;
  decision_summary: string;
}

export interface DbIncidentTimelineEvent {
  id?: number;
  message_id: string;
  contact_id: string;
  stage: string;
  description: string;
  metadata?: string | null;
  timestamp: number;
}

export interface DbAiDraft {
  id: string;
  contact_id: string;
  conversation_id: string;
  incoming_message_id: string | null;
  draft_text: string;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
  model: string;
  latency_ms: number;
  created_at: number;
}

export interface DbPendingResponse {
  id: string;
  contact_id: string;
  conversation_id: string;
  source_message_id?: string | null;
  latest_message_id?: string | null;
  trigger_type: string;
  timer_expires_at: number;
  scheduled_at?: number;
  cancelled_at?: number | null;
  status: 'pending' | 'cancelled' | 'executed' | 'expired';
  cancellation_reason: string | null;
  boot_session_id?: string;
  created_at: number;
  updated_at?: number;
}

export interface DbSetting {
  key: string;
  value: string;
  updated_at: number;
}

export interface DbLog {
  id?: number;
  level: string;
  module: string;
  message: string;
  metadata: string | null;
  timestamp: number;
}

export class JarvisDatabase {
  private db: DatabaseSync;
  private bootSessionId: string;

  constructor(dbPath: string = config.DATABASE_PATH) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.bootSessionId = `boot_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 10000;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initializeSchema();
    this.seedDefaults();
    this.cleanImportedPhonebookContacts();
    this.cleanupStalePendingResponses();
    this.migrateAndCleanIdentities();
    this.reconcileStartupState();
  }

  public getBootSessionId(): string {
    return this.bootSessionId;
  }

  public cleanupStalePendingResponses(): number {
    try {
      const stmt = this.db.prepare(`
        UPDATE pending_responses 
        SET status = 'cancelled', cancellation_reason = 'Server restart / expired pending response'
        WHERE status = 'pending'
      `);
      const res = stmt.run() as any;
      return res?.changes || 0;
    } catch (e) {
      return 0;
    }
  }

  public cleanImportedPhonebookContacts(): void {
    try {
      this.db.exec(`
        DELETE FROM contacts 
        WHERE (custom_system_prompt IS NULL OR custom_system_prompt = '')
          AND id NOT IN (SELECT DISTINCT contact_id FROM messages)
          AND id NOT IN (SELECT DISTINCT contact_id FROM conversations)
      `);
    } catch (e) {}
  }

  public migrateAndCleanIdentities(): void {
    try {
      this.db.exec('PRAGMA foreign_keys = OFF;');

      // 1. Delete group and broadcast entries from contacts table
      this.db.exec(`
        DELETE FROM contacts 
        WHERE id LIKE '%@g.us' 
           OR id LIKE '%@broadcast' 
           OR id = 'status@broadcast' 
           OR id = '0@c.us'
           OR id = 'test_user_999@c.us';
      `);

      // 2. Ensure lid_mappings table exists
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS lid_mappings (
          lid TEXT PRIMARY KEY,
          whatsapp_phone_id TEXT NOT NULL,
          phone_number TEXT,
          updated_at INTEGER NOT NULL
        );
      `);

      // 3. Clean up corrupted alternate names across all contacts
      const rows = this.db.prepare('SELECT * FROM contacts').all() as unknown as DbContact[];

      for (const row of rows) {
        // Remove "Account Owner (You)" from all alternate_names
        const alts = parseAlternateNames(row.alternate_names);
        const cleanedAlts = alts.filter(
          (a) => !a.toLowerCase().includes('account owner') && a.toLowerCase() !== 'you'
        );

        let prompt = row.custom_system_prompt;
        if (prompt && (prompt.includes('hey dad i am edwins ai') || prompt.includes('hey this i s my mom') || prompt.includes('hey this is my father'))) {
          prompt = null;
        }

        this.db.prepare(`
          UPDATE contacts SET
            alternate_names = ?,
            custom_system_prompt = ?,
            updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(cleanedAlts), prompt, Date.now(), row.id);
      }

      // Also ensure settings.system_prompt is set to DEFAULT_JARVIS_SYSTEM_PROMPT
      this.setSetting('system_prompt', DEFAULT_JARVIS_SYSTEM_PROMPT);
    } catch (e) {
      console.error('[DB MIGRATION] Error in migrateAndCleanIdentities:', e);
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  private initializeSchema(): void {
    const schemaPath = path.resolve(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sql = fs.readFileSync(schemaPath, 'utf-8');
      this.db.exec(sql);
    }

    // Safe column migrations for existing databases
    const columnsToEnsure = [
      'ALTER TABLE contacts ADD COLUMN wake_phrase_only INTEGER NOT NULL DEFAULT 1;',
      'ALTER TABLE contacts ADD COLUMN respond_normal_messages INTEGER NOT NULL DEFAULT 0;',
      'ALTER TABLE contacts ADD COLUMN response_delay_seconds INTEGER NOT NULL DEFAULT 180;',
      'ALTER TABLE contacts ADD COLUMN alternate_names TEXT;',
      'ALTER TABLE contacts ADD COLUMN whatsapp_id TEXT;',
      'ALTER TABLE contacts ADD COLUMN whatsapp_phone_id TEXT;',
      'ALTER TABLE contacts ADD COLUMN relationship TEXT;',
      'ALTER TABLE contacts ADD COLUMN description TEXT;',
      'ALTER TABLE contacts ADD COLUMN birthday TEXT;',
      'ALTER TABLE contacts ADD COLUMN anniversary TEXT;',
      'ALTER TABLE contacts ADD COLUMN important_dates TEXT;',
      'ALTER TABLE contacts ADD COLUMN birthday_message TEXT;',
      'ALTER TABLE contacts ADD COLUMN permissions TEXT;',
      'ALTER TABLE contacts ADD COLUMN ai_capabilities TEXT;',
      'ALTER TABLE contacts ADD COLUMN voice_message_enabled INTEGER NOT NULL DEFAULT 0;',
      'ALTER TABLE contacts ADD COLUMN voice_response_enabled INTEGER NOT NULL DEFAULT 0;',
      'ALTER TABLE contacts ADD COLUMN approved_for_jarvis INTEGER NOT NULL DEFAULT 0;',
      'ALTER TABLE contacts ADD COLUMN rag_enabled INTEGER NOT NULL DEFAULT 0;',
      'ALTER TABLE contacts ADD COLUMN rag_namespace_status TEXT NOT NULL DEFAULT \'active\';',
      'ALTER TABLE pending_responses ADD COLUMN source_message_id TEXT;',
      'ALTER TABLE pending_responses ADD COLUMN latest_message_id TEXT;',
      'ALTER TABLE pending_responses ADD COLUMN scheduled_at INTEGER NOT NULL DEFAULT 0;',
      'ALTER TABLE pending_responses ADD COLUMN cancelled_at INTEGER;',
      'ALTER TABLE pending_responses ADD COLUMN boot_session_id TEXT NOT NULL DEFAULT \'\';',
      'ALTER TABLE pending_responses ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;'
    ];

    for (const alterSql of columnsToEnsure) {
      try {
        this.db.exec(alterSql);
      } catch {
        // Column already exists
      }
    }

    // Ensure routines table exists
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS routines (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          name TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          type TEXT NOT NULL,
          time TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
          message TEXT NOT NULL,
          days_of_week TEXT,
          day_of_month INTEGER,
          month INTEGER,
          date TEXT,
          last_run_at INTEGER,
          next_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_routines_contact ON routines(contact_id);
        CREATE INDEX IF NOT EXISTS idx_routines_enabled ON routines(enabled);
      `);
    } catch (e) {
      // Table already exists
    }

    // Ensure calendar_events, tasks, message_processing_states, contact_memory_chunks, ai_audit_logs, incident_timeline exist
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          date TEXT NOT NULL,
          start_time TEXT,
          end_time TEXT,
          location TEXT,
          created_by TEXT NOT NULL DEFAULT 'Edwin',
          contact_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          requester_contact_id TEXT,
          canonical_phone_id TEXT,
          whatsapp_lid TEXT,
          requester_display_name TEXT,
          owner_id TEXT NOT NULL DEFAULT 'Edwin',
          due_date TEXT,
          due_time TEXT,
          reminder_time INTEGER,
          reminder_sent INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          source_message_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (requester_contact_id) REFERENCES contacts(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date, due_time);
        CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester_contact_id);

        CREATE TABLE IF NOT EXISTS message_processing_states (
          message_id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          canonical_phone_id TEXT,
          event_source TEXT NOT NULL DEFAULT 'message',
          received_at INTEGER NOT NULL,
          owner_seen_at INTEGER,
          owner_replied_at INTEGER,
          jarvis_replied_at INTEGER,
          processed_at INTEGER,
          status TEXT NOT NULL,
          terminal_reason TEXT,
          boot_session_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (contact_id) REFERENCES contacts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_msg_state_contact_status ON message_processing_states(contact_id, status);

        CREATE TABLE IF NOT EXISTS contact_memory_chunks (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL,
          message_id TEXT,
          direction TEXT NOT NULL,
          content TEXT NOT NULL,
          keywords TEXT,
          importance_score REAL NOT NULL DEFAULT 1.0,
          timestamp INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_contact_memory_contact ON contact_memory_chunks(contact_id);

        CREATE TABLE IF NOT EXISTS ai_audit_logs (
          audit_event_id TEXT PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          contact_id TEXT NOT NULL,
          canonical_phone_id TEXT,
          message_id TEXT,
          incoming_message TEXT NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'text',
          owner_availability TEXT NOT NULL DEFAULT 'unavailable',
          contact_permissions TEXT,
          conversation_state TEXT,
          rag_retrieval_metadata TEXT,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          config_version TEXT NOT NULL DEFAULT 'v1.0',
          generated_response TEXT NOT NULL,
          latency_ms INTEGER NOT NULL DEFAULT 0,
          token_usage TEXT,
          finish_reason TEXT,
          delivery_result TEXT NOT NULL DEFAULT 'SUCCESS',
          error_information TEXT,
          decision_summary TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_audit_contact ON ai_audit_logs(contact_id);
        CREATE INDEX IF NOT EXISTS idx_ai_audit_message ON ai_audit_logs(message_id);

        CREATE TABLE IF NOT EXISTS incident_timeline (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          stage TEXT NOT NULL,
          description TEXT NOT NULL,
          metadata TEXT,
          timestamp INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_incident_msg ON incident_timeline(message_id);
        CREATE INDEX IF NOT EXISTS idx_incident_contact ON incident_timeline(contact_id);
      `);
    } catch (e) {
      // Tables already exist
    }
  }

  private seedDefaults(): void {
    const defaults: Record<string, string> = {
      master_automation_switch: config.AUTOMATION_MASTER_SWITCH ? 'true' : 'false',
      response_delay_seconds: config.DEFAULT_RESPONSE_DELAY_SECONDS.toString(),
      wake_phrases: JSON.stringify(config.WAKE_PHRASES),
      ai_provider: config.AI_PROVIDER,
      groq_api_key: config.GROQ_API_KEY,
      groq_model: config.GROQ_MODEL,
      owner_availability: 'unavailable',
      jarvis_can_reply_when_unavailable: 'true',
      system_prompt: DEFAULT_JARVIS_SYSTEM_PROMPT
    };

    for (const [key, value] of Object.entries(defaults)) {
      const existing = this.getSetting(key);
      if (existing === null) {
        this.setSetting(key, value);
      }
    }
  }

  // --- Settings ---
  public getSetting(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM settings WHERE key = ?');
    const row = stmt.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  public setSetting(key: string, value: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) 
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    stmt.run(key, value, now);
  }

  public getAllSettings(): Record<string, string> {
    const stmt = this.db.prepare('SELECT key, value FROM settings');
    const rows = stmt.all() as unknown as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }

  // --- LID Mappings ---
  public saveLidMapping(lid: string, whatsappPhoneId: string, phoneNumber?: string | null): void {
    if (!lid || !lid.endsWith('@lid') || !whatsappPhoneId) return;
    try {
      const now = Date.now();
      const cleanPhone = phoneNumber ? normalizePhoneNumber(phoneNumber) : normalizePhoneNumber(whatsappPhoneId);
      const stmt = this.db.prepare(`
        INSERT INTO lid_mappings (lid, whatsapp_phone_id, phone_number, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(lid) DO UPDATE SET
          whatsapp_phone_id = excluded.whatsapp_phone_id,
          phone_number = COALESCE(excluded.phone_number, lid_mappings.phone_number),
          updated_at = excluded.updated_at
      `);
      stmt.run(lid, whatsappPhoneId, cleanPhone ? `+${cleanPhone}` : null, now);
    } catch (err: any) {
      console.warn(`[LID MAPPING SAVE WARNING] Could not save mapping for ${lid}: ${err?.message}`);
    }
  }

  public getLidMapping(lid: string): { lid: string; whatsapp_phone_id: string; phone_number: string | null } | null {
    if (!lid) return null;
    const stmt = this.db.prepare('SELECT * FROM lid_mappings WHERE lid = ?');
    const row = stmt.get(lid) as unknown as { lid: string; whatsapp_phone_id: string; phone_number: string | null } | undefined;
    return row || null;
  }

  // --- Contacts ---
  public getContact(id: string): DbContact | null {
    if (!id) return null;
    const stmt = this.db.prepare('SELECT * FROM contacts WHERE id = ? OR whatsapp_id = ? OR whatsapp_phone_id = ?');
    const row = stmt.get(id, id, id) as unknown as DbContact | undefined;
    return row || null;
  }

  public getContactByPhoneNumber(phone: string): DbContact | null {
    const clean = normalizePhoneNumber(phone);
    if (!clean) return null;
    const stmt = this.db.prepare(`
      SELECT * FROM contacts 
      WHERE phone_number = ? 
         OR phone_number = ? 
         OR id = ? 
         OR whatsapp_phone_id = ?
    `);
    const row = stmt.get(clean, `+${clean}`, `${clean}@c.us`, `${clean}@c.us`) as unknown as DbContact | undefined;
    return row || null;
  }

  public findExistingContact(
    arg1: string | {
      id: string;
      whatsappLid?: string | null;
      whatsappPhoneId?: string | null;
      phoneNumber?: string | null;
      senderName?: string | null;
    },
    arg2?: string | null
  ): DbContact | null {
    let id: string;
    let whatsappLid: string | null = null;
    let whatsappPhoneId: string | null = null;
    let phoneNumber: string | null = null;
    let senderName: string | null = null;

    if (typeof arg1 === 'object' && arg1 !== null) {
      id = arg1.id || '';
      whatsappLid = arg1.whatsappLid || null;
      whatsappPhoneId = arg1.whatsappPhoneId || null;
      phoneNumber = arg1.phoneNumber || null;
      senderName = arg1.senderName || null;
    } else {
      id = arg1 || '';
      phoneNumber = arg2 || null;
      if (id.endsWith('@lid')) whatsappLid = id;
      if (id.endsWith('@c.us') || id.endsWith('@s.whatsapp.net')) whatsappPhoneId = id;
    }

    const canonicalIncomingPhoneId = whatsappPhoneId || (id.endsWith('@c.us') ? id : null);
    const incomingLid = whatsappLid || (id.endsWith('@lid') ? id : null);

    // 1. Direct ID match first
    if (id) {
      const byDirectId = this.getContact(id);
      if (byDirectId) return byDirectId;
    }

    // 2. Canonical WhatsApp Phone ID match (EXACT match only)
    if (canonicalIncomingPhoneId) {
      const stmt = this.db.prepare(`
        SELECT * FROM contacts 
        WHERE whatsapp_phone_id = ? 
           OR id = ?
      `);
      const row = stmt.get(canonicalIncomingPhoneId, canonicalIncomingPhoneId) as unknown as DbContact | undefined;
      if (row) {
        const rowPhoneId = row.whatsapp_phone_id || (row.id.endsWith('@c.us') ? row.id : null);
        if (!rowPhoneId || rowPhoneId === canonicalIncomingPhoneId) {
          return row;
        }
      }
    }

    // 3. Real Phone Number exact match (only if canonical phone matches)
    if (phoneNumber) {
      const cleanDigits = normalizePhoneNumber(phoneNumber);
      if (cleanDigits) {
        const stmt = this.db.prepare(`
          SELECT * FROM contacts 
          WHERE phone_number = ? 
             OR phone_number = ?
        `);
        const row = stmt.get(cleanDigits, `+${cleanDigits}`) as unknown as DbContact | undefined;
        if (row) {
          const rowPhoneId = row.whatsapp_phone_id || (row.id.endsWith('@c.us') ? row.id : null);
          if (canonicalIncomingPhoneId && rowPhoneId && canonicalIncomingPhoneId !== rowPhoneId) {
            console.warn(`[IDENTITY CONFLICT] Phone number ${phoneNumber} matched contact ${row.id} but canonical phone IDs differ (${canonicalIncomingPhoneId} !== ${rowPhoneId})`);
          } else {
            return row;
          }
        }
      }
    }

    // 4. WhatsApp LID match (secondary/stable identifier)
    if (incomingLid) {
      // Check LID mapping table
      const mapping = this.getLidMapping(incomingLid);
      if (mapping && mapping.whatsapp_phone_id) {
        const mappedContact = this.findExistingContact({ id: mapping.whatsapp_phone_id, whatsappPhoneId: mapping.whatsapp_phone_id });
        if (mappedContact) {
          const mappedPhoneId = mappedContact.whatsapp_phone_id || (mappedContact.id.endsWith('@c.us') ? mappedContact.id : null);
          if (canonicalIncomingPhoneId && mappedPhoneId && canonicalIncomingPhoneId !== mappedPhoneId) {
            console.warn(`[IDENTITY CONFLICT] Mapped phone ID ${mappedPhoneId} conflicts with incoming phone ID ${canonicalIncomingPhoneId} for LID ${incomingLid}`);
          } else {
            return mappedContact;
          }
        }
      }

      const stmt = this.db.prepare('SELECT * FROM contacts WHERE whatsapp_id = ? OR id = ?');
      const row = stmt.get(incomingLid, incomingLid) as unknown as DbContact | undefined;
      if (row) {
        const rowPhoneId = row.whatsapp_phone_id || (row.id.endsWith('@c.us') ? row.id : null);
        if (canonicalIncomingPhoneId && rowPhoneId && canonicalIncomingPhoneId !== rowPhoneId) {
          console.warn(`[IDENTITY CONFLICT] Incoming phone ID ${canonicalIncomingPhoneId} conflicts with contact's phone ID ${rowPhoneId} for LID ${incomingLid}`);
          return null;
        }
        return row;
      }
    }

    // CRITICAL: NEVER match by name or alternate_names.
    return null;
  }

  public getAllContacts(): DbContact[] {
    const stmt = this.db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC');
    return stmt.all() as unknown as DbContact[];
  }

  public getApprovedContacts(): DbContact[] {
    const stmt = this.db.prepare('SELECT * FROM contacts WHERE is_approved = 1 ORDER BY updated_at DESC');
    return stmt.all() as unknown as DbContact[];
  }

  public upsertContact(contact: {
    id: string;
    name: string;
    phone_number?: string | null;
    whatsapp_id?: string | null;
    whatsapp_phone_id?: string | null;
    alternate_names?: string | string[] | null;
    relationship?: string | null;
    description?: string | null;
    birthday?: string | null;
    anniversary?: string | null;
    important_dates?: string | null;
    birthday_message?: string | null;
    permissions?: string | Partial<ContactPermissions> | null;
    ai_capabilities?: string | Partial<AiCapabilities> | null;
    profile_pic_url?: string | null;
    is_approved?: boolean;
    approved_for_jarvis?: boolean;
    ai_enabled?: boolean;
    rag_enabled?: boolean;
    rag_namespace_status?: 'active' | 'disabled' | 'deleted';
    voice_message_enabled?: boolean;
    voice_response_enabled?: boolean;
    wake_phrase_only?: boolean;
    respond_normal_messages?: boolean;
    memory_enabled?: boolean;
    response_delay_seconds?: number;
    auto_send?: boolean;
    priority?: 'low' | 'normal' | 'high';
    custom_system_prompt?: string | null;
  }): DbContact {
    const now = Date.now();
    const idType = getWhatsAppIdentityType(contact.id);
    let cleanPhone: string | null = null;
    if (contact.phone_number) {
      cleanPhone = normalizePhoneNumber(contact.phone_number);
    } else if (idType === 'phone') {
      cleanPhone = normalizePhoneNumber(contact.id);
    }

    const whatsappLid = contact.whatsapp_id || (contact.id.endsWith('@lid') ? contact.id : null);
    const whatsappPhoneId = contact.whatsapp_phone_id || (contact.id.endsWith('@c.us') ? contact.id : (idType === 'phone' ? contact.id : null));

    if (whatsappLid && whatsappPhoneId) {
      this.saveLidMapping(whatsappLid, whatsappPhoneId, cleanPhone);
    }

    const existing = this.findExistingContact({
      id: contact.id,
      whatsappLid,
      whatsappPhoneId,
      phoneNumber: cleanPhone
    });

    const serializedPermissions = contact.permissions !== undefined
      ? (typeof contact.permissions === 'string' ? contact.permissions : JSON.stringify(contact.permissions))
      : undefined;

    const serializedCapabilities = contact.ai_capabilities !== undefined
      ? (typeof contact.ai_capabilities === 'string' ? contact.ai_capabilities : JSON.stringify(contact.ai_capabilities))
      : undefined;

    const isApprovedVal = contact.is_approved !== undefined ? (contact.is_approved ? 1 : 0) : (contact.approved_for_jarvis !== undefined ? (contact.approved_for_jarvis ? 1 : 0) : undefined);
    const approvedForJarvisVal = contact.approved_for_jarvis !== undefined ? (contact.approved_for_jarvis ? 1 : 0) : isApprovedVal;
    const ragEnabledVal = contact.rag_enabled !== undefined ? (contact.rag_enabled ? 1 : 0) : (isApprovedVal !== undefined ? isApprovedVal : undefined);
    const ragNamespaceStatusVal = contact.rag_namespace_status || (isApprovedVal === 0 ? 'disabled' : (isApprovedVal === 1 ? 'active' : undefined));

    if (existing) {
      // Safety check before merge
      const existingPhoneId = existing.whatsapp_phone_id || (existing.id.endsWith('@c.us') ? existing.id : null);
      const incomingPhoneId = whatsappPhoneId || (contact.id.endsWith('@c.us') ? contact.id : null);
      const existingLid = existing.whatsapp_id || (existing.id.endsWith('@lid') ? existing.id : null);
      const incomingLid = whatsappLid || (contact.id.endsWith('@lid') ? contact.id : null);

      let mergeAllowed = false;
      let mergeReason = '';

      if (existingPhoneId && incomingPhoneId) {
        if (existingPhoneId === incomingPhoneId) {
          mergeAllowed = true;
          mergeReason = 'IDENTICAL_CANONICAL_PHONE_ID';
        } else {
          mergeAllowed = false;
          mergeReason = `DIFFERENT_CANONICAL_PHONE_IDS (${existingPhoneId} !== ${incomingPhoneId})`;
        }
      } else if (existingLid && incomingLid && existingLid === incomingLid) {
        if (!existingPhoneId && !incomingPhoneId) {
          mergeAllowed = true;
          mergeReason = 'MATCHING_LID_NO_PHONE_CONFLICT';
        } else if (!existingPhoneId && incomingPhoneId) {
          mergeAllowed = true;
          mergeReason = 'LID_ENRICHED_WITH_CANONICAL_PHONE';
        } else if (existingPhoneId && !incomingPhoneId) {
          mergeAllowed = true;
          mergeReason = 'EXISTING_PHONE_LID_MATCH';
        } else {
          mergeAllowed = false;
          mergeReason = `LID_PHONE_CONFLICT (${existingPhoneId} !== ${incomingPhoneId})`;
        }
      } else if (!existingPhoneId && !incomingPhoneId && !existingLid && !incomingLid && existing.id === contact.id) {
        mergeAllowed = true;
        mergeReason = 'DIRECT_ID_MATCH';
      } else {
        mergeAllowed = false;
        mergeReason = 'NO_AUTHORITATIVE_IDENTITY_MATCH';
      }

      const phoneIdEqual = Boolean(existingPhoneId && incomingPhoneId && existingPhoneId === incomingPhoneId);
      const lidEqual = Boolean(existingLid && incomingLid && existingLid === incomingLid);

      console.log(`[CONTACT MERGE CHECK]\nContact A phoneId: ${existingPhoneId || 'none'}\nContact B phoneId: ${incomingPhoneId || 'none'}\nContact A LID: ${existingLid || 'none'}\nContact B LID: ${incomingLid || 'none'}\nContact A name: ${existing.name}\nContact B name: ${contact.name}\nphoneIdEqual: ${phoneIdEqual}\nlidEqual: ${lidEqual}\nmergeAllowed: ${mergeAllowed}\nreason: ${mergeReason}`);

      if (!mergeAllowed) {
        console.log(`[CONTACT MERGE BLOCKED]\nReason: ${mergeReason}\nCreating separate contact record.`);
        return this.createSeparateContact(contact, cleanPhone, whatsappLid, whatsappPhoneId, now);
      }

      // Merge alternate names safely
      const primaryName = existing.name;
      const existingAlts = parseAlternateNames(existing.alternate_names);
      const incomingAlts = Array.isArray(contact.alternate_names)
        ? contact.alternate_names
        : parseAlternateNames(contact.alternate_names as any);
      
      const candidateNames: string[] = [];
      if (contact.name && contact.name.trim().toLowerCase() !== primaryName.trim().toLowerCase()) {
        candidateNames.push(contact.name.trim());
      }
      candidateNames.push(...incomingAlts);

      const mergedAlts = mergeAlternateNames(primaryName, existingAlts, candidateNames);
      
      if (candidateNames.length > 0 && cleanPhone) {
        console.log(`[CONTACT MERGE] Same WhatsApp number detected`);
        console.log(`[CONTACT MERGE] Names: ${[existing.name, ...mergedAlts].join(', ')}`);
        console.log(`[CONTACT MERGE] Result: ONE contact`);
      }

      const stmt = this.db.prepare(`
        UPDATE contacts SET
          phone_number = COALESCE(?, phone_number),
          whatsapp_id = COALESCE(?, whatsapp_id),
          whatsapp_phone_id = COALESCE(?, whatsapp_phone_id),
          alternate_names = ?,
          relationship = COALESCE(?, relationship),
          description = COALESCE(?, description),
          birthday = COALESCE(?, birthday),
          anniversary = COALESCE(?, anniversary),
          important_dates = COALESCE(?, important_dates),
          birthday_message = COALESCE(?, birthday_message),
          permissions = COALESCE(?, permissions),
          ai_capabilities = COALESCE(?, ai_capabilities),
          profile_pic_url = COALESCE(?, profile_pic_url),
          is_approved = COALESCE(?, is_approved),
          approved_for_jarvis = COALESCE(?, approved_for_jarvis),
          ai_enabled = COALESCE(?, ai_enabled),
          rag_enabled = COALESCE(?, rag_enabled),
          rag_namespace_status = COALESCE(?, rag_namespace_status),
          voice_message_enabled = COALESCE(?, voice_message_enabled),
          voice_response_enabled = COALESCE(?, voice_response_enabled),
          wake_phrase_only = COALESCE(?, wake_phrase_only),
          respond_normal_messages = COALESCE(?, respond_normal_messages),
          memory_enabled = COALESCE(?, memory_enabled),
          response_delay_seconds = COALESCE(?, response_delay_seconds),
          auto_send = COALESCE(?, auto_send),
          priority = COALESCE(?, priority),
          custom_system_prompt = COALESCE(?, custom_system_prompt),
          updated_at = ?
        WHERE id = ?
      `);

      (stmt.run as any)(
        cleanPhone ? `+${cleanPhone}` : (existing.phone_number ?? null),
        whatsappLid ?? existing.whatsapp_id ?? null,
        whatsappPhoneId ?? existing.whatsapp_phone_id ?? null,
        JSON.stringify(mergedAlts),
        contact.relationship !== undefined ? contact.relationship : (existing.relationship ?? null),
        contact.description !== undefined ? contact.description : (existing.description ?? null),
        contact.birthday !== undefined ? contact.birthday : (existing.birthday ?? null),
        contact.anniversary !== undefined ? contact.anniversary : (existing.anniversary ?? null),
        contact.important_dates !== undefined ? contact.important_dates : (existing.important_dates ?? null),
        contact.birthday_message !== undefined ? contact.birthday_message : (existing.birthday_message ?? null),
        serializedPermissions !== undefined ? serializedPermissions : (existing.permissions ?? null),
        serializedCapabilities !== undefined ? serializedCapabilities : (existing.ai_capabilities ?? null),
        contact.profile_pic_url ?? existing.profile_pic_url ?? null,
        isApprovedVal !== undefined ? isApprovedVal : existing.is_approved,
        approvedForJarvisVal !== undefined ? approvedForJarvisVal : (existing.approved_for_jarvis ?? existing.is_approved),
        contact.ai_enabled !== undefined ? (contact.ai_enabled ? 1 : 0) : existing.ai_enabled,
        ragEnabledVal !== undefined ? ragEnabledVal : (existing.rag_enabled ?? existing.is_approved),
        ragNamespaceStatusVal !== undefined ? ragNamespaceStatusVal : (existing.rag_namespace_status ?? 'active'),
        contact.voice_message_enabled !== undefined ? (contact.voice_message_enabled ? 1 : 0) : existing.voice_message_enabled,
        contact.voice_response_enabled !== undefined ? (contact.voice_response_enabled ? 1 : 0) : existing.voice_response_enabled,
        contact.wake_phrase_only !== undefined ? (contact.wake_phrase_only ? 1 : 0) : existing.wake_phrase_only,
        contact.respond_normal_messages !== undefined ? (contact.respond_normal_messages ? 1 : 0) : existing.respond_normal_messages,
        contact.memory_enabled !== undefined ? (contact.memory_enabled ? 1 : 0) : existing.memory_enabled,
        contact.response_delay_seconds ?? existing.response_delay_seconds ?? 180,
        contact.auto_send !== undefined ? (contact.auto_send ? 1 : 0) : existing.auto_send,
        contact.priority ?? existing.priority ?? 'normal',
        contact.custom_system_prompt !== undefined ? contact.custom_system_prompt : (existing.custom_system_prompt ?? null),
        now,
        existing.id
      );

      return this.getContact(existing.id)!;
    } else {
      return this.createSeparateContact(contact, cleanPhone, whatsappLid, whatsappPhoneId, now);
    }
  }

  private createSeparateContact(
    contact: {
      id: string;
      name: string;
      phone_number?: string | null;
      whatsapp_id?: string | null;
      whatsapp_phone_id?: string | null;
      alternate_names?: string | string[] | null;
      relationship?: string | null;
      description?: string | null;
      birthday?: string | null;
      anniversary?: string | null;
      important_dates?: string | null;
      birthday_message?: string | null;
      permissions?: string | Partial<ContactPermissions> | null;
      ai_capabilities?: string | Partial<AiCapabilities> | null;
      profile_pic_url?: string | null;
      is_approved?: boolean;
      approved_for_jarvis?: boolean;
      ai_enabled?: boolean;
      rag_enabled?: boolean;
      rag_namespace_status?: 'active' | 'disabled' | 'deleted';
      voice_message_enabled?: boolean;
      voice_response_enabled?: boolean;
      wake_phrase_only?: boolean;
      respond_normal_messages?: boolean;
      memory_enabled?: boolean;
      response_delay_seconds?: number;
      auto_send?: boolean;
      priority?: 'low' | 'normal' | 'high';
      custom_system_prompt?: string | null;
    },
    cleanPhone: string | null,
    whatsappLid: string | null,
    whatsappPhoneId: string | null,
    now: number
  ): DbContact {
    const initialAlts = Array.isArray(contact.alternate_names)
      ? contact.alternate_names
      : parseAlternateNames(contact.alternate_names as any);
    const cleanAlts = mergeAlternateNames(contact.name, [], initialAlts);

    const targetId = whatsappPhoneId || contact.id;
    const serializedPermissions = contact.permissions !== undefined
      ? (typeof contact.permissions === 'string' ? contact.permissions : JSON.stringify(contact.permissions))
      : JSON.stringify(DEFAULT_CONTACT_PERMISSIONS);

    const serializedCapabilities = contact.ai_capabilities !== undefined
      ? (typeof contact.ai_capabilities === 'string' ? contact.ai_capabilities : JSON.stringify(contact.ai_capabilities))
      : JSON.stringify(DEFAULT_AI_CAPABILITIES);

    const isAppr = contact.is_approved !== undefined ? (contact.is_approved ? 1 : 0) : (contact.approved_for_jarvis !== undefined ? (contact.approved_for_jarvis ? 1 : 0) : 0);
    const apprJarvis = contact.approved_for_jarvis !== undefined ? (contact.approved_for_jarvis ? 1 : 0) : isAppr;
    const ragEn = contact.rag_enabled !== undefined ? (contact.rag_enabled ? 1 : 0) : isAppr;
    const ragStatus = contact.rag_namespace_status || (isAppr === 0 ? 'disabled' : 'active');

    const stmt = this.db.prepare(`
      INSERT INTO contacts (
        id, name, phone_number, whatsapp_id, whatsapp_phone_id, alternate_names,
        relationship, description, birthday, anniversary, important_dates, birthday_message, permissions,
        ai_capabilities, profile_pic_url, is_approved, approved_for_jarvis, ai_enabled, rag_enabled, rag_namespace_status,
        voice_message_enabled, voice_response_enabled, wake_phrase_only, respond_normal_messages, memory_enabled,
        response_delay_seconds, auto_send, priority, custom_system_prompt, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        phone_number = COALESCE(excluded.phone_number, contacts.phone_number),
        whatsapp_id = COALESCE(excluded.whatsapp_id, contacts.whatsapp_id),
        whatsapp_phone_id = COALESCE(excluded.whatsapp_phone_id, contacts.whatsapp_phone_id),
        alternate_names = excluded.alternate_names,
        relationship = COALESCE(excluded.relationship, contacts.relationship),
        description = COALESCE(excluded.description, contacts.description),
        birthday = COALESCE(excluded.birthday, contacts.birthday),
        anniversary = COALESCE(excluded.anniversary, contacts.anniversary),
        important_dates = COALESCE(excluded.important_dates, contacts.important_dates),
        birthday_message = COALESCE(excluded.birthday_message, contacts.birthday_message),
        permissions = COALESCE(excluded.permissions, contacts.permissions),
        ai_capabilities = COALESCE(excluded.ai_capabilities, contacts.ai_capabilities),
        is_approved = excluded.is_approved,
        approved_for_jarvis = excluded.approved_for_jarvis,
        ai_enabled = excluded.ai_enabled,
        rag_enabled = excluded.rag_enabled,
        rag_namespace_status = excluded.rag_namespace_status,
        voice_message_enabled = excluded.voice_message_enabled,
        voice_response_enabled = excluded.voice_response_enabled,
        updated_at = excluded.updated_at
    `);

    (stmt.run as any)(
      targetId,
      contact.name,
      cleanPhone ? `+${cleanPhone}` : null,
      whatsappLid ?? null,
      whatsappPhoneId ?? null,
      JSON.stringify(cleanAlts),
      contact.relationship ?? null,
      contact.description ?? null,
      contact.birthday ?? null,
      contact.anniversary ?? null,
      contact.important_dates ?? null,
      contact.birthday_message ?? null,
      serializedPermissions,
      serializedCapabilities,
      contact.profile_pic_url ?? null,
      isAppr,
      apprJarvis,
      contact.ai_enabled !== undefined ? (contact.ai_enabled ? 1 : 0) : 0,
      ragEn,
      ragStatus,
      contact.voice_message_enabled !== undefined ? (contact.voice_message_enabled ? 1 : 0) : 0,
      contact.voice_response_enabled !== undefined ? (contact.voice_response_enabled ? 1 : 0) : 0,
      contact.wake_phrase_only !== undefined ? (contact.wake_phrase_only ? 1 : 0) : 1,
      contact.respond_normal_messages !== undefined ? (contact.respond_normal_messages ? 1 : 0) : 0,
      contact.memory_enabled !== undefined ? (contact.memory_enabled ? 1 : 0) : 1,
      contact.response_delay_seconds ?? 180,
      contact.auto_send !== undefined ? (contact.auto_send ? 1 : 0) : 1,
      contact.priority || 'normal',
      contact.custom_system_prompt ?? null,
      now,
      now
    );

    return this.getContact(targetId)!;
  }

  public setContactSimpleSettings(
    id: string,
    settings: {
      name?: string;
      is_approved?: boolean;
      approved_for_jarvis?: boolean;
      approvedForJarvis?: boolean;
      ai_enabled?: boolean;
      rag_enabled?: boolean;
      ragEnabled?: boolean;
      rag_namespace_status?: 'active' | 'disabled' | 'deleted';
      voice_message_enabled?: boolean;
      voice_response_enabled?: boolean;
      wake_phrase_only?: boolean;
      respond_normal_messages?: boolean;
      memory_enabled?: boolean;
      response_delay_seconds?: number;
      relationship?: string | null;
      description?: string | null;
      birthday?: string | null;
      anniversary?: string | null;
      important_dates?: string | null;
      birthday_message?: string | null;
      permissions?: string | Partial<ContactPermissions> | null;
      ai_capabilities?: string | Partial<AiCapabilities> | null;
      custom_system_prompt?: string | null;
    }
  ): DbContact | null {
    let contact = this.getContact(id);
    if (!contact) {
      contact = this.upsertContact({
        id,
        name: settings.name || id,
        is_approved: settings.is_approved ?? settings.approved_for_jarvis ?? settings.approvedForJarvis ?? true,
        ai_enabled: Boolean(settings.ai_enabled),
        rag_enabled: settings.rag_enabled ?? settings.ragEnabled ?? true,
        voice_message_enabled: Boolean(settings.voice_message_enabled),
        voice_response_enabled: Boolean(settings.voice_response_enabled)
      });
    }
    const now = Date.now();

    const serializedPermissions = settings.permissions !== undefined
      ? (typeof settings.permissions === 'string' ? settings.permissions : JSON.stringify(settings.permissions))
      : null;

    const serializedCapabilities = settings.ai_capabilities !== undefined
      ? (typeof settings.ai_capabilities === 'string' ? settings.ai_capabilities : JSON.stringify(settings.ai_capabilities))
      : null;

    const isApprParam = settings.is_approved !== undefined ? (settings.is_approved ? 1 : 0) : (settings.approved_for_jarvis !== undefined ? (settings.approved_for_jarvis ? 1 : 0) : (settings.approvedForJarvis !== undefined ? (settings.approvedForJarvis ? 1 : 0) : null));
    const ragEnParam = settings.rag_enabled !== undefined ? (settings.rag_enabled ? 1 : 0) : (settings.ragEnabled !== undefined ? (settings.ragEnabled ? 1 : 0) : (isApprParam !== null ? isApprParam : null));
    const ragNsParam = settings.rag_namespace_status !== undefined ? settings.rag_namespace_status : (isApprParam === 0 ? 'disabled' : (isApprParam === 1 ? 'active' : null));

    const stmt = this.db.prepare(`
      UPDATE contacts SET
        name = COALESCE(?, name),
        is_approved = COALESCE(?, is_approved),
        approved_for_jarvis = COALESCE(?, approved_for_jarvis),
        ai_enabled = COALESCE(?, ai_enabled),
        rag_enabled = COALESCE(?, rag_enabled),
        rag_namespace_status = COALESCE(?, rag_namespace_status),
        voice_message_enabled = COALESCE(?, voice_message_enabled),
        voice_response_enabled = COALESCE(?, voice_response_enabled),
        wake_phrase_only = COALESCE(?, wake_phrase_only),
        respond_normal_messages = COALESCE(?, respond_normal_messages),
        memory_enabled = COALESCE(?, memory_enabled),
        response_delay_seconds = COALESCE(?, response_delay_seconds),
        relationship = CASE WHEN ? = 1 THEN ? ELSE relationship END,
        description = CASE WHEN ? = 1 THEN ? ELSE description END,
        birthday = CASE WHEN ? = 1 THEN ? ELSE birthday END,
        anniversary = CASE WHEN ? = 1 THEN ? ELSE anniversary END,
        important_dates = CASE WHEN ? = 1 THEN ? ELSE important_dates END,
        birthday_message = CASE WHEN ? = 1 THEN ? ELSE birthday_message END,
        permissions = CASE WHEN ? = 1 THEN ? ELSE permissions END,
        ai_capabilities = CASE WHEN ? = 1 THEN ? ELSE ai_capabilities END,
        custom_system_prompt = CASE WHEN ? = 1 THEN ? ELSE custom_system_prompt END,
        updated_at = ?
      WHERE id = ?
    `);
    const isAiParam = settings.ai_enabled !== undefined ? (settings.ai_enabled ? 1 : 0) : (isApprParam === 0 ? 0 : null);
    const isVoiceMsgParam = settings.voice_message_enabled !== undefined ? (settings.voice_message_enabled ? 1 : 0) : null;
    const isVoiceRespParam = settings.voice_response_enabled !== undefined ? (settings.voice_response_enabled ? 1 : 0) : null;
    const hasPromptParam = settings.custom_system_prompt !== undefined ? 1 : 0;
    const hasRelParam = settings.relationship !== undefined ? 1 : 0;
    const hasDescParam = settings.description !== undefined ? 1 : 0;
    const hasBdayParam = settings.birthday !== undefined ? 1 : 0;
    const hasAnnivParam = settings.anniversary !== undefined ? 1 : 0;
    const hasDatesParam = settings.important_dates !== undefined ? 1 : 0;
    const hasBdayMsgParam = settings.birthday_message !== undefined ? 1 : 0;
    const hasPermsParam = settings.permissions !== undefined ? 1 : 0;
    const hasCapsParam = settings.ai_capabilities !== undefined ? 1 : 0;

    stmt.run(
      settings.name ?? null,
      isApprParam,
      isApprParam,
      isAiParam,
      ragEnParam,
      ragNsParam,
      isVoiceMsgParam,
      isVoiceRespParam,
      settings.wake_phrase_only !== undefined ? (settings.wake_phrase_only ? 1 : 0) : null,
      settings.respond_normal_messages !== undefined ? (settings.respond_normal_messages ? 1 : 0) : null,
      settings.memory_enabled !== undefined ? (settings.memory_enabled ? 1 : 0) : null,
      settings.response_delay_seconds ?? null,
      hasRelParam,
      settings.relationship ?? null,
      hasDescParam,
      settings.description ?? null,
      hasBdayParam,
      settings.birthday ?? null,
      hasAnnivParam,
      settings.anniversary ?? null,
      hasDatesParam,
      settings.important_dates ?? null,
      hasBdayMsgParam,
      settings.birthday_message ?? null,
      hasPermsParam,
      serializedPermissions,
      hasCapsParam,
      serializedCapabilities,
      hasPromptParam,
      settings.custom_system_prompt ?? null,
      now,
      contact.id
    );

    return this.getContact(contact.id);
  }

  public deleteContact(id: string): void {
    const stmt = this.db.prepare('DELETE FROM contacts WHERE id = ?');
    stmt.run(id);
  }

  // --- Routines ---
  public getRoutinesForContact(contactId: string): DbRoutine[] {
    const existing = this.findExistingContact(contactId);
    const targetId = existing ? existing.id : contactId;
    const stmt = this.db.prepare('SELECT * FROM routines WHERE contact_id = ? ORDER BY created_at ASC');
    return stmt.all(targetId) as unknown as DbRoutine[];
  }

  public getAllRoutines(): DbRoutine[] {
    const stmt = this.db.prepare('SELECT * FROM routines ORDER BY created_at ASC');
    return stmt.all() as unknown as DbRoutine[];
  }

  public getEnabledRoutines(): DbRoutine[] {
    const stmt = this.db.prepare('SELECT * FROM routines WHERE enabled = 1 ORDER BY created_at ASC');
    return stmt.all() as unknown as DbRoutine[];
  }

  public getRoutine(id: string): DbRoutine | null {
    const stmt = this.db.prepare('SELECT * FROM routines WHERE id = ?');
    return (stmt.get(id) as unknown as DbRoutine) || null;
  }

  public upsertRoutine(routine: {
    id?: string;
    contact_id: string;
    name: string;
    enabled?: boolean | number;
    type: DbRoutine['type'];
    time: string;
    timezone?: string;
    message: string;
    days_of_week?: string | string[] | null;
    day_of_month?: number | null;
    month?: number | null;
    date?: string | null;
    last_run_at?: number | null;
    next_run_at?: number | null;
  }): DbRoutine {
    const now = Date.now();
    const id = routine.id || `routine_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const existingContact = this.findExistingContact(routine.contact_id);
    const targetContactId = existingContact ? existingContact.id : routine.contact_id;
    const isEnabled = routine.enabled !== undefined ? (routine.enabled ? 1 : 0) : 1;
    const daysJson = routine.days_of_week !== undefined
      ? (Array.isArray(routine.days_of_week) ? JSON.stringify(routine.days_of_week) : routine.days_of_week)
      : null;
    const tz = routine.timezone || 'Asia/Kolkata';

    const stmt = this.db.prepare(`
      INSERT INTO routines (
        id, contact_id, name, enabled, type, time, timezone, message,
        days_of_week, day_of_month, month, date, last_run_at, next_run_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        contact_id = excluded.contact_id,
        name = excluded.name,
        enabled = excluded.enabled,
        type = excluded.type,
        time = excluded.time,
        timezone = excluded.timezone,
        message = excluded.message,
        days_of_week = excluded.days_of_week,
        day_of_month = excluded.day_of_month,
        month = excluded.month,
        date = excluded.date,
        next_run_at = excluded.next_run_at,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      id,
      targetContactId,
      routine.name,
      isEnabled,
      routine.type,
      routine.time,
      tz,
      routine.message,
      daysJson,
      routine.day_of_month ?? null,
      routine.month ?? null,
      routine.date ?? null,
      routine.last_run_at ?? null,
      routine.next_run_at ?? null,
      now,
      now
    );

    return this.getRoutine(id)!;
  }

  public deleteRoutine(id: string): void {
    const stmt = this.db.prepare('DELETE FROM routines WHERE id = ?');
    stmt.run(id);
  }

  public toggleRoutine(id: string, enabled: boolean): DbRoutine | null {
    const stmt = this.db.prepare('UPDATE routines SET enabled = ?, updated_at = ? WHERE id = ?');
    stmt.run(enabled ? 1 : 0, Date.now(), id);
    return this.getRoutine(id);
  }

  public markRoutineExecuted(id: string, executedAt: number, nextRunAt?: number | null): void {
    const stmt = this.db.prepare(`
      UPDATE routines 
      SET last_run_at = ?, next_run_at = ?, updated_at = ? 
      WHERE id = ?
    `);
    stmt.run(executedAt, nextRunAt ?? null, Date.now(), id);
  }

  // --- Calendar Events ---
  public createCalendarEvent(event: {
    id?: string;
    title: string;
    description?: string | null;
    date: string; // YYYY-MM-DD
    start_time?: string | null;
    end_time?: string | null;
    location?: string | null;
    created_by?: string;
    contact_id?: string | null;
  }): DbCalendarEvent {
    const id = event.id || `event_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO calendar_events (
        id, title, description, date, start_time, end_time, location, created_by, contact_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      event.title,
      event.description ?? null,
      event.date,
      event.start_time ?? null,
      event.end_time ?? null,
      event.location ?? null,
      event.created_by || 'Edwin',
      event.contact_id ?? null,
      now,
      now
    );
    return this.getCalendarEvent(id)!;
  }

  public getCalendarEvent(id: string): DbCalendarEvent | null {
    const stmt = this.db.prepare('SELECT * FROM calendar_events WHERE id = ?');
    return (stmt.get(id) as unknown as DbCalendarEvent) || null;
  }

  public getAllCalendarEvents(): DbCalendarEvent[] {
    const stmt = this.db.prepare('SELECT * FROM calendar_events ORDER BY date ASC, start_time ASC');
    return stmt.all() as unknown as DbCalendarEvent[];
  }

  public getCalendarEventsForDate(date: string): DbCalendarEvent[] {
    const stmt = this.db.prepare('SELECT * FROM calendar_events WHERE date = ? ORDER BY start_time ASC');
    return stmt.all(date) as unknown as DbCalendarEvent[];
  }

  public getCalendarEventsForRange(startDate: string, endDate: string): DbCalendarEvent[] {
    const stmt = this.db.prepare('SELECT * FROM calendar_events WHERE date >= ? AND date <= ? ORDER BY date ASC, start_time ASC');
    return stmt.all(startDate, endDate) as unknown as DbCalendarEvent[];
  }

  public updateCalendarEvent(id: string, updates: Partial<DbCalendarEvent>): DbCalendarEvent | null {
    const existing = this.getCalendarEvent(id);
    if (!existing) return null;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE calendar_events SET
        title = COALESCE(?, title),
        description = CASE WHEN ? = 1 THEN ? ELSE description END,
        date = COALESCE(?, date),
        start_time = CASE WHEN ? = 1 THEN ? ELSE start_time END,
        end_time = CASE WHEN ? = 1 THEN ? ELSE end_time END,
        location = CASE WHEN ? = 1 THEN ? ELSE location END,
        contact_id = CASE WHEN ? = 1 THEN ? ELSE contact_id END,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      updates.title ?? null,
      updates.description !== undefined ? 1 : 0, updates.description ?? null,
      updates.date ?? null,
      updates.start_time !== undefined ? 1 : 0, updates.start_time ?? null,
      updates.end_time !== undefined ? 1 : 0, updates.end_time ?? null,
      updates.location !== undefined ? 1 : 0, updates.location ?? null,
      updates.contact_id !== undefined ? 1 : 0, updates.contact_id ?? null,
      now,
      id
    );
    return this.getCalendarEvent(id);
  }

  public deleteCalendarEvent(id: string): void {
    const stmt = this.db.prepare('DELETE FROM calendar_events WHERE id = ?');
    stmt.run(id);
  }

  // --- Tasks / Delegated Tasks & Reminders ---
  public createTask(task: {
    id?: string;
    title: string;
    description?: string | null;
    requester_contact_id?: string | null;
    canonical_phone_id?: string | null;
    whatsapp_lid?: string | null;
    requester_display_name?: string | null;
    owner_id?: string;
    due_date?: string | null;
    due_time?: string | null;
    reminder_time?: number | null;
    reminder_sent?: number;
    status?: 'pending' | 'completed' | 'cancelled' | 'snoozed';
    source_message_id?: string | null;
  }): DbTask {
    const id = task.id || `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, requester_contact_id, canonical_phone_id, whatsapp_lid,
        requester_display_name, owner_id, due_date, due_time, reminder_time, reminder_sent,
        status, source_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      id,
      task.title,
      task.description ?? null,
      task.requester_contact_id ?? null,
      task.canonical_phone_id ?? null,
      task.whatsapp_lid ?? null,
      task.requester_display_name ?? null,
      task.owner_id || 'Edwin',
      task.due_date ?? null,
      task.due_time ?? null,
      task.reminder_time ?? null,
      task.reminder_sent !== undefined ? task.reminder_sent : 0,
      task.status || 'pending',
      task.source_message_id ?? null,
      now,
      now
    );
    return this.getTask(id)!;
  }

  public getTask(id: string | { id: string }): DbTask | null {
    const rawId = typeof id === 'object' && id !== null ? (id as any).id : id;
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?');
    return (stmt.get(rawId) as unknown as DbTask) || null;
  }

  public getAllTasks(statusFilter?: string): DbTask[] {
    if (statusFilter && statusFilter !== 'all') {
      const stmt = this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY due_date ASC, due_time ASC, created_at DESC');
      return stmt.all(statusFilter) as unknown as DbTask[];
    }
    const stmt = this.db.prepare('SELECT * FROM tasks ORDER BY due_date ASC, due_time ASC, created_at DESC');
    return stmt.all() as unknown as DbTask[];
  }

  public getTasksForContact(contactId: string): DbTask[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE requester_contact_id = ? OR canonical_phone_id = ? OR whatsapp_lid = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(contactId, contactId, contactId) as unknown as DbTask[];
  }

  public getLatestPendingTaskForContact(contactId: string): DbTask | null {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE (requester_contact_id = ? OR canonical_phone_id = ? OR whatsapp_lid = ?) 
        AND status = 'pending' 
      ORDER BY created_at DESC LIMIT 1
    `);
    return (stmt.get(contactId, contactId, contactId) as unknown as DbTask) || null;
  }

  public getDueTasks(nowTimestamp: number = Date.now()): DbTask[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE status = 'pending' 
        AND reminder_sent = 0 
        AND reminder_time IS NOT NULL 
        AND reminder_time <= ?
      ORDER BY reminder_time ASC
    `);
    return stmt.all(nowTimestamp) as unknown as DbTask[];
  }

  public updateTask(id: string, updates: Partial<DbTask>): DbTask | null {
    const existing = this.getTask(id);
    if (!existing) return null;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE tasks SET
        title = COALESCE(?, title),
        description = CASE WHEN ? = 1 THEN ? ELSE description END,
        due_date = CASE WHEN ? = 1 THEN ? ELSE due_date END,
        due_time = CASE WHEN ? = 1 THEN ? ELSE due_time END,
        reminder_time = CASE WHEN ? = 1 THEN ? ELSE reminder_time END,
        reminder_sent = COALESCE(?, reminder_sent),
        status = COALESCE(?, status),
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
      updates.title ?? null,
      updates.description !== undefined ? 1 : 0, updates.description ?? null,
      updates.due_date !== undefined ? 1 : 0, updates.due_date ?? null,
      updates.due_time !== undefined ? 1 : 0, updates.due_time ?? null,
      updates.reminder_time !== undefined ? 1 : 0, updates.reminder_time ?? null,
      updates.reminder_sent !== undefined ? updates.reminder_sent : null,
      updates.status ?? null,
      now,
      id
    );
    return this.getTask(id);
  }

  public updateTaskStatus(id: string, status: DbTask['status']): DbTask | null {
    const stmt = this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');
    stmt.run(status, Date.now(), id);
    return this.getTask(id);
  }

  public snoozeTask(id: string, minutes: number = 60, newDueDate?: string, newDueTime?: string): DbTask | null {
    const existing = this.getTask(id);
    if (!existing) return null;
    const now = Date.now();
    const newReminderTime = now + minutes * 60 * 1000;
    const stmt = this.db.prepare(`
      UPDATE tasks SET
        status = 'snoozed',
        reminder_sent = 0,
        reminder_time = ?,
        due_date = COALESCE(?, due_date),
        due_time = COALESCE(?, due_time),
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(newReminderTime, newDueDate ?? null, newDueTime ?? null, now, id);
    return this.getTask(id);
  }

  public markTaskReminderSent(id: string): void {
    const stmt = this.db.prepare('UPDATE tasks SET reminder_sent = 1, updated_at = ? WHERE id = ?');
    stmt.run(Date.now(), id);
  }

  public deleteTask(id: string): void {
    const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');
    stmt.run(id);
  }

  // --- Contact Important Dates ---
  public getContactImportantDates(): Array<{
    contact_id: string;
    name: string;
    phone_number: string | null;
    relationship: string | null;
    birthday: string | null;
    anniversary: string | null;
    important_dates: string | null;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, id as contact_id, name, phone_number, relationship, birthday, anniversary, important_dates
      FROM contacts
      WHERE (birthday IS NOT NULL AND birthday != '')
         OR (anniversary IS NOT NULL AND anniversary != '')
         OR (important_dates IS NOT NULL AND important_dates != '')
      ORDER BY name ASC
    `);
    return stmt.all() as any[];
  }

  // --- Conversations ---
  public getActiveConversation(contactId: string): DbConversation | null {
    const stmt = this.db.prepare(`
      SELECT * FROM conversations 
      WHERE contact_id = ? AND status = 'active' 
      ORDER BY last_message_at DESC LIMIT 1
    `);
    return (stmt.get(contactId) as unknown as DbConversation) || null;
  }

  public getAllConversations(): (DbConversation & { contact_name?: string; last_message_text?: string })[] {
    const stmt = this.db.prepare(`
      SELECT c.*, ct.name as contact_name,
        (SELECT message_text FROM messages m WHERE m.conversation_id = c.id ORDER BY m.timestamp DESC LIMIT 1) as last_message_text
      FROM conversations c
      LEFT JOIN contacts ct ON c.contact_id = ct.id
      ORDER BY c.last_message_at DESC
    `);
    return stmt.all() as unknown as (DbConversation & { contact_name?: string; last_message_text?: string })[];
  }

  public createConversation(contactId: string): DbConversation {
    const existingContact = this.findExistingContact(contactId);
    const targetContactId = existingContact ? existingContact.id : contactId;
    const id = `conv_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO conversations (id, contact_id, status, started_at, last_message_at, message_count)
      VALUES (?, ?, 'active', ?, ?, 1)
    `);
    stmt.run(id, targetContactId, now, now);
    return {
      id,
      contact_id: targetContactId,
      status: 'active',
      started_at: now,
      last_message_at: now,
      message_count: 1
    };
  }

  public updateConversationMessageCount(conversationId: string, count: number): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE conversations 
      SET message_count = ?, last_message_at = ? 
      WHERE id = ?
    `);
    stmt.run(count, now, conversationId);
  }

  public setConversationStatus(conversationId: string, status: 'active' | 'idle' | 'cancelled' | 'responded'): void {
    const stmt = this.db.prepare('UPDATE conversations SET status = ? WHERE id = ?');
    stmt.run(status, conversationId);
  }

  // --- Messages ---
  public saveMessage(message: {
    id: string;
    contactId: string;
    conversationId?: string | null;
    direction: 'incoming' | 'outgoing';
    messageText: string;
    rawPayload?: any;
    processed?: boolean;
    triggerType?: string | null;
    isManualReply?: boolean;
    timestamp?: number;
  }): void {
    const existingContact = this.findExistingContact(message.contactId);
    const targetContactId = existingContact ? existingContact.id : message.contactId;
    const ts = message.timestamp ?? Date.now();
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, contact_id, conversation_id, direction, message_text, raw_payload, processed, trigger_type, is_manual_reply, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      targetContactId,
      message.conversationId ?? null,
      message.direction,
      message.messageText,
      message.rawPayload ? JSON.stringify(message.rawPayload) : null,
      message.processed ? 1 : 0,
      message.triggerType ?? null,
      message.isManualReply ? 1 : 0,
      ts
    );
  }

  public getMessagesForConversation(conversationId: string): DbMessage[] {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC');
    return stmt.all(conversationId) as unknown as DbMessage[];
  }

  public getRecentMessagesForContact(contactId: string, limit: number = 50): DbMessage[] {
    const stmt = this.db.prepare('SELECT * FROM messages WHERE contact_id = ? ORDER BY timestamp DESC LIMIT ?');
    const rows = stmt.all(contactId, limit) as unknown as DbMessage[];
    return rows.reverse();
  }

  public deleteMessagesForContact(contactId: string): void {
    const stmt = this.db.prepare('DELETE FROM messages WHERE contact_id = ?');
    stmt.run(contactId);
  }

  // --- AI Drafts ---
  public saveAiDraft(draft: {
    id: string;
    contactId: string;
    conversationId: string;
    incomingMessageId?: string | null;
    draftText: string;
    model: string;
    latencyMs: number;
  }): DbAiDraft {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO ai_drafts (id, contact_id, conversation_id, incoming_message_id, draft_text, status, model, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);
    stmt.run(
      draft.id,
      draft.contactId,
      draft.conversationId,
      draft.incomingMessageId ?? null,
      draft.draftText,
      draft.model,
      draft.latencyMs,
      now
    );
    return {
      id: draft.id,
      contact_id: draft.contactId,
      conversation_id: draft.conversationId,
      incoming_message_id: draft.incomingMessageId ?? null,
      draft_text: draft.draftText,
      status: 'pending',
      model: draft.model,
      latency_ms: draft.latencyMs,
      created_at: now
    };
  }

  public getPendingAiDrafts(contactId?: string): DbAiDraft[] {
    if (contactId) {
      const stmt = this.db.prepare('SELECT * FROM ai_drafts WHERE contact_id = ? AND status = \'pending\' ORDER BY created_at DESC');
      return stmt.all(contactId) as unknown as DbAiDraft[];
    }
    const stmt = this.db.prepare('SELECT * FROM ai_drafts WHERE status = \'pending\' ORDER BY created_at DESC');
    return stmt.all() as unknown as DbAiDraft[];
  }

  public setAiDraftStatus(draftId: string, status: 'approved' | 'rejected' | 'edited', updatedText?: string): void {
    if (updatedText !== undefined) {
      const stmt = this.db.prepare('UPDATE ai_drafts SET status = ?, draft_text = ? WHERE id = ?');
      stmt.run(status, updatedText, draftId);
    } else {
      const stmt = this.db.prepare('UPDATE ai_drafts SET status = ? WHERE id = ?');
      stmt.run(status, draftId);
    }
  }

  public getAiDraft(draftId: string): DbAiDraft | null {
    const stmt = this.db.prepare('SELECT * FROM ai_drafts WHERE id = ?');
    return (stmt.get(draftId) as unknown as DbAiDraft) || null;
  }

  // --- Pending Responses ---
  public createPendingResponse(pending: {
    id: string;
    contactId: string;
    conversationId: string;
    sourceMessageId?: string | null;
    latestMessageId?: string | null;
    triggerType: string;
    timerExpiresAt: number;
    scheduledAt?: number;
    bootSessionId?: string;
  }): void {
    const contactRow = this.getContact(pending.contactId);
    console.log('[PENDING RESPONSE DEBUG]');
    console.log('contactId:', pending.contactId);
    console.log('contactId type:', typeof pending.contactId);
    console.log('whatsappLid:', contactRow?.whatsapp_id || 'null');
    console.log('whatsappPhoneId:', contactRow?.whatsapp_phone_id || 'null');
    console.log('phoneNumber:', contactRow?.phone_number || 'null');
    console.log('messageId:', pending.id);
    console.log('referenced contact exists in DB:', Boolean(contactRow));

    const now = Date.now();
    const scheduledAt = pending.scheduledAt ?? now;
    const bootSession = pending.bootSessionId ?? this.bootSessionId;

    const stmt = this.db.prepare(`
      INSERT INTO pending_responses (
        id, contact_id, conversation_id, source_message_id, latest_message_id,
        trigger_type, timer_expires_at, scheduled_at, status, boot_session_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);
    stmt.run(
      pending.id,
      pending.contactId,
      pending.conversationId,
      pending.sourceMessageId ?? null,
      pending.latestMessageId ?? null,
      pending.triggerType,
      pending.timerExpiresAt,
      scheduledAt,
      bootSession,
      now,
      now
    );
  }

  public getPendingResponseById(id: string): DbPendingResponse | null {
    if (!id) return null;
    const stmt = this.db.prepare('SELECT * FROM pending_responses WHERE id = ?');
    return (stmt.get(id) as unknown as DbPendingResponse) || null;
  }

  public getPendingResponseForContact(contactId: string): DbPendingResponse | null {
    const stmt = this.db.prepare(`
      SELECT * FROM pending_responses 
      WHERE contact_id = ? AND status = 'pending' 
      ORDER BY created_at DESC LIMIT 1
    `);
    return (stmt.get(contactId) as unknown as DbPendingResponse) || null;
  }

  public cancelPendingResponse(id?: string | null, reason: string = ''): void {
    if (!id) return;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE pending_responses 
      SET status = 'cancelled', cancellation_reason = ?, cancelled_at = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(reason, now, now, id);
  }

  public markPendingResponseExecuted(id?: string | null): void {
    if (!id) return;
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE pending_responses 
      SET status = 'executed', updated_at = ?
      WHERE id = ?
    `);
    stmt.run(now, id);
  }

  // --- Persistent Message Processing State Machine ---
  public saveMessageProcessingState(state: {
    message_id: string;
    contact_id: string;
    canonical_phone_id?: string | null;
    event_source?: string;
    received_at?: number;
    owner_seen_at?: number | null;
    owner_replied_at?: number | null;
    jarvis_replied_at?: number | null;
    processed_at?: number | null;
    status: MessageProcessingStatus;
    terminal_reason?: string | null;
    boot_session_id?: string;
  }): DbMessageProcessingState {
    const now = Date.now();
    const receivedAt = state.received_at ?? now;
    const bootSession = state.boot_session_id ?? this.bootSessionId;

    const stmt = this.db.prepare(`
      INSERT INTO message_processing_states (
        message_id, contact_id, canonical_phone_id, event_source, received_at,
        owner_seen_at, owner_replied_at, jarvis_replied_at, processed_at, status,
        terminal_reason, boot_session_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        contact_id = excluded.contact_id,
        canonical_phone_id = COALESCE(excluded.canonical_phone_id, message_processing_states.canonical_phone_id),
        owner_seen_at = COALESCE(excluded.owner_seen_at, message_processing_states.owner_seen_at),
        owner_replied_at = COALESCE(excluded.owner_replied_at, message_processing_states.owner_replied_at),
        jarvis_replied_at = COALESCE(excluded.jarvis_replied_at, message_processing_states.jarvis_replied_at),
        processed_at = COALESCE(excluded.processed_at, message_processing_states.processed_at),
        status = excluded.status,
        terminal_reason = COALESCE(excluded.terminal_reason, message_processing_states.terminal_reason),
        updated_at = excluded.updated_at
    `);

    stmt.run(
      state.message_id,
      state.contact_id,
      state.canonical_phone_id ?? null,
      state.event_source || 'message',
      receivedAt,
      state.owner_seen_at ?? null,
      state.owner_replied_at ?? null,
      state.jarvis_replied_at ?? null,
      state.processed_at ?? null,
      state.status,
      state.terminal_reason ?? null,
      bootSession,
      now,
      now
    );

    return this.getMessageProcessingState(state.message_id)!;
  }

  public getMessageProcessingState(messageId: string): DbMessageProcessingState | null {
    if (!messageId) return null;
    const stmt = this.db.prepare('SELECT * FROM message_processing_states WHERE message_id = ?');
    return (stmt.get(messageId) as unknown as DbMessageProcessingState) || null;
  }

  public updateMessageProcessingState(messageId: string, updates: Partial<DbMessageProcessingState>): DbMessageProcessingState | null {
    const existing = this.getMessageProcessingState(messageId);
    if (!existing) return null;
    const now = Date.now();

    const stmt = this.db.prepare(`
      UPDATE message_processing_states SET
        owner_seen_at = COALESCE(?, owner_seen_at),
        owner_replied_at = COALESCE(?, owner_replied_at),
        jarvis_replied_at = COALESCE(?, jarvis_replied_at),
        processed_at = COALESCE(?, processed_at),
        status = COALESCE(?, status),
        terminal_reason = COALESCE(?, terminal_reason),
        updated_at = ?
      WHERE message_id = ?
    `);

    stmt.run(
      updates.owner_seen_at ?? null,
      updates.owner_replied_at ?? null,
      updates.jarvis_replied_at ?? null,
      updates.processed_at ?? null,
      updates.status ?? null,
      updates.terminal_reason ?? null,
      now,
      messageId
    );

    return this.getMessageProcessingState(messageId);
  }

  public markMessageSeenByOwner(messageId: string, contactId?: string): void {
    const now = Date.now();
    const existing = this.getMessageProcessingState(messageId);
    if (existing) {
      this.updateMessageProcessingState(messageId, {
        owner_seen_at: now,
        status: existing.status === 'RESPONDED' ? 'RESPONDED' : 'SEEN_BY_OWNER',
        terminal_reason: 'Owner has seen/read the message'
      });
    } else if (contactId) {
      this.saveMessageProcessingState({
        message_id: messageId,
        contact_id: contactId,
        owner_seen_at: now,
        status: 'SEEN_BY_OWNER',
        terminal_reason: 'Owner has seen/read the message'
      });
    }
  }

  public markMessageRepliedByOwner(contactId: string, messageId?: string): void {
    const now = Date.now();
    if (messageId) {
      this.updateMessageProcessingState(messageId, {
        owner_replied_at: now,
        status: 'ALREADY_HANDLED',
        terminal_reason: 'Owner replied personally'
      });
    } else {
      // Mark latest unhandled message for this contact as replied
      const stmt = this.db.prepare(`
        UPDATE message_processing_states 
        SET owner_replied_at = ?, status = 'ALREADY_HANDLED', terminal_reason = 'Owner replied personally', updated_at = ?
        WHERE contact_id = ? AND status IN ('RECEIVED', 'CLASSIFIED', 'PENDING', 'PROCESSING', 'SEEN_BY_OWNER')
      `);
      stmt.run(now, now, contactId);
    }
  }

  public markMessageRespondedByJarvis(messageId: string, contactId: string): void {
    const now = Date.now();
    this.saveMessageProcessingState({
      message_id: messageId,
      contact_id: contactId,
      jarvis_replied_at: now,
      processed_at: now,
      status: 'RESPONDED',
      terminal_reason: 'JARVIS sent automatic reply'
    });
  }

  public getUnresolvedMessageStates(): DbMessageProcessingState[] {
    const stmt = this.db.prepare(`
      SELECT * FROM message_processing_states 
      WHERE status IN ('RECEIVED', 'CLASSIFIED', 'PENDING', 'PROCESSING')
      ORDER BY received_at ASC
    `);
    return stmt.all() as unknown as DbMessageProcessingState[];
  }

  // --- Per-Contact RAG / Memory Chunks ---
  public saveContactMemoryChunk(chunk: DbContactMemoryChunk): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO contact_memory_chunks (
        id, contact_id, message_id, direction, content, keywords, importance_score, timestamp, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      chunk.id,
      chunk.contact_id,
      chunk.message_id ?? null,
      chunk.direction,
      chunk.content,
      chunk.keywords ?? null,
      chunk.importance_score ?? 1.0,
      chunk.timestamp,
      chunk.created_at || Date.now()
    );
  }

  public getContactMemoryChunks(contactId: string): DbContactMemoryChunk[] {
    const stmt = this.db.prepare(`
      SELECT * FROM contact_memory_chunks 
      WHERE contact_id = ? 
      ORDER BY timestamp DESC
    `);
    return stmt.all(contactId) as unknown as DbContactMemoryChunk[];
  }

  public deleteContactMemoryChunks(contactId: string): number {
    const stmt = this.db.prepare('DELETE FROM contact_memory_chunks WHERE contact_id = ?');
    const res = stmt.run(contactId) as any;
    return res?.changes || 0;
  }

  public getContactMemoryCount(contactId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM contact_memory_chunks WHERE contact_id = ?');
    const row = stmt.get(contactId) as { count: number } | undefined;
    return row?.count || 0;
  }

  public updateContactRagStatus(contactId: string, enabled: boolean, namespaceStatus: 'active' | 'disabled' | 'deleted' = 'active'): void {
    const stmt = this.db.prepare(`
      UPDATE contacts SET
        rag_enabled = ?,
        rag_namespace_status = ?,
        updated_at = ?
      WHERE id = ?
    `);
    stmt.run(enabled ? 1 : 0, namespaceStatus, Date.now(), contactId);
  }

  // --- Persistent AI Audit Logging ---
  public saveAiAuditLog(log: DbAiAuditLog): void {
    const stmt = this.db.prepare(`
      INSERT INTO ai_audit_logs (
        audit_event_id, timestamp, contact_id, canonical_phone_id, message_id,
        incoming_message, message_type, owner_availability, contact_permissions,
        conversation_state, rag_retrieval_metadata, model, provider, config_version,
        generated_response, latency_ms, token_usage, finish_reason, delivery_result,
        error_information, decision_summary
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.audit_event_id,
      log.timestamp || Date.now(),
      log.contact_id,
      log.canonical_phone_id ?? null,
      log.message_id ?? null,
      log.incoming_message,
      log.message_type || 'text',
      log.owner_availability,
      log.contact_permissions ?? null,
      log.conversation_state ?? null,
      log.rag_retrieval_metadata ?? null,
      log.model,
      log.provider,
      log.config_version || 'v1.0',
      log.generated_response,
      log.latency_ms || 0,
      log.token_usage ?? null,
      log.finish_reason ?? null,
      log.delivery_result || 'SUCCESS',
      log.error_information ?? null,
      log.decision_summary
    );
  }

  public getAiAuditLogs(limit: number = 50): DbAiAuditLog[] {
    const stmt = this.db.prepare('SELECT * FROM ai_audit_logs ORDER BY timestamp DESC LIMIT ?');
    return stmt.all(limit) as unknown as DbAiAuditLog[];
  }

  public getAiAuditLogsForContact(contactId: string, limit: number = 50): DbAiAuditLog[] {
    const stmt = this.db.prepare('SELECT * FROM ai_audit_logs WHERE contact_id = ? ORDER BY timestamp DESC LIMIT ?');
    return stmt.all(contactId, limit) as unknown as DbAiAuditLog[];
  }

  // --- Incident Timeline ---
  public addTimelineEvent(event: {
    message_id: string;
    contact_id: string;
    stage: string;
    description: string;
    metadata?: any;
    timestamp?: number;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO incident_timeline (message_id, contact_id, stage, description, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      event.message_id,
      event.contact_id,
      event.stage,
      event.description,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.timestamp || Date.now()
    );
  }

  public getTimelineForMessage(messageId: string): DbIncidentTimelineEvent[] {
    const stmt = this.db.prepare('SELECT * FROM incident_timeline WHERE message_id = ? ORDER BY timestamp ASC, id ASC');
    return stmt.all(messageId) as unknown as DbIncidentTimelineEvent[];
  }

  public getTimelineForContact(contactId: string, limit: number = 100): DbIncidentTimelineEvent[] {
    const stmt = this.db.prepare('SELECT * FROM incident_timeline WHERE contact_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?');
    return stmt.all(contactId, limit) as unknown as DbIncidentTimelineEvent[];
  }

  // --- Owner Availability ---
  public getOwnerAvailability(): 'available' | 'unavailable' | 'busy' | 'auto' {
    const setting = this.getSetting('owner_availability');
    if (setting === 'available' || setting === 'busy' || setting === 'auto') {
      return setting;
    }
    return 'unavailable';
  }

  public setOwnerAvailability(status: 'available' | 'unavailable' | 'busy' | 'auto'): void {
    this.setSetting('owner_availability', status);
  }

  public isOwnerAvailable(): boolean {
    return this.getOwnerAvailability() === 'available';
  }

  // --- Startup Recovery Reconciliation Algorithm ---
  public reconcileStartupState(): { cancelledPendingCount: number; suppressedMessageCount: number } {
    let cancelledPendingCount = 0;
    let suppressedMessageCount = 0;
    try {
      const now = Date.now();

      // 1. Cancel all lingering pending responses from old boot sessions or expired timers
      const cancelStmt = this.db.prepare(`
        UPDATE pending_responses
        SET status = 'cancelled',
            cancellation_reason = 'Server restart / reboot: Stale pending response cancelled',
            cancelled_at = ?,
            updated_at = ?
        WHERE status = 'pending' AND (boot_session_id != ? OR timer_expires_at <= ?)
      `);
      const cancelRes = cancelStmt.run(now, now, this.bootSessionId, now) as any;
      cancelledPendingCount = cancelRes?.changes || 0;

      // 2. Suppress unhandled messages received prior to restart or already seen by owner
      // Case A: Owner saw the message before reboot (owner_seen_at != null) -> Mark SEEN_BY_OWNER
      const seenStmt = this.db.prepare(`
        UPDATE message_processing_states
        SET status = 'SEEN_BY_OWNER',
            terminal_reason = 'Suppressed on reboot: Message was seen by owner before restart',
            updated_at = ?
        WHERE status IN ('RECEIVED', 'CLASSIFIED', 'PENDING', 'PROCESSING')
          AND owner_seen_at IS NOT NULL
      `);
      const seenRes = seenStmt.run(now) as any;

      // Case B: Old unhandled messages from prior boot sessions -> Mark ALREADY_HANDLED (conservative restart recovery)
      const oldMsgStmt = this.db.prepare(`
        UPDATE message_processing_states
        SET status = 'ALREADY_HANDLED',
            terminal_reason = 'Suppressed on reboot: Historical unhandled message prior to restart',
            updated_at = ?
        WHERE status IN ('RECEIVED', 'CLASSIFIED', 'PENDING', 'PROCESSING')
          AND boot_session_id != ?
      `);
      const oldMsgRes = oldMsgStmt.run(now, this.bootSessionId) as any;

      suppressedMessageCount = (seenRes?.changes || 0) + (oldMsgRes?.changes || 0);

      this.addLog('info', 'DatabaseRecovery', `Startup reconciliation completed: ${cancelledPendingCount} pending responses cancelled, ${suppressedMessageCount} historical messages suppressed.`, {
        bootSessionId: this.bootSessionId,
        cancelledPendingCount,
        suppressedMessageCount
      });
    } catch (err: any) {
      console.error('[DB RECOVERY ERROR] Failed during startup reconciliation:', err?.message || err);
    }
    return { cancelledPendingCount, suppressedMessageCount };
  }

  // --- Logs ---
  public addLog(level: string, module: string, message: string, metadata?: any): void {
    const stmt = this.db.prepare(`
      INSERT INTO logs (level, module, message, metadata, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      level,
      module,
      message,
      metadata ? JSON.stringify(metadata) : null,
      Date.now()
    );
  }

  public getRecentLogs(limit: number = 80): DbLog[] {
    const stmt = this.db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT ?');
    return stmt.all(limit) as unknown as DbLog[];
  }

  public close(): void {
    this.db.close();
  }
}

export const db = new JarvisDatabase();


-- JARVIS WhatsApp Automation System SQLite Schema
-- Production Clean: Zero seeded/demo data

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT,
  whatsapp_id TEXT, -- WhatsApp LID (e.g. 271025438752789@lid)
  whatsapp_phone_id TEXT, -- WhatsApp Phone JID (e.g. 916282076955@c.us)
  alternate_names TEXT, -- JSON array of string aliases e.g. ["John Work","Joseph"]
  profile_pic_url TEXT,
  relationship TEXT, -- Explicit relationship e.g. 'father', 'colleague', default null
  description TEXT, -- Per-contact custom prompt context/notes
  birthday TEXT, -- Birthday e.g. '01/01'
  anniversary TEXT, -- Anniversary e.g. '05/20'
  important_dates TEXT, -- Important dates notes or JSON
  birthday_message TEXT, -- Custom birthday message
  permissions TEXT, -- JSON string of ContactPermissions
  ai_capabilities TEXT, -- JSON string of AiCapabilities
  is_approved INTEGER NOT NULL DEFAULT 0,
  approved_for_jarvis INTEGER NOT NULL DEFAULT 0,
  ai_enabled INTEGER NOT NULL DEFAULT 0, -- 1: ON, 0: OFF
  rag_enabled INTEGER NOT NULL DEFAULT 0, -- 1: ON, 0: OFF
  rag_namespace_status TEXT NOT NULL DEFAULT 'active', -- 'active', 'disabled', 'deleted'
  voice_message_enabled INTEGER NOT NULL DEFAULT 0, -- 1: ON, 0: OFF
  voice_response_enabled INTEGER NOT NULL DEFAULT 0, -- 1: ON, 0: OFF
  wake_phrase_only INTEGER NOT NULL DEFAULT 1, -- 1: Respond when I say "Jarvis"
  respond_normal_messages INTEGER NOT NULL DEFAULT 0, -- 0: OFF by default
  memory_enabled INTEGER NOT NULL DEFAULT 1, -- 1: Remember this conversation
  response_delay_seconds INTEGER NOT NULL DEFAULT 180, -- Default: 3 minutes (180s)
  auto_send INTEGER NOT NULL DEFAULT 1,
  priority TEXT NOT NULL DEFAULT 'normal',
  custom_system_prompt TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL DEFAULT 'daily', -- 'daily', 'weekly', 'monthly', 'yearly', 'specific_date'
  time TEXT NOT NULL DEFAULT '08:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  message TEXT NOT NULL,
  days_of_week TEXT, -- JSON array e.g. '[1,3,5]'
  day_of_month INTEGER,
  month INTEGER,
  date TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  date TEXT NOT NULL, -- YYYY-MM-DD
  start_time TEXT, -- HH:MM
  end_time TEXT, -- HH:MM
  location TEXT,
  created_by TEXT NOT NULL DEFAULT 'Edwin',
  contact_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  requester_contact_id TEXT,
  canonical_phone_id TEXT,
  whatsapp_lid TEXT,
  requester_display_name TEXT,
  owner_id TEXT NOT NULL DEFAULT 'Edwin',
  due_date TEXT, -- YYYY-MM-DD
  due_time TEXT, -- HH:MM
  reminder_time INTEGER, -- epoch ms
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'cancelled', 'snoozed'
  source_message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (requester_contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS lid_mappings (
  lid TEXT PRIMARY KEY,
  whatsapp_phone_id TEXT NOT NULL,
  phone_number TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  started_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (contact_id) REFERENCES contacts(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  conversation_id TEXT,
  direction TEXT NOT NULL, -- 'incoming', 'outgoing'
  message_text TEXT NOT NULL,
  raw_payload TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  trigger_type TEXT, -- 'wake_phrase', 'normal', 'manual_reply', 'ai_reply'
  is_manual_reply INTEGER NOT NULL DEFAULT 0,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

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
  status TEXT NOT NULL, -- RECEIVED, CLASSIFIED, PENDING, PROCESSING, RESPONDED, IGNORED, ALREADY_HANDLED, OWNER_AVAILABLE, UNAUTHORIZED, PRIVACY_BLOCKED, SEEN_BY_OWNER, FAILED, CANCELLED
  terminal_reason TEXT,
  boot_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_responses (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_message_id TEXT,
  latest_message_id TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'conversation_collection',
  timer_expires_at INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL DEFAULT 0,
  cancelled_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'cancelled', 'executed', 'expired'
  cancellation_reason TEXT,
  boot_session_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contact_memory_chunks (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  message_id TEXT,
  direction TEXT NOT NULL, -- 'incoming', 'outgoing'
  content TEXT NOT NULL,
  keywords TEXT, -- tokenized search keywords
  importance_score REAL NOT NULL DEFAULT 1.0,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
);

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

CREATE TABLE IF NOT EXISTS incident_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  description TEXT NOT NULL,
  metadata TEXT,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_drafts (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  incoming_message_id TEXT,
  draft_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  module TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  timestamp INTEGER NOT NULL
);

-- Indexes for fast query lookups
CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_msg_state_contact_status ON message_processing_states(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_pending_contact_status ON pending_responses(contact_id, status);
CREATE INDEX IF NOT EXISTS idx_contact_memory_contact ON contact_memory_chunks(contact_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_contact ON ai_audit_logs(contact_id);
CREATE INDEX IF NOT EXISTS idx_ai_audit_message ON ai_audit_logs(message_id);
CREATE INDEX IF NOT EXISTS idx_incident_msg ON incident_timeline(message_id);
CREATE INDEX IF NOT EXISTS idx_incident_contact ON incident_timeline(contact_id);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_routines_contact ON routines(contact_id);
CREATE INDEX IF NOT EXISTS idx_routines_enabled ON routines(enabled);
CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date, due_time);
CREATE INDEX IF NOT EXISTS idx_tasks_requester ON tasks(requester_contact_id);

# 🤖 JARVIS: Privacy-First WhatsApp AI Automation

> **JARVIS is a privacy-first, self-hosted personal AI assistant for WhatsApp, featuring per-contact automation, human-like conversations, approved-user-only RAG, persistent memory, privacy controls, voice processing, scheduled routines, AI audit logs, and restart-safe message handling.**

---

## 🌟 Key Features

- 🔒 **Per-Contact Isolation & Strict Privacy Guard**
  - Fine-grained permission toggles per contact (view messages, notifications, calendar, files, location, personal details).
  - Fail-closed deterministic privacy guard intercepts unauthorized queries pre-AI and scans responses post-AI.
  - WhatsApp `@lid` identity normalization mapping ensuring numeric IDs never overwrite canonical phone identities.

- 🧠 **Per-Contact RAG & Long-Term Semantic Memory**
  - Isolated semantic memory and recent conversation vector context per approved contact.
  - Zero cross-contact memory leakage.
  - Multi-query batching with intelligent sliding window collection timers (60s configurable delay).

- ⚡ **Multi-Provider AI & Resilient Failover**
  - Primary provider support: **Groq** (`llama-3.3-70b-versatile` / `openai/gpt-oss-120b`).
  - Automatic fallback provider: **Google Gemini** (`gemini-1.5-flash`).
  - Local AI support: **Ollama** & **LM Studio**.
  - Natural multilingual support: Seamless English, Malayalam script, and Manglish responses.

- 🔄 **Restart Resilience & Message Reconciliation**
  - Persistent message lifecycle state machine (`PENDING_COLLECTION`, `PENDING_RESPONSE`, `PROCESSING`, `RESPONDED`, `IGNORED_MANUAL_REPLY`, `OWNER_AVAILABLE`, `PRIVACY_BLOCKED`).
  - Automatic recovery and response execution for pending messages across application restarts.
  - Owner availability awareness (auto-suppresses AI replies when owner is actively messaging).

- 🎙️ **Voice Processing (STT + TTS)**
  - Audio transcription via Groq Whisper / Gemini Audio.
  - Automated voice note responses with native audio rendering.
  - Handles mixed Malayalam-English voice queries.

- ⏰ **Scheduled Routines & Delegated Tasks**
  - Scheduled greetings and reminders with timezones, emojis, and multilingual text.
  - Delegated task scheduling with date/time parsing, snooze, and auto-completion.

- 📊 **Real-Time Glassmorphic Dashboard**
  - Modern web dashboard for contact management, permission controls, routine scheduling, and live AI audit event tracking.

---

## 🏗️ Architecture

```text
                               ┌──────────────────────────┐
                               │   Dashboard UI / HTTP    │
                               │    (server/api/server)   │
                               └────────────┬─────────────┘
                                            │
                               ┌────────────▼─────────────┐
                               │    JARVIS Orchestrator   │
                               │ (server/core/orchestrator│
                               └────────────┬─────────────┘
                                            │
                     ┌──────────────────────┼──────────────────────┐
                     ▼                      ▼                      ▼
          ┌────────────────────┐ ┌────────────────────┐ ┌────────────────────┐
          │  Automation Engine │ │    Privacy Guard   │ │ Routine Scheduler  │
          │ (Message Pipelines)│ │  (Capability RBAC) │ │ (Tasks & Reminders)│
          └──────────┬─────────┘ └──────────┬─────────┘ └──────────┬─────────┘
                     │                      │                      │
                     └──────────────────────┼──────────────────────┘
                                            │
                               ┌────────────▼─────────────┐
                               │    Failover AI Manager   │
                               │  ┌────────────────────┐  │
                               │  │ Groq (Primary)     │  │
                               │  ├────────────────────┤  │
                               │  │ Gemini (Fallback)  │  │
                               │  ├────────────────────┤  │
                               │  │ Ollama / LM Studio │  │
                               │  └────────────────────┘  │
                               └────────────┬─────────────┘
                                            │
                               ┌────────────▼─────────────┐
                               │      SQLite Database     │
                               │  - Contacts & @LID Maps  │
                               │  - Isolated RAG Vectors  │
                               │  - Persistent States     │
                               │  - AI Audit Logs         │
                               └──────────────────────────┘
```

---

## 📁 Repository Structure

```text
├── public/                    # Dashboard UI (HTML, CSS, JS)
├── server/
│   ├── ai/                    # Groq, Gemini, Ollama, Failover, and RAG Manager
│   ├── api/                   # REST API routes and dashboard backend
│   ├── core/                  # Configuration, orchestrator, and event bus
│   ├── database/              # SQLite schema, queries, and migrations
│   ├── utils/                 # Phone normalization and identity utilities
│   ├── voice/                 # Voice STT and TTS processing services
│   └── whatsapp/              # WhatsApp client, adapters, privacy guard, and tasks
├── tests/                     # 13+ Automated test suites (100% synthetic fixtures)
├── .env.example               # Environment template
└── package.json               # Node.js project manifest
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js** v20+ or v22+
- **npm**
- (Optional) **Groq API Key** and/or **Google Gemini API Key**

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/e4win2006/whatsapp-automation-with-ai-llm-.git
cd whatsapp-automation-with-ai-llm-

# Install dependencies
npm install
```

### 3. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` and supply your API keys:

```env
AI_PROVIDER=groq
AI_MODEL=llama-3.3-70b-versatile
GROQ_API_KEY=your_groq_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
PORT=3000
DATABASE_PATH=data/jarvis.db
```

### 4. Run Test Suite

Run the full automated test battery with mock fixtures:

```bash
npm test
```

### 5. Start JARVIS

```bash
# Development mode
npm run dev

# Production mode
npm start
```

Access the dashboard at `http://localhost:3000`.

---

## 🧪 Testing & Verification

The repository includes comprehensive automated test suites covering all features:

| Test Suite | Purpose |
| :--- | :--- |
| `tests/restart_recovery_and_rag_test.ts` | Tests per-contact RAG, message states, restart recovery, and audit logs |
| `tests/stabilization_test.ts` | Validates @lid identity resolution, race conditions, and error boundaries |
| `tests/voice_message_test.ts` | Validates voice transcription, multilingual speech, and audio notes |
| `tests/privacy_and_routines_test.ts` | Validates fail-closed privacy guards, permissions, and routines |
| `tests/calendar_task_test.ts` | Validates delegated task creation, snooze, and auto-reminders |
| `tests/failover_test.ts` | Validates seamless AI failover between Groq, Gemini, and local fallbacks |

To run all tests:
```bash
npx tsx tests/restart_recovery_and_rag_test.ts
npx tsx tests/voice_message_test.ts
npx tsx tests/stabilization_test.ts
```

---

## 🛡️ Privacy & Security Commitments

- **Zero Phonebook Scraping**: Unapproved contacts are completely ignored by default.
- **Fail-Closed RBAC**: Contact capabilities must be explicitly enabled in the dashboard.
- **Isolated RAG Stores**: Vector context is partitioned strictly per canonical phone identity.
- **Clean Release Guarantee**: No real WhatsApp sessions, personal chat dumps, or credentials are ever included in this repository.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

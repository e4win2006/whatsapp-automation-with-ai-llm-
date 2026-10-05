# JARVIS WhatsApp Automation System

A modular, production-quality personal **JARVIS WhatsApp Automation System** built with Node.js, TypeScript, SQLite, and an event-driven architecture.

---

## 🏗️ Architectural Overview (Phases 1 & 2 Completed)

```text
                         ┌──────────────────────────┐
                         │    JARVIS Orchestrator   │
                         │  (server/core/orchestrator.ts)
                         └────────────┬─────────────┘
                                      │
                               Intent / Events
                                      │
                         ┌────────────▼─────────────┐
                         │     WhatsApp Manager     │
                         │ (server/whatsapp/client.ts)
                         └────────────┬─────────────┘
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
        ┌───────────────────────┐             ┌───────────────────────┐
        │   MockWhatsAppAdapter  │             │  WhatsAppWebAdapter   │
        │(Testing / Simulation) │             │ (whatsapp-web.js Auth)│
        └───────────────────────┘             └───────────────────────┘
                   │                                     │
                   └──────────────────┬──────────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │   Strongly-Typed EventBus │
                         │ (server/core/eventBus.ts) │
                         └────────────┬─────────────┘
                                      │
                         ┌────────────▼─────────────┐
                         │     SQLite Database      │
                         │ (server/database/database.ts)
                         └──────────────────────────┘
```

---

## 📁 Complete File Tree

```text
d:/whatsapp automation/
├── .env                       # Local environment configuration
├── .env.example               # Configuration template with defaults
├── package.json               # Dependencies and execution scripts
├── tsconfig.json              # TypeScript configuration (ES2022 / NodeNext)
├── README.md                  # System documentation & run guide
│
├── server/
│   ├── index.ts               # Application entry point & lifecycle hooks
│   │
│   ├── core/
│   │   ├── config.ts          # Zod schema validation & environment loader
│   │   ├── eventBus.ts        # Typed pub/sub event bus with full JARVIS event types
│   │   └── orchestrator.ts    # Central coordinator for subsystems & lifecycle
│   │
│   ├── database/
│   │   ├── schema.sql         # SQLite DDL schema (contacts, messages, conversations, logs)
│   │   └── database.ts        # Node:sqlite DatabaseSync typed service layer
│   │
│   └── whatsapp/
│       ├── client.ts          # WhatsAppManager with deduplication & persistence
│       └── adapters/
│           ├── adapterInterface.ts  # IWhatsAppAdapter contract
│           ├── mockAdapter.ts       # Mock adapter with test simulators
│           └── webAdapter.ts        # Modular whatsapp-web.js adapter
│
├── tests/
│   └── phase1_2_test.ts       # Automated 16-point verification test suite
│
└── data/                      # SQLite database files and session data (auto-generated)
```

---

## 🚀 How to Run Locally

### 1. Prerequisites
- Node.js (v20+ or v24+)
- npm

### 2. Install Dependencies
```bash
npm install
```

### 3. Run the Automated Verification Suite
To verify Phase 1 (Database, Schema, EventBus, Config) and Phase 2 (Mock WhatsApp Adapter, Deduplication, Event Routing):
```bash
npm test
```

### 4. Start the JARVIS Development Core
```bash
npm run dev
```

---

## ⚙️ Configuration (`.env`)

| Variable | Description | Default |
|---|---|---|
| `PORT` | API Server Port | `3000` |
| `WHATSAPP_ADAPTER` | Adapter mode (`mock` or `web`) | `mock` |
| `DATABASE_PATH` | Path to SQLite database file | `./data/jarvis.db` |
| `AUTOMATION_MASTER_SWITCH` | Emergency master switch | `true` |
| `DEFAULT_RESPONSE_DELAY_SECONDS` | Conversation window wait delay | `180` |
| `WAKE_PHRASES` | Comma-separated wake words | `Hey Jarvis,Hi Jarvis,Jarvis...` |
| `AI_PROVIDER` | AI backend (`mock`, `lmstudio`, `ollama`) | `mock` |

---

## 🧪 Simulation Capabilities in `MockWhatsAppAdapter`

The mock adapter enables 100% offline development and unit testing without touching real WhatsApp credentials:

```typescript
import { MockWhatsAppAdapter } from './server/whatsapp/adapters/mockAdapter';

const adapter = new MockWhatsAppAdapter();

// Simulate incoming message from Mom
adapter.simulateIncomingMessage('1234567890@c.us', 'Hey Jarvis, are you free?');

// Simulate manual reply from user's phone (fromMe: true)
adapter.simulateManualUserReply('1234567890@c.us', 'Hold on, replying myself');
```

---

## 🗺️ Next Implementation Phases

- [x] **Phase 1**: Backend foundation, Configuration, Typed EventBus, SQLite Database & Schema.
- [x] **Phase 2**: Decoupled WhatsApp Adapter Interface, Mock Provider & Web Adapter scaffold.
- [ ] **Phase 3**: Contact Approval & Whitelisting Filter Engine.
- [ ] **Phase 4**: Wake Phrase Analyzer & Rule Trigger.
- [ ] **Phase 5**: Conversation Collector with Sliding Window Delay Timer.
- [ ] **Phase 6**: Manual Reply Override & Race Condition Lock.
- [ ] **Phase 7**: AI Providers (Ollama & LM Studio integrations).
- [ ] **Phase 8**: Express REST API & WebSocket Realtime Gateway.
- [ ] **Phase 9**: Modern JARVIS Glassmorphism Dashboard (React + TypeScript).
- [ ] **Phase 10**: End-to-End Test Suite, Rate Limiting & Production Hardening.

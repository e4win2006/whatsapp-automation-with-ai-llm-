import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { config } from '../core/config';
import { db } from '../database/database';
import { contactManager } from '../whatsapp/contactManager';
import { automationEngine } from '../whatsapp/automationEngine';
import { whatsappManager } from '../whatsapp/client';
import { WhatsAppWebAdapter } from '../whatsapp/adapters/webAdapter';
import { getAiProvider } from '../ai';
import { eventBus } from '../core/eventBus';

export class ApiServer {
  public app: express.Application;
  public server: http.Server;
  private wss: WebSocketServer;
  private isListening: boolean = false;

  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.setupEventForwarding();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());

    const publicPath = path.resolve(__dirname, '../../public');
    this.app.use(express.static(publicPath));
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const adapter = whatsappManager.getAdapter();
      const qrDataUrl = adapter instanceof WhatsAppWebAdapter ? adapter.getQrDataUrl() : null;
      const accountInfo = adapter instanceof WhatsAppWebAdapter ? adapter.getAccountInfo() : null;

      ws.send(JSON.stringify({
        type: 'INIT_STATE',
        payload: {
          whatsappStatus: whatsappManager.getStatus(),
          accountInfo,
          qrCode: qrDataUrl,
          masterSwitch: automationEngine.isMasterAutomationEnabled(),
          responseDelay: automationEngine.getDelaySeconds(),
          wakePhrases: automationEngine.getWakePhrases(),
          activeTimers: automationEngine.getActiveTimers(),
          aiProvider: db.getSetting('ai_provider') || config.AI_PROVIDER
        }
      }));
    });
  }

  public broadcast(type: string, payload: any): void {
    const data = JSON.stringify({ type, payload, timestamp: Date.now() });
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  }

  private setupEventForwarding(): void {
    eventBus.on('WHATSAPP_STATUS_CHANGED', (p) => this.broadcast('WHATSAPP_STATUS', p));
    eventBus.on('WHATSAPP_QR', (qr) => this.broadcast('WHATSAPP_QR', { qr }));
    eventBus.on('MESSAGE_RECEIVED', (p) => this.broadcast('MESSAGE_RECEIVED', p));
    eventBus.on('MESSAGE_SENT', (p) => this.broadcast('MESSAGE_SENT', p));
    eventBus.on('RESPONSE_TIMER_STARTED', (p) => this.broadcast('TIMER_STARTED', p));
    eventBus.on('RESPONSE_TIMER_RESET', (p) => this.broadcast('TIMER_RESET', p));
    eventBus.on('RESPONSE_CANCELLED', (p) => this.broadcast('TIMER_CANCELLED', p));
    eventBus.on('AI_RESPONSE_GENERATED', (p) => this.broadcast('AI_RESPONSE_GENERATED', p));
    eventBus.on('AUTOMATION_MASTER_SWITCH_CHANGED', (enabled) => this.broadcast('MASTER_SWITCH', { enabled }));
    eventBus.on('TASK_CREATED', (task) => this.broadcast('TASK_CREATED', task));
    eventBus.on('TASK_UPDATED', (task) => this.broadcast('TASK_UPDATED', task));
    eventBus.on('TASK_REMINDER_DUE', (p) => this.broadcast('TASK_REMINDER_DUE', p));
    eventBus.on('CALENDAR_EVENT_CREATED', (event) => this.broadcast('CALENDAR_EVENT_CREATED', event));
    eventBus.on('CALENDAR_EVENT_UPDATED', (event) => this.broadcast('CALENDAR_EVENT_UPDATED', event));
  }

  private setupRoutes(): void {
    // 1. WhatsApp Connection Controls
    this.app.get('/api/whatsapp/status', (req, res) => {
      const adapter = whatsappManager.getAdapter();
      const qr = adapter instanceof WhatsAppWebAdapter ? adapter.getQrDataUrl() : null;
      const account = adapter instanceof WhatsAppWebAdapter ? adapter.getAccountInfo() : null;

      res.json({
        success: true,
        data: {
          status: whatsappManager.getStatus(),
          adapter: adapter.adapterName,
          account,
          qrCode: qr
        }
      });
    });

    this.app.post('/api/whatsapp/connect', async (req, res) => {
      try {
        await whatsappManager.connect();
        res.json({ success: true, message: 'WhatsApp connection initiated' });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    this.app.post('/api/whatsapp/disconnect', async (req, res) => {
      try {
        await whatsappManager.disconnect();
        res.json({ success: true, message: 'WhatsApp disconnected' });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // Fetch live selectable individual contacts/chats from connected WhatsApp session
    this.app.get('/api/whatsapp/available-contacts', async (req, res) => {
      try {
        const isReady = whatsappManager.getStatus() === 'connected';
        if (!isReady) {
          return res.json({ success: true, ready: false, data: [] });
        }
        const chats = await whatsappManager.getSelectableWhatsAppChats();
        res.json({ success: true, ready: true, data: chats });
      } catch (err: any) {
        console.error('[API ERROR] /api/whatsapp/available-contacts failed:', {
          name: err?.name || 'Error',
          message: err?.message || String(err),
          stack: err?.stack || 'No stack trace available'
        });
        res.status(200).json({ success: false, ready: false, error: err?.message || 'Failed to load contacts', data: [] });
      }
    });

    // 2. Global Status
    this.app.get('/api/status', (req, res) => {
      const adapter = whatsappManager.getAdapter();
      const account = adapter instanceof WhatsAppWebAdapter ? adapter.getAccountInfo() : null;
      const qr = adapter instanceof WhatsAppWebAdapter ? adapter.getQrDataUrl() : null;

      res.json({
        success: true,
        data: {
          whatsappStatus: whatsappManager.getStatus(),
          account,
          qrCode: qr,
          masterSwitch: automationEngine.isMasterAutomationEnabled(),
          responseDelaySeconds: automationEngine.getDelaySeconds(),
          wakePhrases: automationEngine.getWakePhrases(),
          aiProvider: db.getSetting('ai_provider') || config.AI_PROVIDER,
          groqModel: db.getSetting('groq_model') || config.GROQ_MODEL,
          automatedCount: contactManager.getAutomatedContacts().length,
          totalContacts: contactManager.getAllContacts().length
        }
      });
    });

    // 3. Automated Contacts Management
    this.app.get('/api/contacts', async (req, res) => {
      try {
        const adapter = whatsappManager.getAdapter();
        const isReady = whatsappManager.getStatus() === 'connected';
        const contacts = await contactManager.getContactsForUi(adapter);
        res.json({
          success: true,
          ready: isReady,
          data: contacts
        });
      } catch (err: any) {
        console.error('[API ERROR] /api/contacts failed:', {
          name: err?.name || 'Error',
          message: err?.message || String(err),
          stack: err?.stack || 'No stack trace available'
        });
        res.status(200).json({ success: false, ready: false, error: err?.message || 'Failed to load contacts', data: contactManager.getAllContacts() });
      }
    });

    this.app.post('/api/contacts', (req, res) => {
      const { id, name, customPrompt, aiEnabled } = req.body;
      if (!id) {
        return res.status(400).json({ success: false, error: 'Contact ID is required' });
      }
      const formattedId = id.includes('@') ? id : `${id.replace(/\D/g, '')}@c.us`;
      const contact = contactManager.addContact(formattedId, name || id, customPrompt);
      if (aiEnabled) {
        contactManager.updateContactSettings(formattedId, { ai_enabled: true });
      }
      res.json({ success: true, data: contactManager.getContact(formattedId) || contact });
    });

    this.app.put('/api/contacts/:id/settings', (req, res) => {
      const { id } = req.params;
      const updated = contactManager.updateContactSettings(id, req.body);
      res.json({ success: true, data: updated });
    });

    this.app.delete('/api/contacts/:id', (req, res) => {
      const { id } = req.params;
      contactManager.deleteContact(id);
      res.json({ success: true, message: 'Contact removed' });
    });

    // 4. Routines Management
    this.app.get('/api/contacts/:id/routines', (req, res) => {
      const { id } = req.params;
      const routines = db.getRoutinesForContact(id);
      res.json({ success: true, data: routines });
    });

    this.app.post('/api/contacts/:id/routines', (req, res) => {
      const { id } = req.params;
      const { name, type, time, timezone, message, days_of_week, day_of_month, month, date, enabled } = req.body;
      if (!name || !type || !time || !message) {
        return res.status(400).json({ success: false, error: 'Name, type, time, and message are required' });
      }
      const routine = db.upsertRoutine({
        contact_id: id,
        name,
        type,
        time,
        timezone: timezone || 'Asia/Kolkata',
        message,
        days_of_week,
        day_of_month: day_of_month ? Number(day_of_month) : null,
        month: month ? Number(month) : null,
        date: date || null,
        enabled: enabled !== undefined ? enabled : true
      });
      res.json({ success: true, data: routine });
    });

    this.app.get('/api/routines', (req, res) => {
      const routines = db.getAllRoutines();
      res.json({ success: true, data: routines });
    });

    this.app.put('/api/routines/:id', (req, res) => {
      const { id } = req.params;
      const existing = db.getRoutine(id);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Routine not found' });
      }
      const updated = db.upsertRoutine({
        ...existing,
        ...req.body,
        id
      });
      res.json({ success: true, data: updated });
    });

    this.app.patch('/api/routines/:id/toggle', (req, res) => {
      const { id } = req.params;
      const { enabled } = req.body;
      const updated = db.toggleRoutine(id, Boolean(enabled));
      res.json({ success: true, data: updated });
    });

    this.app.delete('/api/routines/:id', (req, res) => {
      const { id } = req.params;
      db.deleteRoutine(id);
      res.json({ success: true, message: 'Routine deleted' });
    });

    // 5. Conversations & Messages
    this.app.get('/api/conversations', (req, res) => {
      const convs = db.getAllConversations();
      res.json({ success: true, data: convs });
    });

    this.app.get('/api/messages', (req, res) => {
      const contactId = req.query.contactId as string | undefined;
      const limit = Number(req.query.limit) || 60;
      if (contactId) {
        const msgs = db.getRecentMessagesForContact(contactId, limit);
        return res.json({ success: true, data: msgs });
      }
      const stmt = (db as any).db.prepare('SELECT * FROM messages ORDER BY timestamp DESC LIMIT ?');
      const allMsgs = stmt.all(limit) as any[];
      res.json({ success: true, data: allMsgs.reverse() });
    });

    this.app.post('/api/messages', async (req, res) => {
      const { contactId, message } = req.body;
      if (!contactId || !message) {
        return res.status(400).json({ success: false, error: 'contactId and message required' });
      }
      try {
        const result = await whatsappManager.sendMessage(contactId, message, false);
        res.json({ success: true, data: result });
      } catch (err: any) {
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // 5. Settings
    this.app.get('/api/settings', (req, res) => {
      res.json({
        success: true,
        data: db.getAllSettings()
      });
    });

    this.app.post('/api/settings', (req, res) => {
      const {
        masterSwitch,
        responseDelay,
        wakePhrases,
        systemPrompt,
        aiProvider,
        groqApiKey,
        groqModel,
        sttProvider,
        sttLang,
        ttsVoice,
        ttsFormat
      } = req.body;

      if (masterSwitch !== undefined) {
        automationEngine.setMasterAutomation(Boolean(masterSwitch));
      }
      if (responseDelay !== undefined) {
        automationEngine.setDelaySeconds(Number(responseDelay));
      }
      if (wakePhrases !== undefined) {
        const phrases = Array.isArray(wakePhrases) ? wakePhrases : wakePhrases.split(',');
        automationEngine.setWakePhrases(phrases);
      }
      if (systemPrompt !== undefined) {
        db.setSetting('system_prompt', systemPrompt);
      }
      if (aiProvider !== undefined) {
        db.setSetting('ai_provider', aiProvider);
      }
      if (groqApiKey !== undefined && groqApiKey.trim()) {
        db.setSetting('groq_api_key', groqApiKey.trim());
      }
      if (groqModel !== undefined && groqModel.trim()) {
        db.setSetting('groq_model', groqModel.trim());
      }
      if (sttProvider !== undefined) {
        db.setSetting('stt_provider', sttProvider);
      }
      if (sttLang !== undefined) {
        db.setSetting('stt_lang', sttLang);
      }
      if (ttsVoice !== undefined) {
        db.setSetting('tts_voice', ttsVoice);
      }
      if (ttsFormat !== undefined) {
        db.setSetting('tts_format', ttsFormat);
      }

      res.json({ success: true, data: db.getAllSettings() });
    });

    // 6. Logs API
    this.app.get('/api/logs', (req, res) => {
      const limit = Number(req.query.limit) || 80;
      res.json({ success: true, data: db.getRecentLogs(limit) });
    });

    // 7. Calendar Events API
    this.app.get('/api/calendar/events', (req, res) => {
      const { start, end, date } = req.query as { start?: string; end?: string; date?: string };
      let events;
      if (date) {
        events = db.getCalendarEventsForDate(date);
      } else if (start && end) {
        events = db.getCalendarEventsForRange(start, end);
      } else {
        events = db.getAllCalendarEvents();
      }
      res.json({ success: true, data: events });
    });

    this.app.post('/api/calendar/events', (req, res) => {
      const { title, description, date, start_time, end_time, location, contact_id, created_by } = req.body;
      if (!title || !date) {
        return res.status(400).json({ success: false, error: 'Title and date are required' });
      }
      const event = db.createCalendarEvent({
        title,
        description,
        date,
        start_time,
        end_time,
        location,
        contact_id,
        created_by: created_by || 'Owner'
      });
      eventBus.emit('CALENDAR_EVENT_CREATED', event);
      res.json({ success: true, data: event });
    });

    this.app.put('/api/calendar/events/:id', (req, res) => {
      const { id } = req.params;
      const updated = db.updateCalendarEvent(id, req.body);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Event not found' });
      }
      eventBus.emit('CALENDAR_EVENT_UPDATED', updated);
      res.json({ success: true, data: updated });
    });

    this.app.delete('/api/calendar/events/:id', (req, res) => {
      const { id } = req.params;
      db.deleteCalendarEvent(id);
      res.json({ success: true, message: 'Calendar event removed' });
    });

    // 8. Tasks API
    this.app.get('/api/tasks', (req, res) => {
      const statusFilter = req.query.status as string | undefined;
      const tasks = db.getAllTasks(statusFilter);
      res.json({ success: true, data: tasks });
    });

    this.app.post('/api/tasks', (req, res) => {
      const { title, description, due_date, due_time, requester_display_name, requester_contact_id } = req.body;
      if (!title) {
        return res.status(400).json({ success: false, error: 'Task title is required' });
      }

      let reminderTime: number | null = null;
      if (due_date) {
        const timePart = due_time || '09:00';
        const [y, m, d] = due_date.split('-').map(Number);
        const [hh, mm] = timePart.split(':').map(Number);
        const dt = new Date(y, m - 1, d, hh || 9, mm || 0, 0, 0);
        reminderTime = dt.getTime();
      }

      const task = db.createTask({
        title,
        description,
        due_date,
        due_time,
        reminder_time: reminderTime,
        requester_display_name: requester_display_name || 'Owner',
        requester_contact_id: requester_contact_id || null,
        owner_id: 'Owner',
        status: 'pending'
      });
      eventBus.emit('TASK_CREATED', task);
      res.json({ success: true, data: task });
    });

    this.app.put('/api/tasks/:id', (req, res) => {
      const { id } = req.params;
      const updated = db.updateTask(id, req.body);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'Task not found' });
      }
      eventBus.emit('TASK_UPDATED', updated);
      res.json({ success: true, data: updated });
    });

    this.app.post('/api/tasks/:id/status', (req, res) => {
      const { id } = req.params;
      const { status } = req.body;
      if (!status) {
        return res.status(400).json({ success: false, error: 'Status is required' });
      }
      const updated = db.updateTaskStatus(id, status);
      if (updated) {
        eventBus.emit('TASK_UPDATED', updated);
      }
      res.json({ success: true, data: updated });
    });

    this.app.post('/api/tasks/:id/snooze', (req, res) => {
      const { id } = req.params;
      const minutes = Number(req.body.minutes) || 60;
      const { newDueDate, newDueTime } = req.body;
      const updated = db.snoozeTask(id, minutes, newDueDate, newDueTime);
      if (updated) {
        eventBus.emit('TASK_UPDATED', updated);
      }
      res.json({ success: true, data: updated });
    });

    this.app.delete('/api/tasks/:id', (req, res) => {
      const { id } = req.params;
      db.deleteTask(id);
      res.json({ success: true, message: 'Task deleted' });
    });

    // 9. Contact Important Dates API
    this.app.get('/api/contacts/dates', (req, res) => {
      const dates = db.getContactImportantDates();
      res.json({ success: true, data: dates });
    });

    // 10. Owner Availability API
    this.app.get('/api/owner/availability', (req, res) => {
      res.json({
        success: true,
        data: {
          availability: db.getOwnerAvailability(),
          isAvailable: db.isOwnerAvailable()
        }
      });
    });

    this.app.post('/api/owner/availability', (req, res) => {
      const { status } = req.body;
      if (!status || !['available', 'unavailable', 'busy', 'auto'].includes(status)) {
        return res.status(400).json({ success: false, error: 'Status must be one of: available, unavailable, busy, auto' });
      }
      db.setOwnerAvailability(status);
      this.broadcast('OWNER_AVAILABILITY_CHANGED', { availability: status, isAvailable: status === 'available' });
      res.json({ success: true, data: { availability: status, isAvailable: status === 'available' } });
    });

    // 11. AI Audit Logs API
    this.app.get('/api/audit-logs', (req, res) => {
      const limit = Number(req.query.limit) || 50;
      const logs = db.getAiAuditLogs(limit);
      res.json({ success: true, data: logs });
    });

    this.app.get('/api/audit-logs/contact/:id', (req, res) => {
      const limit = Number(req.query.limit) || 50;
      const logs = db.getAiAuditLogsForContact(req.params.id, limit);
      res.json({ success: true, data: logs });
    });

    // 12. Incident Timeline API
    this.app.get('/api/timeline/message/:messageId', (req, res) => {
      const timeline = db.getTimelineForMessage(req.params.messageId);
      res.json({ success: true, data: timeline });
    });

    this.app.get('/api/timeline/contact/:contactId', (req, res) => {
      const limit = Number(req.query.limit) || 100;
      const timeline = db.getTimelineForContact(req.params.contactId, limit);
      res.json({ success: true, data: timeline });
    });

    // 13. Contact Memory & Approval API
    this.app.get('/api/contacts/:id/memory', (req, res) => {
      const chunks = db.getContactMemoryChunks(req.params.id);
      res.json({ success: true, data: { count: chunks.length, chunks } });
    });

    this.app.delete('/api/contacts/:id/memory', (req, res) => {
      const count = contactManager.deleteContactMemory(req.params.id);
      res.json({ success: true, data: { deletedCount: count } });
    });

    this.app.post('/api/contacts/:id/approve', (req, res) => {
      const contact = contactManager.approveContact(req.params.id, req.body);
      res.json({ success: true, data: contact });
    });

    this.app.post('/api/contacts/:id/revoke', (req, res) => {
      const contact = contactManager.revokeApproval(req.params.id);
      res.json({ success: true, data: contact });
    });

    this.app.post('/api/contacts/:id/rag', (req, res) => {
      const { enabled } = req.body;
      contactManager.setRagEnabled(req.params.id, Boolean(enabled));
      res.json({ success: true, data: { contactId: req.params.id, ragEnabled: Boolean(enabled) } });
    });

    // SPA fallback
    this.app.use((req, res) => {
      const indexFile = path.resolve(__dirname, '../../public/index.html');
      res.sendFile(indexFile);
    });
  }

  public async start(port: number = config.PORT, host: string = config.HOST): Promise<void> {
    if (this.isListening) return;

    return new Promise((resolve) => {
      this.server.listen(port, host, () => {
        this.isListening = true;
        console.log(`[API SERVER] 🚀 JARVIS Web Dashboard live at: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.isListening) return;
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.server.close(() => {
          this.isListening = false;
          resolve();
        });
      });
    });
  }
}

export const apiServer = new ApiServer();

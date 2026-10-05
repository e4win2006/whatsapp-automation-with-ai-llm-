import { eventBus, WhatsAppMessagePayload, WhatsAppStatusPayload } from './eventBus';
import { whatsappManager, WhatsAppManager } from '../whatsapp/client';
import { automationEngine } from '../whatsapp/automationEngine';
import { routineScheduler } from '../whatsapp/routineScheduler';
import { apiServer } from '../api/server';
import { db } from '../database/database';
import { config } from './config';

export class JarvisOrchestrator {
  private isRunning: boolean = false;
  private whatsapp: WhatsAppManager;

  constructor(customWhatsappManager?: WhatsAppManager) {
    this.whatsapp = customWhatsappManager || whatsappManager;
    this.registerSystemEvents();
  }

  private registerSystemEvents(): void {
    // 1. WhatsApp Connection Status
    eventBus.on('WHATSAPP_STATUS_CHANGED', (status: WhatsAppStatusPayload) => {
      console.log(`[JARVIS ORCHESTRATOR] WhatsApp Status: ${status.status.toUpperCase()}${status.error ? ` (${status.error})` : ''}`);
    });

    // 2. Message Received Routing
    eventBus.on('MESSAGE_RECEIVED', (msg: WhatsAppMessagePayload) => {
      if (msg.fromMe) {
        console.log(`[JARVIS] Owner sent a message to ${msg.contactId}: "${msg.body}"`);
        return;
      }

      console.log(`[JARVIS] Incoming message from [${msg.senderName} / ${msg.contactId}]: "${msg.body}"`);
    });

    // 3. Message Sent Log
    eventBus.on('MESSAGE_SENT', (payload) => {
      console.log(`[JARVIS] Outgoing message delivered to [${payload.contactId}]: "${payload.text}" (Automated: ${payload.isAutomated})`);
    });
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[JARVIS] Orchestrator is already running.');
      return;
    }

    console.log('====================================================');
    console.log('       JARVIS WhatsApp Automation Engine            ');
    console.log('====================================================');
    console.log(`Node Environment:    ${config.NODE_ENV}`);
    console.log(`WhatsApp Adapter:    ${config.WHATSAPP_ADAPTER}`);
    console.log(`Database Location:   ${config.DATABASE_PATH}`);
    console.log(`AI Provider:         ${db.getSetting('ai_provider') || config.AI_PROVIDER}`);
    console.log(`Master Auto Switch:  ${automationEngine.isMasterAutomationEnabled() ? 'ENABLED' : 'DISABLED'}`);
    console.log('====================================================\n');

    db.addLog('info', 'Orchestrator', 'JARVIS system starting up');
    this.isRunning = true;

    // 1. Start Web Dashboard & REST API
    try {
      await apiServer.start();
    } catch (err: any) {
      console.error('[JARVIS] Warning: API server startup error:', err.message);
    }

    // 2. Start Scheduled Routine engine
    try {
      routineScheduler.start();
    } catch (err: any) {
      console.error('[JARVIS] Warning: Routine scheduler startup error:', err.message);
    }

    // 3. Connect WhatsApp adapter
    try {
      await this.whatsapp.connect();
      console.log('[JARVIS] WhatsApp adapter initialization started.');
    } catch (err: any) {
      console.error('[JARVIS] Failed to connect WhatsApp adapter:', err.message);
      db.addLog('error', 'Orchestrator', 'Failed to connect WhatsApp adapter', { error: err.message });
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    console.log('[JARVIS] Stopping orchestrator...');
    db.addLog('info', 'Orchestrator', 'JARVIS system stopping');
    routineScheduler.stop();
    await apiServer.stop();
    await this.whatsapp.disconnect();
    this.isRunning = false;
    console.log('[JARVIS] System stopped.');
  }

  public getStatus() {
    return {
      running: this.isRunning,
      whatsappStatus: this.whatsapp.getStatus(),
      adapter: this.whatsapp.getAdapter().adapterName,
      masterSwitch: db.getSetting('master_automation_switch') === 'true',
      responseDelaySeconds: Number(db.getSetting('response_delay_seconds') || config.DEFAULT_RESPONSE_DELAY_SECONDS),
      aiProvider: db.getSetting('ai_provider') || config.AI_PROVIDER
    };
  }

  public getWhatsAppManager(): WhatsAppManager {
    return this.whatsapp;
  }
}

export const orchestrator = new JarvisOrchestrator();

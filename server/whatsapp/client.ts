import { IWhatsAppAdapter, WhatsAppAdapterStatus, WhatsAppContact, WhatsAppChat, WhatsAppIncomingMessage, WhatsAppSendResult } from './adapters/adapterInterface';
import { MockWhatsAppAdapter } from './adapters/mockAdapter';
import { WhatsAppWebAdapter } from './adapters/webAdapter';
import { eventBus } from '../core/eventBus';
import { db, JarvisDatabase } from '../database/database';
import { config } from '../core/config';

export class WhatsAppManager {
  private adapter: IWhatsAppAdapter;
  private db: JarvisDatabase;
  private processedMessageIds: Set<string> = new Set();
  private maxCacheSize = 1000;

  constructor(adapter?: IWhatsAppAdapter, customDb?: JarvisDatabase) {
    this.db = customDb || db;
    if (adapter) {
      this.adapter = adapter;
    } else if (config.WHATSAPP_ADAPTER === 'web') {
      this.adapter = new WhatsAppWebAdapter();
    } else {
      this.adapter = new MockWhatsAppAdapter();
    }

    this.setupListeners();
  }

  private setupListeners(): void {
    this.adapter.onMessage((msg: WhatsAppIncomingMessage) => {
      this.handleIncomingMessage(msg);
    });

    this.adapter.onStatusChange((status: WhatsAppAdapterStatus, details?: any) => {
      this.db.addLog('info', 'WhatsAppManager', `Status changed to ${status}`, details);
      eventBus.emit('WHATSAPP_STATUS_CHANGED', { status, error: details?.error, account: details?.account });

      if (status === 'connected') {
        eventBus.emit('WHATSAPP_CONNECTED', { status, account: details?.account });
      } else if (status === 'disconnected') {
        eventBus.emit('WHATSAPP_DISCONNECTED', { status, error: details?.reason });
      }
    });

    this.adapter.onQrCode((qr: string) => {
      this.db.addLog('info', 'WhatsAppManager', 'New QR Code generated');
      eventBus.emit('WHATSAPP_QR', qr);
    });
  }

  private handleIncomingMessage(msg: WhatsAppIncomingMessage): void {
    try {
      // 1. Deduplication Protection
      if (this.processedMessageIds.has(msg.id)) {
        this.db.addLog('debug', 'WhatsAppManager', `Duplicate message dropped: ${msg.id}`);
        return;
      }

      this.processedMessageIds.add(msg.id);
      if (this.processedMessageIds.size > this.maxCacheSize) {
        const firstKey = this.processedMessageIds.values().next().value;
        if (firstKey) this.processedMessageIds.delete(firstKey);
      }

      // 2. Persist contact if not exists (preserves existing approval status)
      this.db.upsertContact({
        id: msg.contactId,
        name: msg.senderName,
        phone_number: msg.phoneNumber,
        whatsapp_id: msg.whatsappLid,
        whatsapp_phone_id: msg.whatsappPhoneId,
        alternate_names: msg.alternateNames
      });

      // 3. Persist message in database
      this.db.saveMessage({
        id: msg.id,
        contactId: msg.contactId,
        direction: msg.fromMe ? 'outgoing' : 'incoming',
        messageText: msg.body,
        rawPayload: msg.raw,
        processed: false,
        isManualReply: msg.fromMe,
        timestamp: msg.timestamp
      });

      // 4. Emit event for Orchestrator and Automation Engine
      console.log('[WHATSAPP DEBUG] Forwarding incoming message to AutomationEngine');
      eventBus.emit('MESSAGE_RECEIVED', {
        id: msg.id,
        contactId: msg.contactId,
        whatsappLid: msg.whatsappLid,
        whatsappPhoneId: msg.whatsappPhoneId,
        senderName: msg.senderName,
        phoneNumber: msg.phoneNumber,
        alternateNames: msg.alternateNames,
        fromMe: msg.fromMe,
        body: msg.body,
        timestamp: msg.timestamp,
        isGroup: msg.isGroup,
        messageType: msg.messageType,
        audioDuration: msg.audioDuration,
        audioData: msg.audioData,
        audioBuffer: msg.audioBuffer,
        mimetype: msg.mimetype,
        hasMedia: msg.hasMedia,
        downloadMedia: msg.downloadMedia,
        raw: msg.raw,
        eventSource: msg.eventSource
      });
    } catch (err: any) {
      console.error('[JARVIS AUTOMATION ERROR] Error in WhatsAppManager handleIncomingMessage:', err);
    }
  }

  public async connect(): Promise<void> {
    this.db.addLog('info', 'WhatsAppManager', `Connecting using ${this.adapter.adapterName}`);
    await this.adapter.connect();
  }

  public async disconnect(): Promise<void> {
    this.db.addLog('info', 'WhatsAppManager', 'Disconnecting WhatsApp client');
    await this.adapter.disconnect();
  }

  public getStatus(): WhatsAppAdapterStatus {
    return this.adapter.getStatus();
  }

  public isReady(): boolean {
    return this.adapter.getStatus() === 'connected';
  }

  public async checkConnectionState(): Promise<string | null> {
    if (typeof this.adapter.checkConnectionState === 'function') {
      return await this.adapter.checkConnectionState();
    }
    return this.isReady() ? 'CONNECTED' : 'DISCONNECTED';
  }

  public async getContacts(): Promise<WhatsAppContact[]> {
    return this.adapter.getContacts();
  }

  public async getChats(): Promise<WhatsAppChat[]> {
    return this.adapter.getChats();
  }

  public async getSelectableWhatsAppChats(): Promise<import('./adapters/adapterInterface').SelectableWhatsAppContact[]> {
    return this.adapter.getSelectableWhatsAppChats();
  }

  public async sendMessage(contactId: string, message: string, isAutomated: boolean = false): Promise<WhatsAppSendResult> {
    const result = await this.adapter.sendMessage(contactId, message);

    // Save outgoing message in DB
    this.db.saveMessage({
      id: result.messageId,
      contactId,
      direction: 'outgoing',
      messageText: message,
      processed: true,
      triggerType: isAutomated ? 'ai_reply' : 'manual_reply',
      isManualReply: !isAutomated,
      timestamp: result.timestamp
    });

    eventBus.emit('MESSAGE_SENT', {
      contactId,
      messageId: result.messageId,
      text: message,
      timestamp: result.timestamp,
      isAutomated,
      isVoice: false
    });

    return result;
  }

  public async sendVoiceMessage(
    contactId: string,
    audioData: Buffer | string,
    mimetype: string = 'audio/ogg; codecs=opus',
    isAutomated: boolean = false,
    transcriptText: string = '[Voice Message]'
  ): Promise<WhatsAppSendResult> {
    let result: WhatsAppSendResult;

    if (typeof this.adapter.sendVoiceMessage === 'function') {
      result = await this.adapter.sendVoiceMessage(contactId, audioData, mimetype);
    } else {
      result = await this.adapter.sendMessage(contactId, transcriptText);
    }

    // Save outgoing voice message in DB
    this.db.saveMessage({
      id: result.messageId,
      contactId,
      direction: 'outgoing',
      messageText: transcriptText,
      rawPayload: { messageType: 'voice', mimetype, isVoiceResponse: true },
      processed: true,
      triggerType: isAutomated ? 'ai_reply' : 'manual_reply',
      isManualReply: !isAutomated,
      timestamp: result.timestamp
    });

    eventBus.emit('MESSAGE_SENT', {
      contactId,
      messageId: result.messageId,
      text: transcriptText,
      timestamp: result.timestamp,
      isAutomated,
      isVoice: true
    });

    return result;
  }

  public async syncContacts(): Promise<void> {
    // Phonebook import is intentionally disabled to avoid importing full device address books.
    // Contacts are dynamically retrieved from active WhatsApp conversations or explicitly added.
  }

  public getAdapter(): IWhatsAppAdapter {
    return this.adapter;
  }
}

export const whatsappManager = new WhatsAppManager();

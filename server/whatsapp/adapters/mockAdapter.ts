import {
  IWhatsAppAdapter,
  WhatsAppAdapterStatus,
  WhatsAppChat,
  WhatsAppContact,
  WhatsAppIncomingMessage,
  WhatsAppSendResult
} from './adapterInterface';
import { normalizePhoneNumber } from '../../utils/phoneUtils';

export class MockWhatsAppAdapter implements IWhatsAppAdapter {
  public readonly adapterName = 'MockWhatsAppAdapter';
  private status: WhatsAppAdapterStatus = 'disconnected';

  private messageHandler?: (msg: WhatsAppIncomingMessage) => void;
  private statusChangeHandler?: (status: WhatsAppAdapterStatus, details?: any) => void;
  private qrHandler?: (qr: string) => void;

  private mockContacts: WhatsAppContact[] = [];

  private sentMessages: Array<{ contactId: string; message: string; timestamp: number; messageId: string }> = [];

  public async connect(): Promise<void> {
    this.setStatus('connecting');
    // Simulate brief handshake
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.setStatus('connected');
  }

  public async disconnect(): Promise<void> {
    this.setStatus('disconnected');
  }

  public getStatus(): WhatsAppAdapterStatus {
    return this.status;
  }

  public async checkConnectionState(): Promise<string | null> {
    return this.status === 'connected' ? 'CONNECTED' : (this.status === 'connecting' ? 'OPENING' : 'DISCONNECTED');
  }

  public async getContacts(): Promise<WhatsAppContact[]> {
    return [...this.mockContacts];
  }

  public async getChats(): Promise<WhatsAppChat[]> {
    return this.mockContacts.map((c) => ({
      id: c.id,
      name: c.name,
      isGroup: c.isGroup,
      unreadCount: 0,
      lastMessageTimestamp: Date.now()
    }));
  }

  public async getSelectableWhatsAppChats(): Promise<import('./adapterInterface').SelectableWhatsAppContact[]> {
    console.log('[WHATSAPP CONTACTS] Loading WhatsApp contacts...');
    console.log('[WHATSAPP CONTACTS] Source: WhatsApp');
    const chats = await this.getChats();
    console.log(`[WHATSAPP CONTACTS] Chats retrieved: ${chats.length}`);

    let groupsFiltered = 0;
    let systemFiltered = 0;
    let individualChats = 0;

    const candidates: Array<{
      id: string;
      name: string;
      number?: string;
      lastMessageTimestamp?: number;
      type: 'person';
    }> = [];

    for (const c of chats) {
      if (c.id.includes('@broadcast') || c.id === '0@c.us') {
        systemFiltered++;
        continue;
      }
      if (c.isGroup || c.id.includes('@g.us')) {
        groupsFiltered++;
        continue;
      }
      individualChats++;
      const contactObj = this.mockContacts.find((mc) => mc.id === c.id);
      candidates.push({
        id: c.id,
        name: c.name,
        number: contactObj?.number,
        type: 'person',
        lastMessageTimestamp: c.lastMessageTimestamp
      });
    }

    // Merge by normalized phone number
    const mergedMap = new Map<string, {
      id: string;
      name: string;
      number?: string;
      alternateNames: string[];
      lastMessageTimestamp?: number;
      type: 'person';
    }>();

    for (const item of candidates) {
      const cleanPhone = normalizePhoneNumber(item.number || (item.id.endsWith('@c.us') ? item.id : null));
      const identityKey = cleanPhone ? `phone:${cleanPhone}` : `id:${item.id}`;

      const existing = mergedMap.get(identityKey);
      if (existing) {
        const existingAlts = existing.alternateNames || [];
        if (item.name && item.name !== existing.name && !existingAlts.includes(item.name)) {
          existing.alternateNames.push(item.name);
        }
      } else {
        mergedMap.set(identityKey, {
          id: item.id,
          name: item.name,
          number: cleanPhone || item.number,
          alternateNames: [],
          lastMessageTimestamp: item.lastMessageTimestamp,
          type: 'person'
        });
      }
    }

    const selectable = Array.from(mergedMap.values());

    // Log merge occurrences
    for (const entry of selectable) {
      if (entry.alternateNames && entry.alternateNames.length > 0) {
        console.log(`[CONTACT MERGE] Same WhatsApp number detected`);
        console.log(`[CONTACT MERGE] Names: ${[entry.name, ...entry.alternateNames].join(', ')}`);
        console.log(`[CONTACT MERGE] Result: ONE contact`);
      }
    }

    console.log(`[WHATSAPP CONTACTS] Individual chats: ${individualChats}`);
    console.log(`[WHATSAPP CONTACTS] Groups filtered: ${groupsFiltered}`);
    console.log(`[WHATSAPP CONTACTS] System entries filtered: ${systemFiltered}`);
    console.log(`[WHATSAPP CONTACTS] Final selectable contacts: ${selectable.length}`);

    return selectable;
  }

  public async sendMessage(contactId: string, message: string): Promise<WhatsAppSendResult> {
    if (this.status !== 'connected') {
      throw new Error(`[MockAdapter] Cannot send message: Adapter is not connected (current status: ${this.status})`);
    }

    const messageId = `mock_msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = Date.now();
    const isLid = contactId.endsWith('@lid');
    const isPhone = contactId.endsWith('@c.us');

    this.sentMessages.push({
      contactId,
      message,
      timestamp,
      messageId
    });

    console.log(`\n[SEND DEBUG]
contactId: ${contactId}
canonicalPhoneId: ${isPhone ? contactId : 'none'}
lid: ${isLid ? contactId : 'none'}
recipientId: ${contactId}
recipientIdType: ${isLid ? 'LID' : (isPhone ? 'PHONE_ID' : typeof contactId)}
chatFound: true
chatId: ${contactId}
messageLength: ${message.length}
sendStarted: ${new Date(timestamp).toISOString()}
sendSucceeded: true
sendError: none\n`);

    console.log(`\n[MOCK WHATSAPP OUTGOING -> ${contactId}]`);
    console.log(`"${message}"\n`);

    return {
      messageId,
      timestamp,
      success: true
    };
  }

  public async sendVoiceMessage(contactId: string, audioData: Buffer | string, mimetype?: string): Promise<WhatsAppSendResult> {
    if (this.status !== 'connected') {
      throw new Error(`[MockAdapter] Cannot send voice message: Adapter is not connected (current status: ${this.status})`);
    }

    const messageId = `mock_voice_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const timestamp = Date.now();

    this.sentMessages.push({
      contactId,
      message: '[VOICE_RESPONSE_AUDIO]',
      timestamp,
      messageId
    });

    console.log(`\n[MOCK WHATSAPP OUTGOING VOICE AUDIO -> ${contactId}]`);
    console.log(`[Audio Response: ${mimetype || 'audio/ogg; codecs=opus'}, ${typeof audioData === 'string' ? audioData.length : audioData.length} bytes]\n`);

    return {
      messageId,
      timestamp,
      success: true,
      isVoice: true
    };
  }

  public onMessage(handler: (msg: WhatsAppIncomingMessage) => void): void {
    this.messageHandler = handler;
  }

  public onStatusChange(handler: (status: WhatsAppAdapterStatus, details?: any) => void): void {
    this.statusChangeHandler = handler;
  }

  public onQrCode(handler: (qr: string) => void): void {
    this.qrHandler = handler;
  }

  // --- Mock Simulation Helpers (For Testing & CLI) ---

  public async resolveWhatsAppIdentity(userId: string): Promise<import('./adapterInterface').ResolvedWhatsAppIdentity> {
    const contact = this.mockContacts.find((c) => c.id === userId);
    const isLid = userId.endsWith('@lid');
    const isPhone = userId.endsWith('@c.us');

    const whatsappLid = isLid ? userId : null;
    const whatsappPhoneId = isPhone ? userId : (contact?.number ? `${contact.number.replace(/\D/g, '')}@c.us` : null);
    const rawPhone = contact?.number || (isPhone ? userId : null);
    const phoneNumber = rawPhone ? normalizePhoneNumber(rawPhone) : null;

    return {
      whatsappLid,
      whatsappPhoneId,
      phoneNumber: phoneNumber ? `+${phoneNumber}` : null,
      displayName: contact?.name || userId,
      alternateNames: []
    };
  }

  public simulateIncomingMessage(
    contactId: string,
    body: string,
    senderName?: string,
    phoneNumber?: string,
    whatsappPhoneId?: string
  ): WhatsAppIncomingMessage {
    const contact = this.mockContacts.find((c) => c.id === contactId);
    const isLid = contactId.endsWith('@lid');
    const isPhone = contactId.endsWith('@c.us');

    const msg: WhatsAppIncomingMessage = {
      id: `sim_in_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      contactId,
      whatsappLid: isLid ? contactId : undefined,
      whatsappPhoneId: whatsappPhoneId || (isPhone ? contactId : undefined),
      senderName: senderName || contact?.name || contactId,
      phoneNumber: phoneNumber || (isPhone ? contactId : contact?.number),
      fromMe: false,
      body,
      timestamp: Date.now(),
      isGroup: contact?.isGroup || false,
      messageType: 'text'
    };

    console.log(`\n[MOCK WHATSAPP INCOMING <- ${msg.senderName} (${contactId})]`);
    console.log(`"${body}"\n`);

    if (this.messageHandler) {
      this.messageHandler(msg);
    }
    return msg;
  }

  public simulateIncomingVoiceMessage(
    contactId: string,
    options: {
      transcript?: string;
      audioData?: string;
      audioDuration?: number;
      senderName?: string;
      phoneNumber?: string;
      whatsappPhoneId?: string;
      failTranscription?: boolean;
    } = {}
  ): WhatsAppIncomingMessage {
    const contact = this.mockContacts.find((c) => c.id === contactId);
    const isLid = contactId.endsWith('@lid');
    const isPhone = contactId.endsWith('@c.us');
    const duration = options.audioDuration !== undefined ? options.audioDuration : 12;

    const msg: WhatsAppIncomingMessage = {
      id: `sim_voice_in_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      contactId,
      whatsappLid: isLid ? contactId : undefined,
      whatsappPhoneId: options.whatsappPhoneId || (isPhone ? contactId : undefined),
      senderName: options.senderName || contact?.name || contactId,
      phoneNumber: options.phoneNumber || (isPhone ? contactId : contact?.number),
      fromMe: false,
      body: '',
      timestamp: Date.now(),
      isGroup: contact?.isGroup || false,
      messageType: 'voice',
      audioDuration: duration,
      hasMedia: true,
      audioData: options.failTranscription ? 'INVALID_CORRUPT_AUDIO' : (options.audioData || (options.transcript ? `MOCK_AUDIO:${options.transcript}` : 'MOCK_AUDIO_PAYLOAD')),
      downloadMedia: async () => {
        if (options.failTranscription) return null;
        return {
          mimetype: 'audio/ogg; codecs=opus',
          data: options.audioData || Buffer.from(options.transcript || 'mock speech audio').toString('base64'),
          filename: 'voice.ogg'
        };
      },
      raw: {
        fromMe: false,
        type: 'ptt',
        duration,
        mockTranscript: options.transcript,
        failTranscription: options.failTranscription
      }
    };

    console.log(`\n[MOCK WHATSAPP INCOMING VOICE NOTE 🎤 <- ${msg.senderName} (${contactId})] (${duration}s)`);
    if (options.transcript) {
      console.log(`[Simulated Spoken Content]: "${options.transcript}"\n`);
    }

    if (this.messageHandler) {
      this.messageHandler(msg);
    }
    return msg;
  }

  public simulateManualUserReply(contactId: string, body: string): WhatsAppIncomingMessage {
    const msg: WhatsAppIncomingMessage = {
      id: `sim_out_manual_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      contactId,
      senderName: 'Account Owner (You)',
      fromMe: true,
      body,
      timestamp: Date.now(),
      isGroup: false
    };

    console.log(`\n[MOCK WHATSAPP MANUAL USER REPLY (fromMe: true) -> ${contactId}]`);
    console.log(`"${body}"\n`);

    if (this.messageHandler) {
      this.messageHandler(msg);
    }
    return msg;
  }

  public simulateQrCode(qrString: string = 'mock-qr-code-data-for-auth'): void {
    this.setStatus('qr_ready');
    if (this.qrHandler) {
      this.qrHandler(qrString);
    }
  }

  public getSentMessages(): typeof this.sentMessages {
    return [...this.sentMessages];
  }

  public clearSentMessages(): void {
    this.sentMessages = [];
  }

  private setStatus(newStatus: WhatsAppAdapterStatus, details?: any): void {
    this.status = newStatus;
    if (this.statusChangeHandler) {
      this.statusChangeHandler(newStatus, details);
    }
  }
}

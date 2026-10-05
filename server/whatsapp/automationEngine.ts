import { eventBus, WhatsAppMessagePayload } from '../core/eventBus';
import { contactManager, ContactManager } from './contactManager';
import { conversationManager, ConversationManager } from './conversationManager';
import { whatsappManager, WhatsAppManager } from './client';
import { getAiProvider } from '../ai';
import { db, JarvisDatabase, DbMessage, parseContactPermissions, DEFAULT_CONTACT_PERMISSIONS } from '../database/database';
import { config } from '../core/config';
import { getWhatsAppIdentityType } from '../utils/phoneUtils';
import { PrivacyGuard } from './privacyGuard';
import { voiceService } from '../voice/voiceService';
import { TaskManager } from './taskManager';
import { CapabilityGuard } from './capabilityGuard';
import { ragManager, RagManager } from '../ai/ragManager';

interface ActiveTimer {
  timerId: NodeJS.Timeout;
  pendingId: string;
  contactId: string;
  conversationId: string;
  contactName: string;
  sourceMessageId?: string;
  latestMessageId?: string;
  triggerType: string;
  expiresAt: number;
  whatsappReplyId?: string;
}

export class AutomationEngine {
  private activeTimers: Map<string, ActiveTimer> = new Map();
  private incomingMsgDedup: Map<string, { ts: number; source: string }> = new Map();
  private processedAiRequests: Set<string> = new Set();
  private completedOperations: Set<string> = new Set();
  private whatsapp: WhatsAppManager;
  private contacts: ContactManager;
  private conversations: ConversationManager;
  private database: JarvisDatabase;
  private rag: RagManager;
  private defaultDelaySeconds: number = config.DEFAULT_RESPONSE_DELAY_SECONDS;

  constructor(
    customWhatsapp?: WhatsAppManager,
    customContacts?: ContactManager,
    customDb?: JarvisDatabase,
    customConversations?: ConversationManager,
    customRag?: RagManager
  ) {
    this.whatsapp = customWhatsapp || whatsappManager;
    this.contacts = customContacts || contactManager;
    this.database = customDb || db;
    this.conversations = customConversations || conversationManager;
    this.rag = customRag || ragManager;
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    eventBus.on('MESSAGE_RECEIVED', (msg: WhatsAppMessagePayload) => {
      this.handleIncomingMessage(msg);
    });
  }

  public setDelaySeconds(seconds: number): void {
    this.defaultDelaySeconds = Math.max(0, seconds);
    this.database.setSetting('response_delay_seconds', this.defaultDelaySeconds.toString());
  }

  public getDelaySeconds(): number {
    const saved = this.database.getSetting('response_delay_seconds');
    return saved ? Number(saved) : this.defaultDelaySeconds;
  }

  public isMasterAutomationEnabled(): boolean {
    const setting = this.database.getSetting('master_automation_switch');
    if (setting !== null) {
      return setting === 'true';
    }
    return config.AUTOMATION_MASTER_SWITCH;
  }

  public setMasterAutomation(enabled: boolean): void {
    this.database.setSetting('master_automation_switch', enabled ? 'true' : 'false');
    eventBus.emit('AUTOMATION_MASTER_SWITCH_CHANGED', enabled);
    this.database.addLog('warn', 'AutomationEngine', `Master Automation Switch set to ${enabled ? 'ON' : 'OFF'}`);

    if (!enabled) {
      this.cancelAllPendingTimers('Master automation switch turned OFF');
    }
  }

  public getWakePhrases(): string[] {
    const saved = this.database.getSetting('wake_phrases');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {}
    }
    return config.WAKE_PHRASES;
  }

  public setWakePhrases(phrases: string[]): void {
    const cleaned = phrases.map((p) => p.trim().toLowerCase()).filter(Boolean);
    this.database.setSetting('wake_phrases', JSON.stringify(cleaned));
    this.database.addLog('info', 'AutomationEngine', 'Updated wake phrases list', cleaned);
  }

  public containsWakePhrase(text: string): { matches: boolean; phrase?: string } {
    const lower = text.toLowerCase();
    const wakePhrases = this.getWakePhrases();
    for (const phrase of wakePhrases) {
      if (lower.includes(phrase.toLowerCase())) {
        return { matches: true, phrase };
      }
    }
    return { matches: false };
  }

  public async handleIncomingMessage(msg: WhatsAppMessagePayload): Promise<void> {
    try {
      console.log(`\n[JARVIS AUTOMATION DEBUG] handleIncomingMessage ENTERED`);
      const contactId = msg.contactId || (msg as any).from || '';
      const fromMe = Boolean(msg.fromMe);
      const body = msg.body || '';
      const senderName = msg.senderName || (msg as any).pushname || '';
      const phoneNumber = msg.phoneNumber || (msg as any).number || '';
      const eventSource = msg.eventSource || 'message';
      const messageId = msg.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      // 1. In-Memory Earliest Hard Idempotency Gate
      if (msg.id) {
        const now = Date.now();
        for (const [k, v] of this.incomingMsgDedup) {
          if (now - v.ts > 60000) this.incomingMsgDedup.delete(k);
        }
        if (this.incomingMsgDedup.has(msg.id)) {
          const prev = this.incomingMsgDedup.get(msg.id)!;
          console.log(`\n[EVENT DEDUP]\nmessageId: ${msg.id}\nfirstEvent: ${prev.source}\nduplicateEvent: ${eventSource}\naction: IGNORED_DUPLICATE\n`);
          return;
        }
        this.incomingMsgDedup.set(msg.id, { ts: now, source: eventSource });
      }

      // 2. Persistent Database Idempotency & State Gate
      const existingState = this.database.getMessageProcessingState(messageId);
      if (existingState) {
        if (['RESPONDED', 'ALREADY_HANDLED', 'SEEN_BY_OWNER', 'IGNORED', 'PRIVACY_BLOCKED', 'UNAUTHORIZED', 'OWNER_AVAILABLE'].includes(existingState.status)) {
          console.log(`[PERSISTENT STATE DEDUP] Message ${messageId} already in terminal state: ${existingState.status}. Dropping duplicate event.`);
          return;
        }
      }

      // Record Timeline Event: MESSAGE_RECEIVED
      this.database.addTimelineEvent({
        message_id: messageId,
        contact_id: contactId,
        stage: 'MESSAGE_RECEIVED',
        description: `Message received via ${eventSource}`,
        metadata: { fromMe, bodyLength: body.length, senderName }
      });

      // Initialize / Record State: RECEIVED
      this.database.saveMessageProcessingState({
        message_id: messageId,
        contact_id: contactId,
        canonical_phone_id: msg.whatsappPhoneId || (contactId.endsWith('@c.us') ? contactId : null),
        event_source: eventSource,
        received_at: msg.timestamp || Date.now(),
        status: 'RECEIVED'
      });

      // Filter empty messages and status broadcast / system messages
      const isVoiceMsg = msg.messageType === 'voice' || msg.raw?.type === 'ptt' || msg.raw?.type === 'audio' || Boolean(msg.audioData) || Boolean(msg.audioBuffer) || Boolean((msg as any).isVoice);
      if (!body?.trim() && !msg.raw?.type && !isVoiceMsg) {
        this.database.updateMessageProcessingState(messageId, { status: 'IGNORED', terminal_reason: 'Empty message content' });
        return;
      }
      if (!contactId || contactId === 'status@broadcast' || contactId.includes('@broadcast') || contactId === '0@c.us') {
        this.database.updateMessageProcessingState(messageId, { status: 'IGNORED', terminal_reason: 'Broadcast/system channel' });
        return;
      }

      console.log(`\n[JARVIS AUTOMATION] Processing incoming message...`);
      const idType = getWhatsAppIdentityType(contactId);
      if (idType === 'lid') {
        console.log(`[JARVIS AUTOMATION] WhatsApp LID: ${contactId}`);
      } else {
        console.log(`[JARVIS AUTOMATION] Sender ID: ${contactId} (${senderName || 'Unknown'})`);
      }
      console.log(`[JARVIS AUTOMATION] Message: "${body}"`);

      // 3. Manual User Reply Override:
      // If account owner replies personally from their phone (fromMe: true), immediately cancel pending automation
      if (fromMe) {
        console.log(`[JARVIS AUTOMATION] Message is fromMe (Account Owner).`);
        const recipientContact = this.contacts.resolveApprovedContact(contactId);
        const recipientDbId = recipientContact ? recipientContact.id : contactId;
        
        this.database.markMessageRepliedByOwner(recipientDbId, messageId);

        if (this.activeTimers.has(recipientDbId)) {
          console.log(`[JARVIS AUTOMATION] Manual reply from owner to ${recipientDbId}. Cancelling pending JARVIS automation.`);
          this.cancelTimer(recipientDbId, 'Owner manually replied to contact from phone');
        }

        this.database.addTimelineEvent({
          message_id: messageId,
          contact_id: recipientDbId,
          stage: 'MANUAL_OWNER_REPLY',
          description: 'Owner replied personally from phone'
        });

        console.log(`\n[INCOMING TRACE]
messageId: ${messageId}
eventSource: ${eventSource}
fromMe: true
rawSenderId: ${contactId}
canonicalPhoneId: ${msg.whatsappPhoneId || (idType === 'phone' ? contactId : 'none')}
lid: ${msg.whatsappLid || (idType === 'lid' ? contactId : 'none')}
contactId: ${recipientContact?.id || 'none'}
displayName: ${recipientContact?.name || 'Account Owner (You)'}
automationEnabled: false
useJarvis: false
requiredCapability: none
capabilityAllowed: false
privacyAllowed: false
conversationId: none
route: IGNORED
dedupeResult: PROCESSED_FIRST_TIME
`);
        return;
      }

      // 4. Ignore group messages
      if (msg.isGroup) {
        console.log(`[JARVIS AUTOMATION] Group message ignored.`);
        this.database.updateMessageProcessingState(messageId, { status: 'IGNORED', terminal_reason: 'Group message' });
        return;
      }

      // 5. Master Automation Switch Check
      const masterEnabled = this.isMasterAutomationEnabled();
      if (!masterEnabled) {
        console.log(`[JARVIS AUTOMATION] Master automation switch is OFF. Ignoring message.`);
        this.database.updateMessageProcessingState(messageId, { status: 'IGNORED', terminal_reason: 'Master automation switch OFF' });
        console.log(`\n[INCOMING TRACE]
messageId: ${messageId}
eventSource: ${eventSource}
fromMe: false
rawSenderId: ${contactId}
canonicalPhoneId: ${msg.whatsappPhoneId || (idType === 'phone' ? contactId : 'none')}
lid: ${msg.whatsappLid || (idType === 'lid' ? contactId : 'none')}
contactId: none
displayName: ${senderName || contactId}
automationEnabled: false
useJarvis: false
requiredCapability: none
capabilityAllowed: false
privacyAllowed: false
conversationId: none
route: IGNORED
dedupeResult: PROCESSED_FIRST_TIME
`);
        return;
      }

      // 6. Contact Resolution & APPROVED-CONTACT-ONLY Outer Security Gate
      console.log(`[JARVIS AUTOMATION] Looking up contact: ${senderName || contactId}...`);
      const resolvedContact = this.contacts.resolveApprovedContact(
        contactId,
        senderName,
        phoneNumber,
        msg.whatsappPhoneId,
        msg.alternateNames
      );

      const isApprovedForJarvis = Boolean(resolvedContact && (resolvedContact.is_approved === 1 || (resolvedContact as any).approved_for_jarvis === 1));
      const isContactAutomated = Boolean(isApprovedForJarvis && resolvedContact!.ai_enabled === 1);
      const parsedPerms = resolvedContact ? parseContactPermissions(resolvedContact.permissions, resolvedContact.ai_enabled === 1) : { ...DEFAULT_CONTACT_PERMISSIONS, useJarvis: false };

      this.database.addTimelineEvent({
        message_id: messageId,
        contact_id: resolvedContact ? resolvedContact.id : contactId,
        stage: 'CONTACT_RESOLVED',
        description: `Contact matched: ${resolvedContact?.name || 'Unapproved'} (Approved: ${isApprovedForJarvis}, Automated: ${isContactAutomated})`,
        metadata: { approvedForJarvis: isApprovedForJarvis, automationEnabled: isContactAutomated }
      });

      // STRICT REQUIREMENT: Unapproved contacts get NO RAG, NO embeddings, NO AI memory, NO AI calls
      if (!isApprovedForJarvis || !isContactAutomated) {
        console.log(`[JARVIS AUTOMATION] Contact found: ${resolvedContact ? resolvedContact.name : 'None'}`);
        console.log(`[JARVIS AUTOMATION] Automation enabled: false`);
        console.log(`[JARVIS AUTOMATION] Contact is not approved for JARVIS. Ignoring message.`);
        this.database.addLog('debug', 'AutomationEngine', `Message from ${contactId} (${senderName}) ignored: Contact not approved/automated`);
        this.database.updateMessageProcessingState(messageId, { status: 'UNAUTHORIZED', terminal_reason: 'Contact not approved for JARVIS' });

        console.log(`\n[INCOMING TRACE]
messageId: ${messageId}
eventSource: ${eventSource}
fromMe: false
rawSenderId: ${contactId}
canonicalPhoneId: ${msg.whatsappPhoneId || (idType === 'phone' ? contactId : 'none')}
lid: ${msg.whatsappLid || (idType === 'lid' ? contactId : 'none')}
contactId: ${resolvedContact?.id || 'none'}
displayName: ${resolvedContact?.name || senderName || contactId}
automationEnabled: false
useJarvis: ${parsedPerms.useJarvis}
requiredCapability: none
capabilityAllowed: false
privacyAllowed: false
conversationId: none
route: IGNORED
dedupeResult: PROCESSED_FIRST_TIME
`);
        return;
      }

      console.log(`[JARVIS AUTOMATION] Contact found: ${resolvedContact!.name}`);
      console.log(`[JARVIS AUTOMATION] Automation enabled: true`);

      // 7. Voice Message Processing
      const isVoice = msg.messageType === 'voice' || msg.raw?.type === 'ptt' || msg.raw?.type === 'audio' || Boolean(msg.audioData) || Boolean(msg.audioBuffer);
      let messageBody = body || '';
      let voicePayload: any = null;

      if (isVoice) {
        const isVoiceEnabled = Boolean(resolvedContact!.voice_message_enabled === 1);
        if (!isVoiceEnabled) {
          console.log(`[VOICE] Voice message ignored: voiceMessageEnabled is OFF for ${resolvedContact!.name} (${resolvedContact!.id})`);
          this.database.addLog('debug', 'AutomationEngine', `Voice message from ${resolvedContact!.name} ignored: voiceMessageEnabled is OFF`);
          this.database.updateMessageProcessingState(messageId, { status: 'IGNORED', terminal_reason: 'Voice messages disabled for contact' });
          console.log(`\n[INCOMING TRACE]
messageId: ${messageId}
eventSource: ${eventSource}
fromMe: false
rawSenderId: ${contactId}
canonicalPhoneId: ${msg.whatsappPhoneId || (idType === 'phone' ? contactId : 'none')}
lid: ${msg.whatsappLid || (idType === 'lid' ? contactId : 'none')}
contactId: ${resolvedContact!.id}
displayName: ${resolvedContact!.name}
automationEnabled: true
useJarvis: ${parsedPerms.useJarvis}
requiredCapability: voice
capabilityAllowed: false
privacyAllowed: false
conversationId: none
route: IGNORED
dedupeResult: PROCESSED_FIRST_TIME
`);
          return;
        }

        console.log(`\n[VOICE]\ncontactId: ${resolvedContact!.id}\nmessageId: ${messageId}\nduration: ${msg.audioDuration || 'unknown'}\ntranscription started: ${new Date().toISOString()}\n`);

        let audioBase64: string | undefined = msg.audioBase64 || (typeof msg.audioData === 'string' ? msg.audioData : (msg.audioData as any)?.data);
        let mimetype = msg.mimetype || (typeof msg.audioData === 'object' ? (msg.audioData as any)?.mimetype : undefined) || 'audio/ogg; codecs=opus';
        if (!audioBase64 && typeof msg.downloadMedia === 'function') {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              audioBase64 = media.data;
              mimetype = media.mimetype || mimetype;
            }
          } catch (downloadErr) {
            console.warn('[VOICE] Media download error:', downloadErr);
          }
        }

        const sttStartTime = Date.now();
        const sttResult = await voiceService.transcribeAudio({
          audioBuffer: msg.audioBuffer,
          audioBase64,
          mimetype,
          audioDuration: msg.audioDuration,
          raw: msg.raw
        });
        const sttElapsed = Date.now() - sttStartTime;

        if (!sttResult.success || !sttResult.text?.trim()) {
          console.log(`\n[VOICE]\ncontactId: ${resolvedContact!.id}\nmessageId: ${messageId}\nduration: ${msg.audioDuration || 'unknown'}\ntranscription completed: false\nprocessing time: ${sttElapsed}ms\nstatus: FAILURE\n`);
          this.database.addLog('warn', 'VoiceTranscription', `Voice transcription failed for ${resolvedContact!.name}: ${sttResult.error || 'Speech unintelligible'}`);

          const failReply = "Sorry, I couldn't understand the voice message.";
          await this.whatsapp.sendMessage(contactId, failReply, true);
          this.database.updateMessageProcessingState(messageId, { status: 'FAILED', terminal_reason: 'Voice transcription failed' });
          return;
        }

        console.log(`\n[VOICE]\ncontactId: ${resolvedContact!.id}\nmessageId: ${messageId}\nduration: ${msg.audioDuration || sttResult.duration || 0}s\ntranscription completed: true\nprocessing time: ${sttElapsed}ms\nstatus: SUCCESS\n`);
        this.database.addLog('info', 'VoiceTranscription', `Transcribed voice message from ${resolvedContact!.name}`, {
          contactId: resolvedContact!.id,
          messageId: messageId,
          duration: msg.audioDuration || sttResult.duration || 0,
          processingTimeMs: sttElapsed
        });

        messageBody = sttResult.text.trim();
        voicePayload = {
          messageType: 'voice',
          contactId: resolvedContact!.id,
          whatsappPhoneId: resolvedContact!.whatsapp_phone_id || msg.whatsappPhoneId || contactId,
          transcript: messageBody,
          timestamp: msg.timestamp,
          audioDuration: msg.audioDuration || sttResult.duration || 12
        };
      }

      // 8. Wake Phrase & Route Classification
      console.log(`[JARVIS AUTOMATION] Checking wake phrase...`);
      const wakeCheck = this.containsWakePhrase(messageBody);
      console.log(`[JARVIS AUTOMATION] Wake phrase detected: ${wakeCheck.matches}${wakeCheck.phrase ? ` ("${wakeCheck.phrase}")` : ''}`);

      const dbContactId = resolvedContact!.id;
      const whatsappReplyId = contactId;

      const hasActiveTimer = this.activeTimers.has(dbContactId);
      const activeConv = this.conversations.getActiveConversation(dbContactId);
      const isConversationActive = Boolean(activeConv && activeConv.status === 'active');
      const shouldRespond = (hasActiveTimer && resolvedContact!.ai_enabled === 1) ||
                            wakeCheck.matches ||
                            (resolvedContact!.respond_normal_messages === 1) ||
                            (isConversationActive && resolvedContact!.ai_enabled === 1);

      const primaryRoute = wakeCheck.matches ? 'WAKE' : (hasActiveTimer ? 'FOLLOW_UP' : (shouldRespond ? 'NORMAL_CHAT' : 'IGNORED'));

      const requiredCap = CapabilityGuard.classifyRequestedCapability(messageBody);
      const capCheck = CapabilityGuard.checkCapability([messageBody], resolvedContact);
      const privCheck = PrivacyGuard.checkPreAiRequest([messageBody], resolvedContact);

      // 9. Owner Availability Check (Evaluated by Application Logic)
      const ownerAvailability = this.database.getOwnerAvailability();
      const isOwnerAvail = this.database.isOwnerAvailable();
      if (isOwnerAvail && !wakeCheck.matches) {
        console.log(`[OWNER AVAILABILITY] Owner is available. Auto-response suppressed for ${resolvedContact!.name}.`);
        this.database.updateMessageProcessingState(messageId, { status: 'OWNER_AVAILABLE', terminal_reason: 'Owner is currently available' });
        this.database.addTimelineEvent({
          message_id: messageId,
          contact_id: dbContactId,
          stage: 'OWNER_AVAILABLE_SUPPRESSION',
          description: 'Automatic response suppressed because owner is currently available'
        });
        return;
      }

      // 10. Owner Seen / Read Suppression Check
      if ((msg as any).isSeen || (msg as any).seenByOwner || existingState?.owner_seen_at !== null && existingState?.owner_seen_at !== undefined) {
        console.log(`[OWNER SEEN] Message ${messageId} was already seen by owner. Suppressing automatic response.`);
        this.database.updateMessageProcessingState(messageId, { status: 'SEEN_BY_OWNER', terminal_reason: 'Message was already seen by owner' });
        this.database.addTimelineEvent({
          message_id: messageId,
          contact_id: dbContactId,
          stage: 'SEEN_BY_OWNER_SUPPRESSION',
          description: 'Response suppressed because owner has already opened/seen the message'
        });
        return;
      }

      console.log(`\n[INCOMING TRACE]
messageId: ${messageId}
eventSource: ${eventSource}
fromMe: false
rawSenderId: ${contactId}
canonicalPhoneId: ${msg.whatsappPhoneId || resolvedContact!.whatsapp_phone_id || (idType === 'phone' ? contactId : 'none')}
lid: ${msg.whatsappLid || resolvedContact!.whatsapp_id || (idType === 'lid' ? contactId : 'none')}
contactId: ${dbContactId}
displayName: ${resolvedContact!.name}
automationEnabled: ${isContactAutomated}
useJarvis: ${parsedPerms.useJarvis}
requiredCapability: ${requiredCap}
capabilityAllowed: ${capCheck.allowed}
privacyAllowed: ${privCheck.allowed}
conversationId: ${activeConv?.id || 'pending'}
route: ${primaryRoute}
dedupeResult: PROCESSED_FIRST_TIME
`);

      if (!shouldRespond) {
        console.log(`[JARVIS AUTOMATION] Message does not contain wake phrase and conversation is not active for ${resolvedContact!.name}. Ignoring.`);
        this.database.addLog('debug', 'AutomationEngine', `Message from ${contactId} ignored: Wake phrase not detected`);
        this.database.updateMessageProcessingState(messageId, { status: 'IGNORED', terminal_reason: 'Wake phrase not detected & conversation inactive' });
        return;
      }

      // Index message into RAG (ONLY for approved contact with RAG enabled)
      if (resolvedContact!.rag_enabled !== 0 && resolvedContact!.memory_enabled !== 0) {
        this.rag.indexMessage(dbContactId, messageId, 'incoming', messageBody, msg.timestamp || Date.now());
      }

      const triggerType = wakeCheck.matches ? 'wake_phrase' : (hasActiveTimer ? 'followup_message' : 'normal_message');

      if (wakeCheck.matches) {
        eventBus.emit('WAKE_PHRASE_DETECTED', {
          contactId: dbContactId,
          messageId: messageId,
          phrase: wakeCheck.phrase!,
          text: messageBody
        });
        this.database.addLog('info', 'AutomationEngine', `Wake phrase detected ("${wakeCheck.phrase}") from ${senderName || resolvedContact!.name}`);
      }

      // 11. Record message in conversation
      const { conversation } = this.conversations.recordMessage(dbContactId, messageBody, messageId, msg.timestamp, voicePayload);

      // Update state: PENDING
      this.database.updateMessageProcessingState(messageId, { status: 'PENDING' });

      // 12. Schedule or Execute Response
      if (wakeCheck.matches) {
        // Wake phrase triggers immediate AI response (0s delay)
        if (this.activeTimers.has(dbContactId)) {
          this.cancelTimer(dbContactId, 'Wake phrase triggered immediate response');
        }
        console.log(`[JARVIS AUTOMATION] Wake phrase detected: Immediate reply mode (Delay: 0s)...`);
        const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        await this.executeResponse(dbContactId, resolvedContact!.name, conversation.id, pendingId, triggerType, whatsappReplyId, messageId);
      } else {
        const effectiveDelay = this.getEffectiveDelay(resolvedContact?.response_delay_seconds);
        if (effectiveDelay <= 0) {
          console.log(`[JARVIS AUTOMATION] Immediate reply mode (Delay: 0s)...`);
          const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
          await this.executeResponse(dbContactId, resolvedContact!.name, conversation.id, pendingId, triggerType, whatsappReplyId, messageId);
        } else {
          console.log(`[JARVIS AUTOMATION] Response scheduled in ${effectiveDelay} seconds (Message collection active)...`);
          this.scheduleOrResetTimer(dbContactId, resolvedContact!.name, conversation.id, triggerType, effectiveDelay, whatsappReplyId, messageId);
        }
      }
    } catch (error: any) {
      console.error(`\n[JARVIS AUTOMATION ERROR]\nstage: handleIncomingMessage\nerror: ${error?.message || String(error)}\nstack: ${error?.stack || 'no stack'}\n`);
      this.database.addLog('error', 'AutomationEngine', `handleIncomingMessage failed: ${error?.message || error}`, { error: error?.message, stack: error?.stack });
    }
  }

  public getEffectiveDelay(contactDelay?: number): number {
    const envDebugDelay = process.env.DEBUG_RESPONSE_DELAY;
    if (envDebugDelay !== undefined && envDebugDelay !== '') {
      return Math.max(0, Number(envDebugDelay));
    }
    if (contactDelay !== undefined && contactDelay !== null) {
      return contactDelay;
    }
    return this.getDelaySeconds();
  }

  private scheduleOrResetTimer(
    contactId: string,
    contactName: string,
    conversationId: string,
    triggerType: string,
    delaySec: number,
    whatsappReplyId?: string,
    sourceMessageId?: string
  ): void {
    const expiresAt = Date.now() + delaySec * 1000;
    const replyTarget = whatsappReplyId || contactId;
    let initialSourceMessageId = sourceMessageId;

    if (this.activeTimers.has(contactId)) {
      const existing = this.activeTimers.get(contactId)!;
      clearTimeout(existing.timerId);
      initialSourceMessageId = existing.sourceMessageId || sourceMessageId;

      this.database.cancelPendingResponse(existing.pendingId, 'Timer reset by new incoming message');
      eventBus.emit('RESPONSE_TIMER_RESET', {
        conversationId,
        contactId,
        messageCount: 0,
        lastMessageText: '',
        timerSeconds: delaySec,
        expiresAt
      });
    } else {
      eventBus.emit('RESPONSE_TIMER_STARTED', {
        conversationId,
        contactId,
        messageCount: 1,
        lastMessageText: '',
        timerSeconds: delaySec,
        expiresAt
      });
    }

    const pendingId = `pending_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.database.createPendingResponse({
      id: pendingId,
      contactId,
      conversationId,
      sourceMessageId: initialSourceMessageId,
      latestMessageId: sourceMessageId,
      triggerType,
      timerExpiresAt: expiresAt,
      scheduledAt: Date.now()
    });

    const timeout = setTimeout(async () => {
      await this.executeResponse(contactId, contactName, conversationId, pendingId, triggerType, replyTarget, sourceMessageId);
    }, delaySec * 1000);

    this.activeTimers.set(contactId, {
      timerId: timeout,
      pendingId,
      contactId,
      conversationId,
      contactName,
      sourceMessageId: initialSourceMessageId,
      latestMessageId: sourceMessageId,
      triggerType,
      expiresAt,
      whatsappReplyId: replyTarget
    });
  }

  public async executeResponse(
    contactId: string,
    contactName: string,
    conversationId: string,
    pendingId: string,
    triggerType: string,
    whatsappReplyId?: string,
    incomingMessageId?: string
  ): Promise<void> {
    this.activeTimers.delete(contactId);

    const masterEnabled = this.isMasterAutomationEnabled();
    const contactEnabled = this.contacts.isContactAutomationEnabled(contactId);

    if (!masterEnabled || !contactEnabled) {
      console.log(`[JARVIS AUTOMATION] Automation was disabled before response execution (Master: ${masterEnabled}, Contact ${contactId}: ${contactEnabled}).`);
      this.database.cancelPendingResponse(pendingId, 'Automation disabled or contact turned OFF');
      if (incomingMessageId) {
        this.database.updateMessageProcessingState(incomingMessageId, { status: 'CANCELLED', terminal_reason: 'Automation disabled prior to execution' });
      }
      return;
    }

    const contact = this.database.getContact(contactId);
    const unresponded = this.conversations.getUnrespondedMessages(conversationId);

    // Deduplicate message list by ID and clean messages
    const uniqueMap = new Map<string, DbMessage>();
    for (const m of unresponded) {
      if (!uniqueMap.has(m.id)) {
        uniqueMap.set(m.id, m);
      }
    }
    const messageTexts = Array.from(uniqueMap.values()).map((m: DbMessage) => m.message_text);

    if (messageTexts.length === 0) {
      console.log(`[JARVIS AUTOMATION] No unresponded messages found for ${contactName}.`);
      this.database.cancelPendingResponse(pendingId, 'No unresponded messages');
      return;
    }

    let targetRecipient = whatsappReplyId;
    if (!targetRecipient || (targetRecipient.endsWith('@c.us') && targetRecipient.replace(/\D/g, '').length === 10)) {
      targetRecipient = contact?.whatsapp_id || contact?.whatsapp_phone_id || (contact?.phone_number ? `${contact.phone_number.replace(/\D/g, '')}@c.us` : contactId);
    }

    const lastMsgId = incomingMessageId || Array.from(uniqueMap.values()).pop()?.id || `msg_${Date.now()}`;
    const aiRequestId = `ai_${contactId}_${lastMsgId}`;
    const responseOperationId = `op_${contactId}_${lastMsgId}_${triggerType}`;
    const auditEventId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // Transition state: PROCESSING
    this.database.updateMessageProcessingState(lastMsgId, { status: 'PROCESSING', processed_at: Date.now() });

    // 1. Application-Level Pre-AI Privacy Check
    const privacyCheck = PrivacyGuard.checkPreAiRequest(messageTexts, contact);
    if (!privacyCheck.allowed) {
      console.log(`\n[AI TRACE]
messageId: ${lastMsgId}
aiRequestId: ${aiRequestId}
contactId: ${contactId}
conversationId: ${conversationId}
route: ${triggerType}
AI_CALLED = NO
`);
      const refusal = privacyCheck.refusalMessage || "Sorry, I can't provide the owner's private information.";
      console.log(`[PRIVACY GUARD] Blocked unauthorized request from ${contactName} (${contactId}). Reason: ${privacyCheck.refusalReason}`);
      
      this.database.addLog('warn', 'PrivacyGuard', `Privacy refusal sent to ${contactName} (${contactId})`, {
        reason: privacyCheck.refusalReason,
        detectedCategory: privacyCheck.detectedCategory
      });

      this.database.saveAiAuditLog({
        audit_event_id: auditEventId,
        timestamp: Date.now(),
        contact_id: contactId,
        canonical_phone_id: contact?.whatsapp_phone_id || contactId,
        message_id: lastMsgId,
        incoming_message: messageTexts.join(' | '),
        message_type: 'text',
        owner_availability: this.database.getOwnerAvailability(),
        contact_permissions: contact?.permissions || null,
        conversation_state: `conv_${conversationId}`,
        model: 'privacy_guard',
        provider: 'system',
        generated_response: refusal,
        latency_ms: 0,
        delivery_result: 'SUCCESS',
        decision_summary: `Blocked by PrivacyGuard: ${privacyCheck.refusalReason}`
      });

      await this.whatsapp.sendMessage(targetRecipient, refusal, true);
      this.conversations.markMessagesProcessed(conversationId);
      this.database.markPendingResponseExecuted(pendingId);
      this.database.updateMessageProcessingState(lastMsgId, { status: 'PRIVACY_BLOCKED', terminal_reason: privacyCheck.refusalReason });
      return;
    }

    // 2. Application-Level Per-Contact AI Capability Check
    const capabilityCheck = CapabilityGuard.checkCapability(messageTexts, contact);
    if (!capabilityCheck.allowed) {
      console.log(`\n[AI TRACE]
messageId: ${lastMsgId}
aiRequestId: ${aiRequestId}
contactId: ${contactId}
conversationId: ${conversationId}
route: ${triggerType}
AI_CALLED = NO
`);
      const refusal = capabilityCheck.refusalMessage || "Sorry, JARVIS isn't configured to help with that for this contact.";
      console.log(`[CAPABILITY GUARD] Refusal sent to ${contactName} (${contactId}): "${refusal}" (Reason: ${capabilityCheck.reason})`);
      
      this.database.addLog('warn', 'CapabilityGuard', `Capability blocked for ${contactName} (${contactId})`, {
        reason: capabilityCheck.reason,
        requiredCapability: capabilityCheck.requiredCapability
      });

      this.database.saveAiAuditLog({
        audit_event_id: auditEventId,
        timestamp: Date.now(),
        contact_id: contactId,
        canonical_phone_id: contact?.whatsapp_phone_id || contactId,
        message_id: lastMsgId,
        incoming_message: messageTexts.join(' | '),
        message_type: 'text',
        owner_availability: this.database.getOwnerAvailability(),
        contact_permissions: contact?.permissions || null,
        conversation_state: `conv_${conversationId}`,
        model: 'capability_guard',
        provider: 'system',
        generated_response: refusal,
        latency_ms: 0,
        delivery_result: 'SUCCESS',
        decision_summary: `Blocked by CapabilityGuard: ${capabilityCheck.reason}`
      });

      await this.whatsapp.sendMessage(targetRecipient, refusal, true);
      this.conversations.markMessagesProcessed(conversationId);
      this.database.markPendingResponseExecuted(pendingId);
      this.database.updateMessageProcessingState(lastMsgId, { status: 'UNAUTHORIZED', terminal_reason: capabilityCheck.reason });
      return;
    }

    // 3. Delegated Tasks & Reminders Intent Check
    const combinedMessageText = messageTexts.join(' ');
    const taskIntent = TaskManager.processDelegatedTaskIntent(combinedMessageText, contact, lastMsgId, this.database);
    if (taskIntent.isTaskRequest) {
      console.log(`\n[AI TRACE]
messageId: ${lastMsgId}
aiRequestId: ${aiRequestId}
contactId: ${contactId}
conversationId: ${conversationId}
route: ${triggerType}
AI_CALLED = NO
`);
      if (!taskIntent.allowed) {
        const refusal = taskIntent.refusalMessage || "Sorry, I am not authorized to create reminders or tasks for the owner.";
        console.log(`[TASK MANAGER] Blocked reminder request from ${contactName} (${contactId})`);
        
        this.database.saveAiAuditLog({
          audit_event_id: auditEventId,
          timestamp: Date.now(),
          contact_id: contactId,
          canonical_phone_id: contact?.whatsapp_phone_id || contactId,
          message_id: lastMsgId,
          incoming_message: combinedMessageText,
          message_type: 'text',
          owner_availability: this.database.getOwnerAvailability(),
          contact_permissions: contact?.permissions || null,
          conversation_state: `conv_${conversationId}`,
          model: 'task_manager',
          provider: 'system',
          generated_response: refusal,
          latency_ms: 0,
          delivery_result: 'SUCCESS',
          decision_summary: `Task creation blocked: Contact not authorized for tasks/reminders`
        });

        await this.whatsapp.sendMessage(targetRecipient, refusal, true);
        this.conversations.markMessagesProcessed(conversationId);
        this.database.markPendingResponseExecuted(pendingId);
        this.database.updateMessageProcessingState(lastMsgId, { status: 'UNAUTHORIZED', terminal_reason: 'Task creation unauthorized' });
        return;
      }

      if (taskIntent.replyMessage) {
        console.log(`[TASK MANAGER] Sending task confirmation to ${contactName} (${contactId}): "${taskIntent.replyMessage}"`);
        
        this.database.saveAiAuditLog({
          audit_event_id: auditEventId,
          timestamp: Date.now(),
          contact_id: contactId,
          canonical_phone_id: contact?.whatsapp_phone_id || contactId,
          message_id: lastMsgId,
          incoming_message: combinedMessageText,
          message_type: 'text',
          owner_availability: this.database.getOwnerAvailability(),
          contact_permissions: contact?.permissions || null,
          conversation_state: `conv_${conversationId}`,
          model: 'task_manager',
          provider: 'system',
          generated_response: taskIntent.replyMessage,
          latency_ms: 0,
          delivery_result: 'SUCCESS',
          decision_summary: `Task created: "${taskIntent.task?.title}"`
        });

        await this.whatsapp.sendMessage(targetRecipient, taskIntent.replyMessage, true);
        this.conversations.markMessagesProcessed(conversationId);
        this.database.markPendingResponseExecuted(pendingId);
        this.database.markMessageRespondedByJarvis(lastMsgId, contactId);
        return;
      }
    }

    // 4. AI Request Idempotency Check
    if (this.completedOperations.has(responseOperationId)) {
      console.log(`[RESPONSE IDEMPOTENCY] Operation ${responseOperationId} already completed. Dropping duplicate response.`);
      return;
    }
    if (this.processedAiRequests.has(aiRequestId)) {
      console.log(`[AI REQUEST IDEMPOTENCY] AI Request ${aiRequestId} already processed. Dropping duplicate AI call.`);
      return;
    }
    this.processedAiRequests.add(aiRequestId);
    this.completedOperations.add(responseOperationId);

    console.log(`\n[AI TRACE]
messageId: ${lastMsgId}
aiRequestId: ${aiRequestId}
contactId: ${contactId}
conversationId: ${conversationId}
route: ${triggerType}
AI_CALLED = YES
`);

    console.log(`[JARVIS AUTOMATION] Sending message to AI...`);
    const aiProvider = getAiProvider();
    console.log(`[JARVIS AI] Provider: ${aiProvider.providerName.toUpperCase()}`);
    console.log(`[JARVIS AI] Generating response for: ${JSON.stringify(messageTexts)}...`);

    // 5. Retrieve isolated conversation history & Per-Contact RAG Context
    const useMemory = contact?.memory_enabled !== 0;
    const conversationContext = useMemory ? this.conversations.getFormattedHistory(contactId, 6) : undefined;
    
    // Semantic / Keyword RAG retrieval for older context
    const ragResult = (contact?.rag_enabled !== 0 && useMemory)
      ? this.rag.retrieveContext(contactId, messageTexts.join(' '), 3)
      : { relevantChunks: [], retrievalMetadata: null, formattedContext: '' };

    if (ragResult.formattedContext) {
      this.database.addTimelineEvent({
        message_id: lastMsgId,
        contact_id: contactId,
        stage: 'RAG_CONTEXT_RETRIEVED',
        description: `Retrieved ${ragResult.relevantChunks.length} memory chunks for ${contactName}`,
        metadata: ragResult.retrievalMetadata
      });
    }

    try {
      const aiResult = await aiProvider.generateResponse({
        contactName,
        contactId,
        messages: messageTexts,
        conversationContext,
        ragContext: ragResult.formattedContext || undefined,
        relationship: contact?.relationship || null,
        description: contact?.description || null,
        systemPrompt: contact?.custom_system_prompt || undefined,
        triggerType
      });

      // Post-AI Output Guard
      const validated = PrivacyGuard.validatePostAiOutput(aiResult.reply, contact);
      const replyText = validated.filteredReply;

      console.log(`[JARVIS AI] Response generated: "${replyText}" (Latency: ${aiResult.latencyMs}ms)`);

      const isVoiceResponseEnabled = Boolean(contact && contact.voice_response_enabled === 1);
      let voiceSendSucceeded = false;

      if (isVoiceResponseEnabled) {
        // Voice response path
        console.log(`[JARVIS AUTOMATION] Voice response enabled for ${contactName}. Generating speech...`);
        let ttsResult: any = null;
        try {
          ttsResult = await voiceService.generateSpeech(replyText);
        } catch (ttsErr: any) {
          console.error(`[JARVIS AUTOMATION ERROR] TTS_ERROR for ${contactName}: ${ttsErr?.message || ttsErr}`);
          this.database.addLog('error', 'AutomationEngine', `TTS failed for ${contactName}`, { error: ttsErr?.message || ttsErr });
        }

        if (ttsResult?.success && ttsResult.audioBuffer) {
          console.log(`[JARVIS AUTOMATION] Sending WhatsApp audio voice response...`);
          try {
            await this.whatsapp.sendVoiceMessage(targetRecipient, ttsResult.audioBuffer, ttsResult.mimetype || 'audio/ogg; codecs=opus', true, replyText);
            voiceSendSucceeded = true;
            console.log(`[JARVIS AUTOMATION] Voice response sent successfully.`);
          } catch (voiceSendErr: any) {
            const errMsg = voiceSendErr?.message || String(voiceSendErr);
            console.error(`[JARVIS AUTOMATION ERROR] WHATSAPP_SEND_AUDIO_ERROR for ${contactName}: ${errMsg}`);
            this.database.addLog('error', 'AutomationEngine', `Voice send failed for ${contactName}`, { error: errMsg });
          }
        }

        // Always send text response
        console.log(`[JARVIS AUTOMATION] Sending WhatsApp text response...`);
        await this.whatsapp.sendMessage(targetRecipient, replyText, true);
        console.log(`\nTEXT_RESPONSE = SUCCESS\nVOICE_RESPONSE = ${voiceSendSucceeded ? 'SUCCESS' : 'FAILED'}\n`);
      } else {
        // Text-only path
        console.log(`[JARVIS AUTOMATION] Sending WhatsApp text response...`);
        await this.whatsapp.sendMessage(targetRecipient, replyText, true);
        console.log(`\nTEXT_RESPONSE = SUCCESS\nVOICE_RESPONSE = N/A\n`);
      }

      // Index outgoing response into RAG if contact RAG enabled
      if (contact?.rag_enabled !== 0 && contact?.memory_enabled !== 0) {
        this.rag.indexMessage(contactId, `resp_${lastMsgId}`, 'outgoing', replyText, Date.now());
      }

      this.conversations.markMessagesProcessed(conversationId);
      this.database.markPendingResponseExecuted(pendingId);
      this.database.markMessageRespondedByJarvis(lastMsgId, contactId);

      // Save Persistent AI Audit Log
      this.database.saveAiAuditLog({
        audit_event_id: auditEventId,
        timestamp: Date.now(),
        contact_id: contactId,
        canonical_phone_id: contact?.whatsapp_phone_id || contactId,
        message_id: lastMsgId,
        incoming_message: messageTexts.join(' | '),
        message_type: isVoiceResponseEnabled ? 'voice' : 'text',
        owner_availability: this.database.getOwnerAvailability(),
        contact_permissions: contact?.permissions || null,
        conversation_state: `conv_${conversationId}`,
        rag_retrieval_metadata: ragResult.retrievalMetadata ? JSON.stringify(ragResult.retrievalMetadata) : null,
        model: aiResult.model,
        provider: aiResult.provider,
        config_version: 'v2.0',
        generated_response: replyText,
        latency_ms: aiResult.latencyMs,
        token_usage: aiResult.tokenUsage ? JSON.stringify(aiResult.tokenUsage) : null,
        finish_reason: aiResult.finishReason || 'stop',
        delivery_result: 'SUCCESS',
        decision_summary: `JARVIS generated automated response via ${aiResult.provider} (${aiResult.latencyMs}ms)`
      });

      this.database.addTimelineEvent({
        message_id: lastMsgId,
        contact_id: contactId,
        stage: 'RESPONSE_DELIVERED',
        description: `Delivered automated response to ${contactName}`,
        metadata: { latencyMs: aiResult.latencyMs, provider: aiResult.provider }
      });

      console.log(`\n[OUTGOING TRACE]
responseOperationId: ${responseOperationId}
contactId: ${contactId}
sourceMessageId: ${lastMsgId}
sourceType: ${triggerType}
textDelivery: SUCCESS
voiceDelivery: ${isVoiceResponseEnabled ? (voiceSendSucceeded ? 'SUCCESS' : 'FAILED') : 'N/A'}
`);

      eventBus.emit('AI_RESPONSE_GENERATED', {
        contactId,
        conversationId,
        prompt: messageTexts.join(' | '),
        replyText,
        provider: aiResult.provider,
        latencyMs: aiResult.latencyMs
      });

      this.database.addLog('info', 'AutomationEngine', `JARVIS responded to ${contactName}`, {
        contactId,
        provider: aiResult.provider,
        latencyMs: aiResult.latencyMs,
        reply: replyText,
        isVoiceResponse: isVoiceResponseEnabled
      });

      console.log(`[JARVIS AUTOMATION] Response sent successfully.`);
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      const stage = errMsg.startsWith('TTS_ERROR') ? 'TTS_ERROR'
        : errMsg.startsWith('MEDIA_CREATION_ERROR') ? 'MEDIA_CREATION_ERROR'
        : errMsg.startsWith('WHATSAPP_SEND_AUDIO_ERROR') ? 'WHATSAPP_SEND_AUDIO_ERROR'
        : errMsg.includes('Cannot send') ? 'WHATSAPP_SEND_TEXT_ERROR'
        : 'AI_ERROR';
      console.error(`[JARVIS AUTOMATION ERROR] stage: ${stage} | contact: ${contactName} | error: ${errMsg}`);
      this.database.addLog('error', 'AutomationEngine', `Response failed for ${contactName} [${stage}]`, { error: errMsg, stage });
      this.database.cancelPendingResponse(pendingId, `Response failure [${stage}]: ${errMsg}`);
      this.database.updateMessageProcessingState(lastMsgId, { status: 'FAILED', terminal_reason: `Response failure [${stage}]: ${errMsg}` });

      this.database.saveAiAuditLog({
        audit_event_id: auditEventId,
        timestamp: Date.now(),
        contact_id: contactId,
        canonical_phone_id: contact?.whatsapp_phone_id || contactId,
        message_id: lastMsgId,
        incoming_message: messageTexts.join(' | '),
        message_type: 'text',
        owner_availability: this.database.getOwnerAvailability(),
        contact_permissions: contact?.permissions || null,
        conversation_state: `conv_${conversationId}`,
        model: 'unknown',
        provider: 'ai_error',
        generated_response: '',
        latency_ms: 0,
        delivery_result: 'FAILED',
        error_information: errMsg,
        decision_summary: `AI generation failed: ${errMsg}`
      });
    }
  }

  public cancelTimer(contactId: string, reason: string): void {
    if (this.activeTimers.has(contactId)) {
      const active = this.activeTimers.get(contactId)!;
      clearTimeout(active.timerId);
      this.activeTimers.delete(contactId);

      this.database.cancelPendingResponse(active.pendingId, reason);
      eventBus.emit('RESPONSE_CANCELLED', {
        conversationId: active.conversationId,
        contactId,
        messageCount: 0,
        lastMessageText: '',
        reason
      });
    }
  }

  public cancelAllPendingTimers(reason: string): void {
    for (const [contactId] of this.activeTimers) {
      this.cancelTimer(contactId, reason);
    }
  }

  public async flushPendingForContact(contactId: string): Promise<boolean> {
    const timer = this.activeTimers.get(contactId);
    if (!timer) return false;
    clearTimeout(timer.timerId);
    this.activeTimers.delete(contactId);
    await this.executeResponse(
      timer.contactId,
      timer.contactName,
      timer.conversationId,
      timer.pendingId,
      timer.triggerType,
      (timer as any).whatsappReplyId,
      timer.latestMessageId
    );
    return true;
  }

  public getActiveTimers() {
    return Array.from(this.activeTimers.values()).map((t) => ({
      contactId: t.contactId,
      contactName: t.contactName,
      conversationId: t.conversationId,
      pendingId: t.pendingId,
      whatsappReplyId: (t as any).whatsappReplyId,
      triggerType: t.triggerType,
      expiresAt: t.expiresAt,
      remainingSeconds: Math.max(0, Math.round((t.expiresAt - Date.now()) / 1000))
    }));
  }
}

export const automationEngine = new AutomationEngine();

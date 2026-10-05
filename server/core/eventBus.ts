import { EventEmitter } from 'events';

export interface WhatsAppMessagePayload {
  id: string;
  contactId: string;
  whatsappLid?: string;
  whatsappPhoneId?: string;
  senderName?: string;
  phoneNumber?: string;
  alternateNames?: string[];
  fromMe: boolean;
  body: string;
  timestamp: number;
  isGroup?: boolean;
  messageType?: 'text' | 'voice' | 'ptt' | 'audio' | 'image' | 'document';
  audioDuration?: number;
  audioData?: string;
  audioBuffer?: Buffer;
  mimetype?: string;
  hasMedia?: boolean;
  downloadMedia?: () => Promise<{ mimetype: string; data: string; filename?: string } | null>;
  raw?: any;
  eventSource?: string;
}

export interface ContactApprovedPayload {
  contactId: string;
  name: string;
  phoneNumber?: string;
  automationEnabled: boolean;
  ragEnabled?: boolean;
  approvedForJarvis?: boolean;
}

export interface WakePhrasePayload {
  contactId: string;
  messageId: string;
  phrase: string;
  text: string;
}

export interface ConversationEventPayload {
  conversationId: string;
  contactId: string;
  messageCount: number;
  lastMessageText: string;
  timerSeconds?: number;
  expiresAt?: number;
  reason?: string;
}

export interface AiResponsePayload {
  contactId: string;
  conversationId?: string;
  prompt: string;
  replyText: string;
  provider: string;
  latencyMs: number;
}

export interface MessageSentPayload {
  contactId: string;
  messageId: string;
  text: string;
  timestamp: number;
  isAutomated: boolean;
  isVoice?: boolean;
}

export interface WhatsAppStatusPayload {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'error';
  qrCode?: string;
  error?: string;
  account?: any;
}

export interface LogPayload {
  level: 'info' | 'warn' | 'error' | 'debug';
  module: string;
  message: string;
  metadata?: Record<string, any>;
  timestamp: number;
}

export type JarvisEvents = {
  MESSAGE_RECEIVED: (payload: WhatsAppMessagePayload) => void;
  CONTACT_APPROVED: (payload: ContactApprovedPayload) => void;
  WAKE_PHRASE_DETECTED: (payload: WakePhrasePayload) => void;
  CONVERSATION_STARTED: (payload: ConversationEventPayload) => void;
  MESSAGE_ADDED: (payload: ConversationEventPayload) => void;
  RESPONSE_TIMER_STARTED: (payload: ConversationEventPayload) => void;
  RESPONSE_TIMER_RESET: (payload: ConversationEventPayload) => void;
  RESPONSE_CANCELLED: (payload: ConversationEventPayload) => void;
  AI_RESPONSE_GENERATED: (payload: AiResponsePayload) => void;
  MESSAGE_SENT: (payload: MessageSentPayload) => void;
  WHATSAPP_CONNECTED: (payload: WhatsAppStatusPayload) => void;
  WHATSAPP_DISCONNECTED: (payload: WhatsAppStatusPayload) => void;
  WHATSAPP_QR: (qr: string) => void;
  WHATSAPP_STATUS_CHANGED: (payload: WhatsAppStatusPayload) => void;
  AUTOMATION_MASTER_SWITCH_CHANGED: (enabled: boolean) => void;
  LOG_EMITTED: (payload: LogPayload) => void;
  TASK_CREATED: (task: any) => void;
  TASK_UPDATED: (task: any) => void;
  TASK_REMINDER_DUE: (payload: any) => void;
  CALENDAR_EVENT_CREATED: (event: any) => void;
  CALENDAR_EVENT_UPDATED: (event: any) => void;
};

export class JarvisEventBus {
  private static instance: JarvisEventBus;
  private emitter: EventEmitter;

  private constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(50);
  }

  public static getInstance(): JarvisEventBus {
    if (!JarvisEventBus.instance) {
      JarvisEventBus.instance = new JarvisEventBus();
    }
    return JarvisEventBus.instance;
  }

  public on<K extends keyof JarvisEvents>(event: K, listener: JarvisEvents[K]): void {
    this.emitter.on(event, listener as (...args: any[]) => void);
  }

  public off<K extends keyof JarvisEvents>(event: K, listener: JarvisEvents[K]): void {
    this.emitter.off(event, listener as (...args: any[]) => void);
  }

  public emit<K extends keyof JarvisEvents>(event: K, ...args: Parameters<JarvisEvents[K]>): boolean {
    return this.emitter.emit(event, ...args);
  }

  public removeAllListeners(event?: keyof JarvisEvents): void {
    this.emitter.removeAllListeners(event);
  }
}

export const eventBus = JarvisEventBus.getInstance();

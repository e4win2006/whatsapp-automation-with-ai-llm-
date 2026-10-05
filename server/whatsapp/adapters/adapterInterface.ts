export type WhatsAppAdapterStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'error';

export interface WhatsAppContact {
  id: string;
  name: string;
  number?: string;
  isGroup: boolean;
  isMyContact?: boolean;
}

export interface WhatsAppChat {
  id: string;
  name: string;
  isGroup: boolean;
  unreadCount: number;
  lastMessageTimestamp?: number;
}

export interface ResolvedWhatsAppIdentity {
  whatsappLid?: string | null;
  whatsappPhoneId?: string | null;
  phoneNumber?: string | null;
  displayName: string;
  alternateNames: string[];
}

export interface WhatsAppIncomingMessage {
  id: string;
  contactId: string;
  whatsappLid?: string;
  whatsappPhoneId?: string;
  senderName: string;
  phoneNumber?: string;
  alternateNames?: string[];
  fromMe: boolean;
  body: string;
  timestamp: number;
  isGroup: boolean;
  messageType?: 'text' | 'voice' | 'ptt' | 'audio' | 'image' | 'document';
  audioDuration?: number; // Duration in seconds
  audioData?: string; // base64 encoded audio or mock marker
  audioBuffer?: Buffer;
  mimetype?: string;
  hasMedia?: boolean;
  downloadMedia?: () => Promise<{ mimetype: string; data: string; filename?: string } | null>;
  raw?: any;
  eventSource?: string;
}

export interface WhatsAppSendResult {
  messageId: string;
  timestamp: number;
  success: boolean;
  isVoice?: boolean;
}

export interface SelectableWhatsAppContact {
  id: string;
  name: string;
  number?: string;
  alternateNames?: string[];
  lastMessageTimestamp?: number;
  type: 'person';
}

export interface IWhatsAppAdapter {
  readonly adapterName: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): WhatsAppAdapterStatus;
  getContacts(): Promise<WhatsAppContact[]>;
  getChats(): Promise<WhatsAppChat[]>;
  getSelectableWhatsAppChats(): Promise<SelectableWhatsAppContact[]>;
  sendMessage(contactId: string, message: string): Promise<WhatsAppSendResult>;
  sendVoiceMessage?(contactId: string, audioData: Buffer | string, mimetype?: string): Promise<WhatsAppSendResult>;
  checkConnectionState?(): Promise<string | null>;

  // Event handler registration
  onMessage(handler: (msg: WhatsAppIncomingMessage) => void): void;
  onStatusChange(handler: (status: WhatsAppAdapterStatus, details?: any) => void): void;
  onQrCode(handler: (qr: string) => void): void;
}

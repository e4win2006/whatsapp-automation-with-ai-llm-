import {
  IWhatsAppAdapter,
  WhatsAppAdapterStatus,
  WhatsAppChat,
  WhatsAppContact,
  WhatsAppIncomingMessage,
  WhatsAppSendResult
} from './adapterInterface';
import { config } from '../../core/config';
import { normalizePhoneNumber } from '../../utils/phoneUtils';
import { db } from '../../database/database';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export class WhatsAppWebAdapter implements IWhatsAppAdapter {
  public readonly adapterName = 'WhatsAppWebAdapter';
  private status: WhatsAppAdapterStatus = 'disconnected';
  private client: any = null;
  private currentQrString: string | null = null;
  private currentQrDataUrl: string | null = null;
  private authenticatedInfo: { pushname?: string; wid?: string; phone?: string } | null = null;

  private inFlightGetChatsPromise: Promise<import('./adapterInterface').SelectableWhatsAppContact[]> | null = null;
  private cachedSelectableChats: { data: import('./adapterInterface').SelectableWhatsAppContact[]; timestamp: number } | null = null;

  private messageHandler?: (msg: WhatsAppIncomingMessage) => void;
  private statusChangeHandler?: (status: WhatsAppAdapterStatus, details?: any) => void;
  private qrHandler?: (qr: string) => void;

  private isConnecting: boolean = false;
  private readyCheckInterval: any = null;

  // Adapter-level message deduplication with PROCESSING / PROCESSED states.
  // This is the FIRST line of defence — before async identity resolution — so
  // concurrent events from message, message_create, and in-page-bridge for the
  // SAME WhatsApp message ID are collapsed into exactly ONE processing path.
  private readonly msgDedup: Map<string, { state: 'PROCESSING' | 'PROCESSED'; source: string; ts: number }> = new Map();
  private readonly MSG_DEDUP_TTL_MS = 60_000; // entries expire after 60 s

  private tryClaimMessageProcessing(msgId: string, eventSource: string): boolean {
    const now = Date.now();

    // Prune stale entries
    for (const [k, v] of this.msgDedup) {
      if (now - v.ts > this.MSG_DEDUP_TTL_MS) this.msgDedup.delete(k);
    }

    const existing = this.msgDedup.get(msgId);
    if (existing) {
      console.log(`\n[EVENT DEDUP]\nmessageId: ${msgId}\nfirstEvent: ${existing.source}\nduplicateEvent: ${eventSource}\naction: IGNORED_DUPLICATE\n`);
      return false; // another event already claimed this message
    }

    this.msgDedup.set(msgId, { state: 'PROCESSING', source: eventSource, ts: now });
    return true; // this event is the owner
  }

  private markMessageProcessed(msgId: string): void {
    const entry = this.msgDedup.get(msgId);
    if (entry) entry.state = 'PROCESSED';
  }

  public async connect(): Promise<void> {
    if (this.isConnecting) {
      console.log('[WHATSAPP WEB] Connection already in progress. Skipping duplicate connect call.');
      return;
    }
    if (this.status === 'connected' && this.client) {
      console.log('[WHATSAPP WEB] WhatsApp client already connected.');
      return;
    }

    this.isConnecting = true;
    try {
      if (this.client) {
        try {
          await this.client.destroy();
        } catch {}
        this.client = null;
      }

      this.setStatus('connecting');

      // Dynamically import whatsapp-web.js
      const pkgName = 'whatsapp-web.js';
      const wwebjs = (await import(/* webpackIgnore: true */ pkgName)) as any;
      const { Client, LocalAuth } = wwebjs.default || wwebjs;

      const sessionPath = config.WHATSAPP_SESSION_PATH;
      if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true });
      }

      // Detect available Chrome or Edge executable on Windows
      const executablePath = this.detectBrowserExecutable();

      this.client = new Client({
        authStrategy: new LocalAuth({
          dataPath: sessionPath
        }),
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/wwebjs/web-versions/main/packages/client/latest.html'
        },
        puppeteer: {
          headless: config.WHATSAPP_HEADLESS,
          executablePath: executablePath || undefined,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
          ]
        }
      });

      this.client.on('qr', async (qr: string) => {
        console.log('[WHATSAPP DEBUG] qr event received');
        this.currentQrString = qr;
        try {
          this.currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 280 });
        } catch {
          this.currentQrDataUrl = null;
        }

        this.setStatus('qr_ready', { qr: this.currentQrDataUrl || qr });

        if (this.qrHandler) {
          this.qrHandler(this.currentQrDataUrl || qr);
        }

        // Also render QR code in terminal for quick command-line scanning
        try {
          const qrcodeTerm = require('qrcode-terminal');
          console.log('\n[WHATSAPP WEB] Scan this QR code with WhatsApp on your phone:');
          qrcodeTerm.generate(qr, { small: true });
        } catch {}
      });

      this.client.on('authenticated', () => {
        console.log('[WHATSAPP DEBUG] authenticated event received');
        if (this.status !== 'connected') {
          this.setStatus('connecting', { authenticated: true });
        }
        this.startReadyPoll();
      });

      this.client.on('loading_screen', (percent: number, message: string) => {
        console.log(`[WHATSAPP DEBUG] loading_screen event received: ${percent}% - ${message}`);
        if (this.status !== 'connected') {
          this.setStatus('connecting', { loadingPercent: percent, message });
        }
        if (percent === 100) {
          this.startReadyPoll();
        }
      });

      this.client.on('change_state', async (state: string) => {
        console.log(`[WHATSAPP DEBUG] change_state event received: ${state}`);
        if (state === 'CONNECTED') {
          this.stopReadyPoll();
          if (this.status !== 'connected') {
            try {
              const info = this.client?.info;
              if (info) {
                this.authenticatedInfo = {
                  pushname: info?.pushname || 'Owner',
                  wid: info?.wid?._serialized || '',
                  phone: info?.wid?.user || ''
                };
              }
            } catch {}
            this.setStatus('connected', { account: this.authenticatedInfo });
          }
        } else if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'DEPRECATED') {
          this.stopReadyPoll();
          console.warn(`[WHATSAPP WARNING] WhatsApp state changed to ${state}`);
          this.setStatus('disconnected', { reason: state });
        } else if (state === 'TIMEOUT') {
          console.warn('[WHATSAPP WARNING] WhatsApp connection timed out');
        }
      });

      this.client.on('ready', async () => {
        this.stopReadyPoll();
        this.currentQrString = null;
        this.currentQrDataUrl = null;

        try {
          const info = this.client?.info;
          console.log('[WHATSAPP DEBUG] ready event received');
          console.log(`[WHATSAPP DEBUG] info.wid: ${info?.wid?._serialized || 'unknown'}`);
          console.log(`[WHATSAPP DEBUG] info.pushname: ${info?.pushname || 'unknown'}`);
          console.log(`[WHATSAPP DEBUG] info.platform: ${info?.platform || 'unknown'}`);

          this.authenticatedInfo = {
            pushname: info?.pushname || 'Owner',
            wid: info?.wid?._serialized || '',
            phone: info?.wid?.user || ''
          };
        } catch (err: any) {
          console.warn('[WHATSAPP DEBUG] Failed to extract client info on ready:', err);
          this.authenticatedInfo = { pushname: 'Owner' };
        }

        // Attach fail-safe in-page message listener to ensure messages are never lost if whatsapp-web.js internal isNewMsg check misses
        try {
          if (this.client?.pupPage) {
            try {
              await this.client.pupPage.exposeFunction('jarvisOnInPageMsg', (rawMsg: any) => {
                handleRawMessage(rawMsg, 'in-page-bridge');
              });
            } catch {}

            await this.client.pupPage.evaluate(() => {
              try {
                const collections = (window as any).require && (window as any).require('WAWebCollections');
                const Msg = collections?.Msg || (window as any).Store?.Msg;
                if (Msg && typeof Msg.on === 'function') {
                  Msg.on('add', (m: any) => {
                    try {
                      if ((window as any).jarvisOnInPageMsg && (window as any).WWebJS?.getMessageModel) {
                        const model = (window as any).WWebJS.getMessageModel(m);
                        if (model) {
                          (window as any).jarvisOnInPageMsg(model);
                        }
                      }
                    } catch {}
                  });
                }
              } catch (e) {
                console.error('[JARVIS INJECT SETUP ERROR]', e);
              }
            });
            console.log('[WHATSAPP DEBUG] Fail-safe in-page message listener attached');
          }
        } catch (bridgeErr: any) {
          console.warn('[WHATSAPP DEBUG] Could not attach in-page bridge:', bridgeErr?.message || bridgeErr);
        }

        this.setStatus('connected', { account: this.authenticatedInfo });
      });

      this.client.on('auth_failure', (msg: string) => {
        this.stopReadyPoll();
        console.error(`[WHATSAPP DEBUG] auth_failure event received: ${msg}`);
        this.currentQrString = null;
        this.currentQrDataUrl = null;
        this.setStatus('error', { error: 'Authentication failed. Please link again.' });
      });

      this.client.on('disconnected', (reason: string) => {
        this.stopReadyPoll();
        console.warn(`[WHATSAPP DEBUG] disconnected event received: ${reason}`);
        this.currentQrString = null;
        this.currentQrDataUrl = null;
        this.authenticatedInfo = null;
        this.setStatus('disconnected', { reason });
      });

      console.log('[WHATSAPP DEBUG] Registering incoming message listeners');

      const handleRawMessage = async (msg: any, eventSource: string) => {
        if (!this.messageHandler) return;

        try {
          const msgId = typeof msg.id === 'string' ? msg.id : (msg.id?._serialized || msg.id?.id || `msg_${Date.now()}`);
          const isFromMe = Boolean(msg.fromMe !== undefined ? msg.fromMe : msg.id?.fromMe);
          const from = msg.from || (msg.id?.remote ? String(msg.id.remote) : '');
          const to = msg.to || '';
          const msgType = msg.type || 'text';

          // Adapter-level dedup: claim processing slot synchronously before ANY async work
          if (!this.tryClaimMessageProcessing(msgId, eventSource)) {
            return; // duplicate — already logged inside tryClaimMessageProcessing
          }

          console.log(`\n[WHATSAPP DEBUG] INCOMING MESSAGE EVENT RECEIVED (${eventSource})
id: ${msgId}
from: ${from}
to: ${to}
fromMe: ${isFromMe}
type: ${msgType}
hasMedia: ${Boolean(msg.hasMedia)}
timestamp: ${msg.timestamp}`);

          // Filter out system / broadcast / status messages
          if (from === 'status@broadcast' || from.includes('@broadcast') || from === '0@c.us' || to === 'status@broadcast' || to.includes('@broadcast')) {
            this.markMessageProcessed(msgId);
            return;
          }


          // 1. Account Owner manual reply from phone
          if (isFromMe) {
            const isGroup = to ? to.includes('@g.us') : false;
            if (isGroup) return;

            const incoming: WhatsAppIncomingMessage = {
              id: msgId,
              contactId: to,
              senderName: 'Account Owner (You)',
              fromMe: true,
              body: msg.body || '',
              timestamp: (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000,
              isGroup,
              raw: { fromMe: true, type: msgType },
              eventSource
            };

            console.log('[WHATSAPP DEBUG] Forwarding outgoing/manual message to AutomationEngine');
            this.messageHandler(incoming);
            return;
          }

          // 2. Incoming message from contact
          if (!from) return;
          if (!msg.body?.trim() && !msg.type && !msg.hasMedia) return;

          const isGroup = from.includes('@g.us');
          if (isGroup) return;

          let rawContact: any = null;
          try {
            rawContact = typeof msg.getContact === 'function' ? await msg.getContact().catch(() => null) : null;
          } catch {}

          const identity = await this.resolveWhatsAppIdentity(from, rawContact).catch(() => ({
            whatsappLid: from.endsWith('@lid') ? from : null,
            whatsappPhoneId: from.endsWith('@c.us') ? from : null,
            phoneNumber: normalizePhoneNumber(from) ? `+${normalizePhoneNumber(from)}` : null,
            displayName: from,
            alternateNames: []
          }));

          const isVoice = msgType === 'ptt' || msgType === 'audio' || (Boolean(msg.hasMedia) && (msgType === 'ptt' || msgType === 'audio'));

          const incoming: WhatsAppIncomingMessage = {
            id: msgId,
            contactId: from,
            whatsappLid: identity.whatsappLid || undefined,
            whatsappPhoneId: identity.whatsappPhoneId || undefined,
            senderName: identity.displayName,
            phoneNumber: identity.phoneNumber || undefined,
            alternateNames: identity.alternateNames,
            fromMe: false,
            body: msg.body || '',
            timestamp: (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000,
            isGroup,
            messageType: isVoice ? 'voice' : msgType,
            audioDuration: typeof msg.duration === 'number' ? msg.duration : undefined,
            hasMedia: Boolean(msg.hasMedia),
            downloadMedia: msg.hasMedia && typeof msg.downloadMedia === 'function' ? async () => {
              const msgSerializedId = msg.id?._serialized || msg.id?.id || msg.id;
              console.log('[AUDIO DOWNLOAD] Diagnostic info:', {
                id: msgSerializedId,
                type: msg.type,
                fromMe: Boolean(msg.fromMe),
                hasMedia: Boolean(msg.hasMedia),
                timestamp: msg.timestamp
              });

              // Primary download via official whatsapp-web.js Message.downloadMedia()
              try {
                const media = await msg.downloadMedia();
                if (media && media.data) {
                  console.log(`[AUDIO DOWNLOAD SUCCESS] Official downloadMedia succeeded (${media.data.length} bytes, mimetype: ${media.mimetype})`);
                  return {
                    mimetype: media.mimetype || 'audio/ogg; codecs=opus',
                    data: media.data,
                    filename: media.filename
                  };
                }
              } catch (err: any) {
                console.warn('[AUDIO DOWNLOAD WARNING] Official downloadMedia failed:', err?.message || String(err));
              }

              // Fallback direct in-page extraction via Puppeteer
              if (this.client?.pupPage && msgSerializedId) {
                try {
                  console.log('[AUDIO DOWNLOAD] Attempting in-page direct media extraction fallback for', msgSerializedId);
                  const fallback = await this.client.pupPage.evaluate(async (mId: string) => {
                    try {
                      const collections = (window as any).require && (window as any).require('WAWebCollections');
                      const m = collections?.Msg?.get(mId) || 
                        (collections?.Msg?.getMessagesById ? (await collections.Msg.getMessagesById([mId]))?.messages?.[0] : null) ||
                        ((window as any).Store?.Msg?.get ? (window as any).Store.Msg.get(mId) : null);

                      if (!m) return { error: 'msg_not_found_in_store' };

                      if (m.mediaData && m.mediaData.mediaStage !== 'RESOLVED' && typeof m.downloadMedia === 'function') {
                        try {
                          await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
                        } catch {}
                      }

                      if (m.mediaData?.renderableUrl) {
                        try {
                          const res = await fetch(m.mediaData.renderableUrl);
                          const buf = await res.arrayBuffer();
                          const base64 = (window as any).WWebJS ? await (window as any).WWebJS.arrayBufferToBase64Async(buf) : btoa(String.fromCharCode(...new Uint8Array(buf)));
                          return { data: base64, mimetype: m.mimetype || 'audio/ogg; codecs=opus', filename: m.filename };
                        } catch {}
                      }

                      const dm = (window as any).Store?.DownloadManager || 
                        ((window as any).require ? (window as any).require('WAWebDownloadManager')?.downloadManager : null);

                      if (dm && typeof dm.downloadAndMaybeDecrypt === 'function') {
                        const mockQpl = { addAnnotations: function () { return this; }, addPoint: function () { return this; } };
                        const decrypted = await dm.downloadAndMaybeDecrypt({
                          directPath: m.directPath,
                          encFilehash: m.encFilehash,
                          filehash: m.filehash,
                          mediaKey: m.mediaKey,
                          mediaKeyTimestamp: m.mediaKeyTimestamp,
                          type: m.type,
                          signal: new AbortController().signal,
                          downloadQpl: mockQpl
                        });
                        const base64 = (window as any).WWebJS ? await (window as any).WWebJS.arrayBufferToBase64Async(decrypted) : btoa(String.fromCharCode(...new Uint8Array(decrypted)));
                        return { data: base64, mimetype: m.mimetype || 'audio/ogg; codecs=opus', filename: m.filename };
                      }

                      return { error: 'no_suitable_download_handler' };
                    } catch (e: any) {
                      return { error: e?.message || String(e) };
                    }
                  }, msgSerializedId);

                  if (fallback && fallback.data) {
                    console.log(`[AUDIO DOWNLOAD SUCCESS] In-page fallback succeeded (${fallback.data.length} bytes)`);
                    return {
                      mimetype: fallback.mimetype || 'audio/ogg; codecs=opus',
                      data: fallback.data,
                      filename: fallback.filename
                    };
                  } else {
                    console.warn('[AUDIO DOWNLOAD] In-page fallback result:', fallback?.error);
                  }
                } catch (fallbackErr: any) {
                  console.warn('[AUDIO DOWNLOAD ERROR] In-page fallback evaluation failed:', fallbackErr?.message);
                }
              }

              return null;
            } : undefined,
            raw: { fromMe: false, type: msgType, duration: msg.duration },
            eventSource
          };

          console.log('[WHATSAPP DEBUG] Forwarding incoming message to AutomationEngine');
          this.messageHandler(incoming);
          this.markMessageProcessed(msgId);
        } catch (error: any) {
          console.error('[JARVIS AUTOMATION ERROR] Failed to process WhatsApp message event:', error?.message || error);
          // Do NOT call markMessageProcessed here so errors don't permanently block retries
          // (The dedup TTL will naturally expire the entry after 60 s)
        }
      };

      this.client.on('message', (msg: any) => handleRawMessage(msg, 'message'));
      this.client.on('message_create', (msg: any) => handleRawMessage(msg, 'message_create'));
      this.client.on('message_received', (msg: any) => handleRawMessage(msg, 'message_received'));
      console.log('[WHATSAPP DEBUG] Incoming message listeners registered (message, message_create, message_received)');

      await this.client.initialize();
    } catch (error: any) {
      this.setStatus('error', { error: error.message });
      throw error;
    } finally {
      this.isConnecting = false;
    }
  }

  public async disconnect(): Promise<void> {
    this.isConnecting = false;
    this.stopReadyPoll();
    if (this.client) {
      try {
        await this.client.destroy();
      } catch (err) {
        console.warn('[WhatsAppWebAdapter] Disconnect error:', err);
      }
      this.client = null;
    }
    this.inFlightGetChatsPromise = null;
    this.cachedSelectableChats = null;
    this.currentQrString = null;
    this.currentQrDataUrl = null;
    this.authenticatedInfo = null;
    this.setStatus('disconnected');
  }

  private startReadyPoll(): void {
    if (this.readyCheckInterval) {
      clearInterval(this.readyCheckInterval);
    }
    this.readyCheckInterval = setInterval(async () => {
      if (this.status === 'connected') {
        this.stopReadyPoll();
        return;
      }
      if (!this.client) return;

      try {
        if (this.client.info?.wid) {
          console.log('[WHATSAPP DEBUG] Poller found client.info ready:', this.client.info.wid);
          const info = this.client.info;
          this.authenticatedInfo = {
            pushname: info?.pushname || 'Owner',
            wid: info?.wid?._serialized || '',
            phone: info?.wid?.user || ''
          };
          this.stopReadyPoll();
          this.setStatus('connected', { account: this.authenticatedInfo });
          return;
        }

        const state = typeof this.client.getState === 'function' ? await this.client.getState().catch(() => null) : null;
        if (state === 'CONNECTED') {
          console.log('[WHATSAPP DEBUG] Poller found client state CONNECTED');
          try {
            const info = this.client.info;
            this.authenticatedInfo = {
              pushname: info?.pushname || 'Owner',
              wid: info?.wid?._serialized || '',
              phone: info?.wid?.user || ''
            };
          } catch {
            this.authenticatedInfo = { pushname: 'Owner' };
          }
          this.stopReadyPoll();
          this.setStatus('connected', { account: this.authenticatedInfo });
        }
      } catch (err: any) {
        // Suppress poll errors
      }
    }, 2000);
  }

  private stopReadyPoll(): void {
    if (this.readyCheckInterval) {
      clearInterval(this.readyCheckInterval);
      this.readyCheckInterval = null;
    }
  }

  public async checkConnectionState(): Promise<string | null> {
    if (!this.client) return null;
    try {
      if (typeof this.client.getState === 'function') {
        return await this.client.getState();
      }
    } catch (err: any) {
      console.warn('[WHATSAPP DEBUG] Error checking state:', err?.message);
    }
    return null;
  }

  public getStatus(): WhatsAppAdapterStatus {
    return this.status;
  }

  public getQrDataUrl(): string | null {
    return this.currentQrDataUrl;
  }

  public getAccountInfo() {
    return this.authenticatedInfo;
  }

  public async resolveWhatsAppIdentity(userId: string, msgContact?: any): Promise<import('./adapterInterface').ResolvedWhatsAppIdentity> {
    let whatsappLid: string | null = userId.endsWith('@lid') ? userId : null;
    let whatsappPhoneId: string | null = (userId.endsWith('@c.us') || userId.endsWith('@s.whatsapp.net')) ? userId : null;
    let phoneNumber: string | null = null;

    // 1. If LID, resolve using client.getContactLidAndPhone
    if (userId.endsWith('@lid')) {
      try {
        if (typeof this.client?.getContactLidAndPhone === 'function') {
          console.log(`[LID RESOLUTION] Resolving LID: ${userId} via client.getContactLidAndPhone...`);
          const res = await this.client.getContactLidAndPhone([userId]);
          console.log('[LID RESOLUTION RESULT]:', JSON.stringify(res));
          if (res && res[0]) {
            if (res[0].pn) {
              whatsappPhoneId = res[0].pn;
            }
            if (res[0].lid) {
              whatsappLid = res[0].lid;
            }
          }
        }
      } catch (err) {
        console.warn('[LID RESOLUTION ERROR]:', err);
      }
    }

    // 2. Extract normalized real phone number from whatsappPhoneId if available
    if (whatsappPhoneId) {
      phoneNumber = normalizePhoneNumber(whatsappPhoneId);
    }

    if (whatsappLid && whatsappPhoneId) {
      try {
        db.saveLidMapping(whatsappLid, whatsappPhoneId, phoneNumber);
      } catch (lidDbErr) {
        console.warn('[LID MAPPING SAVE ERROR]:', lidDbErr);
      }
    }

    // 3. Retrieve contact object for names
    let contact = msgContact;
    if (!contact) {
      try {
        if (typeof this.client?.getContactById === 'function') {
          contact = await this.client.getContactById(userId);
        }
      } catch {}
    }
    if (!contact && whatsappPhoneId) {
      try {
        if (typeof this.client?.getContactById === 'function') {
          contact = await this.client.getContactById(whatsappPhoneId);
        }
      } catch {}
    }

    if (contact) {
      console.log('[CONTACT RESOLUTION] Raw WhatsApp contact:', {
        id: contact.id,
        name: contact.name,
        pushname: contact.pushname,
        shortName: contact.shortName,
        number: contact.number,
        isWAContact: contact.isWAContact,
        isMyContact: contact.isMyContact
      });

      // If contact.id is @c.us and we didn't have phone ID yet
      if (contact.id?._serialized?.endsWith('@c.us') && !whatsappPhoneId) {
        whatsappPhoneId = contact.id._serialized;
        phoneNumber = normalizePhoneNumber(contact.id._serialized) || phoneNumber;
      }
      if (contact.id?._serialized?.endsWith('@lid') && !whatsappLid) {
        whatsappLid = contact.id._serialized;
      }
    }

    // 4. Sensible Display Name and Alternate Names selection
    const candidateNames: string[] = [];
    if (contact?.name && typeof contact.name === 'string') candidateNames.push(contact.name.trim());
    if (contact?.pushname && typeof contact.pushname === 'string') candidateNames.push(contact.pushname.trim());
    if (contact?.shortName && typeof contact.shortName === 'string') candidateNames.push(contact.shortName.trim());

    const cleanCandidates = candidateNames.filter((n) => n && !n.includes('@') && !/^\+?\d+$/.test(n));

    const displayName = cleanCandidates[0] || (phoneNumber ? `+${phoneNumber}` : 'WhatsApp User');
    const alternateNames: string[] = [];
    const seen = new Set<string>([displayName.toLowerCase()]);

    for (const name of cleanCandidates) {
      const lower = name.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        alternateNames.push(name);
      }
    }

    return {
      whatsappLid,
      whatsappPhoneId,
      phoneNumber: phoneNumber ? (phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`) : null,
      displayName,
      alternateNames
    };
  }

  public async getContacts(): Promise<WhatsAppContact[]> {
    if (!this.client || this.status !== 'connected') return [];
    try {
      const contacts = await this.client.getContacts();
      return contacts
        .filter((c: any) => c && c.id && c.id._serialized)
        .map((c: any) => ({
          id: c.id._serialized,
          name: c.name || c.pushname || c.number || c.id._serialized,
          number: c.id._serialized.endsWith('@c.us') ? c.id.user : undefined,
          isGroup: c.isGroup || false,
          isMyContact: c.isMyContact || false
        }));
    } catch (err: any) {
      console.warn('[CONTACT LOAD] Failed to get contacts from client:', {
        name: err?.name || 'Error',
        message: err?.message || String(err)
      });
      return [];
    }
  }

  public async getChats(): Promise<WhatsAppChat[]> {
    if (!this.client || this.status !== 'connected') return [];
    try {
      const chats = await this.client.getChats();
      return chats.map((c: any) => ({
        id: c.id._serialized,
        name: c.name || c.id._serialized,
        isGroup: c.isGroup || false,
        unreadCount: c.unreadCount || 0,
        lastMessageTimestamp: c.timestamp ? c.timestamp * 1000 : undefined
      }));
    } catch (err: any) {
      console.warn('[CONTACT LOAD] Failed to get chats from client:', {
        name: err?.name || 'Error',
        message: err?.message || String(err)
      });
      return [];
    }
  }

  public async getSelectableWhatsAppChats(forceRefresh: boolean = false): Promise<import('./adapterInterface').SelectableWhatsAppContact[]> {
    const isReady = this.status === 'connected' && Boolean(this.client);
    let clientState = 'DISCONNECTED';
    if (this.client) {
      try {
        clientState = (typeof this.client.getState === 'function' ? await this.client.getState() : (isReady ? 'CONNECTED' : 'UNKNOWN')) || 'UNKNOWN';
      } catch {
        clientState = isReady ? 'CONNECTED' : 'NOT_READY';
      }
    }

    console.log(`[CONTACT LOAD] client ready: ${isReady}`);
    console.log(`[CONTACT LOAD] client state: ${clientState}`);

    if (!isReady || !this.client) {
      console.log('[WHATSAPP CONTACTS] WhatsApp client not ready. Returning empty contact list.');
      return [];
    }

    const now = Date.now();
    if (!forceRefresh && this.cachedSelectableChats && (now - this.cachedSelectableChats.timestamp < 5000)) {
      console.log(`[CONTACT LOAD] Returning ${this.cachedSelectableChats.data.length} cached contacts (TTL active).`);
      return this.cachedSelectableChats.data;
    }

    // Coalesce overlapping / concurrent requests
    if (this.inFlightGetChatsPromise) {
      console.log('[CONTACT LOAD] Reusing in-flight contact loading request...');
      return this.inFlightGetChatsPromise;
    }

    this.inFlightGetChatsPromise = (async () => {
      try {
        console.log('[WHATSAPP CONTACTS] Loading WhatsApp contacts...');
        console.log('[WHATSAPP CONTACTS] Source: WhatsApp');
        console.log('[CONTACT LOAD] requesting chats...');

        // 1. Diagnostics on underlying Puppeteer page and client state
        if (this.client?.pupPage) {
          try {
            const page = this.client.pupPage;
            const isClosed = typeof page.isClosed === 'function' ? page.isClosed() : false;
            const url = typeof page.url === 'function' ? page.url() : 'unknown';
            const pageTitle = typeof page.title === 'function' ? await page.title() : 'unknown';
            const pageEval = await page.evaluate(() => {
              let hasWAWebCollections = false;
              let hasStore = false;
              let chatCount = -1;
              try {
                const collections = (window as any).require && (window as any).require('WAWebCollections');
                hasWAWebCollections = Boolean(collections);
                if (collections?.Chat?.getModelsArray) {
                  chatCount = collections.Chat.getModelsArray().length;
                }
              } catch {
                hasWAWebCollections = false;
              }
              try {
                hasStore = Boolean((window as any).Store);
              } catch {
                hasStore = false;
              }

              return {
                href: location.href,
                readyState: document.readyState,
                title: document.title,
                hasWWebJS: Boolean((window as any).WWebJS),
                hasWAWebCollections,
                hasStore,
                chatCount
              };
            }).catch((err: any) => ({ error: err?.message }));

            console.log(`[WA PAGE] exists: true`);
            console.log(`[WA PAGE] closed: ${isClosed}`);
            console.log(`[WA PAGE] url: ${url}`);
            console.log(`[WA PAGE] title: ${pageTitle}`);
            console.log(`[WA PAGE] state:`, JSON.stringify(pageEval));
            console.log(`[WA CLIENT INFO] wid: ${this.client.info?.wid?._serialized || 'unknown'}, pushname: ${this.client.info?.pushname || 'unknown'}, platform: ${this.client.info?.platform || 'unknown'}`);
          } catch (diagErr: any) {
            console.warn('[WA PAGE DIAGNOSTIC ERROR]:', diagErr?.message);
          }
        }

        let rawChats: any[] = [];
        let attempts = 0;
        const maxAttempts = 2;

        while (attempts < maxAttempts) {
          attempts++;
          try {
            rawChats = await this.client.getChats();
            break;
          } catch (getChatsErr: any) {
            const errName = getChatsErr?.name || 'Error';
            const errMsg = getChatsErr?.message || String(getChatsErr);
            const errStack = getChatsErr?.stack || 'No stack trace available';

            console.warn(`[CONTACT LOAD WARNING] client.getChats() attempt ${attempts}/${maxAttempts} failed:`, {
              name: errName,
              message: errMsg,
              stack: errStack
            });

            if (attempts < maxAttempts) {
              console.log('[CONTACT LOAD] Retrying getChats() after 800ms backoff...');
              await new Promise((resolve) => setTimeout(resolve, 800));
            } else {
              // If client.getChats() fails (e.g. groupMetadata.update bug in whatsapp-web.js), attempt safe direct in-page extraction
              if (this.client?.pupPage) {
                console.log('[CONTACT LOAD] Falling back to safe direct in-page chat retrieval...');
                try {
                  const directChats = await this.client.pupPage.evaluate(() => {
                    try {
                      const collections = (window as any).require && (window as any).require('WAWebCollections');
                      if (!collections || !collections.Chat) return null;
                      const chatModels = collections.Chat.getModelsArray();
                      return chatModels.map((c: any) => {
                        try {
                          return {
                            id: c.id ? { _serialized: c.id._serialized, user: c.id.user, server: c.id.server } : null,
                            name: c.formattedTitle || c.name || null,
                            isGroup: Boolean(c.isGroup || (c.id?._serialized && c.id._serialized.endsWith('@g.us'))),
                            isBroadcast: Boolean(c.isBroadcast || (c.id?._serialized && c.id._serialized.includes('broadcast'))),
                            timestamp: c.t || c.timestamp || 0,
                            unreadCount: c.unreadCount || 0
                          };
                        } catch {
                          return null;
                        }
                      }).filter(Boolean);
                    } catch (e: any) {
                      return null;
                    }
                  });

                  if (Array.isArray(directChats) && directChats.length > 0) {
                    console.log(`[CONTACT LOAD] Safe direct in-page retrieval succeeded with ${directChats.length} chats.`);
                    rawChats = directChats;
                    break;
                  }
                } catch (evalErr: any) {
                  console.warn('[CONTACT LOAD] Safe direct in-page retrieval error:', evalErr?.message);
                }
              }

              // Secondary fallback: retrieve contacts via client.getContacts() if available
              if (rawChats.length === 0 && typeof this.client.getContacts === 'function') {
                console.log('[CONTACT LOAD] Falling back to client.getContacts()...');
                try {
                  const rawContacts = await this.client.getContacts();
                  if (Array.isArray(rawContacts) && rawContacts.length > 0) {
                    rawChats = rawContacts.map((c: any) => ({
                      id: { _serialized: c.id?._serialized || c.id },
                      name: c.name || c.pushname || null,
                      isGroup: Boolean(c.isGroup),
                      isBroadcast: false,
                      timestamp: 0,
                      unreadCount: 0
                    }));
                    console.log(`[CONTACT LOAD] Retrieved ${rawChats.length} contacts via client.getContacts().`);
                    break;
                  }
                } catch (contactErr: any) {
                  console.warn('[CONTACT LOAD] client.getContacts() fallback failed:', contactErr?.message);
                }
              }

              if (rawChats.length === 0) {
                throw getChatsErr;
              }
            }
          }
        }

        const totalChats = Array.isArray(rawChats) ? rawChats.length : 0;
        console.log(`[CONTACT LOAD] chats received: ${totalChats}`);
        console.log('[CONTACT LOAD] processing chats...');

        let groupsFiltered = 0;
        let systemFiltered = 0;
        let individualChats = 0;

        const candidates: Array<{
          id: string;
          name: string;
          number?: string;
          alternateNames: string[];
          lastMessageTimestamp?: number;
          type: 'person';
        }> = [];

        for (const chat of rawChats) {
          try {
            if (!chat || !chat.id) continue;
            const id = chat.id?._serialized || '';
            if (!id) continue;

            // 1. Filter out system / broadcast / status entries
            if (
              chat.isBroadcast ||
              id.includes('@broadcast') ||
              id.includes('status@broadcast') ||
              id === '0@c.us' ||
              id.toLowerCase().includes('whatsapp')
            ) {
              systemFiltered++;
              continue;
            }

            // 2. Filter out groups
            if (chat.isGroup || id.includes('@g.us')) {
              groupsFiltered++;
              continue;
            }

            individualChats++;

            let rawContact: any = null;
            try {
              if (typeof chat.getContact === 'function') {
                rawContact = await Promise.race([
                  chat.getContact(),
                  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500))
                ]);
              }
            } catch {}

            const identity = await this.resolveWhatsAppIdentity(id, rawContact);
            const chatTitle = (chat.name && !chat.name.includes('@')) ? chat.name.trim() : '';
            const finalDisplayName = identity.displayName !== 'WhatsApp User' && identity.displayName !== `+${identity.phoneNumber}`
              ? identity.displayName
              : (chatTitle || identity.displayName);

            const allAlternateNames = [...identity.alternateNames];
            if (chatTitle && chatTitle !== finalDisplayName && !allAlternateNames.includes(chatTitle)) {
              allAlternateNames.push(chatTitle);
            }

            const timestamp = chat.timestamp ? chat.timestamp * 1000 : undefined;

            candidates.push({
              id,
              name: finalDisplayName,
              number: identity.phoneNumber || undefined,
              alternateNames: allAlternateNames,
              lastMessageTimestamp: timestamp,
              type: 'person'
            });
          } catch (chatError: any) {
            let chatIdent = 'unknown';
            try {
              chatIdent = (chat && typeof chat === 'object' && 'id' in chat && chat.id?._serialized) ? chat.id._serialized : 'unknown';
            } catch {}
            console.warn(`[CONTACT LOAD] Malformed chat skipped (${chatIdent}):`, {
              name: chatError?.name,
              message: chatError?.message
            });
          }
        }

        // Merge duplicate contacts by WhatsApp Phone Number (Primary Identity)
        const mergedMap = new Map<string, {
          id: string;
          name: string;
          number?: string;
          alternateNames: string[];
          lastMessageTimestamp?: number;
          type: 'person';
        }>();

        // Sort candidate chats by last message timestamp descending so most recent chats get priority
        candidates.sort((a, b) => (b.lastMessageTimestamp || 0) - (a.lastMessageTimestamp || 0));

        for (const item of candidates) {
          const cleanPhone = normalizePhoneNumber(item.number || (item.id.endsWith('@c.us') ? item.id : null));
          const identityKey = cleanPhone ? `phone:${cleanPhone}` : `id:${item.id}`;

          const existing = mergedMap.get(identityKey);
          if (existing) {
            const existingAlts = existing.alternateNames || [];
            const candidateAlts = [item.name, ...(item.alternateNames || [])];
            for (const cand of candidateAlts) {
              if (cand && cand !== existing.name && !existingAlts.includes(cand)) {
                existing.alternateNames.push(cand);
              }
            }
            if ((item.lastMessageTimestamp || 0) > (existing.lastMessageTimestamp || 0)) {
              existing.lastMessageTimestamp = item.lastMessageTimestamp;
            }
          } else {
            mergedMap.set(identityKey, {
              id: item.id,
              name: item.name,
              number: cleanPhone ? `+${cleanPhone}` : item.number,
              alternateNames: item.alternateNames || [],
              lastMessageTimestamp: item.lastMessageTimestamp,
              type: 'person'
            });
          }
        }

        const deduplicated = Array.from(mergedMap.values());
        console.log(`[CONTACT LOAD] contacts returned: ${deduplicated.length}`);

        // Log merge occurrences
        for (const entry of deduplicated) {
          if (entry.alternateNames && entry.alternateNames.length > 0) {
            console.log(`[CONTACT MERGE] Same WhatsApp number detected`);
            console.log(`[CONTACT MERGE] Names: ${[entry.name, ...entry.alternateNames].join(', ')}`);
            console.log(`[CONTACT MERGE] Result: ONE contact`);
          }
        }

        console.log(`\n[AUTOMATION CONTACT SOURCE]\ntotal WhatsApp chats: ${totalChats}\n1-to-1 chats: ${individualChats}\nexcluded groups: ${groupsFiltered}\nexcluded system chats: ${systemFiltered}\ncontacts returned: ${deduplicated.length}\ncontacts hidden because already approved: 0\ncontacts hidden because no database record: 0\n`);

        this.cachedSelectableChats = {
          data: deduplicated,
          timestamp: Date.now()
        };

        return deduplicated;
      } catch (err: any) {
        console.error('[WHATSAPP CONTACTS ERROR] Failed to load WhatsApp chats:', {
          name: err?.name || 'Error',
          message: err?.message || String(err),
          stack: err?.stack || 'No stack trace available'
        });
        return [];
      } finally {
        this.inFlightGetChatsPromise = null;
      }
    })();

    return this.inFlightGetChatsPromise;
  }

  public async sendMessage(contactId: string, message: string): Promise<WhatsAppSendResult> {
    if (!this.client || this.status !== 'connected') {
      throw new Error('[WhatsAppWebAdapter] Cannot send message: WhatsApp is not connected');
    }

    // Resolve canonical recipient identity
    let recipientId = contactId;
    if (!recipientId.includes('@')) {
      const canonicalDigits = normalizePhoneNumber(recipientId);
      if (canonicalDigits) {
        recipientId = `${canonicalDigits}@c.us`;
      }
    } else if (recipientId.endsWith('@c.us')) {
      const canonicalDigits = normalizePhoneNumber(recipientId);
      if (canonicalDigits) {
        recipientId = `${canonicalDigits}@c.us`;
      }
    }

    let contactObj: any = null;
    let chatObj: any = null;
    try {
      if (typeof this.client?.getContactById === 'function') {
        contactObj = await this.client.getContactById(recipientId);
      }
    } catch {}
    try {
      if (typeof this.client?.getChatById === 'function') {
        chatObj = await this.client.getChatById(recipientId);
      }
    } catch {}

    const sendStarted = new Date().toISOString();
    const isLid = recipientId.endsWith('@lid');
    const isPhone = recipientId.endsWith('@c.us');
    const lidVal = isLid ? recipientId : (contactObj?.id?.server === 'lid' ? contactObj.id._serialized : 'none');
    const phoneVal = isPhone ? recipientId : (contactObj?.id?.server === 'c.us' ? contactObj.id._serialized : 'none');

    try {
      const response = await this.client.sendMessage(recipientId, message);
      const msgId = response?.id?.id || response?.id?._serialized || `msg_${Date.now()}`;
      const timestamp = response?.timestamp ? response.timestamp * 1000 : Date.now();

      console.log(`\n[SEND DEBUG]
contactId: ${contactId}
canonicalPhoneId: ${phoneVal}
lid: ${lidVal}
recipientId: ${recipientId}
recipientIdType: ${isLid ? 'LID' : (isPhone ? 'PHONE_ID' : typeof recipientId)}
chatFound: ${Boolean(chatObj)}
chatId: ${chatObj?.id?._serialized || recipientId}
messageLength: ${message.length}
sendStarted: ${sendStarted}
sendSucceeded: true
sendError: none\n`);

      return {
        messageId: msgId,
        timestamp,
        success: true
      };
    } catch (sendErr: any) {
      console.error(`\n[SEND DEBUG]
contactId: ${contactId}
canonicalPhoneId: ${phoneVal}
lid: ${lidVal}
recipientId: ${recipientId}
recipientIdType: ${isLid ? 'LID' : (isPhone ? 'PHONE_ID' : typeof recipientId)}
chatFound: ${Boolean(chatObj)}
chatId: ${chatObj?.id?._serialized || recipientId}
messageLength: ${message.length}
sendStarted: ${sendStarted}
sendSucceeded: false
sendError: ${sendErr?.message || String(sendErr)}\n`);
      throw sendErr;
    }
  }

  public async sendVoiceMessage(contactId: string, audioData: Buffer | string, mimetype: string = 'audio/ogg; codecs=opus'): Promise<WhatsAppSendResult> {
    if (!this.client || this.status !== 'connected') {
      throw new Error('[WhatsAppWebAdapter] Cannot send voice message: WhatsApp is not connected');
    }

    // Resolve canonical phone ID (never send to a raw LID — WhatsApp sendMessage needs @c.us)
    let recipientId = contactId;
    if (recipientId.endsWith('@lid')) {
      // LID cannot be used as sendMessage target — try resolving via db lookup
      const lidContact = db.getLidMapping ? db.getLidMapping(recipientId) : null;
      if (lidContact?.whatsapp_phone_id) {
        recipientId = lidContact.whatsapp_phone_id;
        console.log(`[VOICE SEND] Resolved LID ${contactId} → canonical phone ID ${recipientId}`);
      } else {
        throw new Error(`[VOICE SEND ERROR] Cannot resolve LID ${contactId} to a canonical phone ID — voice send aborted`);
      }
    } else if (!recipientId.includes('@')) {
      const canonicalDigits = normalizePhoneNumber(recipientId);
      if (canonicalDigits) {
        recipientId = `${canonicalDigits}@c.us`;
      }
    } else if (recipientId.endsWith('@c.us')) {
      const canonicalDigits = normalizePhoneNumber(recipientId);
      if (canonicalDigits) {
        recipientId = `${canonicalDigits}@c.us`;
      }
    }

    const sendStarted = new Date().toISOString();
    const audioSize = typeof audioData === 'string' ? audioData.length : (audioData as Buffer).length;

    // Build MessageMedia
    let media: any;
    let mediaCreated = false;
    try {
      const wwebjs = (await import(/* webpackIgnore: true */ 'whatsapp-web.js')) as any;
      const { MessageMedia } = wwebjs.default || wwebjs;
      const base64Data = typeof audioData === 'string' ? audioData : audioData.toString('base64');
      media = new MessageMedia(mimetype, base64Data, 'voice.ogg');
      mediaCreated = true;
    } catch (mediaErr: any) {
      console.error(`[VOICE SEND DEBUG]\nstage: MEDIA_CREATION_ERROR\ncontactId: ${contactId}\nrecipientId: ${recipientId}\nmimetype: ${mimetype}\naudioSize: ${audioSize}\nerror: ${mediaErr?.message || String(mediaErr)}`);
      throw new Error(`MEDIA_CREATION_ERROR: ${mediaErr?.message || mediaErr}`);
    }

    // Lookup target chat to verify it exists before attempting send
    let chatObj: any = null;
    let contactObj: any = null;
    try {
      if (typeof this.client?.getChatById === 'function') {
        chatObj = await this.client.getChatById(recipientId);
      }
    } catch (chatErr: any) {
      console.warn(`[VOICE SEND] getChatById(${recipientId}) failed: ${chatErr?.message}`);
    }
    try {
      if (!chatObj && typeof this.client?.getContactById === 'function') {
        contactObj = await this.client.getContactById(recipientId);
      }
    } catch {}

    console.log(`\n[VOICE SEND DEBUG]\noperationId: voice-${contactId}-${sendStarted}\ncontactId: ${contactId}\ncanonicalPhoneId: ${recipientId}\nrecipientId: ${recipientId}\nrecipientType: ${recipientId.endsWith('@lid') ? 'LID' : 'PHONE_ID'}\nmediaCreated: ${mediaCreated}\nmediaMimeType: ${mimetype}\nmediaSize: ${audioSize}\nchatFound: ${Boolean(chatObj)}\nchatId: ${chatObj?.id?._serialized || 'none'}\ncontactFound: ${Boolean(contactObj)}\ncontactId_resolved: ${contactObj?.id?._serialized || 'none'}\nclientState: ${this.status}\nsendStarted: ${sendStarted}\n`);

    try {
      const response = await this.client.sendMessage(recipientId, media, { sendAudioAsVoice: true });
      const msgId = response?.id?.id || response?.id?._serialized || `voice_${Date.now()}`;
      const timestamp = response?.timestamp ? response.timestamp * 1000 : Date.now();

      console.log(`[VOICE SEND DEBUG] sendSucceeded: true\nmessageId: ${msgId}\n`);
      return {
        messageId: msgId,
        timestamp,
        success: true,
        isVoice: true
      };
    } catch (sendErr: any) {
      const errMsg = sendErr?.message || String(sendErr);
      console.error(`[VOICE SEND DEBUG]\nstage: WHATSAPP_SEND_AUDIO_ERROR\ncontactId: ${contactId}\nrecipientId: ${recipientId}\nmimetype: ${mimetype}\naudioSize: ${audioSize}\nchatFound: ${Boolean(chatObj)}\nerror: ${errMsg}\n`);
      throw new Error(`WHATSAPP_SEND_AUDIO_ERROR: ${errMsg}`);
    }
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

  private setStatus(newStatus: WhatsAppAdapterStatus, details?: any): void {
    this.status = newStatus;
    if (this.statusChangeHandler) {
      this.statusChangeHandler(newStatus, details);
    }
  }

  private detectBrowserExecutable(): string | null {
    const candidatePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }
    return null;
  }
}

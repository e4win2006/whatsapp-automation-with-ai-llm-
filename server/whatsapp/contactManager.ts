import { db, DbContact, JarvisDatabase } from '../database/database';
import { eventBus } from '../core/eventBus';
import { normalizePhoneNumber, parseAlternateNames, mergeAlternateNames, getWhatsAppIdentityType } from '../utils/phoneUtils';

export class ContactManager {
  private database: JarvisDatabase;

  constructor(customDb?: JarvisDatabase) {
    this.database = customDb || db;
  }

  public getAllContacts(): DbContact[] {
    return this.database.getApprovedContacts();
  }

  public async getContactsForUi(whatsappAdapter?: any): Promise<DbContact[]> {
    const dbContacts = this.database.getAllContacts();
    const map = new Map<string, DbContact>();

    // 1. If WhatsApp adapter is connected and ready, load live 1-to-1 chats
    const isAdapterReady = whatsappAdapter && typeof whatsappAdapter.getStatus === 'function'
      ? whatsappAdapter.getStatus() === 'connected'
      : Boolean(whatsappAdapter);

    if (isAdapterReady && typeof whatsappAdapter.getSelectableWhatsAppChats === 'function') {
      try {
        const chats = await whatsappAdapter.getSelectableWhatsAppChats();
        for (const chat of chats) {
          const matched = this.database.findExistingContact({
            id: chat.id,
            phoneNumber: chat.number,
            senderName: chat.name
          });

          if (matched) {
            map.set(matched.id, matched);
          } else {
            const cleanPhone = chat.number ? normalizePhoneNumber(chat.number) : null;
            map.set(chat.id, {
              id: chat.id,
              name: chat.name || chat.id,
              phone_number: cleanPhone ? `+${cleanPhone}` : (chat.number || null),
              relationship: null,
              description: null,
              birthday: null,
              birthday_message: null,
              permissions: null,
              profile_pic_url: null,
              is_approved: 0,
              ai_enabled: 0,
              voice_message_enabled: 0,
              voice_response_enabled: 0,
              wake_phrase_only: 1,
              respond_normal_messages: 0,
              memory_enabled: 1,
              response_delay_seconds: 180,
              auto_send: 1,
              priority: 'normal',
              custom_system_prompt: null,
              alternate_names: chat.alternateNames ? JSON.stringify(chat.alternateNames) : null,
              whatsapp_id: chat.id.endsWith('@lid') ? chat.id : null,
              whatsapp_phone_id: chat.id.endsWith('@c.us') ? chat.id : null,
              created_at: Date.now(),
              updated_at: Date.now()
            });
          }
        }
      } catch (err: any) {
        console.error('[CONTACT MANAGER] Error loading WhatsApp chats for UI:', {
          name: err?.name || 'Error',
          message: err?.message || String(err),
          stack: err?.stack || 'No stack trace available'
        });
      }
    }

    // 2. Also ensure all existing DB contacts (approved or automated) are included
    for (const c of dbContacts) {
      if (!map.has(c.id)) {
        map.set(c.id, c);
      }
    }

    return Array.from(map.values());
  }

  public getAutomatedContacts(): DbContact[] {
    return this.database.getApprovedContacts().filter((c) => c.ai_enabled === 1);
  }

  public getContact(contactId: string): DbContact | null {
    return this.database.getContact(contactId);
  }

  public isContactAutomationEnabled(contactId: string): boolean {
    const contact = this.resolveApprovedContact(contactId);
    if (!contact) return false;
    return Boolean(contact.is_approved && contact.ai_enabled);
  }

  public resolveApprovedContact(
    arg1: string | {
      contactId: string;
      senderName?: string;
      phoneNumber?: string;
      whatsappPhoneId?: string;
      alternateNames?: string[];
    },
    arg2?: string,
    arg3?: string,
    arg4?: string,
    arg5?: string[]
  ): DbContact | null {
    let contactId: string;
    let senderName: string | undefined;
    let phoneNumber: string | undefined;
    let whatsappPhoneId: string | undefined;
    let alternateNames: string[] | undefined;

    if (typeof arg1 === 'object' && arg1 !== null) {
      contactId = arg1.contactId;
      senderName = arg1.senderName;
      phoneNumber = arg1.phoneNumber;
      whatsappPhoneId = arg1.whatsappPhoneId;
      alternateNames = arg1.alternateNames;
    } else {
      contactId = arg1;
      senderName = arg2;
      phoneNumber = arg3;
      whatsappPhoneId = arg4;
      alternateNames = arg5;
    }

    const idType = getWhatsAppIdentityType(contactId);
    const whatsappLid = idType === 'lid' ? contactId : null;
    const resolvedPhoneId = whatsappPhoneId || (idType === 'phone' ? contactId : null);
    
    // Only normalize phone if a real phone number was provided or the phone ID is @c.us
    let cleanPhone: string | null = null;
    if (phoneNumber) {
      cleanPhone = normalizePhoneNumber(phoneNumber);
    } else if (resolvedPhoneId) {
      cleanPhone = normalizePhoneNumber(resolvedPhoneId);
    }

    // 1. Thorough multi-attribute search against existing database records
    let resolvedContact = this.database.findExistingContact({
      id: contactId,
      whatsappLid,
      whatsappPhoneId: resolvedPhoneId,
      phoneNumber: cleanPhone
    });

    let matchedBy = 'NONE';
    if (resolvedContact) {
      if (resolvedPhoneId && (resolvedContact.whatsapp_phone_id === resolvedPhoneId || resolvedContact.id === resolvedPhoneId)) {
        matchedBy = 'PHONE_ID';
      } else if (cleanPhone && normalizePhoneNumber(resolvedContact.phone_number) === cleanPhone) {
        matchedBy = 'PHONE_NUMBER';
      } else if (whatsappLid && (resolvedContact.whatsapp_id === whatsappLid || resolvedContact.id === whatsappLid)) {
        matchedBy = 'LID';
      } else if (resolvedContact.id === contactId) {
        matchedBy = 'DIRECT_ID';
      }
    }

    // Detailed Identity Debugging Logs
    console.log(`[IDENTITY RESOLUTION]
incomingLid: ${whatsappLid || 'none'}
resolvedPhoneId: ${resolvedPhoneId || 'none'}
resolvedPhoneNumber: ${cleanPhone ? `+${cleanPhone}` : 'none'}
displayName: ${senderName || resolvedContact?.name || 'unknown'}
databaseContactId: ${resolvedContact?.id || 'none'}`);

    console.log(`[IDENTITY MATCH]
matchedBy: ${matchedBy}
matchedPhoneId: ${resolvedContact?.whatsapp_phone_id || resolvedContact?.phone_number || 'none'}
matchedLid: ${resolvedContact?.whatsapp_id || 'none'}
sameIdentity: ${Boolean(resolvedContact)}`);

    // If contact is found and has new verified attributes, update safely
    if (resolvedContact) {
      const existingAlts = parseAlternateNames(resolvedContact.alternate_names);
      const incomingAlts = alternateNames ? [...alternateNames] : [];
      if (senderName && senderName !== resolvedContact.name && !existingAlts.includes(senderName) && !senderName.includes('@')) {
        incomingAlts.push(senderName);
      }
      const newAlts = mergeAlternateNames(resolvedContact.name, existingAlts, incomingAlts);

      const isNewLid = Boolean(whatsappLid && resolvedContact.whatsapp_id !== whatsappLid);
      const isNewPhoneId = Boolean(resolvedPhoneId && resolvedContact.whatsapp_phone_id !== resolvedPhoneId);
      const isNewPhone = Boolean(cleanPhone && !resolvedContact.phone_number);
      const isNewAlts = newAlts.length !== existingAlts.length;

      if (isNewLid || isNewPhoneId || isNewPhone || isNewAlts) {
        this.database.upsertContact({
          id: resolvedContact.id,
          name: resolvedContact.name,
          phone_number: resolvedContact.phone_number || (cleanPhone ? `+${cleanPhone}` : null),
          whatsapp_id: whatsappLid || resolvedContact.whatsapp_id || null,
          whatsapp_phone_id: resolvedPhoneId || resolvedContact.whatsapp_phone_id || null,
          alternate_names: newAlts,
          profile_pic_url: resolvedContact.profile_pic_url,
          is_approved: Boolean(resolvedContact.is_approved),
          ai_enabled: Boolean(resolvedContact.ai_enabled),
          wake_phrase_only: Boolean(resolvedContact.wake_phrase_only),
          respond_normal_messages: Boolean(resolvedContact.respond_normal_messages),
          memory_enabled: Boolean(resolvedContact.memory_enabled),
          response_delay_seconds: resolvedContact.response_delay_seconds || 180,
          custom_system_prompt: resolvedContact.custom_system_prompt
        });
        resolvedContact = this.database.getContact(resolvedContact.id) || resolvedContact;
      }
    }

    // Required Debug Output
    const isAutomated = Boolean(resolvedContact && resolvedContact.is_approved === 1 && resolvedContact.ai_enabled === 1);
    const resolvedPhoneDisplay = resolvedContact?.phone_number || (cleanPhone ? `+${cleanPhone}` : 'unavailable');

    console.log(`[CONTACT MATCH] Incoming WhatsApp ID: ${contactId}`);
    if (resolvedPhoneId) {
      console.log(`[CONTACT MATCH] Resolved WhatsApp phone ID: ${resolvedPhoneId}`);
    }
    console.log(`[CONTACT MATCH] Resolved phone: ${resolvedPhoneDisplay}`);
    console.log(`[CONTACT MATCH] Display name: ${resolvedContact?.name || senderName || 'unknown'}`);
    console.log(`[CONTACT MATCH] Existing contact found: ${Boolean(resolvedContact)}`);
    console.log(`[CONTACT MATCH] Automation enabled: ${isAutomated}`);

    return resolvedContact;
  }

  public shouldRespond(contactId: string, messageText: string, hasWakePhrase: boolean, senderName?: string, phoneNumber?: string): boolean {
    const contact = this.resolveApprovedContact(contactId, senderName, phoneNumber);
    if (!contact || !Boolean(contact.is_approved) || !Boolean(contact.ai_enabled)) {
      return false;
    }

    // If wake phrase is detected, always respond
    if (hasWakePhrase) {
      return true;
    }

    // If respond_normal_messages is enabled for this contact, respond to normal messages
    if (Boolean(contact.respond_normal_messages)) {
      return true;
    }

    // Default: only respond if wake phrase is present
    return false;
  }

  public isContactApprovedForJarvis(contactId: string): boolean {
    const contact = this.resolveApprovedContact(contactId);
    if (!contact) return false;
    return Boolean(contact.is_approved === 1 || (contact as any).approved_for_jarvis === 1);
  }

  public approveContact(
    contactId: string,
    options?: {
      name?: string;
      automationEnabled?: boolean;
      ragEnabled?: boolean;
      customPrompt?: string;
    }
  ): DbContact {
    const updated = this.database.upsertContact({
      id: contactId,
      name: options?.name || contactId,
      is_approved: true,
      approved_for_jarvis: true,
      ai_enabled: Boolean(options?.automationEnabled),
      rag_enabled: options?.ragEnabled !== undefined ? Boolean(options.ragEnabled) : true,
      rag_namespace_status: 'active',
      wake_phrase_only: true,
      respond_normal_messages: false,
      memory_enabled: true,
      response_delay_seconds: 180,
      custom_system_prompt: options?.customPrompt || null
    });

    eventBus.emit('CONTACT_APPROVED', {
      contactId,
      name: updated.name,
      phoneNumber: updated.phone_number || undefined,
      automationEnabled: Boolean(options?.automationEnabled),
      ragEnabled: options?.ragEnabled !== undefined ? Boolean(options.ragEnabled) : true
    });

    this.database.addLog('info', 'ContactManager', `Approved contact for JARVIS: ${updated.name} (${contactId})`);
    return updated;
  }

  public revokeApproval(contactId: string): DbContact | null {
    const contact = this.getContact(contactId);
    if (!contact) return null;

    const updated = this.database.setContactSimpleSettings(contactId, {
      is_approved: false,
      approved_for_jarvis: false,
      ai_enabled: false,
      rag_enabled: false,
      rag_namespace_status: 'disabled'
    });

    this.database.addLog('info', 'ContactManager', `Revoked JARVIS approval for contact: ${contact.name} (${contactId})`);
    return updated;
  }

  public deleteContactMemory(contactId: string): number {
    const deletedCount = this.database.deleteContactMemoryChunks(contactId);
    this.database.addLog('info', 'ContactManager', `Deleted memory chunks for contact: ${contactId} (chunks deleted: ${deletedCount})`);
    return deletedCount;
  }

  public setRagEnabled(contactId: string, enabled: boolean): void {
    this.database.updateContactRagStatus(contactId, enabled, enabled ? 'active' : 'disabled');
    this.database.addLog('info', 'ContactManager', `Set RAG status for ${contactId} to ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  public addContact(contactId: string, name?: string, customPrompt?: string): DbContact {
    const contact = this.database.upsertContact({
      id: contactId,
      name: name || contactId,
      is_approved: true,
      approved_for_jarvis: true,
      ai_enabled: false, // Default is OFF until user turns it ON or during Add flow
      rag_enabled: true,
      rag_namespace_status: 'active',
      wake_phrase_only: true,
      respond_normal_messages: false,
      memory_enabled: true,
      response_delay_seconds: 180,
      custom_system_prompt: customPrompt || null
    });

    eventBus.emit('CONTACT_APPROVED', {
      contactId,
      name: contact.name,
      phoneNumber: contact.phone_number || undefined,
      automationEnabled: false
    });

    this.database.addLog('info', 'ContactManager', `Added contact: ${contact.name} (${contactId})`);
    return contact;
  }

  public updateContactSettings(
    contactId: string,
    settings: {
      name?: string;
      is_approved?: boolean;
      approved_for_jarvis?: boolean;
      approvedForJarvis?: boolean;
      ai_enabled?: boolean;
      rag_enabled?: boolean;
      ragEnabled?: boolean;
      rag_namespace_status?: 'active' | 'disabled' | 'deleted';
      voice_message_enabled?: boolean;
      voice_response_enabled?: boolean;
      voiceMessageEnabled?: boolean;
      voiceResponseEnabled?: boolean;
      wake_phrase_only?: boolean;
      respond_normal_messages?: boolean;
      memory_enabled?: boolean;
      response_delay_seconds?: number;
      relationship?: string | null;
      description?: string | null;
      birthday?: string | null;
      anniversary?: string | null;
      important_dates?: string | null;
      birthday_message?: string | null;
      permissions?: any;
      ai_capabilities?: any;
      custom_system_prompt?: string | null;
    }
  ): DbContact | null {
    const normalizedSettings = {
      ...settings,
      voice_message_enabled: settings.voice_message_enabled !== undefined 
        ? settings.voice_message_enabled 
        : (settings.voiceMessageEnabled !== undefined ? settings.voiceMessageEnabled : undefined),
      voice_response_enabled: settings.voice_response_enabled !== undefined 
        ? settings.voice_response_enabled 
        : (settings.voiceResponseEnabled !== undefined ? settings.voiceResponseEnabled : undefined)
    };
    const updated = this.database.setContactSimpleSettings(contactId, normalizedSettings);
    this.database.addLog('info', 'ContactManager', `Updated settings for contact ${contactId}`, normalizedSettings);
    return updated;
  }

  public deleteContact(contactId: string): void {
    this.database.deleteContactMemoryChunks(contactId);
    this.database.deleteContact(contactId);
    this.database.addLog('info', 'ContactManager', `Removed contact: ${contactId}`);
  }
}

export const contactManager = new ContactManager();


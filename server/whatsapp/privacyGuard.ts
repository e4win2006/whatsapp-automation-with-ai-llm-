import { DbContact, ContactPermissions, parseContactPermissions, DEFAULT_CONTACT_PERMISSIONS } from '../database/database';

export interface PrivacyCheckResult {
  allowed: boolean;
  refusalReason?: string;
  refusalMessage?: string;
  detectedCategory?: keyof ContactPermissions;
}

export class PrivacyGuard {
  private static readonly STANDARD_REFUSAL = "Sorry, I can't provide the owner's private information.";

  /**
   * Evaluates incoming message text against contact permissions before invoking AI.
   * Fail-closed: If permission is not verified or missing, access to private data is denied.
   */
  public static checkPreAiRequest(
    messages: string[],
    contact: DbContact | null
  ): PrivacyCheckResult {
    const combinedText = messages.join(' ').toLowerCase().trim();
    const permissions: ContactPermissions = contact
      ? parseContactPermissions(contact.permissions, contact.ai_enabled === 1)
      : { ...DEFAULT_CONTACT_PERMISSIONS };

    // If useJarvis is explicitly disabled in permissions, deny general AI
    if (contact && contact.permissions) {
      if (permissions.useJarvis === false && contact.ai_enabled === 1) {
        return {
          allowed: false,
          refusalReason: 'USE_JARVIS_DISABLED',
          refusalMessage: "JARVIS is currently disabled for this conversation."
        };
      }
    }

    // Coding / Programming capability check
    if (this.isRequestingCoding(combinedText)) {
      if (contact && contact.permissions) {
        try {
          const parsed = typeof contact.permissions === 'string' ? JSON.parse(contact.permissions) : contact.permissions;
          if (parsed.coding === false || parsed.programmingHelp === false) {
            return {
              allowed: false,
              refusalReason: 'UNAUTHORIZED_CODING_REQUEST',
              refusalMessage: "Sorry, I am not authorized to assist with coding or programming tasks for this conversation."
            };
          }
        } catch {}
      }
    }

    // 1. Messages / Chat inspection
    if (this.isRequestingMessages(combinedText)) {
      if (!permissions.viewMessages) {
        return {
          allowed: false,
          refusalReason: 'UNAUTHORIZED_VIEW_MESSAGES',
          refusalMessage: this.STANDARD_REFUSAL,
          detectedCategory: 'viewMessages'
        };
      }
    }

    // 2. Notifications inspection
    if (this.isRequestingNotifications(combinedText)) {
      if (!permissions.viewNotifications) {
        return {
          allowed: false,
          refusalReason: 'UNAUTHORIZED_VIEW_NOTIFICATIONS',
          refusalMessage: this.STANDARD_REFUSAL,
          detectedCategory: 'viewNotifications'
        };
      }
    }

    // 3. Contacts inspection
    if (this.isRequestingContacts(combinedText)) {
      if (!permissions.viewContacts) {
        return {
          allowed: false,
          refusalReason: 'UNAUTHORIZED_VIEW_CONTACTS',
          refusalMessage: this.STANDARD_REFUSAL,
          detectedCategory: 'viewContacts'
        };
      }
    }

    // 4. Calendar / Schedule inspection
    if (this.isRequestingCalendar(combinedText)) {
      if (!permissions.viewCalendar) {
        return {
          allowed: false,
          refusalReason: 'UNAUTHORIZED_VIEW_CALENDAR',
          refusalMessage: this.STANDARD_REFUSAL,
          detectedCategory: 'viewCalendar'
        };
      }
    }

    // 5. Files / Documents inspection
    if (this.isRequestingFiles(combinedText)) {
      if (!permissions.viewFiles) {
        return {
          allowed: false,
          refusalReason: 'UNAUTHORIZED_VIEW_FILES',
          refusalMessage: this.STANDARD_REFUSAL,
          detectedCategory: 'viewFiles'
        };
      }
    }

    // 6. Location inspection
    if (this.isRequestingLocation(combinedText)) {
      if (!permissions.viewLocation) {
        return {
          allowed: false,
          refusalReason: 'UNAUTHORIZED_VIEW_LOCATION',
          refusalMessage: this.STANDARD_REFUSAL,
          detectedCategory: 'viewLocation'
        };
      }
    }

    // 7. Personal information / Credentials inspection
    if (this.isRequestingPersonalInformation(combinedText)) {
      if (!permissions.viewPersonalInformation) {
        return {
          allowed: false,
          refusalReason: 'UNAUTHORIZED_VIEW_PERSONAL_INFO',
          refusalMessage: this.STANDARD_REFUSAL,
          detectedCategory: 'viewPersonalInformation'
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Post-AI generation output guard.
   * Ensures generated response does not accidentally leak private data, credentials, or internal configuration.
   */
  public static validatePostAiOutput(
    replyText: string,
    contact: DbContact | null
  ): { valid: boolean; filteredReply: string } {
    const permissions: ContactPermissions = contact
      ? parseContactPermissions(contact.permissions)
      : { ...DEFAULT_CONTACT_PERMISSIONS };

    const lowerReply = replyText.toLowerCase();

    // Check for credential or internal system leakage
    const sensitivePatterns = [
      /gsk_[a-zA-Z0-9_-]{20,}/i, // Groq keys
      /AIzaSy[a-zA-Z0-9_-]{30,}/i, // Google API keys
      /Bearer\s+[a-zA-Z0-9._-]{20,}/i,
      /database\s+schema/i,
      /pragma\s+table_info/i,
      /system_prompt\s*=/i,
      /api[_-]?key\s*[:=]/i,
      /password\s*[:=]\s*['"][^'"]+['"]/i
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(replyText)) {
        console.warn(`[PRIVACY GUARD] Blocked response matching sensitive pattern: ${pattern}`);
        return {
          valid: false,
          filteredReply: this.STANDARD_REFUSAL
        };
      }
    }

    // Check for accidental notification/message leak if permission not granted
    if (!permissions.viewNotifications && (
      lowerReply.includes('unread notification') ||
      lowerReply.includes('notification from') ||
      lowerReply.includes('received a notification')
    )) {
      return {
        valid: false,
        filteredReply: this.STANDARD_REFUSAL
      };
    }

    if (!permissions.viewMessages && (
      lowerReply.includes('unread message') ||
      lowerReply.includes('received a message from') ||
      lowerReply.includes('messaged saying') ||
      lowerReply.includes('messaged the owner saying') ||
      lowerReply.includes('messaged edwin saying')
    )) {
      return {
        valid: false,
        filteredReply: this.STANDARD_REFUSAL
      };
    }

    return { valid: true, filteredReply: replyText };
  }

  // ---------------------------------------------------------------------------
  // Helper matching functions
  // IMPORTANT: ALL patterns below must require EXPLICIT reference to the owner
  // (owner / his / him / her / edwin) to avoid false-positives on normal conversation.
  // Generic phrases like "any messages", "show me chats", "my notifications",
  // "show contacts" must NOT be matched.
  // ---------------------------------------------------------------------------

  private static isRequestingMessages(text: string): boolean {
    const patterns = [
      // "show/read/get me owner's messages" or "show/read/get his (private) messages"
      /(show|read|get|give|check|see|tell)\s+(me\s+)?(owner[''`]?s|edwin[''`]?s|his|her)\s*(private\s+|whatsapp\s+|private\s+whatsapp\s+)?messages/i,
      /read\s+(owner[''`]?s|edwin[''`]?s|his|her)\s*(private\s+|whatsapp\s+)?messages/i,
      /who\s+messaged\s+(the\s+owner|owner|edwin|him|her)/i,
      /does\s+(the\s+owner|owner|edwin|he|she)\s+have\s+(unread\s+)?messages/i,
      /what\s+did\s+(the\s+owner|owner|edwin|he|she)\s+receive/i,
      // "open/show his WhatsApp" (explicit his/owner's)
      /(show|open)\s+(me\s+)?(his|her|owner[''`]?s|edwin[''`]?s)\s+whatsapp/i,
      /who\s+is\s+chatting\s+with\s+(the\s+owner|owner|edwin|him|her)/i,
      /what\s+(whatsapp\s+)?messages\s+(did|does)\s+(the\s+owner|owner|edwin|he|she)\s+(get|have|receive)/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isRequestingNotifications(text: string): boolean {
    const patterns = [
      // "show/check owner's notifications" or "show/check his (private) notifications"
      /(show|read|get|give|check|see|tell)\s+(me\s+)?(owner[''`]?s|edwin[''`]?s|his|her)\s*(private\s+)?notifications/i,
      /what\s+notifications?\s+(did\s+he\s+get|does\s+he\s+have|are\s+there\s+for\s+(the\s+owner|owner|him|her|edwin))/i,
      /does\s+(the\s+owner|owner|edwin|he|she)\s+have\s+notifications/i,
      /check\s+(his|her|owner[''`]?s|edwin[''`]?s)\s*alerts/i,
      // "any of owner's/his notifications" — must reference owner
      /any\s+(new\s+)?(owner[''`]?s|edwin[''`]?s|his|her)\s*notifications/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isRequestingContacts(text: string): boolean {
    const patterns = [
      // Must reference "his contacts" or "owner's contacts" explicitly
      /(show|list|get|give|tell)\s+(me\s+)?(owner[''`]?s|edwin[''`]?s|his|her)\s*contacts/i,
      /who\s+is\s+in\s+(his|her|owner[''`]?s|edwin[''`]?s)\s*(phonebook|contacts)/i,
      /(give|show|what\s+is)\s+(owner[''`]?s|edwin[''`]?s|his|her)\s*contact\s*list/i,
      /what\s+are\s+(his|her|owner[''`]?s|edwin[''`]?s)\s*contacts/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isRequestingCalendar(text: string): boolean {
    const patterns = [
      /(show|tell|what\s+is)\s+(me\s+)?(owner[''`]?s|edwin[''`]?s|his|her)\s*(calendar|schedule|agenda|events|meetings)/i,
      /what\s+is\s+(the\s+owner|owner|edwin)\s+(doing|planning|scheduled\s+for)/i,
      /is\s+(the\s+owner|owner|edwin)\s+(busy|free|available)/i,
      /what\s+are\s+(his|her|owner[''`]?s|edwin[''`]?s)\s*plans/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isRequestingFiles(text: string): boolean {
    const patterns = [
      /(show|send|give|open|download)\s+(me\s+)?(owner[''`]?s|edwin[''`]?s|his|her)\s*(files|photos|images|documents|pdfs|videos)/i,
      /access\s+(his|her|owner[''`]?s|edwin[''`]?s)\s*(drive|storage|files)/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isRequestingLocation(text: string): boolean {
    const patterns = [
      /where\s+is\s+(the\s+owner|owner|edwin)/i,
      /(show|tell|give|what\s+is)\s+(me\s+)?(his|her|owner[''`]?s|edwin[''`]?s)\s*(location|gps|whereabouts)/i,
      /is\s+(the\s+owner|owner|edwin)\s+(at\s+home|at\s+work|in\s+college|travelling)/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isRequestingPersonalInformation(text: string): boolean {
    const patterns = [
      /(show|give|tell|send)\s+(me\s+)?(his|her|owner[''`]?s|edwin[''`]?s|private)?\s*(password|passwords|credentials|pin|bank|account|secret|credit\s*card|passport|financial|identity\s*details)/i,
      /(what\s+is|give\s+me|send\s+me)\s+(his|her|owner[''`]?s|edwin[''`]?s)\s*(email\s+password|login|credit\s*card|passport|bank\s*details|card\s*number)/i,
      /(credit\s*card|passport|bank\s*account|credentials|pin\s*number|cvv)/i,
    ];
    return patterns.some((p) => p.test(text));
  }

  private static isRequestingCoding(text: string): boolean {
    const patterns = [
      /write\s+(python|javascript|typescript|java|c\+\+|rust|go|php|ruby|html|css|sql|bash|powershell|code|a\s+script|a\s+program)/i,
      /create\s+a\s+(python|javascript|typescript|java|code|script|program)/i,
      /(code|program|develop)\s+a\s+/i,
      /debug\s+(this\s+code|my\s+code|this\s+script)/i,
    ];
    return patterns.some((p) => p.test(text));
  }
}

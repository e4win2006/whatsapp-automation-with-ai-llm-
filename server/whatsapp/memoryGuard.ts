import { MemoryEvidence } from '../ai/ragManager';

export interface MemoryClaimValidationResult {
  valid: boolean;
  claimDetected: boolean;
  claimSupported: boolean;
  action: 'ALLOW' | 'BLOCK_AND_REGENERATE' | 'SANITIZE';
  filteredReply: string;
  reason?: string;
}

export class MemoryGuard {
  // English patterns of claiming conversation memory
  private static readonly EN_MEMORY_CLAIM_PATTERNS = [
    /\b(i\s+remember\s+(we|that|you|our|discussing|talking)|we\s+(discussed|talked\s+about|agreed\s+on|spoke\s+about)\s+(yesterday|last\s+week|earlier|that))\b/i,
    /\b(as\s+you\s+(told|mentioned|said\s+to)\s+me\s+(yesterday|earlier|last\s+time)|yesterday\s+we\s+(talked|discussed|decided))\b/i,
    /\b(yes,?\s+we\s+(discussed|talked\s+about)|sure,?\s+we\s+(discussed|talked\s+about))\b/i
  ];

  // Manglish / Malayalam patterns of claiming conversation memory
  private static readonly MANGLISH_MEMORY_CLAIM_PATTERNS = [
    /\b(innale\s+(nammal|namal|discuss|paranja|paranjathu)|nammal\s+innale\s+(paranja|discuss)|aa\s+karyam\s+orma\s+und)\b/i,
    /\b(orma\s+undu|orma\s+und|discuss\s+cheytha\s+karyam|paranjirunnalle|athe\s+innale)\b/i,
    /\b(project\s+karyam\s+paranj|innale\s+paranja\s+topic)\b/i
  ];

  /**
   * Output-Level Memory Claim Guard.
   * Ensures the model NEVER manufactures a memory to sound human when no evidence exists.
   */
  public static validatePostAiMemoryClaims(
    generatedReply: string,
    evidence?: MemoryEvidence | null,
    userQuery: string = ''
  ): MemoryClaimValidationResult {
    if (!generatedReply) {
      return {
        valid: true,
        claimDetected: false,
        claimSupported: true,
        action: 'ALLOW',
        filteredReply: generatedReply
      };
    }

    const lowerReply = generatedReply.toLowerCase();
    const isEnClaim = this.EN_MEMORY_CLAIM_PATTERNS.some((p) => p.test(lowerReply));
    const isMlClaim = this.MANGLISH_MEMORY_CLAIM_PATTERNS.some((p) => p.test(lowerReply));
    const claimDetected = isEnClaim || isMlClaim;

    // If evidence is verified and available, claims are grounded
    if (evidence?.status === 'CONFIRMED' && evidence.relevant) {
      return {
        valid: true,
        claimDetected,
        claimSupported: true,
        action: 'ALLOW',
        filteredReply: generatedReply
      };
    }

    // If no memory was needed for this query, allow normal generation
    if (evidence?.status === 'NO_MEMORY_NEEDED' || (!evidence && !claimDetected)) {
      return {
        valid: true,
        claimDetected,
        claimSupported: true,
        action: 'ALLOW',
        filteredReply: generatedReply
      };
    }

    // If status is UNKNOWN (or evidence is missing) and model claims to remember something:
    if (claimDetected && (!evidence || evidence.status === 'UNKNOWN' || !evidence.relevant)) {
      console.warn(`[OUTPUT MEMORY GUARD] Intercepted unsupported memory claim without evidence! Reply: "${generatedReply}"`);
      
      const isManglish = /\b(da|bro|machane|karyam|innale|paray|enth|onnum|nammal|athe|illa)\b/i.test(userQuery) ||
                         /\b(da|bro|machane|karyam|innale|paray|enth|onnum|nammal|athe|illa)\b/i.test(generatedReply);

      const safeClarification = isManglish
        ? 'Hmm, eth karyama da? 😅'
        : "I don't have a clear memory of discussing that. Could you remind me which topic you mean?";

      return {
        valid: false,
        claimDetected: true,
        claimSupported: false,
        action: 'BLOCK_AND_REGENERATE',
        filteredReply: safeClarification,
        reason: 'UNSUPPORTED_MEMORY_CLAIM_WITHOUT_EVIDENCE'
      };
    }

    return {
      valid: true,
      claimDetected: false,
      claimSupported: true,
      action: 'ALLOW',
      filteredReply: generatedReply
    };
  }
}

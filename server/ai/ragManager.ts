import { JarvisDatabase, db } from '../database/database';

export interface RagMemoryChunk {
  id: string;
  contactId: string;
  messageId?: string;
  direction: 'incoming' | 'outgoing';
  content: string;
  keywords?: string[];
  importanceScore?: number;
  timestamp: number;
  createdAt: number;
}

export interface MemoryIntentClassification {
  isMemoryQuery: boolean;
  isMemoryRecall: boolean;
  memoryIntent: 'RECALL_PREVIOUS_CONVERSATION' | 'GENERAL';
  temporalHint?: 'YESTERDAY' | 'PAST_WEEK' | 'EARLIER' | 'TODAY_MORNING' | 'RECENT' | null;
  reason: string;
  queryTopic?: string;
}

export interface MemoryEvidence {
  status: 'CONFIRMED' | 'UNKNOWN' | 'NO_MEMORY_NEEDED';
  available: boolean;
  relevant: boolean;
  confidence: number;
  resultCount: number;
  relevantResultCount: number;
  bestSimilarity: number;
  contextIds: string[];
  generationPolicy: 'INJECT_EVIDENCE' | 'DO_NOT_CLAIM_MEMORY' | 'NORMAL';
  temporalHint?: string | null;
  memoryIntent?: 'RECALL_PREVIOUS_CONVERSATION' | 'GENERAL';
  retrievalSummary?: string;
}

export interface RagRetrievalResult {
  relevantChunks: Array<{
    id: string;
    content: string;
    direction: 'incoming' | 'outgoing';
    timestamp: number;
    score: number;
    isRelevant: boolean;
  }>;
  retrievalMetadata: {
    contactId: string;
    queryKeywords: string[];
    chunksSearched: number;
    chunksMatched: number;
    relevantCount: number;
    topScore: number;
    confidence: number;
    ragEnabled: boolean;
    memoryIntent: string;
    temporalHint: string | null;
    status: 'CONFIRMED' | 'UNKNOWN' | 'NO_MEMORY_NEEDED';
    contextIds: string[];
  };
  formattedContext: string;
  memoryEvidence: MemoryEvidence;
}

export class RagManager {
  private database: JarvisDatabase;

  constructor(customDb?: JarvisDatabase) {
    this.database = customDb || db;
  }

  /**
   * Tokenize text into normalized searchable tokens (supports English, Manglish, and Malayalam).
   */
  public tokenize(text: string): string[] {
    if (!text) return [];
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2);

    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'to', 'in', 'it', 'for', 'of', 'with',
      'by', 'as', 'this', 'that', 'i', 'you', 'he', 'she', 'they', 'we', 'are', 'was', 'were', 'be', 'been'
    ]);

    return Array.from(new Set(words.filter((w) => !stopWords.has(w))));
  }

  /**
   * Classify user query for memory recall intent and temporal hints.
   */
  public classifyMemoryIntent(query: string): MemoryIntentClassification {
    const lower = (query || '').toLowerCase().trim();

    // 1. Temporal Patterns
    let temporalHint: MemoryIntentClassification['temporalHint'] = null;
    if (/\b(innale|yesterday)\b/i.test(lower)) {
      temporalHint = 'YESTERDAY';
    } else if (/\b(last\s+week|kazhinja\s+aazhcha)\b/i.test(lower)) {
      temporalHint = 'PAST_WEEK';
    } else if (/\b(ravile|today\s+morning|this\s+morning)\b/i.test(lower)) {
      temporalHint = 'TODAY_MORNING';
    } else if (/\b(munpe|earlier|kurach\s+divasam\s+munpe|few\s+days\s+ago|last\s+time)\b/i.test(lower)) {
      temporalHint = 'EARLIER';
    }

    // 2. Memory Recall Patterns (English, Malayalam script, and Manglish)
    const recallPatterns = [
      /\b(antha\s+karyam|aa\s+karyam|karyam\s+paranj|namal\s+paranj|nammal\s+paranj|discuss\s+cheyth|paranja\s+karyam)\b/i,
      /\b(you\s+remember|do\s+you\s+remember|remember\s+when|as\s+i\s+told\s+you|what\s+did\s+we\s+discuss|what\s+did\s+i\s+tell\s+you)\b/i,
      /\b(what\s+did\s+(i|you|we)\s+(say|discuss|talk|tell|mention)|what\s+was\s+that\s+(topic|thing|discussion))\b/i,
      /\b(did\s+we\s+talk\s+about|we\s+talked\s+about|we\s+discussed|paranja\s+topic|orma\s+undo|orma\s+und|paranjath)\b/i,
      /\b(paranjirunnalle|paranjatha|paranjirunnu|entha\s+paranje|what\s+was\s+that)\b/i
    ];

    const hasRecallPattern = recallPatterns.some((pattern) => pattern.test(lower));
    const isMemoryQuery = Boolean(
      hasRecallPattern ||
      (temporalHint && /\b(karyam|topic|discuss|project|thing|talk|paranj|say|said|tell|told)\b/i.test(lower))
    );

    return {
      isMemoryQuery,
      isMemoryRecall: isMemoryQuery,
      memoryIntent: isMemoryQuery ? 'RECALL_PREVIOUS_CONVERSATION' : 'GENERAL',
      temporalHint: temporalHint || null,
      reason: isMemoryQuery
        ? `Detected conversation memory recall intent (temporal hint: ${temporalHint || 'none'})`
        : 'Standard conversational query'
    };
  }

  /**
   * Outer security gate: Is contact approved for JARVIS and RAG enabled?
   */
  public isContactEligibleForRag(contactId: string): boolean {
    const contact = this.database.getContact(contactId);
    if (!contact) return false;

    const isApproved = Boolean(contact.is_approved === 1 || (contact as any).approved_for_jarvis === 1);
    const isRagEnabled = Boolean(contact.rag_enabled === 1 || (contact.memory_enabled === 1 && isApproved));
    const isNamespaceActive = contact.rag_namespace_status !== 'disabled' && contact.rag_namespace_status !== 'deleted';

    return isApproved && isRagEnabled && isNamespaceActive;
  }

  /**
   * Add a message to per-contact RAG memory.
   * STRICT ENFORCEMENT: Never stores or embeds memory for unapproved contacts.
   */
  public indexMessage(
    contactId: string,
    messageId: string,
    direction: 'incoming' | 'outgoing',
    content: string,
    timestamp: number = Date.now()
  ): boolean {
    if (!content?.trim()) return false;

    if (!this.isContactEligibleForRag(contactId)) {
      return false;
    }

    const tokens = this.tokenize(content);
    const chunkId = `rag_${contactId}_${messageId}_${Date.now()}`;

    this.database.saveContactMemoryChunk({
      id: chunkId,
      contact_id: contactId,
      message_id: messageId,
      direction,
      content: content.trim(),
      keywords: JSON.stringify(tokens),
      importance_score: 1.0,
      timestamp,
      created_at: Date.now()
    });

    return true;
  }

  /**
   * Two-Stage Retrieval with Corrective Relevance Evaluator (CRAG/Self-RAG Evidence Gate).
   * Evaluates retrieved candidates against the query before creating memory evidence.
   */
  public retrieveContext(contactId: string, query: string, topK: number = 8): RagRetrievalResult {
    const classification = this.classifyMemoryIntent(query);

    const emptyEvidence: MemoryEvidence = {
      status: classification.isMemoryQuery ? 'UNKNOWN' : 'NO_MEMORY_NEEDED',
      available: false,
      relevant: false,
      confidence: 0.0,
      resultCount: 0,
      relevantResultCount: 0,
      bestSimilarity: 0.0,
      contextIds: [],
      generationPolicy: classification.isMemoryQuery ? 'DO_NOT_CLAIM_MEMORY' : 'NORMAL',
      temporalHint: classification.temporalHint || null,
      memoryIntent: classification.memoryIntent
    };

    const emptyResult: RagRetrievalResult = {
      relevantChunks: [],
      retrievalMetadata: {
        contactId,
        queryKeywords: [],
        chunksSearched: 0,
        chunksMatched: 0,
        relevantCount: 0,
        topScore: 0,
        confidence: 0.0,
        ragEnabled: false,
        memoryIntent: classification.memoryIntent,
        temporalHint: classification.temporalHint || null,
        status: emptyEvidence.status,
        contextIds: []
      },
      formattedContext: '',
      memoryEvidence: emptyEvidence
    };

    if (!this.isContactEligibleForRag(contactId)) {
      return emptyResult;
    }

    const queryTokens = this.tokenize(query);
    const allChunks = this.database.getContactMemoryChunks(contactId);

    if (!allChunks || allChunks.length === 0) {
      return {
        ...emptyResult,
        retrievalMetadata: {
          ...emptyResult.retrievalMetadata,
          ragEnabled: true,
          queryKeywords: queryTokens
        }
      };
    }

    // --- STAGE 1: Candidate Retrieval ---
    const now = Date.now();
    const scoredCandidates: Array<{
      chunk: any;
      score: number;
      isTemporalMatch: boolean;
      isSubstantive: boolean;
      matchedTokens: string[];
    }> = [];

    // Temporal window definitions
    const msPerHour = 60 * 60 * 1000;
    const isYesterdayWindow = (ts: number) => {
      const ageHours = (now - ts) / msPerHour;
      return ageHours >= 12 && ageHours <= 72;
    };

    const isTodayMorningWindow = (ts: number) => {
      const ageHours = (now - ts) / msPerHour;
      return ageHours >= 1 && ageHours <= 18;
    };

    const isPastWeekWindow = (ts: number) => {
      const ageHours = (now - ts) / msPerHour;
      return ageHours >= 24 && ageHours <= 24 * 8;
    };

    // Low-information chit-chat / greetings phrases
    const cleanChitChatText = (text: string): string => {
      return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\b(da|bro|machane|mwonu|mwonuse|dear|chetta|nanba|friend|man|dude|guy|sleep\s+well|take\s+care)\b/g, '')
        .trim();
    };

    const chitChatPhrases = new Set([
      'good night', 'good morning', 'good evening', 'hi', 'hello', 'hey', 'ok', 'okay', 'bye',
      'goodnight', 'morning', 'gn', 'gm', 'ha', 'haha', 'hmm', 'sherida', 'sheri', 'sure',
      'thanks', 'thank you', 'welcome', 'tc', 'see you', 'k', 'kk', 'yes', 'no'
    ]);

    // Query intent meta-words to ignore as topical matches
    const metaTokens = new Set([
      'innale', 'yesterday', 'karyam', 'namal', 'nammal', 'paranj', 'paranja', 'paranjath',
      'discuss', 'cheytha', 'what', 'did', 'say', 'said', 'earlier', 'today', 'week', 'last'
    ]);

    for (const chunk of allChunks) {
      const rawLower = (chunk.content || '').toLowerCase().trim();
      const cleanedChitChat = cleanChitChatText(rawLower);
      const isChitChat = chitChatPhrases.has(cleanedChitChat) || (cleanedChitChat.length < 4);
      const isSubstantive = !isChitChat && rawLower.length >= 10;

      let chunkKeywords: string[] = [];
      try {
        chunkKeywords = chunk.keywords ? JSON.parse(chunk.keywords) : this.tokenize(chunk.content);
      } catch {
        chunkKeywords = this.tokenize(chunk.content);
      }

      const chunkKwSet = new Set(chunkKeywords);
      const matched = queryTokens.filter(
        (token) => !metaTokens.has(token) && (chunkKwSet.has(token) || rawLower.includes(token))
      );

      // Check temporal alignment
      let temporalBoost = 1.0;
      let isTemporalMatch = false;

      if (classification.temporalHint === 'YESTERDAY' && isYesterdayWindow(chunk.timestamp)) {
        temporalBoost = 2.2;
        isTemporalMatch = true;
      } else if (classification.temporalHint === 'TODAY_MORNING' && isTodayMorningWindow(chunk.timestamp)) {
        temporalBoost = 2.0;
        isTemporalMatch = true;
      } else if (classification.temporalHint === 'PAST_WEEK' && isPastWeekWindow(chunk.timestamp)) {
        temporalBoost = 1.8;
        isTemporalMatch = true;
      }

      // Overlap score
      const overlapScore = queryTokens.length > 0 ? (matched.length / queryTokens.length) * 3.0 : 0.0;
      const ageHours = (now - chunk.timestamp) / msPerHour;
      const recencyFactor = Math.max(0.4, 1.0 - ageHours / (24 * 30));

      const rawScore = (overlapScore + (isSubstantive ? 1.0 : 0.2)) * recencyFactor * temporalBoost;
      const finalScore = Math.round(rawScore * 100) / 100;

      // Candidate filter: Include if token matched OR temporal match for memory query
      if (matched.length > 0 || (isTemporalMatch && classification.isMemoryQuery && isSubstantive)) {
        scoredCandidates.push({
          chunk,
          score: finalScore,
          isTemporalMatch,
          isSubstantive,
          matchedTokens: matched
        });
      }
    }

    // Sort descending by score
    scoredCandidates.sort((a, b) => b.score - a.score);
    const topCandidates = scoredCandidates.slice(0, topK);

    // --- STAGE 2: Relevance Evaluator & Evidence Gate ---
    // Evaluates whether candidates constitute verified conversational evidence (not generic chit-chat)
    const evaluatedChunks = topCandidates.map((item) => {
      const isRelevant = item.isSubstantive && (item.matchedTokens.length > 0 || (item.isTemporalMatch && item.score >= 1.8));
      return {
        id: item.chunk.id,
        content: item.chunk.content,
        direction: item.chunk.direction as 'incoming' | 'outgoing',
        timestamp: item.chunk.timestamp,
        score: item.score,
        isRelevant
      };
    });

    const relevantChunks = evaluatedChunks.filter((c) => c.isRelevant);
    const bestScore = relevantChunks[0]?.score || (evaluatedChunks[0]?.score ? evaluatedChunks[0].score * 0.4 : 0.0);

    // Compute evidence confidence (0.0 to 1.0)
    let evidenceConfidence = 0.0;
    if (relevantChunks.length > 0) {
      const baseConf = Math.min(0.95, 0.5 + relevantChunks.length * 0.15 + (bestScore > 2.0 ? 0.2 : 0.1));
      evidenceConfidence = Math.round(baseConf * 100) / 100;
    } else if (topCandidates.length > 0) {
      evidenceConfidence = Math.min(0.35, Math.round((topCandidates[0].score / 10) * 100) / 100);
    }

    // Determine Grounding Status & Generation Policy
    let status: MemoryEvidence['status'];
    let generationPolicy: MemoryEvidence['generationPolicy'];

    if (classification.isMemoryQuery) {
      if (relevantChunks.length > 0 && evidenceConfidence >= 0.6) {
        status = 'CONFIRMED';
        generationPolicy = 'INJECT_EVIDENCE';
      } else {
        status = 'UNKNOWN';
        generationPolicy = 'DO_NOT_CLAIM_MEMORY';
      }
    } else {
      if (relevantChunks.length > 0 && evidenceConfidence >= 0.7) {
        status = 'CONFIRMED';
        generationPolicy = 'INJECT_EVIDENCE';
      } else {
        status = 'NO_MEMORY_NEEDED';
        generationPolicy = 'NORMAL';
      }
    }

    const contextIds = (status === 'CONFIRMED' ? relevantChunks : []).map((c) => c.id);

    const memoryEvidence: MemoryEvidence = {
      status,
      available: relevantChunks.length > 0,
      relevant: status === 'CONFIRMED',
      confidence: evidenceConfidence,
      resultCount: topCandidates.length,
      relevantResultCount: relevantChunks.length,
      bestSimilarity: bestScore,
      contextIds,
      generationPolicy,
      temporalHint: classification.temporalHint,
      memoryIntent: classification.memoryIntent,
      retrievalSummary: status === 'CONFIRMED'
        ? `Found ${relevantChunks.length} relevant memories (confidence: ${evidenceConfidence})`
        : `No relevant evidence found (candidate count: ${topCandidates.length}, confidence: ${evidenceConfidence})`
    };

    // Format context for injection
    let formattedContext = '';
    if (status === 'CONFIRMED' && relevantChunks.length > 0) {
      formattedContext =
        `[VERIFIED CONVERSATION MEMORY EVIDENCE]\n` +
        `STATUS: CONFIRMED (Confidence: ${evidenceConfidence})\n` +
        `EVIDENCE INSTRUCTION: The following conversation memory evidence was verified for this contact. Use this evidence to answer. Do NOT invent additional details.\n` +
        relevantChunks
          .map((c) => {
            const dateStr = new Date(c.timestamp).toLocaleString();
            const sender = c.direction === 'incoming' ? 'User' : 'JARVIS';
            return `[${dateStr}] ${sender}: ${c.content}`;
          })
          .join('\n');
    }

    return {
      relevantChunks,
      retrievalMetadata: {
        contactId,
        queryKeywords: queryTokens,
        chunksSearched: allChunks.length,
        chunksMatched: topCandidates.length,
        relevantCount: relevantChunks.length,
        topScore: bestScore,
        confidence: evidenceConfidence,
        ragEnabled: true,
        memoryIntent: classification.memoryIntent,
        temporalHint: classification.temporalHint || null,
        status,
        contextIds
      },
      formattedContext,
      memoryEvidence
    };
  }

  /**
   * Delete contact memory permanently
   */
  public deleteContactMemory(contactId: string): number {
    return this.database.deleteContactMemoryChunks(contactId);
  }

  /**
   * Set RAG enabled status and namespace state for contact
   */
  public setRagStatus(contactId: string, enabled: boolean, namespaceStatus: 'active' | 'disabled' | 'deleted' = 'active'): void {
    this.database.updateContactRagStatus(contactId, enabled, namespaceStatus);
  }
}

export const ragManager = new RagManager();

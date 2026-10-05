import { JarvisDatabase, db, DbContact } from '../database/database';

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

export interface RagRetrievalResult {
  relevantChunks: Array<{
    id: string;
    content: string;
    direction: 'incoming' | 'outgoing';
    timestamp: number;
    score: number;
  }>;
  retrievalMetadata: {
    contactId: string;
    queryKeywords: string[];
    chunksSearched: number;
    chunksMatched: number;
    topScore: number;
    ragEnabled: boolean;
  };
  formattedContext: string;
}

export class RagManager {
  private database: JarvisDatabase;

  constructor(customDb?: JarvisDatabase) {
    this.database = customDb || db;
  }

  /**
   * Tokenize text into normalized searchable tokens (supports English, Manglish, and Malayalam)
   */
  public tokenize(text: string): string[] {
    if (!text) return [];
    // Normalize case, split on whitespace and punctuation
    const words = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2);

    // Filter common English & generic stop words but keep meaningful Manglish words (e.g. innale, karyam, evideya, enthaayi)
    const stopWords = new Set([
      'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'to', 'in', 'it', 'for', 'of', 'with', 'by', 'as', 'this', 'that', 'i', 'you', 'he', 'she', 'they', 'we', 'are', 'was', 'were', 'be', 'been'
    ]);

    return Array.from(new Set(words.filter((w) => !stopWords.has(w))));
  }

  /**
   * Outer security gate: Is contact approved for JARVIS and RAG enabled?
   */
  public isContactEligibleForRag(contactId: string): boolean {
    const contact = this.database.getContact(contactId);
    if (!contact) return false;
    
    // Explicit Approved-Contact-Only RAG check
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

    // 1. Strict Outer Gate
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
   * Retrieve isolated semantic and keyword context for a specific contact.
   * STRICT ENFORCEMENT:
   * - Never queries another contact's RAG namespace.
   * - Never returns results if approval is revoked or RAG is disabled.
   */
  public retrieveContext(contactId: string, query: string, limit: number = 3): RagRetrievalResult {
    const emptyResult: RagRetrievalResult = {
      relevantChunks: [],
      retrievalMetadata: {
        contactId,
        queryKeywords: [],
        chunksSearched: 0,
        chunksMatched: 0,
        topScore: 0,
        ragEnabled: false
      },
      formattedContext: ''
    };

    if (!this.isContactEligibleForRag(contactId)) {
      return emptyResult;
    }

    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0) {
      return {
        ...emptyResult,
        retrievalMetadata: { ...emptyResult.retrievalMetadata, ragEnabled: true }
      };
    }

    const allChunks = this.database.getContactMemoryChunks(contactId);
    if (!allChunks || allChunks.length === 0) {
      return {
        ...emptyResult,
        retrievalMetadata: { ...emptyResult.retrievalMetadata, ragEnabled: true, queryKeywords: queryTokens }
      };
    }

    // Score chunks using keyword overlap + recency weighting
    const now = Date.now();
    const scoredChunks: Array<{
      chunk: any;
      score: number;
      matchedTokens: string[];
    }> = [];

    for (const chunk of allChunks) {
      let chunkKeywords: string[] = [];
      try {
        chunkKeywords = chunk.keywords ? JSON.parse(chunk.keywords) : this.tokenize(chunk.content);
      } catch {
        chunkKeywords = this.tokenize(chunk.content);
      }

      const chunkKwSet = new Set(chunkKeywords);
      const matched = queryTokens.filter((token) => chunkKwSet.has(token) || chunk.content.toLowerCase().includes(token));

      if (matched.length > 0) {
        // Overlap score
        const overlapScore = (matched.length / queryTokens.length) * 2.0;
        // Age decay (older messages have slightly lower baseline score but retain relevance if highly matched)
        const ageHours = (now - chunk.timestamp) / (1000 * 60 * 60);
        const recencyFactor = Math.max(0.5, 1.0 - (ageHours / (24 * 30))); // decay over 30 days
        const finalScore = (overlapScore + (chunk.importance_score || 1.0)) * recencyFactor;

        scoredChunks.push({
          chunk,
          score: Math.round(finalScore * 100) / 100,
          matchedTokens: matched
        });
      }
    }

    // Sort by descending score
    scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = scoredChunks.slice(0, limit);

    const relevantChunks = topChunks.map((item) => ({
      id: item.chunk.id,
      content: item.chunk.content,
      direction: item.chunk.direction as 'incoming' | 'outgoing',
      timestamp: item.chunk.timestamp,
      score: item.score
    }));

    const formattedContext = relevantChunks.length > 0
      ? `Retrieved Memory / Context from this contact:\n` +
        relevantChunks
          .map((c) => {
            const dateStr = new Date(c.timestamp).toLocaleString();
            const sender = c.direction === 'incoming' ? 'User' : 'JARVIS';
            return `[${dateStr}] ${sender}: ${c.content}`;
          })
          .join('\n')
      : '';

    return {
      relevantChunks,
      retrievalMetadata: {
        contactId,
        queryKeywords: queryTokens,
        chunksSearched: allChunks.length,
        chunksMatched: relevantChunks.length,
        topScore: relevantChunks[0]?.score || 0,
        ragEnabled: true
      },
      formattedContext
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

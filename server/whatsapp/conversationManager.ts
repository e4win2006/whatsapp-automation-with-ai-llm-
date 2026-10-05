import { db, DbConversation, DbMessage, JarvisDatabase } from '../database/database';
import { eventBus } from '../core/eventBus';

export class ConversationManager {
  private database: JarvisDatabase;

  constructor(customDb?: JarvisDatabase) {
    this.database = customDb || db;
  }

  public getActiveConversation(contactId: string): DbConversation | null {
    return this.database.getActiveConversation(contactId);
  }

  public getOrCreateConversation(contactId: string): DbConversation {
    let conv = this.database.getActiveConversation(contactId);
    if (!conv) {
      conv = this.database.createConversation(contactId);
      eventBus.emit('CONVERSATION_STARTED', {
        conversationId: conv.id,
        contactId,
        messageCount: 1,
        lastMessageText: ''
      });
    }
    return conv;
  }

  public recordMessage(contactId: string, messageText: string, messageId?: string, timestamp?: number, rawPayload?: any): { conversation: DbConversation; count: number } {
    const conv = this.getOrCreateConversation(contactId);
    const newCount = conv.message_count + 1;
    this.database.updateConversationMessageCount(conv.id, newCount);

    this.database.saveMessage({
      id: messageId || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      contactId,
      conversationId: conv.id,
      direction: 'incoming',
      messageText,
      rawPayload,
      processed: false,
      isManualReply: false,
      timestamp: timestamp || Date.now()
    });

    eventBus.emit('MESSAGE_ADDED', {
      conversationId: conv.id,
      contactId,
      messageCount: newCount,
      lastMessageText: messageText
    });

    return { conversation: conv, count: newCount };
  }

  public getUnrespondedMessages(conversationId: string): DbMessage[] {
    const messages = this.database.getMessagesForConversation(conversationId);
    return messages.filter((m) => m.direction === 'incoming' && m.processed === 0);
  }

  public markMessagesProcessed(conversationId: string): void {
    const stmt = (this.database as any).db.prepare('UPDATE messages SET processed = 1 WHERE conversation_id = ? AND direction = \'incoming\'');
    stmt.run(conversationId);
  }

  public getFormattedHistory(contactId: string, limit: number = 8): string {
    const messages = this.database.getRecentMessagesForContact(contactId, limit);
    if (messages.length === 0) return '';

    return messages
      .map((m) => {
        const sender = m.direction === 'incoming' ? 'Sender' : 'Owner/JARVIS';
        const aiTag = m.trigger_type === 'ai_reply' ? ' [AI]' : '';
        return `${sender}${aiTag}: ${m.message_text}`;
      })
      .join('\n');
  }

  public closeConversation(conversationId: string, status: 'responded' | 'cancelled' | 'idle' = 'responded'): void {
    this.database.setConversationStatus(conversationId, status);
  }
}

export const conversationManager = new ConversationManager();


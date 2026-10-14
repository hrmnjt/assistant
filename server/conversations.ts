import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness, type ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { z } from 'zod';
import type { Database } from './database.js';
import { DomainError } from './domain.js';
import type { Message } from '../src/types.js';

const messageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  authorId: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

export class Conversations {
  private queues = new Map<string, Promise<unknown>>();
  private constructor(
    private db: Database,
    private harness: Harness,
  ) {
    db.sql.exec(
      'CREATE TABLE IF NOT EXISTS pi_conversations(thread_id TEXT PRIMARY KEY REFERENCES threads(id), conversation_id TEXT NOT NULL UNIQUE)',
    );
  }
  static async open(db: Database, path: string) {
    // No provider is registered until the supported AI account integration is validated.
    // Passive transcript entries persist in Pi without making inference requests.
    const harness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models: createModels(), registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    return new Conversations(db, harness);
  }
  private async conversation(threadId: string) {
    const thread = this.db.sql.prepare('SELECT id FROM threads WHERE id=?').get(threadId);
    if (!thread) throw new DomainError('Conversation not found.', 404);
    const row = this.db.sql
      .prepare('SELECT conversation_id FROM pi_conversations WHERE thread_id=?')
      .get(threadId);
    if (row) {
      const conversation = await this.harness.conversation(
        Number(row.conversation_id) as ConversationId,
        BACKGROUND_CONTEXT,
      );
      if (!conversation) throw new DomainError('Conversation storage is unavailable.', 503);
      return conversation;
    }
    const created = await this.harness.createConversation(
      { ownership: { kind: 'ownerless' } },
      BACKGROUND_CONTEXT,
    );
    this.db.sql.prepare('INSERT INTO pi_conversations VALUES (?, ?)').run(threadId, created.id);
    return created;
  }
  private serialize<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work);
    this.queues.set(threadId, pending);
    void pending
      .finally(() => {
        if (this.queues.get(threadId) === pending) this.queues.delete(threadId);
      })
      .catch(() => undefined);
    return pending;
  }
  messages(threadId: string) {
    return this.serialize(threadId, async () => {
      const conversation = await this.conversation(threadId);
      const page = await conversation.entries(
        { order: 'descending' },
        200,
        undefined,
        BACKGROUND_CONTEXT,
      );
      return page.items
        .filter((entry) => entry.kind === 'household.message')
        .map((entry) => messageSchema.parse(entry.data))
        .reverse();
    });
  }
  send(threadId: string, authorId: string, text: string, requestId: string) {
    return this.serialize(threadId, async () => {
      const conversation = await this.conversation(threadId);
      const message: Message = {
        id: randomUUID(),
        threadId,
        authorId,
        text,
        createdAt: new Date().toISOString(),
      };
      const submission = await conversation.submit(
        {
          type: 'write',
          requestId: `${authorId}:${requestId}`,
          entry: { kind: 'household.message', data: message },
        },
        BACKGROUND_CONTEXT,
      );
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status !== 'done')
        throw new DomainError('The message could not be saved. Please retry.', 503);
      return { ok: true };
    });
  }
  close() {
    return this.harness.close(BACKGROUND_CONTEXT);
  }
}

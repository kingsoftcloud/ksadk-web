import type { ConversationItem, ConversationItemReducerState } from './types.js';
import { ConversationItemReducer } from './reducer.js';
import type { ConversationId } from './studio-controller.js';

export type ProjectionCheckpoint = {
  conversationId: ConversationId;
  sourceRevision: string;
  projectionSchemaVersion: 1;
  cursor?: number;
  updatedAt: number;
};

type Entry = { reducer: ConversationItemReducer; checkpoint: ProjectionCheckpoint };

/** Bounded in-memory projection cache; the authoritative runtime log remains external. */
export class ConversationProjectionStore {
  private readonly entries = new Map<ConversationId, Entry>();
  constructor(private readonly maxConversations = 32) {}

  apply(conversationId: ConversationId, item: ConversationItem, sourceRevision = 'live', cursor?: number): boolean {
    const entry = this.entry(conversationId, sourceRevision);
    const changed = entry.reducer.apply(item);
    if (changed || cursor !== undefined) entry.checkpoint = this.checkpoint(conversationId, sourceRevision, cursor);
    return changed;
  }

  replace(conversationId: ConversationId, items: Iterable<ConversationItem>, sourceRevision: string, cursor?: number): void {
    const reducer = new ConversationItemReducer();
    reducer.applyAll(items);
    this.entries.set(conversationId, { reducer, checkpoint: this.checkpoint(conversationId, sourceRevision, cursor) });
    this.evict();
  }

  snapshot(conversationId: ConversationId): ConversationItemReducerState | undefined {
    return this.entries.get(conversationId)?.reducer.snapshot();
  }

  checkpointFor(conversationId: ConversationId): ProjectionCheckpoint | undefined {
    return this.entries.get(conversationId)?.checkpoint;
  }

  delete(conversationId: ConversationId): void { this.entries.delete(conversationId); }
  clear(): void { this.entries.clear(); }

  private entry(conversationId: ConversationId, sourceRevision: string): Entry {
    const existing = this.entries.get(conversationId);
    if (existing && existing.checkpoint.sourceRevision === sourceRevision) return existing;
    const entry = { reducer: new ConversationItemReducer(), checkpoint: this.checkpoint(conversationId, sourceRevision) };
    this.entries.set(conversationId, entry);
    this.evict();
    return entry;
  }

  private checkpoint(conversationId: ConversationId, sourceRevision: string, cursor?: number): ProjectionCheckpoint {
    return { conversationId, sourceRevision, projectionSchemaVersion: 1, cursor, updatedAt: Date.now() };
  }

  private evict(): void {
    while (this.entries.size > Math.max(1, this.maxConversations)) {
      const oldest = this.entries.keys().next().value as ConversationId | undefined;
      if (!oldest) return;
      this.entries.delete(oldest);
    }
  }
}

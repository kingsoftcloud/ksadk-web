/** Stable client-side conversation primitives used by Studio shells. */
export type ConversationId = `conversation_${string}`;

export type ConversationBinding = {
  conversationId: ConversationId;
  nativeSessionId?: string;
  agentId: string;
  targetId?: string;
};

export type DraftSession = {
  conversationId: ConversationId;
  text: string;
  revision: number;
  updatedAt: number;
};

export function createConversationId(random: () => number = Math.random): ConversationId {
  const suffix = `${Date.now().toString(36)}_${(++conversationSequence).toString(36)}_${Math.floor(random() * 0x100000000).toString(36)}`;
  return `conversation_${suffix}`;
}

let conversationSequence = 0;

export function createNavigationEpoch(): { readonly current: number; next: () => number } {
  let current = 0;
  return { get current() { return current; }, next: () => ++current };
}

export class DraftStore {
  private readonly drafts = new Map<ConversationId, DraftSession>();
  get(conversationId: ConversationId): DraftSession {
    return this.drafts.get(conversationId) || { conversationId, text: '', revision: 0, updatedAt: Date.now() };
  }
  set(conversationId: ConversationId, text: string): DraftSession {
    const previous = this.get(conversationId);
    const next = { conversationId, text, revision: previous.revision + 1, updatedAt: Date.now() };
    this.drafts.set(conversationId, next);
    return next;
  }
  delete(conversationId: ConversationId): void { this.drafts.delete(conversationId); }
  clear(): void { this.drafts.clear(); }
  size(): number { return this.drafts.size; }
}

/** Coordinates view identity without owning a runtime or cancelling runs. */
export class ConversationController {
  readonly drafts = new DraftStore();
  private readonly ids = new Map<string, ConversationId>();
  private readonly bindings = new Map<ConversationId, ConversationBinding>();
  private readonly epoch = createNavigationEpoch();

  navigate(): number { return this.epoch.next(); }
  get navigationEpoch(): number { return this.epoch.current; }

  getOrCreate(agentId: string, sessionId: string | null, targetId?: string): ConversationId {
    const key = `${agentId}:${targetId || ''}:${sessionId || 'draft'}`;
    const existing = this.ids.get(key);
    if (existing) return existing;
    const id = createConversationId();
    this.ids.set(key, id);
    this.bindings.set(id, { conversationId: id, agentId, targetId, nativeSessionId: sessionId || undefined });
    return id;
  }

  bindNative(conversationId: ConversationId, nativeSessionId: string): ConversationBinding {
    const current = this.bindings.get(conversationId);
    if (!current) throw new Error(`Unknown conversation: ${conversationId}`);
    const next = { ...current, nativeSessionId };
    this.bindings.set(conversationId, next);
    return next;
  }

  binding(conversationId: ConversationId): ConversationBinding | undefined { return this.bindings.get(conversationId); }
}

export function isCurrentNavigation(epoch: number, expected: number): boolean { return epoch === expected; }

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
  /** Files stay in this owner's memory; they are never serialized as credentials or URLs. */
  attachments: File[];
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
    let draft = this.drafts.get(conversationId);
    if (!draft) {
      draft = { conversationId, text: '', revision: 0, updatedAt: Date.now(), attachments: [] };
      this.drafts.set(conversationId, draft);
    }
    return draft;
  }
  set(conversationId: ConversationId, text: string, attachments?: File[]): DraftSession {
    const previous = this.get(conversationId);
    const files = attachments ?? previous.attachments;
    if (previous.text === text && previous.attachments === files) return previous;
    const next = { conversationId, text, attachments: files, revision: previous.revision + 1, updatedAt: Date.now() };
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
    const key = this.key(agentId, sessionId, targetId);
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
    if (!nativeSessionId) throw new Error('Native session identity is required');
    if (current.nativeSessionId && current.nativeSessionId !== nativeSessionId) {
      throw new Error('An executed conversation cannot change native sessions');
    }
    const nativeKey = this.key(current.agentId, nativeSessionId, current.targetId);
    const existing = this.ids.get(nativeKey);
    if (existing && existing !== conversationId) throw new Error('Native session is already bound');
    const next = { ...current, nativeSessionId };
    this.bindings.set(conversationId, next);
    this.ids.set(nativeKey, conversationId);
    const draftKey = this.key(current.agentId, null, current.targetId);
    if (this.ids.get(draftKey) === conversationId) this.ids.delete(draftKey);
    return next;
  }

  /** Each explicit new action creates a distinct local draft, without touching a host. */
  createDraft(agentId: string, targetId?: string): ConversationId {
    this.ids.delete(this.key(agentId, null, targetId));
    return this.getOrCreate(agentId, null, targetId);
  }

  /** Discard all owner-scoped state on logout or workspace disposal. */
  clear(): void {
    this.navigate();
    this.ids.clear();
    this.bindings.clear();
    this.drafts.clear();
  }

  private key(agentId: string, sessionId: string | null, targetId?: string): string {
    return JSON.stringify([agentId, targetId ?? null, sessionId]);
  }

  binding(conversationId: ConversationId): ConversationBinding | undefined { return this.bindings.get(conversationId); }
}

export function isCurrentNavigation(epoch: number, expected: number): boolean { return epoch === expected; }

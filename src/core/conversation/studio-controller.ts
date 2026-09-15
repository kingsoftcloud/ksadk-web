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

export type OutboxStatus = 'pending' | 'sending' | 'unknown' | 'failed' | 'completed' | 'cancelled';

export type OutboxAttachment = { name: string; type: string; size: number };

export type OutboxEntry = {
  requestId: string;
  conversationId: ConversationId;
  agentId: string;
  text: string;
  attachments: OutboxAttachment[];
  executionMode?: string;
  nativeSessionId?: string;
  invocationId?: string;
  status: OutboxStatus;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

/**
 * Durable client submission ledger. It stores intent and file metadata only;
 * file bytes stay in the in-memory composer until the runtime accepts them.
 * Unknown outcomes are retained for reconciliation and are never retried by
 * this class implicitly.
 */
export class OutboxStore {
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly storageKey: string;
  private readonly maxEntries: number;
  private readonly listeners = new Set<() => void>();
  /** File bytes are runtime-only; restored entries intentionally have none. */
  private readonly runtimeAttachments = new Map<string, File[]>();

  constructor(storageKey = 'ksadk.conversation-outbox', maxEntries = 128) {
    this.storageKey = storageKey;
    this.maxEntries = Math.max(1, maxEntries);
    this.restore();
  }

  enqueue(input: Omit<OutboxEntry, 'requestId' | 'status' | 'attempt' | 'createdAt' | 'updatedAt'> & { requestId?: string }): OutboxEntry {
    const requestId = input.requestId || `request_${Date.now().toString(36)}_${(++outboxSequence).toString(36)}`;
    const existing = this.entries.get(requestId);
    if (existing) return existing;
    const now = Date.now();
    const entry: OutboxEntry = {
      ...input,
      requestId,
      attachments: input.attachments.map(file => ({ ...file })),
      status: 'pending',
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.set(requestId, entry);
    this.evict();
    this.persist();
    return entry;
  }

  get(requestId: string): OutboxEntry | undefined { return this.entries.get(requestId); }

  setRuntimeAttachments(requestId: string, files: File[]): void {
    if (!this.entries.has(requestId)) return;
    this.runtimeAttachments.set(requestId, [...files]);
  }

  getRuntimeAttachments(requestId: string): File[] {
    return [...(this.runtimeAttachments.get(requestId) || [])];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(conversationId?: ConversationId): OutboxEntry[] {
    return [...this.entries.values()]
      .filter(entry => !conversationId || entry.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Entries that need an explicit reconciliation or retry decision. */
  listUnresolved(conversationId?: ConversationId): OutboxEntry[] {
    return this.list(conversationId).filter(entry =>
      entry.status === 'pending' || entry.status === 'sending' || entry.status === 'unknown' || entry.status === 'failed');
  }

  update(requestId: string, patch: Partial<Pick<OutboxEntry, 'status' | 'error' | 'nativeSessionId' | 'invocationId'>> & { attempt?: number }): OutboxEntry | undefined {
    const current = this.entries.get(requestId);
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    this.entries.set(requestId, next);
    this.persist();
    return next;
  }

  markSending(requestId: string): OutboxEntry | undefined {
    const current = this.entries.get(requestId);
    return current ? this.update(requestId, { status: 'sending', attempt: current.attempt + 1, error: undefined }) : undefined;
  }

  /**
   * Requeue a failed/unknown intent after the host has explicitly decided to
   * retry it. Completed, cancelled, and currently sending entries are never
   * silently reopened.
   */
  requeue(requestId: string): OutboxEntry | undefined {
    const current = this.entries.get(requestId);
    if (!current || !['pending', 'failed', 'unknown'].includes(current.status)) return current;
    return this.update(requestId, { status: 'pending', error: undefined });
  }

  remove(requestId: string): void { this.entries.delete(requestId); this.runtimeAttachments.delete(requestId); this.persist(); }
  clear(): void { this.entries.clear(); this.runtimeAttachments.clear(); this.persist(); }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const completed = [...this.entries.values()].find(entry => ['completed', 'cancelled', 'failed'].includes(entry.status));
      const oldest = completed || this.entries.values().next().value;
      if (!oldest) return;
      this.entries.delete(oldest.requestId);
      this.runtimeAttachments.delete(oldest.requestId);
    }
  }

  private restore(): void {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const value of parsed) {
        const entry = value as Partial<OutboxEntry>;
        if (!entry.requestId || !entry.conversationId || !entry.agentId || typeof entry.text !== 'string') continue;
        const status = entry.status;
        if (!status || !['pending', 'sending', 'unknown', 'failed', 'completed', 'cancelled'].includes(status)) continue;
        // A renderer restart cannot prove that an in-flight request reached
        // the runtime. Do not restore a permanently “sending” row; surface it
        // as unknown so reconciliation remains an explicit user decision.
        const restoredStatus = status === 'sending' ? 'unknown' : status;
        this.entries.set(entry.requestId, {
          requestId: entry.requestId, conversationId: entry.conversationId,
          agentId: entry.agentId, text: entry.text,
          attachments: Array.isArray(entry.attachments) ? entry.attachments.map(file => ({
            name: String(file.name || ''), type: String(file.type || ''), size: Number(file.size || 0),
          })) : [],
          executionMode: entry.executionMode,
          nativeSessionId: entry.nativeSessionId,
          invocationId: entry.invocationId,
          status: restoredStatus, attempt: Number(entry.attempt || 0),
          createdAt: Number(entry.createdAt || Date.now()), updatedAt: Number(entry.updatedAt || Date.now()),
          error: restoredStatus === 'unknown' && status === 'sending'
            ? (entry.error || '应用重启后投递状态待确认。')
            : entry.error,
        });
      }
      this.evict();
    } catch {
      // Storage is best effort; an unavailable ledger never blocks editing.
    }
  }

  private persist(): void {
    try { globalThis.localStorage?.setItem(this.storageKey, JSON.stringify([...this.entries.values()])); } catch { /* best effort */ }
    for (const listener of this.listeners) listener();
  }
}

let outboxSequence = 0;

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
  private readonly storageKey: string;
  private readonly maxEntries: number;
  constructor(storageKey = 'ksadk.conversation-drafts', maxEntries = 128) {
    this.storageKey = storageKey;
    this.maxEntries = Math.max(1, maxEntries);
    this.restore();
  }
  get(conversationId: ConversationId): DraftSession {
    let draft = this.drafts.get(conversationId);
    if (!draft) {
      draft = { conversationId, text: '', revision: 0, updatedAt: Date.now(), attachments: [] };
      this.drafts.set(conversationId, draft);
      // Browsing an old/evicted conversation must not grow an unbounded set of
      // empty editor records. Keep the currently viewed draft as the survivor.
      if (this.evict(conversationId)) this.persist();
    }
    return draft;
  }
  set(conversationId: ConversationId, text: string, attachments?: File[]): DraftSession {
    const previous = this.get(conversationId);
    const files = attachments ?? previous.attachments;
    if (previous.text === text && previous.attachments === files) return previous;
    const next = { conversationId, text, attachments: files, revision: previous.revision + 1, updatedAt: Date.now() };
    this.drafts.set(conversationId, next);
    this.evict(conversationId);
    this.persist();
    return next;
  }
  delete(conversationId: ConversationId): void { this.drafts.delete(conversationId); this.persist(); }
  clear(): void { this.drafts.clear(); this.persist(); }
  size(): number { return this.drafts.size; }

  private restore(): void {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [id, value] of Object.entries(parsed)) {
        const draft = value as Partial<DraftSession>;
        if (!id.startsWith('conversation_') || typeof draft.text !== 'string') continue;
        this.drafts.set(id as ConversationId, {
          conversationId: id as ConversationId,
          text: draft.text,
          revision: Number.isFinite(draft.revision) ? Number(draft.revision) : 0,
          updatedAt: Number.isFinite(draft.updatedAt) ? Number(draft.updatedAt) : Date.now(),
          attachments: [],
        });
      }
      if (this.evict()) this.persist();
    } catch {
      // Storage is best effort and may be unavailable in private/SSR contexts.
    }
  }

  /** Keep recent editable state bounded while leaving native session facts intact. */
  private evict(protectedId?: ConversationId): boolean {
    let changed = false;
    while (this.drafts.size > this.maxEntries) {
      const oldest = [...this.drafts.values()]
        .filter(draft => draft.conversationId !== protectedId)
        .sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!oldest) break;
      this.drafts.delete(oldest.conversationId);
      changed = true;
    }
    return changed;
  }

  private persist(): void {
    try {
      if (!globalThis.localStorage) return;
      const serializable: Record<string, Pick<DraftSession, 'text' | 'revision' | 'updatedAt'>> = {};
      for (const [id, draft] of this.drafts) {
        if (draft.text) serializable[id] = { text: draft.text, revision: draft.revision, updatedAt: draft.updatedAt };
      }
      globalThis.localStorage.setItem(this.storageKey, JSON.stringify(serializable));
    } catch {
      // Storage is best effort; in-memory drafts remain authoritative.
    }
  }
}

/** Coordinates view identity without owning a runtime or cancelling runs. */
export class ConversationController {
  readonly drafts: DraftStore;
  readonly outbox: OutboxStore;
  private readonly storageKey: string;
  private readonly ids = new Map<string, ConversationId>();
  private readonly bindings = new Map<ConversationId, ConversationBinding>();
  private readonly epoch = createNavigationEpoch();

  constructor(storageKey = 'ksadk.conversation-bindings') {
    this.storageKey = storageKey;
    this.drafts = new DraftStore(`${storageKey}:drafts`);
    this.outbox = new OutboxStore(`${storageKey}:outbox`);
    this.restoreIds();
  }

  navigate(): number { return this.epoch.next(); }
  get navigationEpoch(): number { return this.epoch.current; }

  getOrCreate(agentId: string, sessionId: string | null, targetId?: string): ConversationId {
    const key = this.key(agentId, sessionId, targetId);
    const existing = this.ids.get(key);
    if (existing) {
      if (!this.bindings.has(existing)) {
        this.bindings.set(existing, { conversationId: existing, agentId, targetId, nativeSessionId: sessionId || undefined });
      }
      return existing;
    }
    const id = createConversationId();
    this.ids.set(key, id);
    this.bindings.set(id, { conversationId: id, agentId, targetId, nativeSessionId: sessionId || undefined });
    this.persistIds();
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
    this.persistIds();
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
    this.outbox.clear();
    this.persistIds();
  }

  private restoreIds(): void {
    try {
      const raw = globalThis.localStorage?.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.startsWith('conversation_')) this.ids.set(key, value as ConversationId);
      }
    } catch {
      // Storage is best effort and may be unavailable in private/SSR contexts.
    }
  }

  private persistIds(): void {
    try {
      globalThis.localStorage?.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this.ids)));
    } catch {
      // Storage is best effort; in-memory identity remains authoritative.
    }
  }

  private key(agentId: string, sessionId: string | null, targetId?: string): string {
    return JSON.stringify([agentId, targetId ?? null, sessionId]);
  }

  binding(conversationId: ConversationId): ConversationBinding | undefined { return this.bindings.get(conversationId); }
}

export function isCurrentNavigation(epoch: number, expected: number): boolean { return epoch === expected; }

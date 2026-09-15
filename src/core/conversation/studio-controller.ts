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
  const suffix = `${Date.now().toString(36)}_${Math.floor(random() * 0x100000000).toString(36)}`;
  return `conversation_${suffix}`;
}

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

export function isCurrentNavigation(epoch: number, expected: number): boolean { return epoch === expected; }

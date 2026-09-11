import { ConversationItemReducer } from '../conversation/reducer.js';
import { decodeConversationItem } from '../conversation/contracts.js';
import type { ConversationItem } from '../conversation/types.js';
import { consumeTeamsSse, type TeamsFetch } from './client.js';
import { memberStreamRefSchema, TeamsError } from './contracts.js';
import { memberStreamKey } from './reducer.js';
import type { ConnectionStatus, MemberObservation, MemberStreamRef } from './types.js';

export type MemberHistory = { ref: MemberStreamRef; items: ConversationItem[]; cursor: number };
export type MemberFrame = { ref: MemberStreamRef; item: ConversationItem; cursor: number };
export type MemberObservationTransport = {
  read(ref: MemberStreamRef, signal: AbortSignal): Promise<MemberHistory>;
  subscribe(ref: MemberStreamRef, after: number, signal: AbortSignal, onFrame: (frame: MemberFrame) => void): Promise<void>;
};
export type ChatScopeSnapshot = MemberObservation & { draft: string; error: string | null };

/** A member scope owns its requests, reducer and draft. It has no send/delete API. */
export class MemberChatScope {
  readonly ref: Readonly<MemberStreamRef>;
  private value: ChatScopeSnapshot;
  private reducer = new ConversationItemReducer();
  private listeners = new Set<() => void>();
  private abort?: AbortController;
  private generation = 0;
  private disposed = false;
  constructor(ref: MemberStreamRef) {
    const parsed = memberStreamRefSchema.safeParse(ref);
    if (!parsed.success) throw new TeamsError('invalid_member_ref', '成员观察需要完整的运行引用。');
    this.ref = Object.freeze({ ...parsed.data });
    this.value = { ref: this.ref, items: [], cursor: 0, connection: 'closed', draft: '', error: null };
  }
  getSnapshot = (): ChatScopeSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<ChatScopeSnapshot>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    this.listeners.forEach(listener => listener());
  }
  setDraft(draft: string) { this.update({ draft }); }
  private assertRef(ref: MemberStreamRef) {
    if (memberStreamKey(ref) !== memberStreamKey(this.ref)) throw new TeamsError('scope_mismatch', '成员事件的执行身份不匹配。');
  }
  private decode(item: unknown): ConversationItem {
    const decoded = decodeConversationItem(item);
    if (!decoded) throw new TeamsError('contract_mismatch', '成员会话内容格式不兼容。');
    if (decoded.sessionId !== this.ref.sessionId || decoded.runId !== this.ref.runId) throw new TeamsError('scope_mismatch', '成员事件引用了其他会话或运行。');
    return decoded;
  }
  ingest(frame: MemberFrame) {
    if (this.disposed) return;
    this.assertRef(frame.ref);
    if (!Number.isSafeInteger(frame.cursor) || frame.cursor < 0) throw new TeamsError('contract_mismatch', '成员事件游标无效。');
    if (frame.cursor <= this.value.cursor) return;
    this.reducer.apply(this.decode(frame.item));
    this.update({ items: this.reducer.snapshot().items, cursor: frame.cursor });
  }
  restore(history: MemberHistory) {
    this.assertRef(history.ref);
    if (!Number.isSafeInteger(history.cursor) || history.cursor < 0) throw new TeamsError('contract_mismatch', '成员历史游标无效。');
    if (history.cursor < this.value.cursor) return;
    const reducer = new ConversationItemReducer();
    for (const item of history.items) reducer.apply(this.decode(item));
    this.reducer = reducer;
    this.update({ items: reducer.snapshot().items, cursor: history.cursor });
  }
  async observe(transport: MemberObservationTransport): Promise<void> {
    if (this.disposed) throw new TeamsError('scope_disposed', '成员会话已关闭。');
    this.disconnect();
    const generation = ++this.generation;
    const controller = new AbortController();
    this.abort = controller;
    const current = () => !controller.signal.aborted && generation === this.generation;
    this.update({ connection: 'connecting', error: null });
    try {
      let needSnapshot = true;
      let failures = 0;
      while (current()) {
        try {
          if (needSnapshot) {
            const history = await transport.read(this.ref, controller.signal);
            if (!current()) return;
            this.restore(history);
            needSnapshot = false;
          }
          this.update({ connection: 'connected', error: null });
          await transport.subscribe(this.ref, this.value.cursor, controller.signal, frame => {
            if (current()) { this.ingest(frame); failures = 0; }
          });
          if (!current()) return;
          throw new TeamsError('stream_ended', '成员事件连接已断开。');
        } catch (error) {
          if (!current()) return;
          if (error instanceof TeamsError && (['scope_mismatch', 'contract_mismatch'].includes(error.code) || [401, 403, 404].includes(error.status ?? 0))) throw error;
          if (failures++ >= 6) throw error;
          if (error instanceof TeamsError && error.code === 'reset_required') needSnapshot = true;
          this.update({ connection: 'reconnecting' });
          await new Promise<void>(resolve => {
            const signal = controller.signal;
            const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
            const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(500 * 2 ** (failures - 1), 10_000));
            signal.addEventListener('abort', abort, { once: true });
          });
        }
      }
    } catch (error) {
      if (current()) this.update({ connection: 'offline', error: error instanceof Error ? error.message : '成员详情加载失败。' });
    }
  }
  setConnection(connection: ConnectionStatus) { this.update({ connection }); }
  /** Close the observation; intentionally never invokes cancel/control. */
  disconnect() { this.generation++; this.abort?.abort(); this.abort = undefined; this.update({ connection: 'closed' }); }
  dispose() { this.disconnect(); this.disposed = true; this.listeners.clear(); this.reducer = new ConversationItemReducer(); this.value = { ...this.value, draft: '', items: [], cursor: 0, error: null }; }
}

export function createChatScope(ref: MemberStreamRef): MemberChatScope { return new MemberChatScope(ref); }

/** Optional same-origin HTTP adapter. Hosts may inject an existing authorized observer. */
export function createHttpMemberTransport(options: { fetch?: TeamsFetch; baseUrl?: string } = {}): MemberObservationTransport {
  const fetcher = options.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
  const baseUrl = (options.baseUrl ?? '/api/v1/groups').replace(/\/+$/, '');
  const path = (ref: MemberStreamRef, suffix: string, after?: number) => {
    const query = new URLSearchParams({ sessionId: ref.sessionId, runId: ref.runId, bindingRef: ref.bindingRef });
    if (after !== undefined) query.set('after', String(after));
    return `${baseUrl}/${encodeURIComponent(ref.groupId)}/members/${encodeURIComponent(ref.memberId)}/${suffix}?${query}`;
  };
  const get = async (url: string, signal: AbortSignal) => {
    const response = await fetcher(url, { method: 'GET', signal });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
      throw new TeamsError(body.error?.code ?? 'member_observation_failed', body.error?.message ?? `成员详情请求失败（${response.status}）`, response.status);
    }
    return response;
  };
  return {
    async read(ref, signal) { return (await get(path(ref, 'conversation'), signal)).json() as Promise<MemberHistory>; },
    async subscribe(ref, after, signal, onFrame) {
      const response = await get(path(ref, 'conversation/events', after), signal);
      await consumeTeamsSse(response, signal, (type, raw) => {
        if (type === 'heartbeat' || type === 'ping') return;
        if (type === 'reset_required') throw new TeamsError('reset_required', '成员历史已变化，请重新连接。');
        onFrame(raw as MemberFrame);
      });
    },
  };
}

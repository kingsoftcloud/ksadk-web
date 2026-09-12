import { decodeGroupEvent, decodeGroupSnapshot, decodeExecutionSnapshot, TeamsError, validateGroupCreate } from './contracts.js';
import { GroupReducer } from './reducer.js';
import type { MemberStreamRef, ConnectionStatus, ExecutionSnapshot, GroupCreateInput, GroupList, GroupMessageInput, GroupReceipt, GroupSnapshot, TaskAction, TeamControlAction, TeamInteractionInput } from './types.js';

export type TeamsFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type TeamsClientOptions = { fetch?: TeamsFetch; baseUrl?: string; maxReconnects?: number; retryDelayMs?: (attempt: number) => number };
export type GroupWatchOptions = {
  signal: AbortSignal;
  onSnapshot: (snapshot: GroupSnapshot) => void;
  onConnection?: (status: ConnectionStatus) => void;
  onError?: (error: TeamsError) => void;
};

function throwIfAborted(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const cleanup = () => signal.removeEventListener('abort', abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Read-only SSE consumption; frames never contain executable extensions. */
export async function consumeTeamsSse(response: Response, signal: AbortSignal, onFrame: (type: string, data: unknown) => void): Promise<void> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new TeamsError('contract_mismatch', '服务没有返回事件流。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const frame = (raw: string) => {
    throwIfAborted(signal);
    let type = 'message';
    const data: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return;
    let parsed: unknown;
    try { parsed = JSON.parse(data.join('\n')); } catch { throw new TeamsError('contract_mismatch', '无法解析群事件。'); }
    onFrame(type, parsed);
  };
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 8_000_000) throw new TeamsError('event_too_large', '群事件超过客户端大小限制。');
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        frame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) { if (buffer.trim()) frame(buffer); break; }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Authenticated transport is injected by the host. No ambient selected-Agent state. */
export class HttpTeamsClient {
  private readonly fetcher: TeamsFetch;
  private readonly baseUrl: string;
  private readonly reconnects: number;
  private readonly retryDelay: (attempt: number) => number;
  constructor(options: TeamsClientOptions = {}) {
    this.fetcher = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.baseUrl = (options.baseUrl ?? '/api/v1/groups').replace(/\/+$/, '');
    this.reconnects = options.maxReconnects ?? 6;
    if (!Number.isSafeInteger(this.reconnects) || this.reconnects < 0 || this.reconnects > 32) throw new TeamsError('invalid_reconnect_limit', '重连次数必须在 0–32 之间。');
    this.retryDelay = options.retryDelayMs ?? (attempt => Math.min(500 * 2 ** attempt, 10_000));
  }
  private path(groupId: string, suffix = '') { return `/${encodeURIComponent(groupId)}${suffix}`; }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    throwIfAborted(init.signal ?? undefined);
    const response = await this.fetcher(`${this.baseUrl}${path}`, init);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string }; code?: string; message?: string };
      throw new TeamsError(body.error?.code ?? body.code ?? 'http_error', body.error?.message ?? body.message ?? `群服务请求失败（${response.status}）`, response.status);
    }
    return response;
  }
  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
  private post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  }
  list(options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<GroupList> {
    const query = new URLSearchParams();
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit) query.set('limit', String(options.limit));
    return this.json(query.size ? `?${query}` : '', { signal: options.signal });
  }
  async snapshot(groupId: string, signal?: AbortSignal): Promise<GroupSnapshot> {
    const snapshot = decodeGroupSnapshot(await this.json(this.path(groupId), { signal }));
    if (snapshot.group.groupId !== groupId) throw new TeamsError('scope_mismatch', '服务返回了另一个群。');
    return snapshot;
  }
  async create(input: GroupCreateInput, signal?: AbortSignal): Promise<GroupSnapshot> {
    validateGroupCreate(input);
    return decodeGroupSnapshot(await this.post('', input, signal));
  }
  async update(groupId: string, input: { expectedRevision: number; name?: string; leaderMemberId?: string; removeMemberId?: string; addMember?: { memberId: string; name: string; bindingRef: string }; rebindMember?: { memberId: string; name: string; bindingRef: string }; taskAcceptance?: 'human' | 'result'; peerWake?: boolean; archived?: boolean; idempotencyKey: string }, signal?: AbortSignal): Promise<GroupSnapshot> {
    const snapshot = decodeGroupSnapshot(await this.json(this.path(groupId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal }));
    if (snapshot.group.groupId !== groupId) throw new TeamsError('scope_mismatch', '群更新返回了另一个群。');
    return snapshot;
  }
  send(groupId: string, input: GroupMessageInput, signal?: AbortSignal): Promise<GroupReceipt> {
    if (!input.parts.some(part => part.kind !== 'text' || part.text.trim())) throw new TeamsError('empty_message', '请输入消息。');
    if (input.intent === 'directed' && !input.mentions.length) throw new TeamsError('missing_recipient', '请选择接收成员。');
    return this.post(this.path(groupId, '/messages'), input, signal);
  }
  start(groupId: string, input: { goalMessageId: string; idempotencyKey: string }, signal?: AbortSignal): Promise<GroupReceipt> { return this.post(this.path(groupId, '/team-runs'), input, signal); }
  taskAction(groupId: string, taskId: string, input: { action: TaskAction; expectedRevision: number; idempotencyKey: string; memberId?: string; reason?: string }, signal?: AbortSignal): Promise<GroupReceipt> { return this.post(this.path(groupId, `/tasks/${encodeURIComponent(taskId)}/actions`), input, signal); }
  control(groupId: string, teamRunId: string, input: { action: TeamControlAction; expectedRevision: number; idempotencyKey: string }, signal?: AbortSignal): Promise<GroupReceipt> { return this.post(this.path(groupId, `/team-runs/${encodeURIComponent(teamRunId)}/control`), input, signal); }
  acceptRun(groupId: string, teamRunId: string, input: { accepted: boolean; expectedRevision: number; idempotencyKey: string }, signal?: AbortSignal): Promise<GroupReceipt> { return this.post(this.path(groupId, `/team-runs/${encodeURIComponent(teamRunId)}/acceptance`), input, signal); }
  interaction(groupId: string, input: TeamInteractionInput, signal?: AbortSignal): Promise<GroupReceipt> {
    if (input.ref.groupId !== groupId) throw new TeamsError('scope_mismatch', '审批不属于当前群。');
    return this.post(this.path(groupId, '/interactions'), input, signal);
  }
  cancelMember(groupId: string, memberId: string, input: { ref: MemberStreamRef; idempotencyKey: string }, signal?: AbortSignal): Promise<{ status: 'cancel_requested'; runId: string }> {
    if (input.ref.groupId !== groupId || input.ref.memberId !== memberId) throw new TeamsError('scope_mismatch', '停止请求不属于当前成员。');
    return this.post(this.path(groupId, `/members/${encodeURIComponent(memberId)}/cancel`), input, signal);
  }
  async execution(groupId: string, teamRunId?: string, signal?: AbortSignal): Promise<ExecutionSnapshot> { const result = decodeExecutionSnapshot(await this.json(this.path(groupId, `/execution${teamRunId ? `?teamRunId=${encodeURIComponent(teamRunId)}` : ''}`), { signal })); if (result.groupId !== groupId || (teamRunId && result.teamRunId !== teamRunId)) throw new TeamsError('scope_mismatch', '执行视图不属于当前协作轮次。'); return result; }
  markRead(groupId: string, watermark: number, signal?: AbortSignal): Promise<void> { return this.post(this.path(groupId, '/read'), { watermark }, signal); }

  /** Snapshot + watermark subscription. Aborting closes observation only. */
  async watch(groupId: string, options: GroupWatchOptions): Promise<void> {
    const { signal, onSnapshot, onConnection, onError } = options;
    let reducer: GroupReducer | undefined;
    let needsSnapshot = true;
    let failures = 0;
    onConnection?.('connecting');
    try {
      while (!signal.aborted) {
        try {
          if (needsSnapshot) {
            const snapshot = await this.snapshot(groupId, signal);
            if (reducer) {
              if (!reducer.replace(snapshot)) throw new TeamsError('reset_required', '服务返回的快照早于当前状态，正在重新核对。');
            } else reducer = new GroupReducer(snapshot);
            needsSnapshot = false;
            throwIfAborted(signal);
            onSnapshot(reducer.snapshot());
          }
          if (!reducer) throw new TeamsError('reset_required', '群快照尚未就绪。');
          const response = await this.request(this.path(groupId, `/events?after=${reducer.snapshot().watermark}`), { signal });
          onConnection?.('connected');
          await consumeTeamsSse(response, signal, (type, raw) => {
            if (type === 'reset_required') throw new TeamsError('reset_required', '群事件游标已过期。');
            if (type === 'heartbeat' || type === 'ping') return;
            if (reducer!.apply(decodeGroupEvent(raw))) { failures = 0; onSnapshot(reducer!.snapshot()); }
          });
          throwIfAborted(signal);
          throw new TeamsError('stream_ended', '群事件连接已断开。');
        } catch (error) {
          if (signal.aborted) break;
          const cause = error instanceof TeamsError ? error : new TeamsError('network_error', error instanceof Error ? error.message : '无法连接群服务。');
          if (cause.code === 'reset_required') needsSnapshot = true;
          else if (cause.status === 401 || cause.status === 403 || cause.status === 404 || cause.code === 'contract_mismatch' || cause.code === 'scope_mismatch') throw cause;
          if (failures++ >= this.reconnects) throw cause;
          onConnection?.('reconnecting');
          await delay(this.retryDelay(failures - 1), signal);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        onConnection?.('offline');
        const cause = error instanceof TeamsError ? error : new TeamsError('network_error', String(error));
        onError?.(cause);
        throw cause;
      }
    } finally { if (signal.aborted) onConnection?.('closed'); }
  }
}

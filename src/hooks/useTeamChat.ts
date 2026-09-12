import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { HttpTeamsClient } from '../core/teams/client.js';
import { TeamsError } from '../core/teams/contracts.js';
import type { ConnectionStatus, GroupMessageInput, GroupSnapshot } from '../core/teams/types.js';

type TeamChatState = { snapshot: GroupSnapshot | null; connection: ConnectionStatus; error: string | null; draft: string };

/** A single group subscription. It does not mount member execution controllers. */
class TeamChatController {
  private value: TeamChatState = { snapshot: null, connection: 'closed', error: null, draft: '' };
  private listeners = new Set<() => void>();
  private abort?: AbortController;
  private generation = 0;
  readonly client: HttpTeamsClient;
  readonly groupId: string;
  readonly authorityRef: string;
  constructor(client: HttpTeamsClient, groupId: string, authorityRef: string) { this.client = client; this.groupId = groupId; this.authorityRef = authorityRef; }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<TeamChatState>) { this.value = { ...this.value, ...patch }; this.listeners.forEach(listener => listener()); }
  setDraft = (draft: string) => this.update({ draft });
  start = () => {
    this.disconnect();
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const current = () => generation === this.generation && !abort.signal.aborted;
    this.update({ error: null, connection: 'connecting' });
    void this.client.watch(this.groupId, {
      signal: abort.signal,
      onSnapshot: snapshot => {
        if (!current()) return;
        if (snapshot.group.authorityRef !== this.authorityRef) throw new TeamsError('scope_mismatch', '群授权域发生变化，请重新打开。');
        this.update({ snapshot });
      },
      onConnection: connection => { if (current()) this.update({ connection }); },
      onError: error => { if (current()) this.update({ error: error.message }); },
    }).catch(error => { if (current()) this.update({ connection: 'offline', error: error instanceof Error ? error.message : '群连接失败。' }); });
  };
  disconnect = () => { this.generation++; this.abort?.abort(); this.abort = undefined; };
  send = (input: GroupMessageInput) => this.client.send(this.groupId, input);
}

export function useTeamChat(options: { client: HttpTeamsClient; groupId: string; authorityRef: string }) {
  const controller = useMemo(() => new TeamChatController(options.client, options.groupId, options.authorityRef), [options.client, options.groupId, options.authorityRef]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.start(); return controller.disconnect; }, [controller]);
  return { ...state, loading: !state.snapshot && state.connection === 'connecting', setDraft: controller.setDraft, send: controller.send, reconnect: controller.start };
}

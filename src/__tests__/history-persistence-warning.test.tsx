import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  hostedRuntime: undefined as boolean | undefined,
  history: {
    nextCursor: null, hasMore: false, isLoadingInitial: false, isLoadingOlder: false,
    persistenceDegraded: true, historyEpoch: 'epoch-1', snapshotSeqId: 0,
  },
}));
vi.mock('../stores/session.js', () => ({
  useSessionStore: (select: (value: unknown) => unknown) => select({
    currentSessionId: 's', isLoadingSessions: false, sessions: [], messageHistory: { s: state.history },
  }),
}));
vi.mock('../stores/bootstrap.js', () => ({
  useBootstrapStore: (select: (value: unknown) => unknown) => select({ capabilities: {
    HostedRuntime: state.hostedRuntime,
    RuntimeCapabilities: { Checkpoint: {
      Supported: true, Backend: 'sqlite', Scope: 'pod_local', Durable: true, SharedAcrossPods: false,
    } },
  } }),
}));
vi.mock('../components/chat/ChatMessageList.js', () => ({ ChatMessageList: () => null }));
vi.mock('../components/chat/AttachmentPreview.js', () => ({ AttachmentPreview: () => null }));

import { ConnectedMessageList } from '../components/chat/ConnectedMessageList.js';

describe('history persistence warning', () => {
  it.each([
    [false, '本地恢复取决于所用存储及数据文件是否保留，不保证跨实例恢复。'],
    [true, '刷新、重启或切换实例后，部分消息可能无法恢复。'],
    [undefined, '刷新或切换设备后，部分消息可能无法恢复。'],
  ] as const)('preserves the history warning gate with HostedRuntime=%s', (hostedRuntime, text) => {
    state.hostedRuntime = hostedRuntime;
    state.history.persistenceDegraded = true;
    const before = structuredClone(state.history);
    const render = () => renderToStaticMarkup(<ConnectedMessageList
      agentName="Agent" isMobile={false} onDeleteFeedback={() => {}}
      onSubmitFeedback={() => {}} onRespondToApproval={() => {}} />);
    const html = render();
    expect(html).toContain('history-persistence-warning');
    expect(html).toContain(text);
    // A durable local checkpoint neither proves history durability nor clears its warning.
    expect(html).not.toContain('历史尚未持久化');
    expect(state.history).toEqual(before);
    state.history.persistenceDegraded = false;
    expect(render()).not.toContain('history-persistence-warning');
  });
});

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useStreamingStore } from '../stores/streaming.js';
import type { ApiFacade } from '../core/api/types.js';
import type { UiCapabilities } from '../types/capabilities.js';

const caps = { KernelSessionEventsByCommand: true,
  RunLifecycle: { Enabled: true, Resume: true, Checkpoints: false } } as UiCapabilities;
function lifecycle(overrides: Partial<ApiFacade>) {
  const api = {
    listSessionMessages: vi.fn().mockResolvedValue({ Messages: [], LatestSeqId: 0, HasMore: false }),
    listSessionEvents: vi.fn().mockResolvedValue({ Events: [], Total: 0 }),
    subscribeRunEvents: vi.fn(),
    ...overrides,
  };
  let actions!: ReturnType<typeof useSessionLifecycle>;
  function Probe() {
    actions = useSessionLifecycle({ agentId: 'agent', currentSessionId: 'a', isMobile: false,
      uiCapabilities: caps, api: api as unknown as ApiFacade, restoreSession: false, resetCompaction: () => {} });
    return null;
  }
  renderToString(createElement(Probe));
  return { actions, api };
}
const start = (runId = 'run-a', source: 'run' | 'restore' = 'restore') => {
  useStreamingStore.getState().setSessionStreaming('a', true);
  useStreamingStore.getState().updateActivity({ sessionId: 'a', runId, source, status: 'running', phase: '正在处理' });
};

describe('trailing feedback reconciles with durable session state', () => {
  beforeEach(() => {
    useBootstrapStore.getState().setAgentId('agent');
    useBootstrapStore.getState().setCapabilities(caps);
    useSessionStore.getState().setCurrentSessionId('a');
    useMessageStore.getState().setMessages([]);
    useStreamingStore.getState().resetRun();
  });

  it.each(['completed', 'failed', 'cancelled'])('settles a background %s run on returning to its session', async status => {
    start();
    const { actions, api } = lifecycle({ getSession: vi.fn().mockResolvedValue({ ActiveInvocationId: 'run-a', ActiveRunStatus: status }) });
    await actions.loadSession('a');
    expect(useStreamingStore.getState().isSessionStreaming('a')).toBe(false);
    expect(useStreamingStore.getState().getSessionActivity('a')?.status).toBe(status === 'cancelled' ? 'stopped' : status);
    expect(api.subscribeRunEvents).not.toHaveBeenCalled();
  });

  it('settles from terminal history when the active pointer has already been cleared', async () => {
    start();
    const { actions } = lifecycle({ getSession: vi.fn().mockResolvedValue({}),
      listSessionEvents: vi.fn().mockResolvedValue({ Events: [{ InvocationId: 'run-a', SeqId: 3,
        EventType: 'run_status', Content: { status: 'completed' } }], Total: 1 }) });
    await actions.loadSession('a');
    expect(useStreamingStore.getState().isSessionStreaming('a')).toBe(false);
  });

  it('does not let stale terminal metadata settle a newer native run', async () => {
    start('new-run', 'run');
    const { actions } = lifecycle({ getSession: vi.fn().mockResolvedValue({ ActiveInvocationId: 'old-run', ActiveRunStatus: 'completed' }) });
    await actions.loadSession('a');
    expect(useStreamingStore.getState().isSessionStreaming('a')).toBe(true);
    expect(useStreamingStore.getState().getSessionActivity('a')?.runId).toBe('new-run');
  });

  it('does not settle the root run from a child scope terminal', async () => {
    start();
    const { actions } = lifecycle({ getSession: vi.fn().mockResolvedValue({}),
      listSessionEvents: vi.fn().mockResolvedValue({ Events: [{ InvocationId: 'run-a', SeqId: 3,
        EventType: 'run.completed', Content: { runtime_event: { parent_scope_id: 'root' } } }], Total: 1 }) });
    await actions.loadSession('a');
    expect(useStreamingStore.getState().isSessionStreaming('a')).toBe(true);
  });

  it('keeps the native owner on session return instead of opening another stream', async () => {
    start('run-a', 'run');
    const { actions, api } = lifecycle({ getSession: vi.fn().mockResolvedValue({ ActiveInvocationId: 'run-a', ActiveRunStatus: 'running' }) });
    await actions.loadSession('a');
    expect(api.subscribeRunEvents).not.toHaveBeenCalled();
    expect(useStreamingStore.getState().getSessionActivity('a')).toMatchObject({ source: 'run', phase: '正在处理' });
  });

  it('reports an unconfirmed state when the session query fails', async () => {
    start();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { actions } = lifecycle({ getSession: vi.fn().mockRejectedValue(new TypeError('offline')) });
      await actions.loadSession('a');
      expect(useStreamingStore.getState().getSessionActivity('a')?.phase).toBe('正在确认任务状态');
      expect(useStreamingStore.getState().isSessionStreaming('a')).toBe(true);
    } finally { warning.mockRestore(); }
  });
});

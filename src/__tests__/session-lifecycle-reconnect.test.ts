import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CancelledError } from '../api/client.js';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useSessionStore } from '../stores/session.js';
import { useStreamingStore } from '../stores/streaming.js';
import type { ApiFacade } from '../core/api/types.js';
import type { UiCapabilities } from '../types/capabilities.js';

const capabilities = {
  RunLifecycle: { Enabled: true, Resume: true, Checkpoints: false },
} as UiCapabilities;

function lifecycle(api: Partial<ApiFacade>) {
  let actions!: ReturnType<typeof useSessionLifecycle>;
  function Probe() {
    actions = useSessionLifecycle({
      agentId: 'agent-a',
      currentSessionId: null,
      isMobile: false,
      uiCapabilities: capabilities,
      api: api as ApiFacade,
      resetCompaction: () => {},
      restoreSession: false,
    });
    return null;
  }
  renderToString(createElement(Probe));
  return actions;
}

describe('session lifecycle reconnect errors', () => {
  beforeEach(() => {
    useBootstrapStore.getState().setAgentId('agent-a');
    useBootstrapStore.getState().setCapabilities(capabilities);
    useSessionStore.getState().setCurrentSessionId(null);
    useStreamingStore.getState().resetRun();
    useStreamingStore.getState().setBanner(null);
  });

  it('surfaces permanent subscription auth failures instead of retrying forever', async () => {
    const subscribeRunEvents = vi.fn().mockRejectedValue(new ApiError(401, 'Unauthorized'));
    const actions = lifecycle({
      listSessionMessages: vi.fn().mockResolvedValue({
        Messages: [], LatestSeqId: 0, HasMore: false, NextCursor: null,
      }),
      listSessionEvents: vi.fn().mockResolvedValue({ Events: [], Total: 0 }),
      getSession: vi.fn().mockResolvedValue({
        ActiveRunStatus: 'running', ActiveInvocationId: 'run-1',
      }),
      subscribeRunEvents,
    });

    await actions.loadSession('session-auth-expired');
    // Longer than the old 500ms retry delay: a permanent 401 must still make
    // exactly one request and leave a visible failed state.
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(useStreamingStore.getState().isSessionStreaming('session-auth-expired')).toBe(false);
    expect(useStreamingStore.getState().getSessionActivity('session-auth-expired')).toMatchObject({
      status: 'failed',
    });
    expect(useStreamingStore.getState().banner).toMatchObject({
      kind: 'error',
      message: expect.stringContaining('Unauthorized'),
      sessionId: 'session-auth-expired',
    });
  });

  it('does not retry an explicitly aborted subscription', async () => {
    const subscribeRunEvents = vi.fn().mockRejectedValue(new CancelledError());
    const actions = lifecycle({
      listSessionMessages: vi.fn().mockResolvedValue({
        Messages: [], LatestSeqId: 0, HasMore: false, NextCursor: null,
      }),
      listSessionEvents: vi.fn().mockResolvedValue({ Events: [], Total: 0 }),
      getSession: vi.fn().mockResolvedValue({
        ActiveRunStatus: 'running', ActiveInvocationId: 'run-1',
      }),
      subscribeRunEvents,
    });

    await actions.loadSession('session-aborted');
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(useStreamingStore.getState().isSessionStreaming('session-aborted')).toBe(false);
    expect(useStreamingStore.getState().getSessionActivity('session-aborted')).toMatchObject({
      status: 'stopped',
    });
    expect(useStreamingStore.getState().banner).toBeNull();
  });

  it('stops a pending subscription when its abort signal is triggered', async () => {
    let signal: AbortSignal | undefined;
    const subscribeRunEvents = vi.fn((_params, options?: { signal?: AbortSignal }) => {
      signal = options?.signal;
      return new Promise<ReadableStream<Uint8Array>>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new CancelledError()), { once: true });
      });
    });
    const actions = lifecycle({
      listSessionMessages: vi.fn().mockResolvedValue({
        Messages: [], LatestSeqId: 0, HasMore: false, NextCursor: null,
      }),
      listSessionEvents: vi.fn().mockResolvedValue({ Events: [], Total: 0 }),
      getSession: vi.fn().mockResolvedValue({
        ActiveRunStatus: 'running', ActiveInvocationId: 'run-1',
      }),
      subscribeRunEvents,
    });

    await actions.loadSession('session-unmount');
    await vi.waitFor(() => expect(signal).toBeDefined());
    actions.runSubscriptionAbortRef.current?.abort();
    await vi.waitFor(() => expect(
      useStreamingStore.getState().getSessionActivity('session-unmount')?.status,
    ).toBe('stopped'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(subscribeRunEvents).toHaveBeenCalledTimes(1);
    expect(useStreamingStore.getState().isSessionStreaming('session-unmount')).toBe(false);
  });
});

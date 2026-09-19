import { afterEach, describe, expect, it } from 'vitest';
import { useStreamingStore } from '../stores/streaming.js';

describe('streaming store session activity', () => {
  it('reports draft submission immediately before a session id or activity event exists', () => {
    const store = useStreamingStore.getState();
    store.setSessionStreaming(null, true);
    expect(store.getSessionActivity(null)).toBeNull();
    expect(store.isSessionStreaming(null)).toBe(true);
    expect(store.isSessionStreaming('other-session')).toBe(false);
    store.setSessionStreaming('created-session', true);
    store.setSessionStreaming(null, false);
    expect(store.isSessionStreaming(null)).toBe(false);
    expect(store.isSessionStreaming('created-session')).toBe(true);
    store.setSessionStreaming('created-session', false);
    expect(useStreamingStore.getState().isStreaming).toBe(false);
  });
  afterEach(() => {
    useStreamingStore.getState().resetRun();
  });

  it('keeps a session-scoped banner active until that session is stopped', () => {
    const store = useStreamingStore.getState();

    store.updateActivity({
      sessionId: 'session-1',
      runId: 'run-1',
      status: 'running',
      phase: '后台长任务运行中',
    });
    store.setSessionStreaming('session-1', true);

    useStreamingStore.getState().stopActivity('用户停止接收');

    expect(useStreamingStore.getState().isSessionStreaming('session-1')).toBe(true);

    useStreamingStore.getState().stopSessionActivity('session-1', '用户停止接收');

    expect(useStreamingStore.getState().isSessionStreaming('session-1')).toBe(false);
    expect(useStreamingStore.getState().getSessionActivity('session-1')?.status).toBe('stopped');
  });

  it('keeps a pending approval visible after its transport stream settles', () => {
    const store = useStreamingStore.getState();
    store.updateActivity({
      sessionId: 'session-approval',
      status: 'waiting',
      phase: '等待人工确认',
    });
    store.setSessionStreaming('session-approval', true);

    store.setSessionStreaming('session-approval', false);

    expect(store.getSessionActivity('session-approval')).toMatchObject({
      status: 'waiting',
      phase: '等待人工确认',
    });
    expect(store.isSessionStreaming('session-approval')).toBe(false);
  });
});

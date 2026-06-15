import { afterEach, describe, expect, it } from 'vitest';
import { useStreamingStore } from '../stores/streaming.js';

describe('streaming store session activity', () => {
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

    useStreamingStore.getState().stopActivity('用户停止接收');

    expect(useStreamingStore.getState().isSessionStreaming('session-1')).toBe(true);

    useStreamingStore.getState().stopSessionActivity('session-1', '用户停止接收');

    expect(useStreamingStore.getState().isSessionStreaming('session-1')).toBe(false);
    expect(useStreamingStore.getState().getSessionActivity('session-1')?.status).toBe('stopped');
  });
});

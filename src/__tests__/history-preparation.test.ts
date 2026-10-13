import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CancelledError } from '../api/client.js';
import { readPreparedHistory } from '../utils/history-preparation.js';

const pending = () => new ApiError(503, 'preparing', { ReasonCode: 'HISTORY_PREPARING' });
afterEach(() => vi.useRealTimers());
describe('queued legacy history', () => {
  it('polls an explicit pending task and returns its prepared page', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(pending()).mockResolvedValue({ Messages: ['ready'] });
    const onPreparing = vi.fn();
    const result = readPreparedHistory(read, { isCurrent: () => true, onPreparing });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toEqual({ Messages: ['ready'] });
    expect(onPreparing).toHaveBeenCalledOnce();
  });
  it('never automatically repeats an ordinary heavy read timeout', async () => {
    const read = vi.fn().mockRejectedValue(new ApiError(504, 'timeout'));
    await expect(readPreparedHistory(read, { isCurrent: () => true })).rejects.toMatchObject({ code: 504 });
    expect(read).toHaveBeenCalledOnce();
  });
  it('stops polling after a session switch', async () => {
    vi.useFakeTimers();
    let current = true;
    const read = vi.fn().mockRejectedValue(pending());
    const result = readPreparedHistory(read, { isCurrent: () => current });
    const assertion = expect(result).rejects.toBeInstanceOf(CancelledError);
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(read).toHaveBeenCalledOnce();
  });
  it('bounds polling and preserves a retryable error instead of empty success', async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(pending());
    const result = readPreparedHistory(read, { isCurrent: () => true });
    const assertion = expect(result).rejects.toMatchObject({ code: 503 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(read).toHaveBeenCalledTimes(15);
  });
  it('aborts a pending delay without leaving its timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn().mockRejectedValue(pending());
    const result = readPreparedHistory(read, { isCurrent: () => true, signal: controller.signal });
    const assertion = expect(result).rejects.toBeInstanceOf(CancelledError);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });
});

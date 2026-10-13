import { ApiError, CancelledError } from '../api/client.js';

export function isHistoryPreparing(error: unknown): boolean {
  return error instanceof ApiError && error.code === 503
    && (error.detail as { ReasonCode?: string } | undefined)?.ReasonCode === 'HISTORY_PREPARING';
}

/** Poll only an explicitly queued read. Ordinary timeouts never replay a heavy read. */
export async function readPreparedHistory<T>(read: () => Promise<T>, options: {
  isCurrent: () => boolean;
  signal?: AbortSignal;
  onPreparing?: () => void;
}): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    if (!options.isCurrent() || options.signal?.aborted) throw new CancelledError();
    try {
      return await read();
    } catch (error) {
      if (!isHistoryPreparing(error) || attempt >= 14 || Date.now() - started >= 58_000) throw error;
      if (!options.isCurrent() || options.signal?.aborted) throw new CancelledError();
      options.onPreparing?.();
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(2000, 60_000 - (Date.now() - started)));
        options.signal?.addEventListener('abort', done, { once: true });
        if (options.signal?.aborted) done();
      });
    }
  }
}

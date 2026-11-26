import { useEffect, useRef, useState } from 'react';

import type { HistoryContentCheckpoint, ReadHistoryContent } from '../../utils/history-content.js';

export function DeferredHistoryContent({ label, read }: {
  label: string; read: ReadHistoryContent;
}) {
  const [body, setBody] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const checkpoint = useRef<HistoryContentCheckpoint>({});
  useEffect(() => () => {
    request.current?.abort();
    checkpoint.current = {};
  }, []);
  const load = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const value = await read(controller.signal, checkpoint.current);
      if (!controller.signal.aborted) setBody(value);
    } catch {
      if (!controller.signal.aborted) setError('读取失败。');
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return <div className="my-2 text-sm">
    <button type="button" disabled={loading} aria-expanded={body !== undefined}
      onClick={() => body === undefined ? void load() : setBody(undefined)}>
      {loading ? '正在读取' : error ? '重试' : body === undefined ? '展开' : '收起'} {label}
    </button>
    {error && <span role="alert">{error}</span>}
    {body !== undefined && <pre className="max-h-96 overflow-auto whitespace-pre-wrap">{body}</pre>}
  </div>;
}

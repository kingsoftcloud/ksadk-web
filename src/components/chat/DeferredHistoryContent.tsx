import { useEffect, useRef, useState } from 'react';
import type { Message } from './types.js';

export function DeferredHistoryContent({ message }: { message: Message }) {
  const [body, setBody] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const load = async () => {
    if (request.current || !message.readHistoryContent) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const value = await message.readHistoryContent(controller.signal);
      if (!controller.signal.aborted) setBody(value);
    } catch {
      if (!controller.signal.aborted) setError('读取失败，请重试。');
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return <div className="my-2 text-sm">
    <button type="button" disabled={loading} aria-expanded={body !== undefined}
      onClick={() => body === undefined ? void load() : setBody(undefined)}>
      {loading ? '正在读取' : body === undefined ? '展开' : '收起'} {message.content}
    </button>
    {error && <span role="alert">{error}</span>}
    {body !== undefined && <pre className="max-h-96 overflow-auto whitespace-pre-wrap">{body}</pre>}
  </div>;
}

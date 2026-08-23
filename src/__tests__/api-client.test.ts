import { describe, expect, it, vi } from 'vitest';
import { ApiError, postJsonAction, streamAction } from '../api/client.js';

describe('AgentEngine action response parsing', () => {
  it('explains Dashboard authentication when a hosted Agent returns an HTML 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('<!doctype html>', {
      status: 401,
      headers: { 'content-type': 'text/html' },
    }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      await expect(postJsonAction('GetAgentUiBootstrap', { AgentId: 'agent-1' }))
        .rejects
        .toMatchObject<ApiError>({
          code: 401,
          message: '访问会话已失效，请从 Dashboard 或 Studio 的云端会话重新打开 Agent。',
        });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('keeps malformed successful responses distinguishable from authentication failures', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;

    try {
      await expect(postJsonAction('GetAgentUiBootstrap', { AgentId: 'agent-1' }))
        .rejects
        .toMatchObject<ApiError>({ code: -2, message: '响应格式异常' });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('rejects an HTTP 200 action error before exposing it as an SSE stream', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      Code: 503,
      Message: 'runtime agent kernel is not ready',
      Data: {
        ReceiptStatus: 'rejected',
        Error: { code: 'runtime_not_ready' },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })) as typeof fetch;

    try {
      await expect(streamAction('RunAgent', { Stream: true }))
        .rejects
        .toMatchObject<ApiError>({
          code: 503,
          message: 'runtime agent kernel is not ready',
        });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

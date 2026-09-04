import { describe, expect, it, vi } from 'vitest';
import {
  AgentEngineClient,
  ApiError,
  postJsonAction,
  streamAction,
} from '../api/client.js';

describe('AgentEngine action response parsing', () => {
  it('scopes JSON, form, and stream requests to one embedded agent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith('/RunAgent')) {
        return new Response('event: done\ndata: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return new Response(JSON.stringify({ Code: 0, Data: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new AgentEngineClient({
      fetch: fetcher,
      baseUrl: '/studio/actions/',
      agentId: 'agent-cloud-1',
    });

    await client.postJsonAction('ListSessionEvents', {
      SessionId: 'session-1',
      AgentId: undefined,
    });
    const form = new FormData();
    form.append('File', new Blob(['hello']), 'hello.txt');
    await client.postFormAction('UploadFile', form);
    await client.streamAction('RunAgent', { SessionId: 'session-1' });

    expect(calls.map((call) => call.url)).toEqual([
      '/studio/actions/ListSessionEvents',
      '/studio/actions/UploadFile',
      '/studio/actions/RunAgent',
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      AgentId: 'agent-cloud-1',
      SessionId: 'session-1',
    });
    expect(form.get('AgentId')).toBe('agent-cloud-1');
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      AgentId: 'agent-cloud-1',
      SessionId: 'session-1',
    });
  });

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

import { describe, expect, it, vi } from 'vitest';
import { ApiError, postJsonAction } from '../api/client.js';

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
});

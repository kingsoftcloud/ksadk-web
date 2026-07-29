import { describe, it, expect } from 'vitest';
import { ApiFacadeImpl } from '../core/api/facade.js';
import type { ApiFacade } from '../core/api/types.js';

describe('ApiFacadeImpl', () => {
  it('exposes all required methods', () => {
    const facade = new ApiFacadeImpl();
    const methods: (keyof ApiFacade)[] = [
      'listSessions', 'createSession', 'deleteSession', 'getSession',
      'listSessionEvents', 'listSessionMessages', 'listSessionCheckpoints', 'listToolReceipts', 'previewCheckpointResume', 'runAgent', 'resumeRun', 'subscribeRunEvents', 'cancelRun',
      'getResponseFeedback', 'upsertResponseFeedback', 'deleteResponseFeedback',
      'listWorkspaceFiles', 'addWorkspaceFile', 'deleteWorkspaceFile', 'getWorkspaceFileContent',
      'listAgentModels', 'getAgentUiBootstrap', 'uploadFile',
    ];
    for (const method of methods) {
      expect(typeof facade[method]).toBe('function');
    }
  });

  it('sends feedback payloads without rebuilding them as Message objects', async () => {
    const facade = new ApiFacadeImpl();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        Code: 0,
        Data: {
          Feedback: {
            ResponseId: 'resp-1',
            EventId: 'evt-1',
            Rating: 'up',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await facade.upsertResponseFeedback({
        AgentId: 'agent-1',
        SessionId: 'session-1',
        ResponseId: 'resp-1',
        EventId: 'evt-1',
        Rating: 'up',
        Comment: '',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: '/agentengine/api/v1/UpsertResponseFeedback',
        body: {
          AgentId: 'agent-1',
          SessionId: 'session-1',
          ResponseId: 'resp-1',
          EventId: 'evt-1',
          Rating: 'up',
          Comment: '',
        },
      },
    ]);
  });

  it('sends session pagination fields and returns list metadata', async () => {
    const facade = new ApiFacadeImpl();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        Code: 0,
        Data: {
          Sessions: [{ SessionId: 'sess-1' }],
          Total: 12,
          Page: 2,
          PageSize: 5,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const data = await facade.listSessions('agent-1', { page: 2, pageSize: 5 });
      expect(data.Total).toBe(12);
      expect(data.Sessions).toEqual([{ SessionId: 'sess-1' }]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: '/agentengine/api/v1/ListSessions',
        body: {
          AgentId: 'agent-1',
          Page: 2,
          PageSize: 5,
        },
      },
    ]);
  });

  it('sends session event pagination fields and returns total metadata', async () => {
    const facade = new ApiFacadeImpl();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({
        Code: 0,
        Data: {
          Events: [{ SeqId: 3 }],
          Total: 9,
          Offset: 2,
          Limit: 1,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const data = await facade.listSessionEvents('sess-1', { offset: 2, limit: 1 });
      expect(data.Total).toBe(9);
      expect(data.Events).toEqual([{ SeqId: 3 }]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: '/agentengine/api/v1/ListSessionEvents',
        body: {
          SessionId: 'sess-1',
          Offset: 2,
          Limit: 1,
        },
      },
    ]);
  });

  it('uses message cursors for older history and scopes cancellation to the session', async () => {
    const facade = new ApiFacadeImpl();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      });
      const data = String(url).endsWith('/ListSessionMessages')
        ? { Messages: [{ MessageId: 'evt-2', Role: 'assistant', SeqId: 2 }], LatestSeqId: 2, HasMore: false, NextCursor: null }
        : { Cancelled: true };
      return new Response(JSON.stringify({ Code: 0, Data: data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const messagePage = await facade.listSessionMessages('session-1', {
        beforeSeqId: 6,
        limit: 50,
        includeReasoning: true,
        includeToolEvents: true,
        includeAttachments: true,
      });
      expect(messagePage.NextCursor).toBeNull();
      await facade.cancelRun('agent-1', 'session-1', 'run-1');
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: '/agentengine/api/v1/ListSessionMessages',
        body: {
          SessionId: 'session-1',
          BeforeSeqId: 6,
          Limit: 50,
          IncludeReasoning: true,
          IncludeToolEvents: true,
          IncludeAttachments: true,
        },
      },
      {
        url: '/agentengine/api/v1/CancelRun',
        body: {
          AgentId: 'agent-1',
          SessionId: 'session-1',
          InvocationId: 'run-1',
        },
      },
    ]);
  });

  it('maps checkpoint actions to backend action payloads', async () => {
    const facade = new ApiFacadeImpl();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown>,
      });
      const data = String(url).endsWith('/ResumeRun')
        ? {}
        : String(url).endsWith('/GetCheckpointResumePreview')
          ? { Preview: { Risk: { Level: 'medium' } } }
          : String(url).endsWith('/ListToolReceipts')
            ? { ToolReceipts: [{ ReceiptId: 'tr-1' }] }
          : { Checkpoints: [{ CheckpointId: 'ckpt-1', RunId: 'run-1' }] };
      return new Response(JSON.stringify({ Code: 0, Data: data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      await facade.listSessionCheckpoints({
        agentId: 'agent-1',
        sessionId: 'session-1',
        runId: 'run-1',
      });
      await facade.previewCheckpointResume({
        agentId: 'agent-1',
        sessionId: 'session-1',
        runId: 'run-1',
        checkpointId: 'ckpt-1',
      });
      await facade.listToolReceipts({
        agentId: 'agent-1',
        sessionId: 'session-1',
        runId: 'run-1',
        checkpointId: 'ckpt-1',
      });
      await facade.resumeRun({
        agentId: 'agent-1',
        sessionId: 'session-1',
        runId: 'run-1',
        checkpointId: 'ckpt-1',
        invocationId: 'run-resume-1',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        url: '/agentengine/api/v1/ListSessionCheckpoints',
        body: { AgentId: 'agent-1', SessionId: 'session-1', RunId: 'run-1' },
      },
      {
        url: '/agentengine/api/v1/GetCheckpointResumePreview',
        body: {
          AgentId: 'agent-1',
          SessionId: 'session-1',
          RunId: 'run-1',
          CheckpointId: 'ckpt-1',
        },
      },
      {
        url: '/agentengine/api/v1/ListToolReceipts',
        body: {
          AgentId: 'agent-1',
          SessionId: 'session-1',
          RunId: 'run-1',
          CheckpointId: 'ckpt-1',
        },
      },
      {
        url: '/agentengine/api/v1/ResumeRun',
        body: {
          AgentId: 'agent-1',
          SessionId: 'session-1',
          RunId: 'run-1',
          CheckpointId: 'ckpt-1',
          Stream: true,
          InvocationId: 'run-resume-1',
        },
      },
    ]);
  });
});

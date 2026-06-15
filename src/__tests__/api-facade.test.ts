import { describe, it, expect } from 'vitest';
import { ApiFacadeImpl } from '../core/api/facade.js';
import type { ApiFacade } from '../core/api/types.js';

describe('ApiFacadeImpl', () => {
  it('exposes all required methods', () => {
    const facade = new ApiFacadeImpl();
    const methods: (keyof ApiFacade)[] = [
      'listSessions', 'createSession', 'deleteSession',
      'listSessionEvents', 'listSessionCheckpoints', 'listToolReceipts', 'previewCheckpointResume', 'runAgent', 'resumeRun', 'subscribeRunEvents',
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
        : String(url).endsWith('/PreviewCheckpointResume')
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
        url: '/agentengine/api/v1/PreviewCheckpointResume',
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

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentChat } from '../hooks/useAgentChat.js';
import { ConversationController } from '../core/conversation/studio-controller.js';
import type { ApiFacade } from '../core/api/types.js';

const { submitDraft } = vi.hoisted(() => ({ submitDraft: vi.fn() }));
vi.mock('../hooks/useRunAgent.js', () => ({ useRunAgent: () => ({
  submitDraft, isOutboxRequestActive: () => false, stopGeneration: vi.fn(), disconnectRun: vi.fn(),
  resumeCheckpoint: vi.fn(), submitAguiAction: vi.fn(), respondToAguiApproval: vi.fn(),
}) }));

function probe(getSession: ApiFacade['getSession']) {
  const controller = new ConversationController('outbox-retry-test');
  let chat!: ReturnType<typeof useAgentChat>;
  function Probe() {
    chat = useAgentChat({ api: { getSession } as ApiFacade,
      agentId: 'default-agent', conversationController: controller, restoreSession: false });
    return null;
  }
  renderToString(createElement(Probe));
  const entry = controller.outbox.enqueue({ conversationId: chat.conversationId!,
    agentId: chat.agentId, text: 'perform this operation once', attachments: [],
    nativeSessionId: 'session-a', invocationId: 'run-a' });
  controller.outbox.update(entry.requestId, { status: 'unknown' });
  return { chat, controller, requestId: entry.requestId };
}

describe('outbox retry through the public chat controller', () => {
  beforeEach(() => { submitDraft.mockReset().mockResolvedValue(undefined); });

  it('does not resend an uncertain operation when the reconciliation query fails', async () => {
    const p = probe(vi.fn().mockRejectedValue(new Error('offline')));
    expect(await p.chat.retryOutbox(p.requestId)).toBe(false);
    expect(submitDraft).not.toHaveBeenCalled();
    expect(p.controller.outbox.get(p.requestId)?.status).toBe('unknown');
  });

  it.each([
    { SessionId: 'session-a' },
    { SessionId: 'session-a', ActiveInvocationId: 'another-run', ActiveRunStatus: 'completed' },
    { SessionId: 'another-session', ActiveInvocationId: 'run-a', ActiveRunStatus: 'completed' },
    { SessionId: 'session-a', AgentId: 'another-agent', ActiveInvocationId: 'run-a', ActiveRunStatus: 'failed' },
  ])('keeps unmatched session facts unknown: %j', async state => {
    const p = probe(vi.fn().mockResolvedValue(state));
    expect(await p.chat.retryOutbox(p.requestId)).toBe(false);
    expect(submitDraft).not.toHaveBeenCalled();
    expect(p.controller.outbox.get(p.requestId)?.status).toBe('unknown');
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'reconciles a matching %s run without starting a second operation', async status => {
      const p = probe(vi.fn().mockResolvedValue({ SessionId: 'session-a',
        ActiveInvocationId: 'run-a', ActiveRunStatus: status }));
      expect(await p.chat.retryOutbox(p.requestId)).toBe(false);
      expect(submitDraft).not.toHaveBeenCalled();
      expect(p.controller.outbox.get(p.requestId)?.status).toBe(status);
    },
  );

  it('requires a separate explicit retry after a matching failure is confirmed', async () => {
    const p = probe(vi.fn().mockResolvedValue({ SessionId: 'session-a',
      ActiveInvocationId: 'run-a', ActiveRunStatus: 'failed' }));
    await p.chat.retryOutbox(p.requestId);
    expect(submitDraft).not.toHaveBeenCalled();
    expect(await p.chat.retryOutbox(p.requestId)).toBe(true);
    expect(submitDraft).toHaveBeenCalledTimes(1);
    expect(submitDraft.mock.calls[0].at(-1)).toBe(p.requestId);
  });

  it('keeps unknown creation outcomes blocked when no native identity was received', async () => {
    const getSession = vi.fn();
    const p = probe(getSession);
    p.controller.outbox.update(p.requestId, { nativeSessionId: undefined });
    expect(await p.chat.retryOutbox(p.requestId)).toBe(false);
    expect(submitDraft).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('does not need attachment bytes to query an unknown delivery', async () => {
    const getSession = vi.fn().mockResolvedValue({ SessionId: 'session-a',
      ActiveInvocationId: 'run-a', ActiveRunStatus: 'completed' });
    const p = probe(getSession);
    p.controller.outbox.get(p.requestId)!.attachments.push({ name: 'file.txt', type: 'text/plain', size: 5 });
    expect(await p.chat.retryOutbox(p.requestId)).toBe(false);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(p.controller.outbox.get(p.requestId)?.status).toBe('completed');
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it('coalesces concurrent queries and preserves a newer authoritative settlement', async () => {
    let resolve!: (state: Awaited<ReturnType<ApiFacade['getSession']>>) => void;
    const getSession = vi.fn(() => new Promise<Awaited<ReturnType<ApiFacade['getSession']>>>(done => { resolve = done; }));
    const p = probe(getSession);
    const first = p.chat.retryOutbox(p.requestId);
    expect(await p.chat.retryOutbox(p.requestId)).toBe(false);
    p.controller.outbox.update(p.requestId, { status: 'completed' });
    resolve({ SessionId: 'session-a', ActiveInvocationId: 'run-a', ActiveRunStatus: 'failed' });
    expect(await first).toBe(false);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(p.controller.outbox.get(p.requestId)?.status).toBe('completed');
    expect(submitDraft).not.toHaveBeenCalled();
  });

  it('only retries restored pending work once while its submit is awaiting acceptance', async () => {
    let resolve!: () => void;
    submitDraft.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const p = probe(vi.fn());
    p.controller.outbox.update(p.requestId, { status: 'pending' });
    const first = p.chat.retryOutbox(p.requestId);
    expect(await p.chat.retryOutbox(p.requestId)).toBe(false);
    expect(submitDraft).toHaveBeenCalledTimes(1);
    resolve();
    expect(await first).toBe(true);
  });
});

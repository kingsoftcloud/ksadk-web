import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFeedback } from '../hooks/useFeedback.js';
import { useMessageStore } from '../stores/message.js';
import { useSessionStore } from '../stores/session.js';
import type { Message } from '../components/chat/types.js';
import type { ApiFacade } from '../core/api/types.js';
import type { ToolBlock } from '../core/run/blocks.js';

const approvalBlock: ToolBlock = {
  id: 'tool-1',
  type: 'tool',
  toolName: 'shell',
  args: '{}',
  status: 'paused',
  extra: { approvalRequestId: 'approval-1', approvalStatus: 'pending' },
};

const approvalMessage: Message = {
  id: 'message-1',
  role: 'model',
  content: '',
  timestamp: 1,
  tools: {
    shell: {
      name: 'shell',
      args: '{}',
      status: 'paused',
      approvalRequestId: 'approval-1',
      approvalStatus: 'pending',
    },
  },
  blocks: [approvalBlock],
};

function probe(options: {
  isStreaming: boolean;
  submitDraft: Parameters<typeof useFeedback>[0]['submitDraft'];
}) {
  let actions!: ReturnType<typeof useFeedback>;
  function Probe() {
    actions = useFeedback({
      agentId: 'agent-1',
      currentSessionId: 'session-1',
      isStreaming: options.isStreaming,
      api: {} as ApiFacade,
      submitDraft: options.submitDraft,
    });
    return null;
  }
  renderToString(createElement(Probe));
  return actions;
}

describe('legacy approval dispatch result', () => {
  beforeEach(() => {
    useSessionStore.getState().setCurrentSessionId('session-1');
    useMessageStore.getState().setMessages([approvalMessage]);
  });

  it('returns false and leaves the approval untouched while streaming', async () => {
    const submitDraft = vi.fn().mockResolvedValue(true);
    const actions = probe({ isStreaming: true, submitDraft });

    await expect(actions.respondToApproval({
      approvalRequestId: 'approval-1',
      approve: true,
    })).resolves.toBe(false);
    expect(submitDraft).not.toHaveBeenCalled();
    expect(useMessageStore.getState().messages[0].tools?.shell.approvalStatus).toBe('pending');
  });

  it('does not patch the transcript when the resume launch is rejected', async () => {
    const submitDraft = vi.fn().mockResolvedValue(false);
    const actions = probe({ isStreaming: false, submitDraft });

    await expect(actions.respondToApproval({
      approvalRequestId: 'approval-1',
      approve: false,
    })).resolves.toBe(false);
    expect(submitDraft).toHaveBeenCalledOnce();
    expect(useMessageStore.getState().messages[0].tools?.shell.approvalStatus).toBe('pending');
  });

  it('patches the transcript only after the resume launch is accepted', async () => {
    const submitDraft = vi.fn().mockResolvedValue(true);
    const actions = probe({ isStreaming: false, submitDraft });

    await expect(actions.respondToApproval({
      approvalRequestId: 'approval-1',
      approve: true,
    })).resolves.toBe(true);
    expect(useMessageStore.getState().messages[0].tools?.shell).toMatchObject({
      approvalStatus: 'approved',
      status: 'running',
    });
  });

  it('does not patch another session with the same approval ID after delayed acceptance', async () => {
    let finish!: (accepted: boolean) => void;
    const actions = probe({ isStreaming: false,
      submitDraft: () => new Promise<boolean>(resolve => { finish = resolve; }) });
    const responding = actions.respondToApproval({ approvalRequestId: 'approval-1', approve: true });
    useSessionStore.getState().setCurrentSessionId('session-2');
    const otherMessage = { ...approvalMessage, id: 'other-message' };
    useMessageStore.getState().setMessages([otherMessage]);
    finish(true);
    await expect(responding).resolves.toBe(true);
    expect(useMessageStore.getState().messages).toEqual([otherMessage]);
  });

  it.each([
    { decision: 'approved', approve: false, status: 'running' },
    { decision: 'approved', approve: false, status: 'completed' },
    { decision: 'approved', approve: false, status: 'error' },
    { decision: 'rejected', approve: true, status: 'completed' },
    { decision: 'cancelled', approve: true, status: 'completed' },
    { decision: 'cancelled', approve: false, status: 'completed' },
  ] as const)('preserves server $decision/$status during an async submit (approve=$approve)', async ({ decision, approve, status }) => {
    let finish!: (accepted: boolean) => void;
    const submitDraft = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const actions = probe({ isStreaming: false, submitDraft });

    const responding = actions.respondToApproval({
      approvalRequestId: 'approval-1',
      approve,
    });
    expect(submitDraft).toHaveBeenCalledOnce();
    expect(useMessageStore.getState().messages[0]).toEqual(approvalMessage);

    const resolvedMessage: Message = {
      ...approvalMessage,
      tools: {
        shell: { ...approvalMessage.tools!.shell, status, approvalStatus: decision },
      },
      blocks: [{
        ...approvalBlock,
        status,
        extra: { ...approvalBlock.extra, approvalStatus: decision },
      }],
    };
    useMessageStore.getState().setMessages([resolvedMessage]);
    finish(true);

    await expect(responding).resolves.toBe(true);
    expect(useMessageStore.getState().messages[0]).toEqual(resolvedMessage);
  });

  it.each([true, false])('still patches legacy approvals without a status (approve=%s)', async (approve) => {
    const legacyMessage: Message = {
      ...approvalMessage,
      tools: {
        shell: { ...approvalMessage.tools!.shell, approvalStatus: undefined },
      },
      blocks: [{
        ...approvalBlock,
        extra: { ...approvalBlock.extra, approvalStatus: undefined },
      }],
    };
    useMessageStore.getState().setMessages([legacyMessage]);
    const submitDraft = vi.fn().mockResolvedValue(true);
    const actions = probe({ isStreaming: false, submitDraft });

    await expect(actions.respondToApproval({
      approvalRequestId: 'approval-1',
      approve,
      previousResponseId: 'response-1',
    })).resolves.toBe(true);
    expect(submitDraft).toHaveBeenCalledWith('', [], [{
      type: 'mcp_approval_response',
      approval_request_id: 'approval-1',
      approve,
    }], 'response-1');
    const expected = {
      approvalStatus: approve ? 'approved' : 'rejected',
      status: approve ? 'running' : 'completed',
    };
    expect(useMessageStore.getState().messages[0].tools?.shell).toMatchObject(expected);
    expect(useMessageStore.getState().messages[0].blocks?.[0]).toMatchObject({
      status: expected.status,
      extra: { approvalStatus: expected.approvalStatus },
    });
  });

  it.each(['tool', 'block'] as const)('guards each projection independently when only the %s is terminal', async (terminal) => {
    const message: Message = {
      ...approvalMessage,
      tools: {
        shell: {
          ...approvalMessage.tools!.shell,
          ...(terminal === 'tool' ? { status: 'completed', approvalStatus: 'cancelled' } as const : {}),
        },
        other: { ...approvalMessage.tools!.shell, approvalRequestId: 'approval-2' },
      },
      blocks: [
        terminal === 'block'
          ? { ...approvalBlock, status: 'completed', extra: { ...approvalBlock.extra, approvalStatus: 'cancelled' } }
          : approvalBlock,
        { ...approvalBlock, id: 'tool-2', extra: { approvalRequestId: 'approval-2', approvalStatus: 'pending' } },
      ],
    };
    useMessageStore.getState().setMessages([message]);
    const actions = probe({ isStreaming: false, submitDraft: vi.fn().mockResolvedValue(true) });

    await expect(actions.respondToApproval({
      approvalRequestId: 'approval-1',
      approve: true,
    })).resolves.toBe(true);

    const updated = useMessageStore.getState().messages[0];
    expect(updated.tools?.shell).toMatchObject({
      approvalStatus: terminal === 'tool' ? 'cancelled' : 'approved',
      status: terminal === 'tool' ? 'completed' : 'running',
    });
    expect(updated.blocks?.[0]).toMatchObject({
      extra: { approvalStatus: terminal === 'block' ? 'cancelled' : 'approved' },
      status: terminal === 'block' ? 'completed' : 'running',
    });
    expect(updated.tools?.other).toBe(message.tools?.other);
    expect(updated.blocks?.[1]).toBe(message.blocks?.[1]);
  });
});

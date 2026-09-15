import { describe, expect, it, vi } from 'vitest';
import { ApiSessionFacade } from './session-facade.js';
import { ConversationController } from './studio-controller.js';

function fakeApi() {
  return {
    listSessions: vi.fn(async () => ({ Sessions: [{ SessionId: 'ses_1', Title: 'A' }], Total: 1 })),
    listSessionMessages: vi.fn(async () => ({ Messages: [{ id: 'item_1' }], LatestSeqId: 1, HasMore: false })),
    getSession: vi.fn(async () => ({ SessionId: 'ses_1', Title: 'A', ActiveRunStatus: 'completed' })),
    createSession: vi.fn(async () => ({ SessionId: 'ses_new' })),
    runAgent: vi.fn(async () => new ReadableStream<Uint8Array>()),
    cancelRun: vi.fn(async () => ({ status: 'accepted' })),
    submitInteraction: vi.fn(async () => ({ status: 'accepted', command_id: 'cmd_1' })),
  } as any;
}

describe('ApiSessionFacade', () => {
  it('separates read queries from explicit execution binding', async () => {
    const api = fakeApi();
    const facade = new ApiSessionFacade(api, { agentId: 'agent-a', targetId: 'local' });
    await expect(facade.listSessionSummaries()).resolves.toMatchObject({ total: 1, items: [{ sessionId: 'ses_1' }] });
    const controller = new ConversationController();
    const id = controller.getOrCreate('agent-a', null, 'local');
    const binding = await facade.ensureExecutionBinding(id);
    expect(api.createSession).toHaveBeenCalledTimes(1);
    await facade.submit(binding, { text: 'hello', clientRequestId: 'req_1', idempotencyKey: 'idem_1' });
    expect(api.runAgent).toHaveBeenCalledWith(expect.objectContaining({ SessionId: 'ses_new', InvocationId: 'req_1', IdempotencyKey: 'idem_1' }), {});
  });

  it('requires a binding for commands and preserves approval identity', async () => {
    const facade = new ApiSessionFacade(fakeApi(), { agentId: 'agent-a' });
    const binding = { conversationId: 'conversation_x' as any, agentId: 'agent-a' };
    await expect(facade.interrupt(binding, 'run_1')).rejects.toThrow('binding');
    const api = fakeApi();
    const ready = new ApiSessionFacade(api, { agentId: 'agent-a' });
    await ready.approve({ ...binding, nativeSessionId: 'ses_1' }, { interactionId: 'i_1', runId: 'run_1', expectedRevision: 7, approve: true, idempotencyKey: 'idem_7' });
    expect(api.submitInteraction).toHaveBeenCalledWith(expect.objectContaining({ InteractionId: 'i_1', RunId: 'run_1', ExpectedRevision: 7, IdempotencyKey: 'idem_7' }), {});
  });
});

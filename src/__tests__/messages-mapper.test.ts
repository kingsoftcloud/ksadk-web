import { describe, it, expect } from 'vitest';
import { mapBackendMessage, mapBackendMessages } from '../utils/messages.js';
import type { BackendMessage } from '../api/messages.js';

describe('mapBackendMessage', () => {
  it('maps user message with attachments', () => {
    const msg: BackendMessage = {
      MessageId: 'msg-1',
      Role: 'user',
      Content: { text: 'hello' },
      SeqId: 1,
      Attachments: [
        { file_uri: 'ae-upload://f1', name: 'doc.pdf', mime: 'application/pdf', size: 123, url: '/agentengine/api/v1/AttachmentContent?FileUri=ae-upload%3A%2F%2Ff1', is_image: false },
      ],
    };
    const result = mapBackendMessage(msg);
    expect(result.role).toBe('user');
    expect(result.content).toBe('hello');
    expect(result.id).toBe('msg-1');
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toEqual({
      name: 'doc.pdf',
      url: '/agentengine/api/v1/AttachmentContent?FileUri=ae-upload%3A%2F%2Ff1',
      type: 'application/pdf',
      fileUri: 'ae-upload://f1',
    });
  });

  it('maps assistant message with reasoning and tools', () => {
    const msg: BackendMessage = {
      MessageId: 'msg-2',
      Role: 'assistant',
      Content: { parts: [{ text: 'found 3' }] },
      SeqId: 2,
      Reasoning: [{ text: 'need to search', SeqId: 1 }],
      ToolEvents: [
        { Name: 'search', Args: { q: 'foo' }, Result: { hits: 3 }, Status: 'completed', ToolCallId: 'c1' },
      ],
    };
    const result = mapBackendMessage(msg);
    expect(result.role).toBe('model'); // assistant → model
    expect(result.content).toBe('found 3');
    expect(result.reasoning).toBe('need to search');
    expect(result.tools.search).toBeDefined();
    expect(result.tools.search.name).toBe('search');
    expect(result.tools.search.args).toBe('{"q":"foo"}');
    expect(result.tools.search.output).toBe('{"hits":3}');
    expect(result.tools.search.status).toBe('completed');
  });

  it('keeps same-name tool calls distinct by ToolCallId', () => {
    const result = mapBackendMessage({
      Role: 'assistant',
      Content: { text: 'done' },
      ToolEvents: [
        { Name: 'search', ToolCallId: 'call-1', Args: { q: 'one' }, Result: 'first' },
        { Name: 'search', ToolCallId: 'call-2', Args: { q: 'two' }, Result: 'second' },
      ],
    } satisfies BackendMessage);

    expect(Object.keys(result.tools)).toEqual(['call-1', 'call-2']);
    expect(result.tools['call-1'].args).toBe('{"q":"one"}');
    expect(result.tools['call-2'].output).toBe('second');
  });

  it('maps paused approval tool event', () => {
    const msg: BackendMessage = {
      Role: 'assistant',
      Content: { text: '' },
      ToolEvents: [
        { Name: 'send_email', Status: 'paused', ApprovalRequestId: 'apr-1' },
      ],
    };
    const result = mapBackendMessage(msg);
    expect(result.tools.send_email.status).toBe('paused');
    expect(result.tools.send_email.approvalRequestId).toBe('apr-1');
    expect(result.tools.send_email.approvalStatus).toBe('pending');
    expect(result.tools.send_email.approvalProtocol).toBe('responses');
  });

  it('preserves AG-UI protocol for replayed approval events', () => {
    const msg = {
      Role: 'assistant',
      Content: { text: '' },
      ToolEvents: [
        {
          Name: 'run_command',
          Status: 'approved',
          ApprovalRequestId: 'interrupt-1',
          Protocol: 'ag-ui',
          ApprovalLevel: 'elevated',
          ApprovalMessage: '运行此高风险命令前需要确认。',
        },
      ],
    } as BackendMessage;

    const result = mapBackendMessage(msg);

    expect(result.tools.run_command.approvalStatus).toBe('approved');
    expect(result.tools.run_command.approvalProtocol).toBe('ag-ui');
    expect(result.tools.run_command.approvalLevel).toBe('elevated');
    expect(result.tools.run_command.approvalMessage).toBe('运行此高风险命令前需要确认。');
  });

  it('maps denied approval to rejected', () => {
    const msg: BackendMessage = {
      Role: 'assistant',
      Content: { text: '' },
      ToolEvents: [{ Name: 'delete', Status: 'denied', ApprovalRequestId: 'apr-2' }],
    };
    const result = mapBackendMessage(msg);
    expect(result.tools.delete.approvalStatus).toBe('rejected');
  });

  it('mapBackendMessages maps list', () => {
    const msgs = [
      { Role: 'user' as const, Content: { text: 'q' } },
      { Role: 'assistant' as const, Content: { text: 'a' } },
    ];
    const result = mapBackendMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('model');
  });

  it('rehydrates persisted A2UI operations as an activity message', () => {
    const result = mapBackendMessages([{
      MessageId: 'assistant-1',
      Role: 'assistant',
      Content: { text: '状态如下' },
      Activities: [{
        MessageId: 'run-1:a2ui:status',
        SurfaceId: 'status',
        Content: {
          a2ui_operations: [{ createSurface: { surfaceId: 'status' } }],
        },
      }],
    }]);

    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({
      role: 'a2ui',
      aguiActivity: {
        surfaceId: 'status',
        messages: [{ createSurface: { surfaceId: 'status' } }],
      },
    });
  });

  it('repairs only the legacy A2UI root id during history rehydration', () => {
    const result = mapBackendMessages([{
      MessageId: 'assistant-legacy',
      Role: 'assistant',
      Content: { text: '状态如下' },
      Activities: [{
        SurfaceId: 'status',
        Content: {
          a2ui_operations: [{
            updateComponents: {
              surfaceId: 'status',
              components: [{ id: 'status-root', component: 'Column', children: [] }],
            },
          }],
        },
      }],
    }]);

    expect(result[1].aguiActivity.messages[0].updateComponents.components[0].id).toBe('root');
  });
});

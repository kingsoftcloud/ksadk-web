import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentBlockView } from '../components/chat/AgentBlockView';
import type { ConversationItem } from '../core/conversation/types';
const item: ConversationItem = {
  apiVersion: 'conversation.ksadk.io/v1',
  kindVersion: 1,
  kind: 'agent',
  itemId: 'agent',
  sessionId: 'session',
  runId: 'run',
  parentItemId: 'trigger',
  sourceEventIds: ['event'],
  operation: 'replace',
  lifecycle: 'streaming',
  visibility: 'public',
  payloadSchemaRef: 'conversation.item.agent/v1',
  nativeRef: {},
  payload: {
    schema: 'execution.scope/v1',
    scope_id: 'child',
    parent_scope_id: 'root',
    trigger_ref: { scope_id: 'root', item_id: 'trigger', call_id: 'call' },
    binding_id: 'binding',
    agent: { name: 'Finance' },
    status: 'working',
    cancel: { capability: 'unsupported', request_state: 'none' },
  },
};
describe('AgentBlockView', () => {
  it.each([
    'submitted',
    'working',
    'input_required',
    'completed',
    'failed',
    'cancelled',
  ])('renders truthful %s status collapsed by default', (status) => {
    const html = renderToStaticMarkup(
      <AgentBlockView
        block={{
          item: { ...item, payload: { ...item.payload, status } },
          messages: [
            {
              id: 'message',
              role: 'model',
              content: 'private collapsed detail',
              timestamp: 0,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(status);
    expect(html).not.toContain('private collapsed detail');
    expect(html).not.toContain('Cancel remote agent');
  });
});

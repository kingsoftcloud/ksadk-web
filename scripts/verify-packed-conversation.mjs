import assert from 'node:assert/strict';
import {
  ConversationItemReducer,
  HttpConversationClient,
  buildConversationInput,
  decodeConversationInput,
  decodeConversationItem,
  decodeConversationSurface,
  projectConversationItems,
} from '@kingsoftcloud/ksadk-web/conversation';

assert.equal(typeof HttpConversationClient, 'function');
assert.equal(typeof ConversationItemReducer, 'function');

const input = buildConversationInput({
  inputId: 'packed-input-1',
  sessionId: 'packed-session-1',
  idempotencyKey: 'packed-turn-1',
  parts: [{ kind: 'text', text: 'hello from packed consumer' }],
  modelRef: 'packed-model',
});
assert.deepEqual(decodeConversationInput(input), input);

const surface = decodeConversationSurface({
  apiVersion: 'conversation.ksadk.io/v1',
  kind: 'ConversationSurface',
  surfaceId: 'packed-surface-1',
  sessionId: 'packed-session-1',
  providerRef: 'packed-provider-1',
  inputs: [
    { name: 'text', mode: 'native' },
    { name: 'model.select', mode: 'native' },
  ],
  outputs: [{ name: 'text', mode: 'native' }],
});
assert.equal(surface?.apiVersion, 'conversation.ksadk.io/v1');

const item = decodeConversationItem({
  apiVersion: 'conversation.ksadk.io/v1',
  kindVersion: 1,
  itemId: 'packed-item-1',
  sourceEventIds: ['packed-event-1'],
  sessionId: 'packed-session-1',
  runId: 'packed-run-1',
  kind: 'assistant_text',
  lifecycle: 'completed',
  operation: 'completed',
  visibility: 'public',
  payloadSchemaRef: 'conversation.item.assistant_text/v1',
  payload: { text: 'packed response' },
  nativeRef: {},
});
assert.ok(item);
const reducer = new ConversationItemReducer();
reducer.apply(item);
assert.equal(
  projectConversationItems(reducer.snapshot()).textItems[0]?.text,
  'packed response',
);

console.log('packed conversation public API verified');

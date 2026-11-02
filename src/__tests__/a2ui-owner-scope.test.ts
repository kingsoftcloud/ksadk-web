import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '../components/chat/types.js';
import type { ConversationItem } from '../core/conversation/types.js';
import { createConversationItemState } from '../core/conversation/reducer.js';
import { projectConversationItems } from '../core/conversation/presentation.js';
import { a2uiManifest } from '../core/a2ui/catalog.js';
import { A2uiSurfaces } from '../core/a2ui/surfaces.js';
import { coalesceA2uiActivities, sameA2uiActivityOwner } from '../core/a2ui/transcript.js';
import { mergeA2uiActivity } from '../core/a2ui/history.js';
import { dispatchRunEventToStores } from '../core/run/dispatcher.js';
import { useMessageStore } from '../stores/message.js';
import { useSessionStore } from '../stores/session.js';
import { mapBackendMessages } from '../utils/messages.js';

const surfaceId = 'dynamic-surface';
const operations = (text: string) => [
  { version: 'v0.9.1', createSurface: { surfaceId, catalogId: a2uiManifest.catalog_id } },
  { version: 'v0.9.1', updateComponents: { surfaceId, components: [{ id: 'root', component: 'Text', text }] } },
];
const activity = (text: string, interactionId?: string) => ({ surfaceId, messages: operations(text),
  ...(interactionId ? { interactionId } : {}) });
const row = (id: string, runId?: string, interactionId?: string): Message => ({
  id, role: 'model', content: '', timestamp: 1, ...(runId ? { runId } : {}),
  aguiActivities: [activity(id, interactionId)],
});
const canonical = (id: string, runId: string, interactionId?: string): ConversationItem => ({
  apiVersion: 'conversation.ksadk.io/v1', kindVersion: 1, itemId: id, sessionId: 'session',
  runId, kind: 'a2ui', operation: 'snapshot', lifecycle: 'completed', visibility: 'public',
  payloadSchemaRef: 'conversation.item.a2ui/v1', sourceEventIds: [id], nativeRef: {},
  payload: { surfaceId, data: operations(id), ...(interactionId ? { interactionId } : {}) },
});

afterEach(() => {
  useMessageStore.getState().setMessages([]);
  useSessionStore.setState({ currentSessionId: null });
});

describe('A2UI activity ownership', () => {
  it.each([false, true])('keeps the static default surface independent in two runs, bound=%s', bound => {
    const input = [row('first', 'run-one', bound ? 'wait-one' : undefined), row('second', 'run-two', bound ? 'wait-two' : undefined)];
    const result = coalesceA2uiActivities(input);
    expect(result).toBe(input);
    expect(result.map(message => message.aguiActivities?.[0].messages)).toEqual(input.map(message => message.aguiActivities?.[0].messages));
    for (const message of result) {
      const model = new A2uiSurfaces(() => {});
      try { expect(() => model.apply(message.aguiActivities![0].messages)).not.toThrow(); }
      finally { model.dispose(); }
    }
  });

  it('preserves distinct interaction generations in the same logical run', () => {
    const input = [row('first', 'original', 'wait-one'), row('second', 'original', 'wait-two')];
    expect(coalesceA2uiActivities(input)).toBe(input);
  });

  it('promotes a tool card to its wait and merges replay across wire attempts once', () => {
    const tool = row('tool', 'original');
    const bound = { ...row('pending', 'original', 'wait'), aguiActivities: [{ ...activity('tool', 'wait'), batchIds: ['batch'] }] };
    const resumed = { ...bound, id: 'resumed-wire', runId: 'wire-attempt' };
    const result = coalesceA2uiActivities([tool, bound, resumed]);
    expect(result.flatMap(message => message.aguiActivities || [])).toHaveLength(1);
    expect(result[0].aguiActivities![0]).toMatchObject({ runId: 'original', interactionId: 'wait', messages: operations('tool') });
    expect(tool.aguiActivities![0].interactionId).toBeUndefined();
  });

  it('does not guess a cross-message owner when legacy run identity is missing', () => {
    const input = [row('unknown'), row('known', 'run-one'), row('another', 'run-two')];
    expect(coalesceA2uiActivities(input)).toBe(input);
  });

  it('retains backend activity run identity while coalescing only copies from that run', () => {
    const rows = ['run-one', 'run-one', 'run-two'].map((runId, index) => ({
      MessageId: `message-${index}`, Role: 'model', Content: { text: 'reply' }, InvocationId: runId,
      Activities: [{ SurfaceId: surfaceId, Content: { a2ui_operations: operations(runId) } }],
    }));
    const cards = mapBackendMessages(rows).filter((message: Message) => message.aguiActivity);
    expect(cards).toHaveLength(2);
    expect(cards.map((message: Message) => message.invocationId)).toEqual(['run-one', 'run-two']);
  });

  it('keeps canonical timeline projection scoped to runs and interaction generations', () => {
    const state = { ...createConversationItemState(), items: [
      canonical('first', 'run-one', 'wait-one'), canonical('second', 'run-two', 'wait-two'),
      canonical('third', 'run-two', 'wait-three'),
    ] };
    const projected = projectConversationItems(state);
    expect(projected.timeline.map(entry => entry.item.itemId)).toEqual(['first', 'second', 'third']);
    expect(new Set(projected.timeline.map(entry => entry.key)).size).toBe(3);
    const promoted = projectConversationItems({ ...createConversationItemState(), items: [
      canonical('tool', 'same-run'), canonical('wait', 'same-run', 'wait-id'),
    ] });
    expect(promoted.timeline).toHaveLength(1);
    expect(promoted.timeline[0].item.payload.interactionId).toBe('wait-id');
  });

  it('isolates live cards, dedupes replay and supports a resumed message with the same wait', () => {
    useSessionStore.setState({ currentSessionId: 'session' });
    useMessageStore.getState().setMessages([
      { id: 'first', role: 'model', content: '', timestamp: 1, invocationId: 'run-one' },
      { id: 'second', role: 'model', content: '', timestamp: 2, invocationId: 'run-two' },
    ]);
    for (const [id, runId, interactionId] of [['first', 'run-one', 'wait-one'], ['second', 'run-two', 'wait-two']]) {
      const event = { type: 'agui_activity' as const, messageId: id, runId, surfaceId,
        interactionId, batchId: interactionId, messages: operations(id), sessionId: 'session' };
      dispatchRunEventToStores(event);
      dispatchRunEventToStores(event);
    }
    dispatchRunEventToStores({ type: 'agui_activity', messageId: 'new-wire-message', runId: 'run-two', surfaceId,
      interactionId: 'wait-two', batchId: 'wait-two', messages: operations('second'), sessionId: 'session' });
    dispatchRunEventToStores({ type: 'agui_activity', messageId: 'first', surfaceId,
      interactionId: 'wait-one', messages: [{ version: 'v0.9.1', updateDataModel: {
        surfaceId, path: '/', value: { answer: false },
      } }], sessionId: 'session' });
    dispatchRunEventToStores({ type: 'agui_activity', messageId: 'first', runId: 'run-one', surfaceId,
      interactionId: 'wait-one', batchId: 'wait-one', messages: operations('first'), sessionId: 'session' });
    const messages = useMessageStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.map(message => message.aguiActivities?.[0].interactionId)).toEqual(['wait-one', 'wait-two']);
    expect(messages.map(message => message.aguiActivities?.length)).toEqual([1, 1]);
    expect(messages[1].aguiActivities![0].messages).toEqual(operations('second'));
    expect(messages[0].aguiActivities![0].messages).toHaveLength(3);
    expect(messages[0].aguiActivities![0].batchIds).toEqual(['wait-one']);
  });

  it('scopes standalone cards before assistant text arrives and accepts legacy updates on their own message', () => {
    useSessionStore.setState({ currentSessionId: 'session' });
    for (const runId of ['run-one', 'run-two']) dispatchRunEventToStores({ type: 'agui_activity',
      runId, messageId: `${runId}:assistant`, surfaceId, messages: operations(runId), sessionId: 'session' });
    expect(useMessageStore.getState().messages).toHaveLength(2);
    const [first, second] = useMessageStore.getState().messages;
    expect(first.id).not.toBe(second.id);
    useMessageStore.getState().setMessages([row('legacy', 'original')]);
    dispatchRunEventToStores({ type: 'agui_activity', messageId: 'legacy', surfaceId,
      messages: operations('legacy'), sessionId: 'session' });
    expect(useMessageStore.getState().messages[0].aguiActivities).toHaveLength(1);
  });

  it('retains the known source message when a legacy card arrives before assistant text', () => {
    useSessionStore.setState({ currentSessionId: 'session' });
    const first = { type: 'agui_activity' as const, messageId: 'legacy-assistant', surfaceId,
      messages: operations('first'), sessionId: 'session' };
    dispatchRunEventToStores(first);
    dispatchRunEventToStores({ type: 'assistant_message_created', messageId: first.messageId, sessionId: 'session' });
    const update = { version: 'v0.9.1', updateDataModel: { surfaceId, path: '/', value: { answer: 'next' } } };
    dispatchRunEventToStores({ ...first, messages: [update] });
    const cards = useMessageStore.getState().messages.flatMap(message => [
      ...(message.aguiActivity ? [message.aguiActivity] : []), ...(message.aguiActivities || []),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].messages).toEqual([...first.messages, update]);
    const renderer = new A2uiSurfaces(() => {});
    try { expect(() => renderer.apply(cards[0].messages)).not.toThrow(); }
    finally { renderer.dispose(); }
  });

  it('promotes identity on a repeated batch and preserves it on unbound incremental updates', () => {
    const tool = { ...activity('first'), runId: 'original', batchIds: ['batch'] };
    const pending = mergeA2uiActivity(tool, { ...tool, interactionId: 'wait-one' }, 'batch');
    expect(pending.interactionId).toBe('wait-one');
    expect(pending.messages).toBe(tool.messages);
    const updated = mergeA2uiActivity(pending, { surfaceId, runId: 'original', messages: [
      { version: 'v0.9.1', updateDataModel: { surfaceId, path: '/', value: { answer: 0 } } },
    ] }, 'update');
    expect(updated.interactionId).toBe('wait-one');
    expect(updated.messages).toHaveLength(3);
    expect(sameA2uiActivityOwner(
      { message: { id: 'first' }, activity: updated },
      { message: { id: 'second', runId: 'original' }, activity: activity('second', 'wait-two') },
    )).toBe(false);
  });
});

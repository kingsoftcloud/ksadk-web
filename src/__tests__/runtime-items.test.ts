import { describe, expect, it } from 'vitest';

import {
  RuntimeItemReducer,
  legacyAssistantIdentity,
  projectRuntimeItems,
  responsesEventToItemOperations,
  sessionEventToItemOperation,
  type RuntimeItemOperation,
} from '../core/stream/runtime-items.js';

const RUN = 'run-1';
const SCOPE = 'scope-1';

function start(itemId: string, scopeId = SCOPE): RuntimeItemOperation {
  return {
    type: 'item_started',
    runId: RUN,
    scopeId,
    itemId,
    itemKind: 'message',
    phase: 'final_answer',
  };
}

function append(itemId: string, text: string, scopeId = SCOPE): RuntimeItemOperation {
  return {
    type: 'item_updated',
    runId: RUN,
    scopeId,
    itemId,
    partId: 'text-0',
    op: 'append',
    part: { partId: 'text-0', contentType: 'text', text },
  };
}

function replace(itemId: string, text: string, scopeId = SCOPE): RuntimeItemOperation {
  return {
    type: 'item_snapshot_replaced',
    runId: RUN,
    scopeId,
    itemId,
    parts: [{ partId: 'text-0', contentType: 'text', text }],
  };
}

function complete(itemId: string, text: string, scopeId = SCOPE): RuntimeItemOperation {
  return {
    type: 'item_completed',
    runId: RUN,
    scopeId,
    itemId,
    parts: [{ partId: 'text-0', contentType: 'text', text }],
  };
}

function twoCompletedItems(text: string): RuntimeItemReducer {
  const reducer = new RuntimeItemReducer();
  reducer.apply(start('item-1'));
  reducer.apply(complete('item-1', text));
  reducer.apply(start('item-2'));
  reducer.apply(complete('item-2', text));
  return reducer;
}

function project(reducer: RuntimeItemReducer) {
  return projectRuntimeItems(reducer.snapshot());
}

describe('RuntimeItemReducer', () => {
  it('replaces a completed snapshot without appending it twice', () => {
    const reducer = new RuntimeItemReducer();
    reducer.apply(start('item-1'));
    reducer.apply(append('item-1', 'hel'));
    reducer.apply(complete('item-1', 'hello'));
    expect(reducer.snapshot().items[0].parts[0].text).toBe('hello');
  });

  it('preserves identical text from distinct item ids', () => {
    expect(project(twoCompletedItems('same')).map((item) => item.text)).toEqual(['same', 'same']);
  });

  it('appends deltas onto the same part by identity', () => {
    const reducer = new RuntimeItemReducer();
    reducer.apply(start('item-1'));
    reducer.apply(append('item-1', 'he'));
    reducer.apply(append('item-1', 'llo'));
    expect(reducer.snapshot().items[0].parts[0].text).toBe('hello');
  });

  it('replaces a streaming snapshot instead of merging text', () => {
    const reducer = new RuntimeItemReducer();
    reducer.apply(start('item-1'));
    reducer.apply(append('item-1', 'hel'));
    reducer.apply(replace('item-1', 'hello w'));
    reducer.apply(replace('item-1', 'hello world'));
    expect(reducer.snapshot().items[0].parts[0].text).toBe('hello world');
  });

  it('treats a repeated event id as an idempotent replay no-op', () => {
    const reducer = new RuntimeItemReducer();
    const delta: RuntimeItemOperation = { ...append('item-1', 'hel'), eventId: 'evt-1', seq: 1 };
    reducer.apply(start('item-1'));
    reducer.apply(delta);
    reducer.apply(delta);
    reducer.apply({ ...append('item-1', 'lo'), eventId: 'evt-2', seq: 2 });
    expect(reducer.snapshot().items[0].parts[0].text).toBe('hello');
  });

  it('keeps interleaved subagent scopes independent', () => {
    const reducer = new RuntimeItemReducer();
    reducer.apply(start('item-a', 'scope-a'));
    reducer.apply(start('item-b', 'scope-b'));
    reducer.apply(append('item-a', 'A1', 'scope-a'));
    reducer.apply(append('item-b', 'B1', 'scope-b'));
    reducer.apply(append('item-a', 'A2', 'scope-a'));
    reducer.apply(complete('item-b', 'B1-done', 'scope-b'));
    const snapshot = reducer.snapshot();
    const itemA = snapshot.items.find((item) => item.itemId === 'item-a');
    const itemB = snapshot.items.find((item) => item.itemId === 'item-b');
    expect(itemA?.parts[0].text).toBe('A1A2');
    expect(itemA?.status).toBe('open');
    expect(itemB?.parts[0].text).toBe('B1-done');
    expect(itemB?.status).toBe('completed');
  });

  it('rebuilds the same projection on refresh replay and cursor reconnect', () => {
    const log: RuntimeItemOperation[] = [
      { type: 'run_started', runId: RUN, eventId: 'e0', seq: 0 },
      { ...start('item-1'), eventId: 'e1', seq: 1 },
      { ...append('item-1', 'hel'), eventId: 'e2', seq: 2 },
      { ...append('item-1', 'lo'), eventId: 'e3', seq: 3 },
      { ...complete('item-1', 'hello'), eventId: 'e4', seq: 4 },
      { type: 'run_completed', runId: RUN, eventId: 'e5', seq: 5 },
    ];
    const live = new RuntimeItemReducer();
    live.applyAll(log);

    // Refresh replay: a brand new reducer over the full log.
    const replayed = new RuntimeItemReducer();
    replayed.applyAll(log);

    // Cursor reconnect: re-applying the tail to the live reducer is a no-op.
    live.applyAll(log.slice(2));

    expect(replayed.snapshot()).toEqual(live.snapshot());
    expect(live.snapshot().items[0].parts[0].text).toBe('hello');
    expect(live.snapshot().status).toBe('completed');
  });
});

describe('sessionEventToItemOperation', () => {
  it('maps canonical Metadata.RuntimeItem assistant_message to a completed item', () => {
    const operation = sessionEventToItemOperation({
      EventType: 'assistant_message',
      InvocationId: 'inv-1',
      EventId: 'evt-assistant',
      Content: { parts: [{ text: '最终答案' }] },
      Metadata: {
        RuntimeItem: {
          RunId: 'run-9',
          ScopeId: 'scope-9',
          ItemId: 'item-9',
          PartId: 'text-0',
          Operation: 'replace',
          SourceEventId: 'native-1',
        },
      },
    });
    expect(operation).toMatchObject({
      type: 'item_completed',
      runId: 'run-9',
      scopeId: 'scope-9',
      itemId: 'item-9',
      eventId: 'native-1',
    });
  });

  it('maps canonical deltas to append/replace by Operation without touching text', () => {
    const base = {
      InvocationId: 'inv-1',
      Content: { parts: [{ text: 'chunk' }] },
      Metadata: {
        RuntimeItem: {
          RunId: 'run-9',
          ScopeId: 'scope-9',
          ItemId: 'item-9',
          PartId: 'text-0',
          SourceEventId: 'native-2',
        },
      },
    };
    const appended = sessionEventToItemOperation({
      ...base,
      EventType: 'assistant_stream_delta',
      Metadata: { RuntimeItem: { ...base.Metadata.RuntimeItem, Operation: 'append' } },
    });
    expect(appended).toMatchObject({ type: 'item_updated', op: 'append' });

    const replaced = sessionEventToItemOperation({
      ...base,
      EventType: 'assistant_stream_delta',
      Metadata: { RuntimeItem: { ...base.Metadata.RuntimeItem, Operation: 'replace' } },
    });
    expect(replaced).toMatchObject({ type: 'item_updated', op: 'replace' });
  });

  it('maps legacy assistant_stream_snapshot to a replace on the synthesized identity', () => {
    const operation = sessionEventToItemOperation({
      EventType: 'assistant_stream_snapshot',
      InvocationId: 'inv-1',
      EventId: 'evt-snap',
      Content: { parts: [{ text: 'partial' }] },
    });
    expect(operation).toMatchObject({
      type: 'item_snapshot_replaced',
      scopeId: 'inv-1',
      itemId: 'inv-1:legacy-assistant',
    });
  });

  it('maps legacy assistant_message to a complete on the synthesized identity', () => {
    const operation = sessionEventToItemOperation({
      EventType: 'assistant_message',
      InvocationId: 'inv-1',
      EventId: 'evt-final',
      Content: { parts: [{ text: 'done' }] },
    });
    expect(operation).toMatchObject({
      type: 'item_completed',
      scopeId: 'inv-1',
      itemId: 'inv-1:legacy-assistant',
    });
  });

  it('reduces a legacy snapshot-then-final run to one assistant item', () => {
    const reducer = new RuntimeItemReducer();
    const events = [
      {
        EventType: 'assistant_stream_snapshot',
        InvocationId: 'inv-1',
        EventId: 'e1',
        Content: { parts: [{ text: 'hel' }] },
      },
      {
        EventType: 'assistant_stream_snapshot',
        InvocationId: 'inv-1',
        EventId: 'e2',
        Content: { parts: [{ text: 'hello' }] },
      },
      {
        EventType: 'assistant_message',
        InvocationId: 'inv-1',
        EventId: 'e3',
        Content: { parts: [{ text: 'hello' }] },
      },
    ];
    for (const event of events) {
      const operation = sessionEventToItemOperation(event);
      if (operation) reducer.apply(operation);
    }
    const snapshot = reducer.snapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].parts[0].text).toBe('hello');
    expect(snapshot.items[0].status).toBe('completed');
  });

  it('synthesizes the legacy identity from the invocation id only', () => {
    expect(legacyAssistantIdentity('inv-1')).toEqual({
      scopeId: 'inv-1',
      itemId: 'inv-1:legacy-assistant',
    });
  });
});

describe('responsesEventToItemOperations', () => {
  it('keys a Responses message item by its output item id', () => {
    const operations = [
      ...responsesEventToItemOperations(
        'response.output_item.added',
        { item: { id: 'msg_1', type: 'message' } },
        RUN,
        SCOPE,
      ),
      ...responsesEventToItemOperations(
        'response.output_text.delta',
        { item_id: 'msg_1', delta: 'hel' },
        RUN,
        SCOPE,
      ),
      ...responsesEventToItemOperations(
        'response.output_item.done',
        { item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'hello' }] } },
        RUN,
        SCOPE,
      ),
    ];
    const reducer = new RuntimeItemReducer();
    reducer.applyAll(operations);
    const snapshot = reducer.snapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].itemId).toBe('msg_1');
    expect(snapshot.items[0].parts[0].text).toBe('hello');
    expect(snapshot.items[0].status).toBe('completed');
  });

  it('keeps two Responses output items with identical text distinct', () => {
    const reducer = new RuntimeItemReducer();
    for (const itemId of ['msg_1', 'msg_2']) {
      reducer.applyAll(
        responsesEventToItemOperations(
          'response.output_item.added',
          { item: { id: itemId, type: 'message' } },
          RUN,
          SCOPE,
        ),
      );
      reducer.applyAll(
        responsesEventToItemOperations(
          'response.output_item.done',
          { item: { id: itemId, type: 'message', content: [{ type: 'output_text', text: 'same' }] } },
          RUN,
          SCOPE,
        ),
      );
    }
    const snapshot = reducer.snapshot();
    expect(snapshot.items.map((item) => item.itemId)).toEqual(['msg_1', 'msg_2']);
    expect(projectRuntimeItems(snapshot).map((item) => item.text)).toEqual(['same', 'same']);
  });
});

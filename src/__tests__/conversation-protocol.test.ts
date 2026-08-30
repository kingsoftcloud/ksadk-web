import { describe, expect, it } from 'vitest';

import {
  ConversationItemReducer,
  createConversationItemState,
  decodeConversationItem,
  decodeConversationSurface,
  projectConversationItems,
  reduceConversationItem,
  surfacePermitsInput,
  type ConversationItem,
} from '../core/conversation/index.js';

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'conversation.ksadk.io/v1',
    kindVersion: 1,
    itemId: 'item-1',
    sourceEventIds: ['event-1'],
    sessionId: 'session-1',
    runId: 'run-1',
    kind: 'assistant_text',
    operation: 'append',
    lifecycle: 'streaming',
    visibility: 'public',
    payloadSchemaRef: 'conversation.item.assistant_text/v1',
    payload: { text: 'same text' },
    nativeRef: {},
    ...overrides,
  };
}

function decodedItem(overrides: Record<string, unknown> = {}): ConversationItem {
  const decoded = decodeConversationItem(item(overrides));
  if (!decoded) throw new Error('test fixture did not decode');
  return decoded;
}

describe('ConversationSurface/v1', () => {
  it('decodes the frozen fixture shape and never guesses unavailable inputs', () => {
    const surface = decodeConversationSurface({
      apiVersion: 'conversation.ksadk.io/v1',
      kind: 'ConversationSurface',
      surfaceId: 'studio.conversation',
      sessionId: 'session-example',
      providerRef: 'runtime:codex',
      inputs: [
        { name: 'text', mode: 'native' },
        { name: 'attachment.image', mode: 'translated' },
        { name: 'goal', mode: 'unavailable', reason: 'not supported' },
      ],
      outputs: [{ name: 'text', mode: 'native' }],
    });

    expect(surface).not.toBeNull();
    expect(surfacePermitsInput(surface!, 'text')).toBe(true);
    expect(surfacePermitsInput(surface!, 'attachment.image', 'attachment.file')).toBe(true);
    expect(surfacePermitsInput(surface!, 'goal')).toBe(false);
    expect(surfacePermitsInput(surface!, 'plan')).toBe(false);
  });

  it('applies contract defaults but rejects duplicate or dishonest capabilities', () => {
    const minimal = {
      apiVersion: 'conversation.ksadk.io/v1',
      kind: 'ConversationSurface',
      surfaceId: 'surface-1',
      sessionId: 'session-1',
      providerRef: 'provider-1',
    };
    expect(decodeConversationSurface(minimal)).toMatchObject({ inputs: [], outputs: [] });
    expect(decodeConversationSurface({
      ...minimal,
      inputs: [{ name: 'text', mode: 'native' }, { name: 'text', mode: 'translated' }],
    })).toBeNull();
    expect(decodeConversationSurface({
      ...minimal,
      inputs: [{ name: 'goal', mode: 'unavailable' }],
    })).toBeNull();
    expect(decodeConversationSurface({
      ...minimal,
      inputs: [{ name: 'Not Namespaced', mode: 'native' }],
    })).toBeNull();
  });
});

describe('ConversationItem/v1 identity reducer', () => {
  it('preserves equal text from distinct items and ignores reconnect replay', () => {
    const first = decodedItem();
    const second = decodedItem({ itemId: 'item-2', sourceEventIds: ['event-2'] });
    let state = createConversationItemState();
    state = reduceConversationItem(state, first);
    const afterFirst = state;
    state = reduceConversationItem(state, first);
    expect(state).toBe(afterFirst);
    state = reduceConversationItem(state, second);

    expect(projectConversationItems(state).textItems).toEqual([
      expect.objectContaining({ id: 'item-1', text: 'same text' }),
      expect.objectContaining({ id: 'item-2', text: 'same text' }),
    ]);
  });

  it('merges a new delta by item identity and source event identity', () => {
    const reducer = new ConversationItemReducer();
    expect(reducer.apply(decodedItem({ payload: { text: 'hello' } }))).toBe(true);
    expect(reducer.apply(decodedItem({ payload: { text: 'hello' } }))).toBe(false);
    expect(reducer.apply(decodedItem({
      sourceEventIds: ['event-2'],
      payload: { text: ' world' },
    }))).toBe(true);
    const presentation = projectConversationItems(reducer.snapshot());
    expect(presentation.textItems[0]?.text)
      .toBe('hello world');
    expect(presentation.output).toBe('hello world');
    expect(presentation.reasoning).toBe('');
  });

  it('keeps a terminal snapshot monotonic when an older delta reconnects late', () => {
    const completed = decodedItem({
      sourceEventIds: ['event-terminal'],
      operation: 'completed',
      lifecycle: 'completed',
      payload: { text: 'final' },
    });
    const stale = decodedItem({
      sourceEventIds: ['event-stale'],
      payload: { text: ' stale' },
    });
    let state = reduceConversationItem(createConversationItemState(), completed);
    state = reduceConversationItem(state, stale);

    expect(state.items[0]?.lifecycle).toBe('completed');
    expect(projectConversationItems(state).textItems[0]?.text).toBe('final');
    expect(state.appliedSources).toContain(JSON.stringify(['item-1', 'event-stale']));
  });

  it('does not collide when item or source identifiers contain delimiters', () => {
    const first = decodedItem({
      itemId: 'item',
      sourceEventIds: ['source\u0000tail'],
      payload: { text: 'first' },
    });
    const second = decodedItem({
      itemId: 'item\u0000source',
      sourceEventIds: ['tail'],
      payload: { text: 'second' },
    });
    let state = reduceConversationItem(createConversationItemState(), first);
    state = reduceConversationItem(state, second);

    expect(projectConversationItems(state).textItems.map((entry) => entry.text))
      .toEqual(['first', 'second']);
  });

  it('rejects structurally invalid terminal operations', () => {
    expect(decodeConversationItem(item({
      operation: 'completed',
      lifecycle: 'streaming',
    }))).toBeNull();
    expect(decodeConversationItem(item({ sourceEventIds: ['event-1', 'event-1'] })))
      .toBeNull();
  });
});

describe('ConversationItem/v1 renderer projection', () => {
  it('keeps stream order and enriches a tool call with a separate result item', () => {
    let state = createConversationItemState();
    state = reduceConversationItem(state, decodedItem({
      itemId: 'reasoning-1',
      sourceEventIds: ['reasoning-event'],
      kind: 'reasoning',
      payloadSchemaRef: 'conversation.item.reasoning/v1',
      payload: { text: 'inspect workspace' },
    }));
    state = reduceConversationItem(state, decodedItem({
      itemId: 'tool-call-item',
      sourceEventIds: ['tool-call-event'],
      kind: 'tool_call',
      payloadSchemaRef: 'conversation.item.tool-call/v1',
      payload: { callId: 'call-1', tool: 'shell', args: { command: 'pwd' } },
    }));
    state = reduceConversationItem(state, decodedItem({
      itemId: 'tool-result-item',
      sourceEventIds: ['tool-result-event'],
      kind: 'tool_call',
      operation: 'completed',
      lifecycle: 'completed',
      payloadSchemaRef: 'conversation.item.tool-call/v1',
      payload: { callId: 'call-1', output: { stdout: '/workspace' } },
    }));
    state = reduceConversationItem(state, decodedItem({
      itemId: 'answer-1',
      sourceEventIds: ['answer-event'],
      payload: { text: 'Workspace inspected.' },
    }));

    const presentation = projectConversationItems(state);
    expect(presentation.timeline.map((entry) => entry.key)).toEqual([
      'item:reasoning-1',
      'tool:call-1',
      'item:answer-1',
    ]);
    expect(presentation.timeline[1]).toMatchObject({
      sourceItemIds: ['tool-call-item', 'tool-result-item'],
      item: {
        itemId: 'tool-call-item',
        lifecycle: 'completed',
        payload: {
          tool: 'shell',
          output: { stdout: '/workspace' },
        },
      },
    });
  });

  it('degrades future kinds and payload schemas without executing their payload', () => {
    const unknownKind = decodedItem({
      itemId: 'future-kind',
      sourceEventIds: ['future-event'],
      kind: 'game_board',
      payloadSchemaRef: 'vendor.game-board/v7',
      payload: { html: '<script>bad()</script>' },
    });
    const unknownSchema = decodedItem({
      itemId: 'future-schema',
      sourceEventIds: ['future-schema-event'],
      payloadSchemaRef: 'conversation.item.assistant_text/v99',
    });
    let state = createConversationItemState();
    state = reduceConversationItem(state, unknownKind);
    state = reduceConversationItem(state, unknownSchema);
    const presentation = projectConversationItems(state);

    expect(presentation.textItems).toEqual([]);
    expect(presentation.fallbacks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'future-kind', title: 'Unsupported content' }),
      expect.objectContaining({ id: 'future-schema', title: 'Unsupported content' }),
    ]));
    expect(unknownKind.payload).not.toHaveProperty('html');
  });

  it.each([
    ['javascript:alert(1)', null],
    ['data:text/html,bad', null],
    ['file:///tmp/secret', null],
    ['https://user:secret@example.com/report', null],
    ['https://example.com/report.md', 'https://example.com/report.md'],
  ])('sanitizes artifact URI %s', (uri, expected) => {
    const artifact = decodedItem({
      kind: 'artifact',
      operation: 'completed',
      lifecycle: 'completed',
      payloadSchemaRef: 'conversation.item.artifact/v1',
      payload: { name: 'report.md', mimeType: 'text/markdown', uri },
    });
    const state = reduceConversationItem(createConversationItemState(), artifact);
    expect(projectConversationItems(state).artifacts[0]?.uri).toBe(expected);
  });

  it('omits internal and hidden items unless internal rendering is explicit', () => {
    let state = createConversationItemState();
    state = reduceConversationItem(state, decodedItem({
      itemId: 'public',
      sourceEventIds: ['public-event'],
      payload: { text: 'public' },
    }));
    state = reduceConversationItem(state, decodedItem({
      itemId: 'internal',
      sourceEventIds: ['internal-event'],
      visibility: 'internal',
      payload: { text: 'internal' },
    }));
    state = reduceConversationItem(state, decodedItem({
      itemId: 'hidden',
      sourceEventIds: ['hidden-event'],
      visibility: 'hidden',
      payload: { text: 'hidden' },
    }));

    expect(projectConversationItems(state).textItems.map((entry) => entry.text))
      .toEqual(['public']);
    expect(projectConversationItems(state, { includeInternal: true }).textItems
      .map((entry) => entry.text)).toEqual(['public', 'internal']);
  });
});

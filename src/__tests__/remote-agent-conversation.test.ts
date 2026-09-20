import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RuntimeConversationIngress } from '../core/conversation/runtime-ingress';
import { projectConversationItems } from '../core/conversation/presentation';
const events = readFileSync(
  new URL(
    './fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl',
    import.meta.url,
  ),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((x) => x.kind === 'runtime_event')
  .map((x) => x.payload);
function replay(frames = events) {
  const ingress = new RuntimeConversationIngress('session', undefined, 'agent-block-v1');
  frames.forEach((e) => ingress.apply(e));
  return ingress;
}
describe('remote AgentBlock canonical fixture', () => {
  it('renders A2A text artifacts identically to message items during persisted replay', () => {
    const artifactFrames = events.map(event => event.parent_scope_id && event.item_kind === 'message'
      ? {...event, item_kind:'artifact'} : event);
    const expected = projectConversationItems(replay().snapshot());
    const actual = projectConversationItems(replay(artifactFrames).snapshot());
    const visible = (value: unknown) => JSON.parse(JSON.stringify(value, (key, entry) => key === 'sourceEventIds' ? undefined : entry));
    expect(visible(actual.timeline)).toEqual(visible(expected.timeline));
    expect(actual.artifacts).toEqual([]);
  });

  it('groups trigger/descriptor and scoped children without ending root early', () => {
    const ingress = replay(events.slice(0, 19));
    const p = projectConversationItems(ingress.snapshot());
    expect(p.terminalStatus).toBeUndefined();
    expect(p.timeline).toHaveLength(1);
    expect(p.timeline[0].item.kind).toBe('agent');
    expect(
      p.timeline[0].children?.filter((e) => e.item.kind === 'assistant_text'),
    ).toHaveLength(2);
    expect(
      p.timeline[0].children?.filter((e) => e.item.kind === 'tool_call'),
    ).toHaveLength(1);
    expect(p.output).toBe('');
  });
  it('live/full/cursor-13 replay are identical and duplicates no-op', () => {
    const ingress = replay(events.slice(0, 13));
    events.slice(13).forEach((e) => ingress.apply(e));
    const expected = replay().snapshot();
    expect(ingress.snapshot()).toEqual(expected);
    events.forEach((e) => ingress.apply(e));
    expect(ingress.snapshot()).toEqual(expected);
    expect(projectConversationItems(expected).output).toBe('Root final answer');
  });
  it('call completion remains running until a result exists', () => {
    const p = projectConversationItems(replay(events.slice(0, 11)).snapshot());
    expect(
      p.timeline[0].children?.find((e) => e.item.kind === 'tool_call')?.item
        .payload.executionStatus,
    ).toBe('running');
  });
  it('rejects a child run terminal', () => {
    const ingress = replay(events.slice(0, 5));
    expect(() =>
      ingress.apply({
        ...events[21],
        event_id: 'bad',
        scope_id: 'child-scope-1',
        parent_scope_id: 'root-scope',
      }),
    ).toThrow();
  });
});

import { HttpConversationClient } from '../core/conversation/client';
import { agentBlockProfile, bootstrapPresentationProfile } from '../core/conversation/agent';
import { agentBlockRendererCatalog } from '../core/conversation/renderer-registry';
import { decodeConversationInput } from '../core/conversation/contracts';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history';
import { projectConversationStreamForHostedUi } from '../core/conversation/hosted';
import type {
  ConversationSurface,
  ConversationInput,
} from '../core/conversation/types';
const surface: ConversationSurface = {
  apiVersion: 'conversation.ksadk.io/v1',
  kind: 'ConversationSurface',
  surfaceId: 'surface',
  sessionId: 'session',
  providerRef: 'test',
  inputs: [
    { name: 'text', mode: 'native' },
    { name: 'ksadk.presentation', mode: 'native' },
  ],
  outputs: [{ name: 'agent.block', mode: 'translated' }],
};
const input: ConversationInput = {
  apiVersion: 'conversation.ksadk.io/v1',
  kind: 'ConversationInput',
  sessionId: 'session',
  inputId: 'input',
  idempotencyKey: 'idempotency',
  parts: [{ kind: 'text', text: 'hello' }],
};
const stream = (frames: Record<string, unknown>[]) =>
  new Response(
    frames
      .map(
        (e) => `id: ${e.seq}\ndata: ${JSON.stringify({ runtimeEvent: e })}\n\n`,
      )
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
describe('shared remote profile, history and reconnect', () => {
  it('requires producer input/output declaration and trusted renderer', () => {
    expect(agentBlockProfile(surface)).toBe('flat-v1');
    expect(agentBlockProfile(surface, agentBlockRendererCatalog)).toBe(
      'agent-block-v1',
    );
    expect(
      agentBlockProfile({ ...surface, inputs: [] }, agentBlockRendererCatalog),
    ).toBe('flat-v1');
    expect(
      agentBlockProfile({ ...surface, outputs: [] }, agentBlockRendererCatalog),
    ).toBe('flat-v1');
    expect(
      decodeConversationInput({
        ...input,
        extensions: { 'ksadk.presentation': { profile: 'invented' } },
      }),
    ).toBeNull();
    expect(
      decodeConversationInput({
        ...input,
        extensions: {
          'ksadk.presentation': { profile: 'agent-block-v1', url: 'unsafe' },
        },
      }),
    ).toBeNull();
  });
  it('selects one lane and retains negotiated profile at cursor 13', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HttpConversationClient({
      rendererCatalog: agentBlockRendererCatalog,
      sleep: async () => {},
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1
          ? stream(events.slice(0, 13))
          : stream(events.slice(13));
      },
    });
    const result = await client.streamTurn({
      bootstrap: { buildId: 'build', surface },
      input,
    });
    expect(calls).toHaveLength(2);
    expect(
      JSON.parse(String(calls[0].init?.body)).input.extensions[
        'ksadk.presentation'
      ],
    ).toEqual({ profile: 'agent-block-v1' });
    expect(calls[1].url).toContain('after=13');
    expect(calls[1].url).toContain('presentationProfile=agent-block-v1');
    expect(result.presentation).toEqual(
      projectConversationItems(replay().snapshot()),
    );
    expect(result.presentation.timeline.map((e) => e.item.kind)).toEqual([
      'agent',
      'assistant_text',
    ]);
  });
  it('old surfaces receive no extension and only root final once', async () => {
    let posted: Record<string, unknown> = {};
    const updates: string[] = [];
    const client = new HttpConversationClient({
      rendererCatalog: agentBlockRendererCatalog,
      ingressLane: 'runtime',
      fetch: async (_url, init) => {
        posted = JSON.parse(String(init?.body));
        return stream(events);
      },
    });
    const result = await client.streamTurn({
      bootstrap: {
        buildId: 'build',
        surface: { ...surface, inputs: [surface.inputs[0]], outputs: [] },
      },
      input,
      onUpdate: (r) => updates.push(r.presentation.output),
    });
    expect((posted.input as ConversationInput).extensions).toBeUndefined();
    expect(
      result.presentation.timeline.every((e) => e.item.kind !== 'agent'),
    ).toBe(true);
    expect(updates.filter(Boolean)).toEqual(['Root final answer']);
  });
  it('rebuilds history through the same projection', () => {
    const history = rebuildPersistedSessionHistory(
      [],
      events.map((e) => ({
        SeqId: e.seq,
        EventType: 'runtime_event',
        Content: { runtime_event: e },
      })),
      'session',
      'agent-block-v1',
    );
    const state = replay().snapshot();
    const live = projectConversationStreamForHostedUi({
      state,
      presentation: projectConversationItems(state),
      cursor: 22,
      runId: 'root-run-1',
    });
    expect(
      history.messages.map((m) => ({
        content: m.content,
        agentBlock: m.agentBlock,
        blocks: m.blocks,
      })),
    ).toEqual(
      live.messages.map((m) => ({
        content: m.content,
        agentBlock: m.agentBlock,
        blocks: m.blocks,
      })),
    );
  });
  it('keeps the durable user input once before its remote run on refresh', () => {
    const history = rebuildPersistedSessionHistory(
      [{ id: 'input-1', role: 'user', content: 'question', timestamp: 999000,
        invocationId: 'root-run-1' }],
      events.map(e => ({ SeqId: e.seq, EventType: 'runtime_event',
        Content: { runtime_event: e } })),
      'session',
      'agent-block-v1',
    );
    expect(history.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(history.messages[0]?.id).toBe('input-1');
    expect(history.messages.some(m => m.agentBlock)).toBe(true);
  });
  it('descriptor-first retains the trigger position', () => {
    const frames = [
      events[0],
      events[3],
      events[19],
      events[1],
      ...events.slice(4, 19),
      events[20],
      events[21],
    ];
    const p = projectConversationItems(replay(frames).snapshot());
    expect(p.timeline.map((e) => e.item.kind)).toEqual([
      'assistant_text',
      'agent',
    ]);
    expect(p.timeline[1].sourceItemIds).toHaveLength(2);
  });
  it('same native call IDs in concurrent scopes remain separate', () => {
    const second = events
      .slice(3, 19)
      .map((frame) =>
        JSON.parse(
          JSON.stringify(frame)
            .replaceAll('child-scope-1', 'child-scope-2')
            .replaceAll('scope-descriptor-1', 'scope-descriptor-2')
            .replaceAll('handoff-1', 'handoff-2'),
        ),
      );
    second.forEach((frame: Record<string, unknown>) => {
      frame.event_id = `second-${frame.event_id}`;
    });
    const p = projectConversationItems(
      replay([...events.slice(0, 19), ...second]).snapshot(),
    );
    expect(p.timeline).toHaveLength(2);
    expect(
      p.timeline.map(
        (e) => e.children?.filter((c) => c.item.kind === 'tool_call').length,
      ),
    ).toEqual([1, 1]);
    expect(
      p.timeline[0].children?.find((e) => e.item.kind === 'tool_call')?.key,
    ).not.toBe(
      p.timeline[1].children?.find((e) => e.item.kind === 'tool_call')?.key,
    );
  });
  it('rejects terminal mutation and scope parent changes', () => {
    expect(() =>
      replay([
        ...events,
        {
          ...events[18],
          event_id: 'terminal-conflict',
          snapshot: { parts: [] },
        },
      ]),
    ).toThrow();
    expect(() =>
      replay([
        ...events.slice(0, 5),
        { ...events[5], event_id: 'parent-conflict', parent_scope_id: 'other' },
      ]),
    ).toThrow();
  });
});

import { safeToolValue } from '../core/conversation/safe-tool-value';
it('public tool observations exclude credentials, private addresses and diagnostics', () => {
  const safe = JSON.stringify(
    safeToolValue({
      authorization: 'Bearer fixture-secret',
      url: 'http://127.0.0.1/admin',
      traceback: 'Traceback: fixture-private',
      long_field: 'x'.repeat(20000),
    }),
  );
  expect(safe).not.toContain('fixture-secret');
  expect(safe).not.toContain('127.0.0.1');
  expect(safe).not.toContain('fixture-private');
  expect(safe).toContain('[truncated]');
});
it('mixed native and runtime lanes do not double project', async () => {
  const native = replay().snapshot().items;
  let body = '';
  for (const item of native) {
    body += `id: ${body.length + 1}\ndata: ${JSON.stringify({ conversationItem: item })}\n\n`;
    body += `id: ${body.length + 1}\ndata: ${JSON.stringify({ runtimeEvent: events[0] })}\n\n`;
  }
  const client = new HttpConversationClient({
    rendererCatalog: agentBlockRendererCatalog,
    fetch: async () => new Response(body),
  });
  const result = await client.streamTurn({
    bootstrap: {
      buildId: 'build',
      surface: {
        ...surface,
        outputs: [{ name: 'agent.block', mode: 'native' }],
      },
    },
    input,
  });
  expect(result.state.items).toHaveLength(native.length);
  expect(result.presentation.timeline.map((e) => e.item.kind)).toEqual([
    'agent',
    'assistant_text',
  ]);
});
it('pure delegation flat answer follows explicit output refs only', () => {
  const frames = [
    ...events.slice(0, 19),
    {
      ...events[21],
      output_refs: [{ scope_id: 'child-scope-1', item_id: 'child-message-2' }],
    },
  ];
  const p = projectConversationItems(replay(frames).snapshot(), {
    profile: 'flat-v1',
  });
  expect(p.output).toBe('second answer');
  expect(
    p.timeline.filter((e) => e.item.kind === 'assistant_text'),
  ).toHaveLength(1);
});
it('same text in different native message items remains distinct', () => {
  const frames = events.map((e) =>
    JSON.parse(
      JSON.stringify(e)
        .replaceAll('second answer', 'first answer')
        .replaceAll('second ', 'first '),
    ),
  );
  const p = projectConversationItems(replay(frames).snapshot());
  expect(
    p.timeline[0].children?.filter(
      (e) => e.item.payload.text === 'first answer',
    ),
  ).toHaveLength(2);
});

it('result-only stays an honest orphan and a late call cannot reopen execution', () => {
  const ingress = replay([events[0], events[3], events[12]]);
  let p = projectConversationItems(ingress.snapshot());
  expect(p.timeline[0].children?.[0].item.payload.orphan).toBe(true);
  ingress.apply(events[9]);
  ingress.apply(events[10]);
  p = projectConversationItems(ingress.snapshot());
  expect(p.timeline[0].children).toHaveLength(1);
  expect(p.timeline[0].children?.[0].item.payload.orphan).toBe(false);
  expect(p.timeline[0].children?.[0].item.payload.executionStatus).toBe(
    'completed',
  );
});
it('child messages and tools reference the descriptor, and mismatched trigger calls are rejected', () => {
  const state = replay().snapshot();
  const agent = state.items.find((item) => item.kind === 'agent')!;
  expect(
    state.items
      .filter((item) => item.nativeRef.parentScopeId && item.kind !== 'agent')
      .every((item) => item.parentItemId === agent.itemId),
  ).toBe(true);
  const bad = JSON.parse(JSON.stringify(events[3]));
  bad.initial.parts[0].data.trigger_ref.call_id = 'other';
  expect(() => replay([events[0], events[1], bad])).toThrow(
    'trigger call mismatch',
  );
});

it('rejects transport authority disagreement before sending', async () => {
  let requests = 0;
  const client = new HttpConversationClient({
    ingressLane: 'native',
    rendererCatalog: agentBlockRendererCatalog,
    fetch: async () => {
      requests++;
      return stream(events);
    },
  });
  await expect(
    client.streamTurn({ bootstrap: { buildId: 'build', surface }, input }),
  ).rejects.toMatchObject({ code: 'conversation_contract_mismatch' });
  expect(requests).toBe(0);
});
it('a runtime frame arriving first cannot steal a native-authoritative run', async () => {
  const native = replay().snapshot().items;
  const body =
    `id: 1\ndata: ${JSON.stringify({ runtimeEvent: events[0] })}\n\n` +
    native
      .map(
        (item, index) =>
          `id: ${index + 2}\ndata: ${JSON.stringify({ conversationItem: item })}\n\n`,
      )
      .join('');
  const client = new HttpConversationClient({
    rendererCatalog: agentBlockRendererCatalog,
    fetch: async () => new Response(body),
  });
  const result = await client.streamTurn({
    bootstrap: {
      buildId: 'build',
      surface: {
        ...surface,
        outputs: [{ name: 'agent.block', mode: 'native' }],
      },
    },
    input,
  });
  expect(result.state.items).toHaveLength(native.length);
  expect(result.presentation.output).toBe('Root final answer');
});
it('rejects child content until its actual descriptor item identity is known', () => {
  expect(() => replay([events[0], events[5]])).toThrow('descriptor first');
});

it('local cancellation is pre-send only and an identical terminal reconcile is accepted', () => {
  const cancelled = JSON.parse(JSON.stringify(events[18]));
  cancelled.snapshot.parts[0].data.status = 'cancelled';
  cancelled.snapshot.parts[0].data.cancel = {
    capability: 'unsupported',
    request_state: 'local_confirmed',
  };
  expect(() =>
    replay([
      events[0],
      events[3],
      cancelled,
      { ...cancelled, event_id: 'same-local-terminal' },
    ]),
  ).not.toThrow();
  expect(() => replay([events[0], events[3], events[4], cancelled])).toThrow(
    'Local cancellation after send',
  );
});

it.each([
  ['failed', 'error'],
  ['completed', 'completed'],
  ['running', 'running'],
  ['unknown', 'unknown'],
])(
  'honors explicit tool executionStatus %s independently of item closure',
  (executionStatus, expected) => {
    const state = replay().snapshot();
    const resultItem = state.items.find(
      (item) => item.payload.sourceKind === 'tool_result',
    )!;
    resultItem.lifecycle =
      executionStatus === 'completed' ? 'failed' : 'completed';
    resultItem.payload = {
      callId: resultItem.payload.callId,
      sourceKind: 'tool_result',
      executionStatus,
      output: 'execution result',
      orphan: true,
    };
    const projected = projectConversationStreamForHostedUi({
      state,
      presentation: projectConversationItems(state),
      cursor: 22,
      runId: 'root-run-1',
    });
    const tool = projected.messages[0].agentBlock!.messages.find((message) =>
      message.blocks?.some((block) => block.type === 'tool'),
    )!;
    expect(tool.blocks?.[0].status).toBe(expected);
    expect(Object.values(tool.tools!)[0].status).toBe(expected);
    expect(resultItem.payload.orphan).toBe(true);
  },
);

it('selects only the latest safe public child text for the collapsed agent summary', () => {
  const state = replay().snapshot();
  const agent = state.items.find((item) => item.kind === 'agent')!;
  const publicText = state.items.find(
    (item) => item.nativeRef.parentScopeId && item.kind === 'assistant_text',
  )!;
  state.items.push(
    {
      ...publicText,
      itemId: 'internal',
      visibility: 'internal',
      payload: { text: 'internal private data' },
    },
    {
      ...publicText,
      itemId: 'raw-reasoning',
      kind: 'reasoning',
      payloadSchemaRef: 'conversation.item.reasoning/v1',
      payload: { text: 'raw reasoning' },
    },
    {
      ...publicText,
      itemId: 'credential',
      payload: { text: 'Bearer fixture-secret' },
    },
  );
  const projected = projectConversationStreamForHostedUi({
    state,
    presentation: projectConversationItems(state, { includeInternal: true }),
    cursor: 22,
    runId: agent.runId,
  });
  expect(projected.messages[0].agentBlock?.summary).toBe('second answer');
});

it('keeps a failed result-only observation an orphan without fabricating a call', () => {
  const state = replay([events[0], events[3], events[12]]).snapshot();
  const result = state.items.find(
    (item) => item.payload.sourceKind === 'tool_result',
  )!;
  result.payload = {
    ...result.payload,
    executionStatus: 'failed',
    output: 'request failed',
  };
  delete result.payload.isError;
  const presentation = projectConversationItems(state);
  expect(presentation.timeline[0].children?.[0].item.payload.orphan).toBe(true);
  const projected = projectConversationStreamForHostedUi({
    state,
    presentation,
    cursor: 13,
    runId: result.runId,
  });
  const tool = projected.messages[0].agentBlock?.messages[0].blocks?.[0];
  expect(tool).toMatchObject({
    type: 'tool',
    toolName: 'Tool result',
    status: 'error',
    output: 'request failed',
  });
});
it('bounds summaries and omits them when there is no safe public text', () => {
  const state = replay().snapshot();
  const textItems = state.items.filter(
    (item) => item.nativeRef.parentScopeId && item.kind === 'assistant_text',
  );
  for (const item of textItems) item.payload.text = '';
  const project = () =>
    projectConversationStreamForHostedUi({
      state,
      presentation: projectConversationItems(state),
      cursor: 22,
      runId: 'root-run-1',
    }).messages[0].agentBlock?.summary;
  expect(project()).toBeUndefined();
  textItems[0].payload.text = '公开 '.repeat(100);
  expect(Array.from(project()!)).toHaveLength(161);
  expect(project()).toMatch(/…$/);
});

it('translated flat-v1 preserves the legacy root identity when a child uses the same native ID', async () => {
  const frames = events.map(frame => JSON.parse(
    JSON.stringify(frame).replaceAll('root-message-2', 'child-message-1'),
  ));
  const client = new HttpConversationClient({
    ingressLane: 'runtime',
    fetch: async () => stream(frames),
  });
  const result = await client.streamTurn({
    bootstrap: {
      buildId: 'build',
      surface: {...surface, outputs: [], inputs: [surface.inputs[0]]},
    },
    input,
  });
  expect(result.presentation.output).toBe('Root final answer');
  expect(result.presentation.timeline.find(
    entry => entry.item.kind === 'assistant_text',
  )?.item.itemId).toBe('child-message-1');
  const collidingItems = result.state.items.filter(
    item => item.nativeRef.runtimeItemId === 'child-message-1',
  ).map(item => item.itemId);
  expect(collidingItems).toHaveLength(2);
  expect(collidingItems).toEqual(expect.arrayContaining([
    '["root-run-1","child-scope-1","child-message-1"]',
    'child-message-1',
  ]));
});

it.each(['before', 'after'])(
  'AgentBlock absorbs its complete scoped trigger family when result arrives %s descriptor',
  (order) => {
    const result = {
      ...events[12],
      event_id: 'root-trigger-result',
      scope_id: 'root-scope',
      parent_scope_id: undefined,
      item_id: 'root-trigger-result',
      snapshot: {
        parts: [{
          content_type: 'tool_result',
          part_id: 'result',
          call_id: 'a2a-call-1',
          result: 'delegated',
          is_error: false,
        }],
      },
    };
    const frames = order === 'before'
      ? [...events.slice(0, 3), result, ...events.slice(3)]
      : [...events.slice(0, 19), result, ...events.slice(19)];
    const state = replay(frames).snapshot();
    const presentation = projectConversationItems(state);
    expect(presentation.timeline.map(entry => entry.item.kind)).toEqual([
      'agent',
      'assistant_text',
    ]);
    const resultItem = state.items.find(
      item => item.nativeRef.runtimeItemId === 'root-trigger-result',
    )!;
    expect(presentation.timeline[0].sourceItemIds).toContain(resultItem.itemId);
    expect(presentation.timeline[0].children?.filter(
      entry => entry.item.kind === 'tool_call',
    )).toHaveLength(1);
  },
);


describe('runtime bootstrap presentation negotiation', () => {
  it('defaults unknown producers, versions, and renderers to flat', () => {
    expect(bootstrapPresentationProfile(undefined, agentBlockRendererCatalog)).toBe('flat-v1');
    expect(bootstrapPresentationProfile({...surface, apiVersion:'conversation.ksadk.io/v99'}, agentBlockRendererCatalog)).toBe('flat-v1');
    expect(bootstrapPresentationProfile(surface)).toBe('flat-v1');
    expect(bootstrapPresentationProfile(surface, agentBlockRendererCatalog)).toBe('agent-block-v1');
  });
  it('raw runtime ingress does not enable hierarchy without negotiation', () => {
    const ingress = new RuntimeConversationIngress('session');
    events.forEach(e => ingress.apply(e));
    expect(projectConversationItems(ingress.snapshot(), {profile:'flat-v1'}).timeline.some(e => e.item.kind === 'agent')).toBe(false);
    expect(projectConversationItems(ingress.snapshot(), {profile:'flat-v1'}).output).toBe('Root final answer');
  });
});

it('keeps a safe unknown-outcome error inside its child scope', () => {
  const first = events.find(e => e.parent_scope_id && e.item_kind === 'status');
  const cutoff = events.indexOf(first);
  const ingress = replay(events.slice(0, cutoff + 1));
  const common = { ...first, item_id: 'local-outcome-error', item_kind: 'status' };
  delete common.snapshot;
  delete common.initial;
  ingress.apply({ ...common, event_id: 'local-error-start', seq: first.seq + 1,
    event_type: 'item.started', initial: { parts: [] } });
  const failed = { ...common, event_id: 'local-error-failed', seq: first.seq + 2,
    event_type: 'item.failed', error: { code: 'A2A_SEND_OUTCOME_UNKNOWN',
      message: 'Remote result is unknown; do not resend the call.', source: 'a2a', scope_id: first.scope_id } };
  ingress.apply(failed);
  const snapshot = ingress.snapshot();
  const error = snapshot.items.find(item => item.kind === 'error');
  expect(error?.parentItemId).toBeTruthy();
  expect(error?.payload.error).toContain('Remote result is unknown');
  expect(projectConversationItems(snapshot).output).toBe('');
  ingress.apply(failed);
  expect(ingress.snapshot()).toEqual(snapshot);
});

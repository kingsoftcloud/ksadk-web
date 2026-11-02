import { describe, expect, it } from 'vitest';
import { RuntimeConversationIngress } from '../core/conversation/runtime-ingress.js';
import { projectConversationItems } from '../core/conversation/presentation.js';
import { projectConversationStreamForHostedUi } from '../core/conversation/hosted.js';
import { KernelRunEventTranslator } from '../core/stream/kernel-events.js';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';

const base = { schema_version: 2, family: 'runtime', run_id: 'run', scope_id: 'root', timestamp: 1700000000 };
const internal = { conversation_visibility: 'internal', ksadk_internal_operation: 'a2ui_generation' };
const frame = (seq: number, event_type: string, extra: Record<string, unknown> = {}) => ({
  ...base, seq, event_id: `event-${seq}`, event_type, source: { framework: 'langgraph' }, ...extra,
});
const call = (id: string, name = 'render_a2ui') => ({
  part_id: id, content_type: 'tool_call', call_id: id, name, arguments: { title: id },
});
const internalCall = frame(3, 'item.completed', {
  item_id: 'layout', item_kind: 'tool_call',
  source: { framework: 'langgraph', metadata: internal },
  snapshot: { parts: [call('internal-layout-call')] },
});

describe('explicit internal model ownership', () => {
  it.each(['flat-v1', 'agent-block-v1'] as const)('keeps public same-name errors and unknown results in %s', profile => {
    const ingress = new RuntimeConversationIngress('session', undefined, profile);
    const events = [
      frame(1, 'run.started'), internalCall,
      frame(4, 'item.completed', { item_id: 'business-failed', item_kind: 'tool_call', snapshot: { parts: [call('failed-call')] } }),
      frame(5, 'item.completed', { item_id: 'business-failed-result', item_kind: 'tool_result', snapshot: { parts: [{
        part_id: 'failed-result', content_type: 'tool_result', call_id: 'failed-call', is_error: true, result: { error: 'Business lookup failed' },
      }] } }),
      frame(6, 'item.completed', { item_id: 'business-unknown', item_kind: 'tool_call', snapshot: { parts: [call('unknown-call')] } }),
      frame(7, 'item.completed', { item_id: 'answer', item_kind: 'message', snapshot: { parts: [{ part_id: 'answer', content_type: 'text', text: 'Public answer' }] } }),
      frame(8, 'run.completed'),
    ];
    for (const event of events) ingress.apply(event);
    const state = ingress.snapshot();
    expect(state.items.find(item => item.payload.callId === 'internal-layout-call')?.visibility).toBe('internal');
    const result = projectConversationStreamForHostedUi({ state, presentation: projectConversationItems(state, { profile }), runId: 'run', cursor: 8 });
    const tools = result.messages.flatMap(message => Object.values(message.tools || {}));
    expect(tools).toHaveLength(2);
    expect(tools).toMatchObject([
      { name: 'render_a2ui', callId: 'failed-call', status: 'error' },
      { name: 'render_a2ui', callId: 'unknown-call', status: 'unknown' },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain('internal-layout-call');
    expect(JSON.stringify(result.messages)).toContain('Business lookup failed');
    expect(JSON.stringify(result.messages)).toContain('Public answer');
  });

  it('honors generic visibility in partial legacy history without matching tool names', () => {
    const translator = new KernelRunEventTranslator('session');
    expect(translator.translate(internalCall)).toBeNull();
    const publicSameName = { ...internalCall, event_id: 'public-call', source: { framework: 'langgraph' } };
    expect(translator.translate(publicSameName)).toMatchObject({ EventType: 'tool_call', Metadata: { tool_name: 'render_a2ui' } });
    const record = { SeqId: 100, EventId: internalCall.event_id, EventType: internalCall.event_type, Content: { runtime_event: internalCall } };
    const rebuilt = rebuildPersistedSessionHistory([
      { id: 'answer', role: 'model', content: 'Public answer', timestamp: 1, invocationId: 'run' },
    ], [record], 'session');
    expect(rebuilt.messages.map(message => message.content)).toEqual(['Public answer']);
    expect(rebuilt.messages.flatMap(message => Object.values(message.tools || {}))).toEqual([]);
  });

  it('keeps a public call with the same name/id in a different scope', () => {
    const ingress = new RuntimeConversationIngress('session', undefined, 'agent-block-v1');
    ingress.apply(frame(1, 'run.started'));
    ingress.apply({ ...internalCall, snapshot: { parts: [{ ...call('shared-call'), arguments: { value: 'private-layout-definition' } }] } });
    ingress.apply(frame(4, 'item.completed', { scope_id: 'business-scope', item_id: 'business', item_kind: 'tool_call',
      snapshot: { parts: [{ ...call('shared-call'), arguments: { value: 'public-business-input' } }] },
    }));
    ingress.apply(frame(5, 'run.completed'));
    const state = ingress.snapshot();
    const result = projectConversationStreamForHostedUi({ state, presentation: projectConversationItems(state, { profile: 'agent-block-v1' }), runId: 'run', cursor: 5 });
    const tools = result.messages.flatMap(message => Object.values(message.tools || {}));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: 'render_a2ui', callId: 'shared-call', status: 'unknown' });
    expect(JSON.stringify(result.messages)).toContain('public-business-input');
    expect(JSON.stringify(result.messages)).not.toContain('private-layout-definition');
  });

  it('removes only the exact native result item closed as internal control flow', () => {
    const ingress = new RuntimeConversationIngress('session', undefined, 'agent-block-v1');
    ingress.apply(frame(1, 'run.started'));
    ingress.apply(frame(2, 'item.started', { item_id: 'paused-result', item_kind: 'tool_result', initial: { parts: [] } }));
    const before = ingress.snapshot();
    expect(projectConversationItems(before).toolItems).toHaveLength(1);
    ingress.apply(frame(3, 'item.completed', { item_id: 'paused-result', item_kind: 'tool_result',
      source: { framework: 'langgraph', metadata: { conversation_visibility: 'internal', ksadk_control_flow: 'interrupt' } },
      snapshot: { parts: [] },
    }));
    const after = ingress.snapshot();
    expect(after.items.find(item => item.nativeRef.runtimeItemId === 'paused-result')?.visibility).toBe('internal');
    expect(projectConversationItems(after).toolItems).toEqual([]);
    expect(after.items.find(item => item.nativeRef.runtimeItemId === 'paused-result')?.payload.output).toBeUndefined();
    const replay = new RuntimeConversationIngress('session', undefined, 'agent-block-v1');
    for (const event of [frame(1, 'run.started'), frame(2, 'item.started', { item_id: 'paused-result', item_kind: 'tool_result', initial: { parts: [] } }),
      frame(3, 'item.completed', { item_id: 'paused-result', item_kind: 'tool_result', source: { framework: 'langgraph', metadata: { conversation_visibility: 'internal', ksadk_control_flow: 'interrupt' } }, snapshot: { parts: [] } })]) replay.apply(event);
    expect(replay.snapshot()).toEqual(after);
  });
});

import { describe, expect, it } from 'vitest';
import { RuntimeConversationIngress } from '../core/conversation/runtime-ingress';
import { KernelRunEventTranslator } from '../core/stream/kernel-events';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events';
import { projectConversationItems } from '../core/conversation/presentation';
import { projectConversationStreamForHostedUi } from '../core/conversation/hosted';

const frame = (event_type: string, event_id: string, extra = {}) => ({
 schema_version: 2, family: 'runtime', run_id: 'parent-run', scope_id: 'node',
 parent_scope_id: 'graph', source: { framework: 'langgraph' }, event_type, event_id, ...extra,
});
describe('native graph scopes alongside managed experts', () => {
 it('keeps internal state out of public text while preserving business JSON and tool output', () => {
  const ingress = new RuntimeConversationIngress('parent-session');
  ingress.apply(frame('run.started', 'begin', { scope_id: 'graph', parent_scope_id: undefined }));
  for (const [id, visibility, text] of [
   ['state', 'internal', '{"context":"private-state"}'],
   ['answer', 'public', '{"businessResult":0,"enabled":false}'],
  ]) {
   ingress.apply(frame('item.completed', `${id}:done`, { item_id: id, item_kind: 'message',
    source: { framework: 'langgraph', metadata: { visibility } },
    snapshot: { parts: [{ part_id: 'text', content_type: 'text', text }] },
   }));
  }
  const state = ingress.snapshot();
  const projected = projectConversationStreamForHostedUi({ state,
   presentation: projectConversationItems(state), cursor: 3, runId: 'parent-run' });
  const display = JSON.stringify(projected.messages);
  expect(display).not.toContain('private-state');
  expect(display).toContain('businessResult');
 });
 it('preserves large local tool text through live ingress and hosted history replay', () => {
  const output = 'TOOL_BEGIN\n' + 'data row\n'.repeat(3000) + 'TOOL_END';
  const events = [
   frame('run.started','begin',{scope_id:'graph',parent_scope_id:undefined}),
   frame('item.completed','call',{item_id:'call',item_kind:'tool_call',snapshot:{parts:[{part_id:'call',content_type:'tool_call',call_id:'call-1',name:'analyze_partition',arguments:{partition:0}}]}}),
   frame('item.completed','result',{item_id:'result',item_kind:'tool_result',snapshot:{parts:[{part_id:'result',content_type:'tool_result',call_id:'call-1',result:output,is_error:false}]}}),
  ];
  for (const repetitions of [1, 2]) {
   const ingress = new RuntimeConversationIngress('parent-session');
   for (let i = 0; i < repetitions; i++) for (const event of events) ingress.apply(event);
   const state = ingress.snapshot();
   const projected = projectConversationStreamForHostedUi({state,presentation:projectConversationItems(state),cursor:3,runId:'parent-run'});
   const blocks = projected.messages.flatMap(message => message.blocks || []).filter(block => block.type === 'tool');
   expect(blocks).toHaveLength(1);
   expect(blocks[0].output).toBe(output);
  }
 });
 it.each(['flat-v1','agent-block-v1'] as const)('consumes local nodes before approval under %s', profile => {
  const ingress = new RuntimeConversationIngress('parent-session', undefined, profile);
  ingress.apply(frame('run.started','start',{scope_id:'start-native',parent_scope_id:undefined}));
  ingress.apply(frame('item.started','node-start',{item_id:'node-info',item_kind:'data'}));
  ingress.apply(frame('item.completed','node-done',{item_id:'node-info',item_kind:'data',snapshot:{parts:[{part_id:'data',content_type:'data',data:{node:'expert'}}]}}));
  expect(ingress.apply(frame('run.progress','node-progress'))).toBeNull();
  ingress.apply(frame('item.started','tool-start',{item_id:'call',item_kind:'tool_call'}));
  ingress.apply(frame('item.completed','tool-done',{item_id:'call',item_kind:'tool_call',snapshot:{parts:[{part_id:'call',content_type:'tool_call',call_id:'call-1',name:'expert',arguments:{message:'hello'}}]}}));
  const translator = new KernelRunEventTranslator('parent-session');
  const approval = translator.translate({seq:9,family:'interaction',event_type:'interaction.requested',run_id:'parent-run',session_id:'parent-session',interaction_id:'approval',kind:'approval',revision:1,request:{presentation:{title:'Approve expert'}}});
  expect(interactionFromSessionEvent(approval)).toMatchObject({kind:'approval',runId:'parent-run',sessionId:'parent-session'});
  expect(() => ingress.apply(frame('run.completed','done',{scope_id:'end-native',parent_scope_id:undefined}))).not.toThrow();
  expect(ingress.snapshot().items.some(item => item.kind==='tool_call')).toBe(true);
 });
 it('still rejects undeclared remote children and child run terminals', () => {
  const ingress = new RuntimeConversationIngress('parent-session');
  expect(() => ingress.apply(frame('item.started','bad',{source:{framework:'a2a'},item_id:'remote',item_kind:'message'}))).toThrow('scope descriptor');
  expect(() => ingress.apply(frame('run.completed','child-terminal'))).toThrow('Child scope');
 });
});

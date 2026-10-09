import { describe, expect, it } from 'vitest';
import { RuntimeConversationIngress } from '../core/conversation/runtime-ingress';
import { KernelRunEventTranslator } from '../core/stream/kernel-events';
import { interactionFromSessionEvent } from '../core/interaction/adapters/session-events';

const frame = (event_type: string, event_id: string, extra = {}) => ({
 schema_version: 2, family: 'runtime', run_id: 'parent-run', scope_id: 'node',
 parent_scope_id: 'graph', source: { framework: 'langgraph' }, event_type, event_id, ...extra,
});
describe('native graph scopes alongside managed experts', () => {
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

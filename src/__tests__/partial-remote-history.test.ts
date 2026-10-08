import {readFileSync} from 'node:fs';
import { ingestSessionEventRecord, sharedInteractionStore } from '../core/interaction';
import {expect,it} from 'vitest';
import {rebuildPersistedSessionHistory} from '../utils/persisted-session-history';
const frames = readFileSync(new URL('./fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl',import.meta.url),'utf8').trim().split('\n').map(l=>JSON.parse(l)).filter(e=>e.kind==='runtime_event').map(e=>e.payload);
it('keeps fallback transcript while the newest event page starts inside an A2A run',()=>{
 const suffix = frames.slice(10).map(e=>({SeqId:e.seq, EventType:'runtime_event',Content:{runtime_event:e}}));
 expect(()=>rebuildPersistedSessionHistory([{id:'durable-answer',role:'model',content:'Root final answer',timestamp:1,invocationId:'root-run-1'}],suffix,'session','agent-block-v1')).not.toThrow();
});
import {RuntimeConversationIngress} from '../core/conversation/runtime-ingress';
import {projectConversationItems} from '../core/conversation/presentation';
it('flat presentation keeps native LangGraph subgraph tools',()=>{
 const ingress=new RuntimeConversationIngress('session',undefined,'flat-v1');
 const base={schema_version:2,family:'runtime',run_id:'r',scope_id:'subgraph',parent_scope_id:'root',source:{framework:'langgraph'}};
 const tool={part_id:'call',content_type:'tool_call',call_id:'native-call',name:'search',arguments:{q:'hello'}};
 ingress.apply({...base,event_type:'run.started',event_id:'start',scope_id:'root',parent_scope_id:undefined});
 ingress.apply({...base,event_type:'item.started',event_id:'call-start',item_id:'tool',item_kind:'tool_call',initial:{parts:[tool]}});
 ingress.apply({...base,event_type:'item.completed',event_id:'call-done',item_id:'tool',item_kind:'tool_call',snapshot:{parts:[tool]}});
 ingress.apply({...base,event_type:'run.completed',event_id:'done',scope_id:'root',parent_scope_id:undefined,output_refs:[]});
 expect(projectConversationItems(ingress.snapshot(),{profile:'flat-v1'}).timeline.some(e=>e.item.kind==='tool_call')).toBe(true);
});
it('preserves native subgraph tool history across this PR',()=>{
 const base={schema_version:2,family:'runtime',run_id:'r',scope_id:'subgraph',parent_scope_id:'root',source:{framework:'langgraph'},timestamp:1700000000};
 const tool={part_id:'call',content_type:'tool_call',call_id:'native-call',name:'search',arguments:{q:'hello'}};
 const answer={part_id:'text',content_type:'text',text:'done'};
 const all=[
 {...base,event_type:'run.started',event_id:'start',scope_id:'root',parent_scope_id:undefined},
 {...base,event_type:'item.started',event_id:'call-start',item_id:'tool',item_kind:'tool_call',initial:{parts:[tool]}},
 {...base,event_type:'item.completed',event_id:'call-done',item_id:'tool',item_kind:'tool_call',snapshot:{parts:[tool]}},
 {...base,event_type:'item.started',event_id:'text-start',item_id:'answer',item_kind:'message',phase:'final_answer'},
 {...base,event_type:'item.completed',event_id:'text-done',item_id:'answer',item_kind:'message',phase:'final_answer',snapshot:{parts:[answer]}},
 {...base,event_type:'run.completed',event_id:'done',scope_id:'root',parent_scope_id:undefined,output_refs:[{scope_id:'subgraph',item_id:'answer'}]},
 ].map((e,i)=>({SeqId:i+1,EventType:'runtime_event',Content:{runtime_event:e}}));
 const after=rebuildPersistedSessionHistory([],all,'session','flat-v1');
 const tools=(messages: typeof after.messages)=>messages.flatMap(m=>m.blocks||[]).filter(b=>b.type==='tool').map(b=>b.toolName);
 expect(tools(after.messages)).toContain('search');
});

it('isolates a malformed run while a complete remote run remains canonical',()=>{
 const good=frames.map((frame,i)=>({SeqId:i+100,EventType:'runtime_event',Content:{runtime_event:frame}}));
 const bad=structuredClone(frames).map((frame,i)=>({SeqId:i+200,EventType:'runtime_event',Content:{runtime_event:{...frame,run_id:'bad-run',event_id:'bad-'+frame.event_id}}}));
 // Corrupt only the second run's stable descriptor identity.
 const terminal=bad.find(row=>row.Content.runtime_event.item_kind==='status'&&row.Content.runtime_event.event_type==='item.completed');
 terminal!.Content.runtime_event.snapshot.parts[0].data.binding_id='changed-binding';
 const rebuilt=rebuildPersistedSessionHistory([{id:'bad-fallback',role:'model',content:'Durable bad-run answer',timestamp:2,invocationId:'bad-run'}],[...good,...bad],'session','agent-block-v1');
 expect(rebuilt.messages.some(message=>message.agentBlock?.item.runId==='root-run-1')).toBe(true);
 expect(rebuilt.messages.find(message=>message.id==='bad-fallback')?.content).toBe('Durable bad-run answer');
 expect(rebuilt.canonicalRunIds).toContain('root-run-1');
 expect(rebuilt.canonicalRunIds).not.toContain('bad-run');
 const independent={SeqId:300,Content:{session_event:{family:'interaction',event_type:'interaction.requested',session_id:'independent-session',run_id:'independent-run',payload:{interaction_id:'independent-approval',kind:'approval',revision:1,request:{presentation:{title:'Approve'}}}}}};
 ingestSessionEventRecord(independent,'independent-session');
 expect(sharedInteractionStore.get('independent-session','independent-approval')?.status).toBe('pending');
 sharedInteractionStore.clearSession('independent-session');
});
it('waits for the missing descriptor start before replacing compatibility history',()=>{
 const records=frames.filter(frame=>frame.event_type!=='item.started'||frame.item_kind!=='status').map((frame,i)=>({SeqId:i+100,EventType:'runtime_event',Content:{runtime_event:frame}}));
 const rebuilt=rebuildPersistedSessionHistory([{id:'fallback',role:'model',content:'Durable answer',timestamp:2,invocationId:'root-run-1'}],records,'session','agent-block-v1');
 expect(rebuilt.messages.some(message=>message.id==='fallback')).toBe(true);
 expect(rebuilt.canonicalRunIds).not.toContain('root-run-1');
});

it('flat projection keeps same-named native scopes in a different run',()=>{
 const ingress=new RuntimeConversationIngress('session',undefined,'agent-block-v1');
 frames.slice(0,11).forEach(frame=>ingress.apply(frame));
 const state=ingress.snapshot();
 const native={...state.items.find(item=>item.kind==='tool_call')!,itemId:'native-other-run',runId:'other-run',parentItemId:null,nativeRef:{scopeId:'child-scope-1',parentScopeId:'native-root',framework:'langgraph'},payload:{tool:'native-search'}};
 const projection=projectConversationItems({...state,items:[...state.items,native]},{profile:'flat-v1'});
 expect(projection.toolItems.map(item=>item.itemId)).toContain('native-other-run');
 expect(projection.toolItems.some(item=>item.parentItemId===state.items.find(item=>item.kind==='agent')?.itemId)).toBe(false);
});

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionLifecycle } from '../hooks/useSessionLifecycle.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useStreamingStore } from '../stores/streaming.js';
import type { ApiFacade } from '../core/api/types.js';
import type { UiCapabilities } from '../types/capabilities.js';
import type { Interaction } from '../core/interaction/types.js';

const frames = readFileSync(new URL('./fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl',import.meta.url),'utf8')
  .trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.kind==='runtime_event').map(row=>({...row.payload,family:'runtime',
    ...(row.payload.parent_scope_id && row.payload.item_kind==='message'?{item_kind:'artifact'}:{})}));
const caps = {KernelSessionEventsByCommand:true,RunLifecycle:{Enabled:true,Resume:true,Checkpoints:false},ConversationSurface:{
  apiVersion:'conversation.ksadk.io/v1',kind:'ConversationSurface',surfaceId:'surface',sessionId:'session',providerRef:'test',
  inputs:[{name:'ksadk.presentation',mode:'native'}],outputs:[{name:'agent.block',mode:'translated'}],
}} as UiCapabilities;

function lifecycle(api: Partial<ApiFacade>) {
  let actions!:ReturnType<typeof useSessionLifecycle>;
  function Probe() {actions=useSessionLifecycle({agentId:'agent',currentSessionId:'session',isMobile:false,uiCapabilities:caps,
    api:api as ApiFacade,resetCompaction:()=>{},restoreSession:false});return null}
  renderToString(createElement(Probe));return actions;
}
const wire = (items: typeof frames) => new TextEncoder().encode(items.map(f=>`data: ${JSON.stringify({
  EventId:f.event_id,SessionId:'session',InvocationId:f.run_id,SeqId:f.seq,
  EventType:f.event_type.startsWith('run.')?'run_status':f.event_type,
  Content:{runtime_event:f,...(f.event_type==='run.completed'?{status:'completed'}:{})},
})}\n\n`).join(''));

describe('native approval/reload recovery',()=>{
  beforeEach(()=>{
    useBootstrapStore.getState().setAgentId('agent');useBootstrapStore.getState().setCapabilities(caps);
    useSessionStore.getState().setCurrentSessionId('session');useMessageStore.getState().setMessages([]);
    useStreamingStore.getState().resetRun();
  });
  it('renders remote text/tools from the wrapped recovery stream before root completion',async()=>{
    let controller!:ReadableStreamDefaultController<Uint8Array>;
    const subscribe=vi.fn(async()=>new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(wire(frames.slice(0,13)))} }));
    const api={listSessionMessages:vi.fn().mockResolvedValue({Messages:[],LatestSeqId:900,HasMore:false,NextCursor:null}),
      listSessionEvents:vi.fn().mockResolvedValue({Events:[],Total:0}),
      getSession:vi.fn().mockResolvedValue({ActiveRunStatus:'running',ActiveInvocationId:'root-run-1'}),subscribeRunEvents:subscribe};
    const actions=lifecycle(api);await actions.loadSession('session');
    await vi.waitFor(()=>expect(JSON.stringify(useMessageStore.getState().messages)).toContain('first answer'));
    expect(useMessageStore.getState().messages.some(m=>m.agentBlock)).toBe(true);
    expect(JSON.stringify(useMessageStore.getState().messages)).toContain('query_metrics');
    expect(subscribe).toHaveBeenCalledWith({sessionId:'session',invocationId:'root-run-1',afterSeqId:0},expect.anything());
    controller.enqueue(wire(frames.slice(13)));controller.close();
    await vi.waitFor(()=>expect(JSON.stringify(useMessageStore.getState().messages)).toContain('Root final answer'));
    expect(useMessageStore.getState().messages.filter(m=>m.agentBlock)).toHaveLength(1);
    actions.runSubscriptionAbortRef.current?.abort();
  });
  it('does not open a competing recovery subscription while the native run owner is still streaming',()=>{
    const subscribe=vi.fn();const actions=lifecycle({subscribeRunEvents:subscribe});
    useStreamingStore.getState().setSessionStreaming('session',true);
    useStreamingStore.getState().updateActivity({sessionId:'session',runId:'root-run-1',source:'run',status:'running'});
    actions.followAcceptedInteraction({sessionId:'session',runId:'root-run-1'} as Interaction);
    expect(subscribe).not.toHaveBeenCalled();
  });
});

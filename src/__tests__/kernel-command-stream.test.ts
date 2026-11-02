import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RunEngineImpl } from '../core/run/index.js';
import { ApiError } from '../api/client.js';
import type { ApiFacade } from '../core/api/types.js';
import type { RunEvent } from '../core/run/types.js';
import { ApiFacadeImpl } from '../core/api/facade.js';

const fixture = readFileSync(new URL('./fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map(line => JSON.parse(line)).filter(row => row.kind === 'runtime_event').map(row => row.payload);
const commandId = '11111111-2222-4333-8444-555555555555';
const createRunEngine = (api: ApiFacade) => new RunEngineImpl(api);
const bytes = (s: string) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });
const encode = (frames: unknown[]) => new TextEncoder().encode(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''));
const framesFor = (run: string) => fixture.map((f, i) => ({ ...f, family: 'runtime', run_id: run, event_id: `${run}:${f.event_id}`, seq: 501 + i,
  ...(f.parent_scope_id && f.item_kind === 'message' ? { item_kind: 'artifact' } : {}) }));

describe('command-bound native hosted streaming', () => {
  it.each([true, false])('does not turn exhausted reconnection into failure (pending input: %s)', async pending => {
    vi.useFakeTimers();
    try {
      const frames = [{seq:501, family:'control', event_type:'control.run_transition',
        run_id:'root-run-1', state:'running'}, ...(pending ? [{seq:502, family:'interaction',
        event_type:'interaction.requested', run_id:'root-run-1', interaction_id:'input-1'}] : [])];
      const api = {
        runAgent:vi.fn(async()=>bytes(JSON.stringify({Data:{ReceiptStatus:'accepted',CommandId:commandId}}))),
        subscribeSessionEvents:vi.fn().mockResolvedValueOnce(bytes(new TextDecoder().decode(encode(frames))))
          .mockRejectedValue(new TypeError('connection unavailable')),
      } as unknown as ApiFacade;
      const engine=createRunEngine(api);const settled=vi.fn();const events: RunEvent[]=[];
      engine.subscribe(event=>events.push(event));
      engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph',
        selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true});
      engine.start({text:'task',sessionId:'session',attachments:[],onSettled:settled});
      await vi.waitFor(()=>expect(api.subscribeSessionEvents).toHaveBeenCalledTimes(1));
      await vi.runAllTimersAsync();
      expect(settled).toHaveBeenCalledWith('session', pending ? 'awaiting-input' : 'unknown');
      expect(api.runAgent).toHaveBeenCalledTimes(1);
      expect(api.subscribeSessionEvents).toHaveBeenCalledTimes(7);
      expect(events.filter(event=>event.type==='activity' && event.status==='failed')).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(['failed', 'cancelled'])('keeps the authoritative terminal %s', async state => {
    const api={runAgent:async()=>bytes(JSON.stringify({Data:{ReceiptStatus:'accepted',CommandId:commandId}})),
      subscribeSessionEvents:async()=>bytes(new TextDecoder().decode(encode([
        {seq:501,family:'control',event_type:'control.run_transition',run_id:'root-run-1',state},
      ]))),
    } as unknown as ApiFacade;
    const engine=createRunEngine(api);const settled=vi.fn();
    engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph',
      selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true});
    engine.start({text:'task',sessionId:'session',attachments:[],onSettled:settled});
    await vi.waitFor(()=>expect(settled).toHaveBeenCalledWith('session', state));
  });

  it.each([200,409])('keeps the real GET transport reason for a queued admission (HTTP %s)',async status=>{
    let subscriptions=0;
    const fetcher=vi.fn(async(url:RequestInfo|URL)=>{
      if(String(url).includes('/RunAgent'))return new Response(JSON.stringify({Code:0,Data:{ReceiptStatus:'accepted',CommandId:commandId,PresentationProfile:'agent-block-v1'}}),{headers:{'content-type':'application/json'}});
      subscriptions++;
      if(subscriptions===1)return new Response(JSON.stringify({Code:409,Message:'Kernel command is waiting for its run',Data:{ReasonCode:'KERNEL_COMMAND_PENDING'}}),{status,headers:{'content-type':'application/json'}});
      return new Response(encode(framesFor('root-run-1')),{headers:{'content-type':'text/event-stream'}});
    });
    const engine=createRunEngine(new ApiFacadeImpl({fetch:fetcher,agentId:'agent'}));const settled=vi.fn();
    engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph',selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true,presentationProfile:'agent-block-v1'});
    engine.start({text:'queued turn',sessionId:'session',attachments:[],onSettled:settled});
    await vi.waitFor(()=>expect(settled).toHaveBeenCalledWith('session','completed'),{timeout:3000});
    expect(fetcher.mock.calls.filter(([u])=>String(u).includes('/RunAgent'))).toHaveLength(1);
    expect(subscriptions).toBe(2);
    expect(fetcher.mock.calls.filter(([u])=>String(u).includes('/SubscribeSessionEvents')).every(([u])=>String(u).includes('CommandId='+commandId))).toBe(true);
  });
  it('releases an open subscription when a durable control terminal arrives', async () => {
    const cancelled=vi.fn();
    const api={runAgent:async()=>bytes(JSON.stringify({Data:{ReceiptStatus:'accepted',CommandId:commandId}})),
      subscribeSessionEvents:async()=>new ReadableStream<Uint8Array>({start(c){c.enqueue(encode([
        {seq:501,family:'control',event_type:'control.run_transition',run_id:'root-run-1',state:'completed'},
      ]))},cancel:cancelled}),
    } as unknown as ApiFacade;
    const engine=createRunEngine(api);const settled=vi.fn();
    engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph',selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true});
    engine.start({text:'task',sessionId:'session',attachments:[],onSettled:settled});
    await vi.waitFor(()=>expect(settled).toHaveBeenCalledWith('session','completed'));
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it.each(['accepted', 'duplicate'])('shows remote text before completion and reconnects from the same session cursor: %s', async status => {
    const frames = framesFor('root-run-1');
    let first!: ReadableStreamDefaultController<Uint8Array>;
    const api = {
      runAgent: vi.fn(async () => bytes(JSON.stringify({Data: {ReceiptStatus: status, CommandId: commandId, AcceptedSeq: 1, PresentationProfile: 'agent-block-v1'}}))),
      subscribeSessionEvents: vi.fn()
        .mockImplementationOnce(async () => new ReadableStream<Uint8Array>({ start(c) {
          first = c; c.enqueue(encode([{seq:500, family:'control',event_type:'control.run_transition',run_id:'root-run-1'}, ...frames.slice(0,13)]));
        } }))
        .mockImplementationOnce(async () => bytes(new TextDecoder().decode(encode(frames.slice(13))))),
    } as unknown as ApiFacade;
    const engine = createRunEngine(api);
    engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph', selectedModel:'',thinkingMode:'auto',
      kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true,presentationProfile:'agent-block-v1'});
    const snapshots: Extract<RunEvent,{type:'conversation_snapshot'}>[] = [];
    engine.subscribe(e => {if(e.type==='conversation_snapshot') snapshots.push(e)});
    const settled = vi.fn();
    engine.start({text:'remote',sessionId:'session',attachments:[],onSettled:settled});
    await vi.waitFor(() => expect(JSON.stringify(snapshots.at(-1)?.result.presentation.timeline)).toContain('first answer'));
    expect(snapshots.at(-1)?.result.presentation.timeline[0].item.kind).toBe('agent');
    expect(snapshots.at(-1)?.result.presentation.terminalStatus).toBeUndefined();
    expect(settled).not.toHaveBeenCalled();
    expect(api.subscribeSessionEvents).toHaveBeenNthCalledWith(1,'session',0,expect.objectContaining({commandId}));
    first.error(new TypeError('network disconnected'));
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith('session','completed'), {timeout:3000});
    expect(api.subscribeSessionEvents).toHaveBeenNthCalledWith(2,'session',513,expect.objectContaining({commandId}));
    expect(JSON.stringify(snapshots.at(-1)?.result.presentation.timeline)).toContain('second answer');
    expect(snapshots.at(-1)?.result.presentation.output).toBe('Root final answer');
  });

  it('keeps consecutive turns in the same session independent', async () => {
    let turn = 0;
    const api = {
      runAgent: vi.fn(async () => {turn++; return bytes(JSON.stringify({Data:{ReceiptStatus:'accepted',CommandId:`command-${turn}`,PresentationProfile:'agent-block-v1'}}))}),
      subscribeSessionEvents: vi.fn(async () => bytes(new TextDecoder().decode(encode(framesFor(`run-${turn}`))))),
    } as unknown as ApiFacade;
    const engine = createRunEngine(api);
    engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph',selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true,presentationProfile:'agent-block-v1'});
    for (let i=1;i<=2;i++) {
      const settled=vi.fn(); engine.start({text:`turn ${i}`,sessionId:'session',attachments:[],onSettled:settled});
      await vi.waitFor(()=>expect(settled).toHaveBeenCalledWith('session','completed'));
      expect(api.subscribeSessionEvents).toHaveBeenNthCalledWith(i,'session',0,expect.objectContaining({commandId:`command-${i}`}));
    }
  });

  it('fails closed on missing command identity without replaying the whole session', async () => {
    const api = {runAgent:vi.fn(async()=>bytes(JSON.stringify({Data:{ReceiptStatus:'accepted',AcceptedSeq:1}}))),subscribeSessionEvents:vi.fn()} as unknown as ApiFacade;
    const engine=createRunEngine(api);const settled=vi.fn();
    engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph',selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true});
    engine.start({text:'task',sessionId:'session',attachments:[],onSettled:settled});
    await vi.waitFor(()=>expect(settled).toHaveBeenCalledWith('session','failed'));
    expect(api.subscribeSessionEvents).not.toHaveBeenCalled();
  });

  it('polls a queued command without selecting another run or resubmitting the prompt', async () => {
    const api = {
      runAgent:vi.fn(async()=>bytes(JSON.stringify({Data:{ReceiptStatus:'accepted',CommandId:commandId,PresentationProfile:'agent-block-v1'}}))),
      subscribeSessionEvents:vi.fn().mockRejectedValueOnce(new ApiError(409,'queued',{Data:{ReasonCode:'KERNEL_COMMAND_PENDING'}}))
        .mockResolvedValueOnce(bytes(new TextDecoder().decode(encode(framesFor('root-run-1'))))),
    } as unknown as ApiFacade;
    const engine=createRunEngine(api);const settled=vi.fn();
    const phases: string[] = [];
    engine.subscribe(event => { if (event.type === 'activity') phases.push(event.phase); });
    engine.updateConfig({agentId:'agent',apiFormats:['responses'],agentFramework:'langgraph',selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true,presentationProfile:'agent-block-v1'});
    engine.start({text:'task',sessionId:'session',attachments:[],onSettled:settled});
    await vi.waitFor(()=>expect(settled).toHaveBeenCalledWith('session','completed'),{timeout:3000});
    expect(api.runAgent).toHaveBeenCalledTimes(1);
    expect(api.subscribeSessionEvents).toHaveBeenCalledTimes(2);
    expect(phases.indexOf('运行已入队，等待执行')).toBeGreaterThanOrEqual(0);
    expect(phases.indexOf('正在处理')).toBeGreaterThan(phases.indexOf('运行已入队，等待执行'));
  });
});

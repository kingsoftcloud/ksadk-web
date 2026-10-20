import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RunEngineImpl, dispatchRunEventToStores } from '../../src/core/run/index.js';
import { useSessionStore } from '../../src/stores/session.js';
import { useMessageStore } from '../../src/stores/message.js';
import { useStreamingStore } from '../../src/stores/streaming.js';
import { ChatMessageList } from '../../src/public/chat-timeline.js';
import { ApiFacadeImpl } from '../../src/core/api/facade.js';
import fixture from '../../src/__tests__/fixtures/a2a_remote_agent/v1/a2a_stream_tool_terminal.jsonl?raw';
import '../../src/index.css';

// Synthetic transport, production RunEngine / stores / AgentBlock renderer.
const frames = fixture.trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.kind==='runtime_event').map(row=>row.payload);
let turn=0, sent=0, attempts=0, current:ReadableStreamDefaultController<Uint8Array>;
const encode=(items:Record<string,unknown>[])=>new TextEncoder().encode(items.map(f=>`data: ${JSON.stringify(f)}\n\n`).join(''));
const runFrames=()=>frames.map((f,i)=>({...f,run_id:`run-${turn}`,event_id:`turn-${turn}:${f.event_id}`,family:'runtime',seq:500*turn+i+1,
  ...(f.parent_scope_id && f.item_kind==='message'?{item_kind:'artifact'}:{})}));
const emit=(until:number)=>{current.enqueue(encode(runFrames().slice(sent,until)));sent=until;};
const api=new ApiFacadeImpl({agentId:'fixture',fetch:async(url)=>{
  if(String(url).includes('/RunAgent')){turn++;sent=0;attempts=0;return new Response(JSON.stringify({Code:0,Data:{ReceiptStatus:'accepted',CommandId:`command-${turn}`,AcceptedSeq:1,PresentationProfile:'agent-block-v1'}}),{headers:{'content-type':'application/json'}})}
  if(String(url).includes('/SubscribeSessionEvents')){
    if(++attempts===1)return new Response(JSON.stringify({Code:409,Message:'Kernel command is waiting for its run',Data:{ReasonCode:'KERNEL_COMMAND_PENDING'}}),{status:409,headers:{'content-type':'application/json'}});
    return new Response(new ReadableStream<Uint8Array>({start(c){current=c;emit(7)}}),{headers:{'content-type':'text/event-stream'}});
  }
  throw new Error('Unexpected fixture request');
}});
const engine=new RunEngineImpl(api);
engine.updateConfig({agentId:'fixture',apiFormats:['responses'],agentFramework:'langgraph',selectedModel:'',thinkingMode:'auto',kernelSessionEventsEnabled:true,kernelCommandEventsEnabled:true,presentationProfile:'agent-block-v1'});
engine.subscribe(e=>dispatchRunEventToStores(e));
useSessionStore.getState().setCurrentSessionId('session');

function App(){
  const [step,setStep]=useState(0);const [round,setRound]=useState(0);
  const messages=useMessageStore(s=>s.messages);const streaming=useStreamingStore(s=>s.isStreaming);
  const activity=useStreamingStore(s=>s.activity);const scrollRef=useRef<HTMLDivElement>(null);
  return <main className="mx-auto max-w-4xl p-6">
    <h1 className="mb-4 text-lg">A2A 原生卡片 · 本地回归（模拟传输）</h1>
    <nav className="mb-4 flex gap-4">
      <button disabled={streaming} onClick={()=>{engine.start({text:'remote test',attachments:[],sessionId:'session'});setStep(1);setRound(round+1)}}>开始下一轮</button>
      <button disabled={step!==1 || sent===0} onClick={()=>{emit(13);setStep(2)}}>追加远端文字和工具</button>
      <button disabled={step!==2} onClick={()=>{emit(19);setStep(3)}}>远端完成</button>
      <button disabled={step!==3} onClick={()=>{emit(22);current.close();setStep(4)}}>调用者完成</button>
    </nav>
    <p className="mb-4">第 {round} 轮 · {streaming?'运行中':'空闲'} · 同一 session · 每轮先返回一次真实 HTTP 409 排队响应</p>
    <ChatMessageList agentName="Fixture caller" isMobile={false} isStreaming={streaming} activity={activity}
      contextIndicator={null} messages={messages} scrollRef={scrollRef} onDeleteFeedback={()=>{}} onSubmitFeedback={()=>{}}
      onOpenAttachmentPreview={()=>{}} onRespondToApproval={()=>{}} />
  </main>
}
createRoot(document.getElementById('root')!).render(<App/>);

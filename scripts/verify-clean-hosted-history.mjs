// Local-only clean Docker acceptance; discovery fixture, real history transport.
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs';
const root=process.env.HISTORY_ACCEPTANCE_OUTPUT;
if(!root)throw Error('HISTORY_ACCEPTANCE_OUTPUT with local-bootstrap.json is required');
const browser=await chromium.launch({headless:true});const results=[];
try {for(const variant of ['old','new']){
 const agent=variant==='old'?'official-old-history':'local-heavy-history';
 const prefix=variant==='old'?'official-old-':'local-heavy-';
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});const page=await ctx.newPage();
 const calls=[],errors=[];let closing=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/agentengine/api/v1/*',async route=>{
  try{
   const action=new URL(route.request().url()).pathname.split('/').pop();
   const request=route.request().postDataJSON()||{};
   if(action==='GetAgentUiBootstrap'){
    // Discovery-only fixture; all session lists/history below traverse actual
    // Server -> Gateway -> Runtime -> PostgreSQL. Application code is baked.
    const b=JSON.parse(fs.readFileSync(root+'/local-bootstrap.json'));
    b.Data.Agent.AgentId=agent;b.Data.Agent.Name=agent;
    return await route.fulfill({json:b});
   }
   const history=['ListSessions','GetSession','ListSessionMessages','ListSessionEvents','SubscribeSessionEvents'].includes(action);
   const response=await route.fetch({url:(history?'http://127.0.0.1:18092':'http://127.0.0.1:18090')+'/agentengine/api/v1/'+action,
    headers:{...route.request().headers(),'X-Ksc-Account-Id':'acceptance','X-Auth-Agent-Id':agent},timeout:15000});
   const body=await response.json();calls.push({action,request,code:body.Code,message:body.Message,reason:body.ReasonCode,data:body.Data});fs.writeFileSync(root+'/browser-calls-'+variant+'.json',JSON.stringify(calls,null,2));
   await route.fulfill({response});
  }catch(e){if(!closing&&!page.isClosed())throw e;}
 });
 const transcript=()=>page.locator('div.scroll-smooth.overflow-y-auto');
 await page.goto('http://127.0.0.1:4189/hosted-ui/chat/',{waitUntil:'domcontentloaded'});
 await expect.poll(()=>calls.some(x=>x.action==='ListSessions'&&x.code===0),{timeout:30000}).toBe(true);
 for(const slot of ['A','B','C']){
  const sid=prefix+slot;
  const listing=calls.find(x=>x.action==='ListSessions'&&x.data?.Sessions?.some(s=>s.SessionId===sid));
  if(!listing)throw Error('Session absent '+sid);
  const session=listing.data.Sessions.find(s=>s.SessionId===sid);
  await page.getByPlaceholder('搜索会话、模型或摘要').fill(sid);
  await page.locator('aside div.group > button').first().click();
  await page.getByPlaceholder('搜索会话、模型或摘要').fill('');
  const marker='LGHEAVY_'+variant+'_'+slot+'_R'+(variant==='old'?'0003':'0024');
  await expect(transcript()).toContainText('REPORT_END '+marker,{timeout:30000});
  await expect(page.getByText(marker,{exact:true})).toBeAttached();
  const text=await transcript().innerText();
  if((text.match(/LGHEAVY_(?:old|new)_[ABC]_R\d{4}/g)||[]).some(x=>!x.startsWith('LGHEAVY_'+variant+'_'+slot+'_')))throw Error('Cross-session text');
  results.push({variant,slot,user:true,completeReport:true});console.log(JSON.stringify(results.at(-1)));
 }
 let older={request:{},code:0};
 if(variant==='new'){
 const before=calls.length;
 await transcript().evaluate(el=>el.scrollTo({top:el.scrollHeight,behavior:'instant'}));
 await page.waitForTimeout(200);const box=await transcript().boundingBox();
 await page.mouse.move(box.x+box.width/2,box.y+150);await page.mouse.wheel(0,-10000000);
 await expect.poll(()=>calls.slice(before).some(x=>x.action==='ListSessionMessages'&&x.request.BeforeSeqId!=null),{timeout:20000}).toBe(true);
 older=calls.slice(before).find(x=>x.action==='ListSessionMessages'&&x.request.BeforeSeqId!=null);
 expect(older.code).toBe(0);expect(Boolean(older.request.HistoryEpoch)).toBe(variant==='new');
 }
 await page.screenshot({path:root+'/clean-hosted-'+variant+'-chat.png'});
 for(const surface of ['tui','workspace']){
  await page.goto('http://127.0.0.1:4189/hosted-ui/'+surface+'/',{waitUntil:'domcontentloaded'});
  await expect.poll(()=>page.locator('#root').innerText()).not.toBe('');
  await page.waitForTimeout(1000);
  const text=await page.locator('#root').innerText();expect(text.length).toBeGreaterThan(30);
  await page.screenshot({path:root+'/clean-hosted-'+variant+'-'+surface+'.png'});
  results.push({variant,surface,chars:text.length,errors:[...errors]});
 }
 expect(errors).toEqual([]);
 results.push({variant,pagination:variant==='new',epoch:!!older.request.HistoryEpoch,calls:calls.map(x=>({action:x.action,code:x.code,session:x.request.SessionId}))});
 closing=true;await ctx.close();
}}finally{fs.writeFileSync(root+'/clean-hosted-browser.json',JSON.stringify(results,null,2));await browser.close();}

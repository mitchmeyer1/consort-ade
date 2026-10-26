import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { slackMasterMonitor, MASTER_MONITOR_HEADING } from '../src/shared/slackMonitor.ts';
import * as monitor from '../src/shared/slackMonitor.ts';
import * as headless from '../src/shared/headless.ts';
const require=createRequire(import.meta.url);
const compiled=ts.transpileModule(readFileSync(new URL('../src/cli/slackMonitor.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const now=Date.UTC(2026,9,26,14,0);
const task=(over={})=>({id:'t',jobId:'j',ticket:{id:'ticket-1',title:'Export locations',url:'https://app.clickup.com/t/ticket-1'},status:'working',pid:5,slackThread:'123.456',feature:{stage:'Implementing',prs:['https://github.com/acme/repo/pull/1']},accountIds:{},startedAt:now-600000,updatedAt:now,...over});
function fixture(over={}) {
  const state={accounts:[],jobs:[],tasks:[task()],slack:{botToken:'secret',userId:'owner',channel:'C123'},...over};
  const calls=[];let existing,failPost,failUpdate,failLink;
  const slack={removeDuplicateMonitors:async keep=>{calls.push(['cleanup',keep]);},channel:async()=>state.slack.channel,findMonitor:async()=>{calls.push(['find']);return existing;},permalink:async ts=>{calls.push(['link',ts]);if(failLink)throw failLink;return `https://example.slack.com/archives/C123/p${ts.replace('.','')}`;},postMonitor:async text=>{calls.push(['post',text]);if(failPost)throw failPost;return 'monitor-ts';},updateMonitor:async(ts,text)=>{calls.push(['update',ts,text]);if(failUpdate){const err=failUpdate;failUpdate=undefined;throw err;}}};
  const mocks={'../shared/slackMonitor.ts':monitor,'../shared/headless.ts':headless,'./state':{loadState:()=>state,mutateState:fn=>fn(state)},'./slack':{Slack:class{}},'./daemonctl':{alive:()=>true},'./usage':{cachedUsage:()=>new Map()}};
  const mod={exports:{}};new Function('require','module','exports',compiled)(n=>mocks[n]??require(n),mod,mod.exports);
  return {state,calls,run:(at=now)=>mod.exports.refreshSlackMonitor(at,()=>slack),existing:ts=>{existing=ts;},failLink:err=>{failLink=err;},failPost:err=>{failPost=err;},failUpdate:err=>{failUpdate=err;}};
}
test('master monitor has three sections, linked ticket titles, costs and safe account meters',()=>{
  const text=slackMasterMonitor({tasks:[task(),task({id:'done',status:'done',finishedAt:now-60000,slackThread:'789.1',ticket:{id:'done',title:'Fix map tiles',url:'https://ticket/2'}})],jobs:[],accounts:[{id:'c',provider:'claude',name:'private@example.com',apiKey:'SECRET'}]},new Map([['t','https://example.slack.com/thread/1'],['done','https://example.slack.com/thread/2']]),now,()=>true,new Map([['c',{at:now,windows:[{label:'5-hour',percent:25}]}]]));
  assert.ok(text.startsWith(MASTER_MONITOR_HEADING));
  for(const section of ['*Working*','*Completed · most recent 6*','*Accounts*'])assert.ok(text.includes(section));
  assert.match(text,/<https:\/\/example.slack.com\/thread\/1\|Export locations>/);
  assert.match(text,/<https:\/\/example.slack.com\/thread\/2\|Fix map tiles>/);
  assert.match(text,/^🔄 .*Export locations.*RUNNING/m);
  assert.match(text,/^🎉🍭🎊 .*Fix map tiles/m);
  assert.match(text,/Claude 1.*5-hour 25%/);
  assert.doesNotMatch(text,/private@example.com|SECRET/);
  if(process.env.CONSORT_SCREENSHOT_FIXTURE){const html=text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/&lt;(https:\/\/[^|]+)\|([^&]+)&gt;/g,'<a href="$1">$2</a>').replace(/\*([^*]+)\*/g,'<strong>$1</strong>');writeFileSync('.consort/slack-master-preview.html',`<!doctype html><meta charset="utf-8"><title>Slack master monitor preview</title><style>body{background:#1a1d21;color:#ddd;font:16px/1.8 system-ui;padding:32px;max-width:1000px}a{color:#5bbbea}pre{font:inherit;white-space:pre-wrap}strong{color:white}</style><p>Monitor preview — test data</p><pre>${html}</pre>`);}
});
test('creates one root and updates it in place; unchanged content does not post again',async()=>{
  const f=fixture();await f.run();await f.run();await f.run(now+60000);
  assert.equal(f.calls.filter(c=>c[0]==='post').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='update').length,1);
  assert.equal(f.state.slackMonitor.ts,'monitor-ts');
  assert.equal(f.state.slackMonitor.lease,undefined);
  assert.match(f.calls.find(c=>c[0]==='post')[1],/<https:\/\/example.slack.com\/archives/);
});
test('saved master timestamp and channel survive restart without making a new root',async()=>{
  const f=fixture({slackMonitor:{channel:'C123',ts:'saved-ts'}});await f.run();
  assert.ok(f.calls.some(c=>c[0]==='update'&&c[1]==='saved-ts'));
  assert.ok(!f.calls.some(c=>c[0]==='post'||c[0]==='find'));
});
test('finds an existing monitor before first creation',async()=>{
  const f=fixture();f.existing('found-ts');await f.run();
  assert.equal(f.state.slackMonitor.ts,'found-ts');assert.ok(!f.calls.some(c=>c[0]==='post'));
});
test('concurrent refreshes share one creation',async()=>{
  const f=fixture();await Promise.all([f.run(),f.run(),f.run()]);assert.equal(f.calls.filter(c=>c[0]==='post').length,1);
});
test('a cross-process lease prevents a second creator',async()=>{
  const f=fixture({slackMonitor:{channel:'C123',lease:{id:'other',until:now+10000}}});await f.run();assert.equal(f.calls.length,0);
});
test('ambiguous creation failure is recovered by discovery without blind duplicate posting',async()=>{
  const f=fixture();f.failPost(new TypeError('fetch failed'));await assert.rejects(f.run(),/fetch failed/);
  await assert.rejects(f.run(),/interrupted/);assert.equal(f.calls.filter(c=>c[0]==='post').length,1);
  f.existing('recovered-ts');await f.run();assert.equal(f.state.slackMonitor.ts,'recovered-ts');
});
test('deleted monitor is rediscovered or recreated on the next refresh',async()=>{
  const f=fixture({slackMonitor:{channel:'C123',ts:'deleted-ts'}});f.failUpdate(new Error('Slack chat.update: message_not_found'));
  await assert.rejects(f.run(),/message_not_found/);await f.run();assert.equal(f.state.slackMonitor.ts,'monitor-ts');
});
test('changing destination does not edit the old channel monitor',async()=>{
  const f=fixture({slackMonitor:{channel:'OLD',ts:'old-ts'}});await f.run();assert.equal(f.state.slackMonitor.channel,'C123');assert.ok(!f.calls.some(c=>c[1]==='old-ts'));
});

test('Slack monitor API posts a root without a thread or broadcast and resolves ticket permalinks',async()=>{
  const { Slack }=await import('../src/cli/slack.ts');const calls=[];
  const slack=new Slack({botToken:'test-token',userId:'owner',channel:'C1'},async(url,init)=>{
    const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method,body});
    const response=method==='chat.getPermalink'?{ok:true,permalink:'https://example.slack.com/archives/C1/p123456'}:{ok:true,ts:'master-ts'};
    return new Response(JSON.stringify(response));
  },text=>text);
  await slack.postMonitor(MASTER_MONITOR_HEADING);await slack.updateMonitor('master-ts','Updated monitor');
  assert.equal(await slack.permalink('123.456'),'https://example.slack.com/archives/C1/p123456');
  for(const c of calls.filter(c=>['chat.postMessage','chat.update'].includes(c.method))){assert.equal(c.body.thread_ts,undefined);assert.equal(c.body.reply_broadcast,undefined);}
  assert.equal(calls[0].body.text,MASTER_MONITOR_HEADING);
  assert.equal(calls.at(-1).body.channel,'C1');
  assert.equal(calls.at(-1).body.conversation_id,undefined);
  assert.equal(calls.at(-1).body.message_ts,'123.456');
});
test('monitor discovery pages history and accepts only this bot’s root',async()=>{
  const { Slack }=await import('../src/cli/slack.ts');let pages=0;
  const slack=new Slack({botToken:'test',userId:'owner',channel:'C1'},async(url)=>{
    if(String(url).endsWith('auth.test'))return new Response(JSON.stringify({ok:true,user_id:'BOT'}));
    const messages=++pages===1?[{ts:'human',user:'owner',text:MASTER_MONITOR_HEADING},{ts:'reply',user:'BOT',text:MASTER_MONITOR_HEADING,thread_ts:'parent'}]:[{ts:'original',user:'BOT',text:MASTER_MONITOR_HEADING.replace('📊',':bar_chart:')}];
    return new Response(JSON.stringify({ok:true,messages,has_more:pages===1,response_metadata:{next_cursor:pages===1?'next':''}}));
  },text=>text);
  assert.equal(await slack.findMonitor(MASTER_MONITOR_HEADING),'original');assert.equal(pages,2);
});

test('existing Slack setup creates a monitor without setup migration or tickets',async()=>{
  const f=fixture({tasks:[]});await f.run();
  assert.equal(f.calls.filter(c=>c[0]==='post').length,1);
  assert.equal(f.state.slackMonitor.ts,'monitor-ts');
});
test('failed ticket permalink still creates the monitor and retries the link next refresh',async()=>{
  const f=fixture();f.failLink(new Error('Slack chat.getPermalink: message_not_found'));await f.run();
  assert.equal(f.calls.filter(c=>c[0]==='post').length,1);
  assert.match(f.calls.find(c=>c[0]==='post')[1],/Slack thread pending/);
  f.failLink(undefined);await f.run(now+60000);
  assert.match(f.calls.find(c=>c[0]==='update')[2],/<https:\/\/example.slack.com\/archives/);
});

test('long monitors use bounded Slack blocks for both creation and edits',async()=>{
  const {Slack}=await import('../src/cli/slack.ts');const calls=[];
  const slack=new Slack({botToken:'test',userId:'owner',channel:'C1'},async(url,init)=>{
    calls.push(Object.fromEntries(new URLSearchParams(init.body)));
    return new Response(JSON.stringify({ok:true,ts:'monitor'}));
  },text=>text.replaceAll('SECRET','MASKED'));
  const text=MASTER_MONITOR_HEADING+'\n'+Array(40).fill('Ticket SECRET '+'x'.repeat(150)).join('\n');
  await slack.postMonitor(text);await slack.updateMonitor('monitor',text);
  for(const body of calls){
    const blocks=JSON.parse(body.blocks);assert.ok(blocks.length>1);
    assert.ok(blocks.every(b=>b.text.text.length<=3000));
    assert.ok(blocks[0].text.text.startsWith(MASTER_MONITOR_HEADING));
    assert.doesNotMatch(JSON.stringify(blocks),/SECRET/);
    assert.match(blocks.map(b=>b.text.text).join('\n'),/MASKED/);
    assert.equal(body.thread_ts,undefined);
  }
});

test('duplicate cleanup deletes only obsolete own monitor roots without replies',async()=>{
  const {Slack}=await import('../src/cli/slack.ts');const removed=[];
  const slack=new Slack({botToken:'test',userId:'owner',channel:'C1'},async(url,init)=>{
    const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));
    if(method==='auth.test')return Response.json({ok:true,user_id:'BOT'});
    if(method==='chat.delete'){removed.push(body.ts);return Response.json({ok:true});}
    return Response.json({ok:true,messages:[
      {ts:'keep',user:'BOT',text:MASTER_MONITOR_HEADING},
      {ts:'old',user:'BOT',text:MASTER_MONITOR_HEADING.replace('📊',':bar_chart:')+'\nUpdated earlier'},
      {ts:'discussion',user:'BOT',text:MASTER_MONITOR_HEADING,reply_count:1},
      {ts:'human',user:'owner',text:MASTER_MONITOR_HEADING},
      {ts:'ticket',user:'BOT',text:'Ticket status'},
      {ts:'reply',user:'BOT',text:MASTER_MONITOR_HEADING,thread_ts:'ticket'},
    ]});
  },text=>text);
  await slack.removeDuplicateMonitors('keep',MASTER_MONITOR_HEADING);assert.deepEqual(removed,['old']);
  await assert.rejects(slack.removeDuplicateMonitors('missing',MASTER_MONITOR_HEADING),/confirming/);
  assert.deepEqual(removed,['old']);
});

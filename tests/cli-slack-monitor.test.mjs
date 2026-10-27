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
  const slack={retireFiles:async ids=>{calls.push(['retire',ids]);},setUsageFile:u=>{calls.push(['usage-in',u]);},getUsageFile:()=>({file:'SHOWN',key:'k'}),pinMonitor:async ts=>{calls.push(['pin',ts]);},removeDuplicateMonitors:async keep=>{calls.push(['cleanup',keep]);},channel:async()=>state.slack.channel,findMonitor:async()=>{calls.push(['find']);return existing;},permalink:async ts=>{calls.push(['link',ts]);if(failLink)throw failLink;return `https://example.slack.com/archives/C123/p${ts.replace('.','')}`;},postMonitor:async text=>{calls.push(['post',text]);if(failPost)throw failPost;return 'monitor-ts';},updateMonitor:async(ts,text)=>{calls.push(['update',ts,text]);if(failUpdate){const err=failUpdate;failUpdate=undefined;throw err;}}};
  const mocks={'./slackMonitorAuthors':{monitorAuthors:async()=>new Map()},'../shared/slackMonitor.ts':monitor,'../shared/headless.ts':headless,'./state':{loadState:()=>state,mutateState:fn=>fn(state)},'./slack':{Slack:class{}},'./daemonctl':{alive:()=>true},'./usage':{cachedUsage:()=>new Map()}};
  const mod={exports:{}};new Function('require','module','exports',compiled)(n=>mocks[n]??require(n),mod,mod.exports);
  return {state,calls,run:(at=now)=>mod.exports.refreshSlackMonitor(at,()=>slack),existing:ts=>{existing=ts;},failLink:err=>{failLink=err;},failPost:err=>{failPost=err;},failUpdate:err=>{failUpdate=err;}};
}
test('master monitor has four sections, linked ticket titles, costs and safe account meters',()=>{
  const text=slackMasterMonitor({tasks:[task(),task({id:'attention',status:'waiting',pauseReason:'Approve the review in its Slack thread',ticket:{id:'attention',title:'Review needs your reply'}}),task({id:'ready',status:'ready',finishedAt:now-120000,slackThread:'456.1',ticket:{id:'ready',title:'Fix Sentry batching',url:'https://ticket/ready'}}),task({id:'done',status:'done',finishedAt:now-60000,slackThread:'789.1',ticket:{id:'done',title:'Fix map tiles',url:'https://ticket/2'}})],jobs:[],accounts:[{id:'c',provider:'claude',name:'private@example.com',apiKey:'SECRET'},{id:'blocked',provider:'claude',blockedUntil:now+3600000,blockedWhy:'5-hour limit reached'},{id:'codex',provider:'codex'}]},new Map([['t','https://example.slack.com/thread/1'],['done','https://example.slack.com/thread/2'],['ready','https://example.slack.com/thread/ready']]),now,()=>true,new Map([['c',{at:now,windows:[{label:'5-hour',percent:25}]}],['blocked',{at:now,windows:[{label:'5-hour',percent:100,resetsAt:now+3600000}]}],['codex',{at:now,windows:[{label:'5-hour',percent:100}]}]]),new Map([['t','mitchmeyer1'],['done','pmonco'],['ready','mitchmeyer1']]));
  assert.ok(text.startsWith(MASTER_MONITOR_HEADING));
  for(const section of ['*Working*','*Ready to merge · your action*','*Completed · most recent 6*','*Accounts*'])assert.ok(text.includes(section));
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

test('monitor labels review, feature and Sentry rows with actual GitHub authors',()=>{
  const tasks=[task({id:'review',kind:'review',review:{author:'pmonco',url:'https://github.com/acme/repo/pull/2'}}),task({id:'feature'}),task({id:'sentry',jobId:'sentry-worker'}),task({id:'new',feature:{stage:'Implementing',prs:[]}})];
  const text=slackMasterMonitor({tasks,jobs:[{id:'sentry-worker',sentryProducerId:'producer'}],accounts:[]},new Map(),now,()=>true,new Map(),new Map([['feature','mitchmeyer1'],['sentry','sentry-builder']]));
  assert.match(text,/🔄 Review .*author: <https:\/\/github.com\/pmonco\|@pmonco>/);
  assert.match(text,/🔄 Feature .*author: <https:\/\/github.com\/mitchmeyer1\|@mitchmeyer1>/);
  assert.match(text,/🔄 Sentry .*author: <https:\/\/github.com\/sentry-builder\|@sentry-builder>/);
  assert.match(text,/🔄 Feature .*PR not created/);
});

test('author lookup uses the PR author, caches successes and retries failures',async()=>{
  const source=ts.transpileModule(readFileSync(new URL('../src/cli/slackMonitorAuthors.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod={exports:{}};new Function('require','module','exports',source)(require,mod,mod.exports);
  const tasks=[task(),task({id:'review',kind:'review',review:{author:'pmonco'}}),task({id:'no-pr',feature:{prs:[]}})];
  let calls=0;const lookup=async()=>{calls++;if(calls===1)throw Error('offline');return 'actual-pr-author';};
  const first=await mod.exports.monitorAuthors(tasks,lookup);assert.equal(first.get('t'),undefined);assert.equal(first.get('review'),'pmonco');
  const second=await mod.exports.monitorAuthors(tasks,lookup);assert.equal(second.get('t'),'actual-pr-author');
  await mod.exports.monitorAuthors(tasks,lookup);assert.equal(calls,2);
});

test('account colors use the highest window with exact usage boundaries and blocked overrides',()=>{
  for(const [percent,icon] of [[0,'🟢'],[50,'🟢'],[51,'🟡'],[89,'🟡'],[90,'🟠'],[99,'🟠'],[100,'🔴'],[105,'🔴']]){
    const text=slackMasterMonitor({tasks:[],jobs:[],accounts:[{id:'a',provider:'claude'}]},new Map(),now,()=>true,new Map([['a',{at:now,windows:[{label:'5-hour',percent:0},{label:'Weekly',percent}]}]]));
    assert.ok(text.includes(icon+' Claude 1'),`${percent}% should show ${icon}`);
    if(percent>=100)assert.match(text,/Claude 1 · blocked/);
  }
  for(const over of [{blockedUntil:now+60000},{}]){
    const usage={at:now,windows:[{label:'5-hour',percent:10}],...(over.blockedUntil?{}:{blocked:'credits exhausted'})};
    const text=slackMasterMonitor({tasks:[],jobs:[],accounts:[{id:'a',provider:'codex',...over}]},new Map(),now,()=>true,new Map([['a',usage]]));
    assert.match(text,/🔴 Codex 1/);
  }
  const missing=slackMasterMonitor({tasks:[],jobs:[],accounts:[{id:'a',provider:'claude'}]},new Map(),now,()=>true);
  assert.match(missing,/⚪ Claude 1 · usage unavailable/);
});

test('an open account line carries its last weekly window reset: the model weekly where there is one, else the weekly',()=>{
  const render=(provider,windows)=>slackMasterMonitor({tasks:[],jobs:[],accounts:[{id:'a',provider}]},new Map(),now,()=>true,new Map([['a',{at:now,windows}]]));
  const claude=render('claude',[{label:'5-hour',percent:10,resetsAt:now+3600000},{label:'Weekly',percent:20,resetsAt:now+86400000},{label:'Weekly · Fable',percent:30,resetsAt:now+2*86400000}]);
  assert.match(claude,/Weekly · Fable 30% · resets Oct 28, 10:00 AM EDT · usage 0m ago$/m);
  assert.match(render('codex',[{label:'5-hour',percent:10,resetsAt:now+3600000},{label:'Weekly',percent:20,resetsAt:now+86400000}]),/Weekly 20% · resets Oct 27, 10:00 AM EDT · usage/);
  assert.doesNotMatch(render('codex',[{label:'5-hour',percent:10,resetsAt:now+3600000}]),/resets/,'a 5-hour reset is not shown');
});

test('blocked accounts show only the reason and latest applicable Eastern resume time',()=>{
  const render=(at,account,windows)=>slackMasterMonitor({tasks:[],jobs:[],accounts:[{id:'a',provider:'claude',...account}]},new Map(),at,()=>true,new Map([['a',{at,windows}]]));
  const text=render(now,{blockedUntil:now+3600000,blockedWhy:'5-hour limit reached'},[{label:'5-hour',percent:100,resetsAt:now+3600000},{label:'Weekly',percent:10}]);
  assert.match(text,/🔴 Claude 1 · blocked: 5-hour limit reached · resume after Oct 26, 11:00 AM EDT/);
  assert.match(text,/resume after Oct 26, 11:00 AM EDT · 5-hour 100% · Weekly 10%$/m,"a blocked account keeps its windows for the panel");assert.doesNotMatch(text,/usage 0m/);
  const winter=Date.UTC(2026,11,1,14);
  assert.match(render(winter,{},[{label:'Weekly',percent:100,resetsAt:winter+3600000}]),/Dec 1, 10:00 AM EST/);
  assert.match(render(now,{},[{label:'Weekly',percent:100}]),/resume time unavailable/);
  assert.match(render(now,{blockedUntil:now+3600000},[{label:'Weekly',percent:100,resetsAt:now+7200000}]),/12:00 PM EDT/);
});

test('ready-to-merge tasks stay separate and visible beyond recent completed retention',async()=>{
 const ready=task({id:'old-ready',status:'ready',updatedAt:now-30*86400000,finishedAt:now-30*86400000,slackThread:'old.1',ticket:{id:'ready',title:'Old ready ticket',url:'https://ticket/ready'}});
 const done=Array.from({length:8},(_,i)=>task({id:'done-'+i,status:'done',updatedAt:now-i*1000,finishedAt:now-i*1000,ticket:{id:'d'+i,title:'Done '+i}}));
 const f=fixture({tasks:[task(),ready,...done]});await f.run();
 const text=f.calls.find(c=>c[0]==='post')[1];
 const [working,rest]=text.split('*Ready to merge · your action*');const [pending,completed]=rest.split('*Completed · most recent 6*');
 assert.doesNotMatch(working,/Old ready ticket/);assert.doesNotMatch(completed,/Old ready ticket/);
 assert.match(pending,/READY TO MERGE/);assert.match(pending,/<https:\/\/example.slack.com\/archives\/C123\/pold1\|Old ready ticket>/);
 assert.match(pending,/merge PR>/);assert.equal((completed.match(/^🎉🍭🎊 /gm)||[]).length,6);
 f.state.tasks.find(t=>t.id==='old-ready').status='done';f.state.tasks.find(t=>t.id==='old-ready').finishedAt=now;
 await f.run(now+60000);const updated=f.calls.find(c=>c[0]==='update')[2];
 assert.match(updated.split('*Ready to merge · your action*')[1].split('*Completed')[0],/No tickets waiting/);
 assert.match(updated.split('*Completed · most recent 6*')[1],/Old ready ticket/);
});

test('human attention is orange while a missing worker stays stopped',()=>{
 const text=slackMasterMonitor({tasks:[task({id:'wait',status:'waiting',ticket:{id:'wait',title:'Needs owner'}}),task({id:'stopped',pid:undefined,ticket:{id:'stopped',title:'Stopped worker'}})],accounts:[],jobs:[]},new Map(),now,()=>true);
 assert.match(text,/^🟠 .*Needs owner.*WAITING/m);assert.match(text,/^❌ .*Stopped worker.*STOPPED/m);
});
test('existing and newly created monitors are pinned once without additional posts',async()=>{
 for(const saved of [undefined,{channel:'C123',ts:'existing'}]){
   const f=fixture({slackMonitor:saved});await f.run();await f.run(now+60000);
   assert.equal(f.calls.filter(c=>c[0]==='pin').length,1);
   assert.equal(f.calls.filter(c=>c[0]==='post').length,saved?0:1);
 }
});
test('pin API uses the existing root timestamp and accepts already pinned',async()=>{
 const {Slack}=await import('../src/cli/slack.ts');const calls=[];
 const slack=new Slack({botToken:'test',userId:'owner',channel:'C1'},async(url,init)=>{
  calls.push({url,body:Object.fromEntries(new URLSearchParams(init.body))});return Response.json({ok:false,error:'already_pinned'});
 },text=>text);
 await slack.pinMonitor('monitor');assert.equal(calls[0].body.timestamp,'monitor');assert.ok(calls[0].url.endsWith('pins.add'));
});

test('uploads left in state by earlier layouts are retired, and the last usage panel carries over as the shown file',async()=>{
  const f=fixture({slackMonitor:{channel:'C123',ts:'monitor-ts',imageFiles:[{id:'IMG1',key:'a'},{id:'IMG2',key:'b'}],usageFile:'PANEL'}});
  await f.run();
  assert.deepEqual(f.calls.find(c=>c[0]==='retire')[1],['IMG1','IMG2']);
  assert.deepEqual(f.calls.find(c=>c[0]==='usage-in')[1],{file:'PANEL'});
  assert.equal(f.state.slackMonitor.imageFiles,undefined);assert.equal(f.state.slackMonitor.usageFile,undefined);
  assert.deepEqual(f.state.slackMonitor.usage,{file:'SHOWN',key:'k'},'what the Slack class reports after the edit is saved');
  const again=fixture({slackMonitor:{channel:'C123',ts:'monitor-ts',usage:{file:'KEEP',key:'k2'}}});
  await again.run();
  assert.ok(!again.calls.some(c=>c[0]==='retire'));assert.deepEqual(again.calls.find(c=>c[0]==='usage-in')[1],{file:'KEEP',key:'k2'});
});

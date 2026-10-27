import {test} from 'node:test';
import assert from 'node:assert/strict';
import {monitorBlockKit,bar} from '../src/cli/slackMonitorBlocks.ts';
import {Slack} from '../src/cli/slack.ts';
const text=`*📊 Consort master monitor*
Updated 2026-10-27 16:45 UTC

*Working*
🟠 Feature · <https://slack.example/thread|Curation &amp; parity> · author: <https://github.com/mitch|@mitch> · WAITING · Review 7/9 · $608 · 18m
   Confirm whether parity needs a separate task.
   <https://app.clickup.com/t/123|ticket> · <https://github.com/a/b/pull/1|github>
🔄 Sentry · Paging shard · author unavailable · RUNNING · Build 3/9 · cost pending · 2h
   Preparing the task
❌ Feature · Stopped one (Slack thread pending) · PR not created · STOPPED · Setup 1/9 · $1 · 1d
   Stopped for consort-cli stop
🔄 Sentry · Analysis only · RUNNING · Triage 2/3
   Reading the Sentry issue

*Ready to merge · your action*
📦 Review · <https://slack.example/ready|Ship it> · author: <https://github.com/pmonco|@pmonco> · READY TO MERGE · Approve 5/5 · $9 · ready 3m ago
   <https://github.com/a/b/pull/2|merge PR>

*Completed · most recent 6*
🎉🍭🎊 Feature · <https://slack.example/done|Finished one> · author: <https://github.com/mitch|@mitch> · DONE · Done 9/9 · $4 · finished 33m ago
   <https://app.clickup.com/t/9|ticket> · <https://github.com/a/b/pull/3|github>

*Accounts*
🟢 Claude 1 · available · 5-hour 42% · weekly 20% · usage 3m ago
🔴 Claude 2 · blocked: weekly limit reached · resume after Oct 28, 2:30 PM EDT
⚪ Codex 1 · usage unavailable

Open a ticket title to reply in its Slack thread. This monitor updates in place; ticket discussions stay in their own threads.

STATUS: MONITORING`;
const NOW=1700000000000;
const texts=blocks=>JSON.stringify(blocks);
const cards=blocks=>blocks.filter(b=>b.type==='card');
test('monitor opens with the header and counts, then groups in the order the owner acts',()=>{
 const blocks=monitorBlockKit(text,NOW);
 assert.equal(blocks[0].type,'header');assert.equal(blocks[0].text.text,'Consort');
 assert.match(blocks[1].elements[0].text,/^Updated <!date\^1793119500\^\{date_short_pretty\} \{time\}\|Updated 2026-10-27 16:45 UTC>/);
 assert.match(blocks[1].elements[0].text,/\*1\* needs your reply.*\*1\* ready to merge.*\*3\* working.*\*1\* completed/);
 const headings=blocks.filter(b=>b.type==='section'&&/^\*[A-Za-z ]+\*   ·   \d+$/.test(b.text.text)).map(b=>b.text.text);
 assert.deepEqual(headings,['*Needs your reply*   ·   1','*Ready to merge*   ·   1','*Working*   ·   3']);
 assert.deepEqual(cards(blocks).map(c=>c.title.text),['Curation &amp; parity','Ship it','Paging shard','Stopped one','Analysis only']);
 assert.deepEqual(blocks.filter(b=>b.type==='container').map(b=>b.title.text),['Completed','AI capacity']);
 assert.doesNotMatch(texts(blocks),/🟠|📦|🔄|✅|⚡|🎉/);
});
test('a task card carries who, cost, age, the action, the stage bar and link buttons with one primary action',()=>{
 const [reply,ready,sentry,stopped,analysis]=cards(monitorBlockKit(text,NOW));
 assert.equal(reply.subtitle.text,'Feature   ·   by <https://github.com/mitch|@mitch>   ·   $608   ·   18m');
 assert.equal(reply.body.text,'Confirm whether parity needs a separate task.');
 assert.equal(reply.subtext.text,'Review 7/9   ▰▰▰▰▰▰▱▱▱');
 assert.deepEqual(reply.actions.map(b=>[b.text.text,b.url,b.style]),[['Reply in thread','https://slack.example/thread','primary'],['ClickUp','https://app.clickup.com/t/123',undefined],['GitHub','https://github.com/a/b/pull/1',undefined]]);
 assert.deepEqual(ready.actions.map(b=>[b.text.text,b.style]),[['Open thread',undefined],['Merge PR','primary']]);
 assert.equal(ready.subtext.text,'Approve 5/5   ▰▰▰▰▰');
 assert.equal(sentry.subtitle.text,'Sentry   ·   author unavailable   ·   cost pending   ·   2h');assert.equal(sentry.actions,undefined);
 assert.equal(stopped.subtext.text,'Setup 1/9   ▱▱▱▱▱▱▱▱▱   ·   *STOPPED*   ·   _Slack thread pending_');
 assert.equal(analysis.subtitle.text,'Sentry');assert.equal(analysis.body.text,'Reading the Sentry issue');assert.equal(analysis.subtext.text,'Triage 2/3   ▰▱▱');
 const ids=new Set(cards(monitorBlockKit(text,NOW)).flatMap(c=>(c.actions??[]).map(b=>b.action_id)));assert.equal(ids.size,5);
 assert.ok(cards(monitorBlockKit(text,NOW)).every(c=>c.block_id&&(c.actions??[]).length<=3&&(c.actions??[]).filter(b=>b.style==='primary').length<=1));
});
test('completed work and AI capacity are tables inside titled containers',()=>{
 const blocks=monitorBlockKit(text,NOW);
 const [done,capacity]=blocks.filter(b=>b.type==='container');
 assert.equal(done.subtitle.text,'most recent 1');assert.equal(done.width,'full');assert.equal(done.is_collapsible,true);
 const doneTable=done.child_blocks[0];assert.equal(doneTable.type,'table');assert.equal(doneTable.block_id,`completed-table-${NOW}`);
 assert.deepEqual(doneTable.rows[0].map(c=>c.elements[0].elements[0].text),['Task','Author','Cost','Finished','Links']);
 const row=doneTable.rows[1];
 assert.deepEqual(row[0].elements[0].elements[0],{type:'link',url:'https://slack.example/done',text:'Finished one'});
 assert.deepEqual(row.slice(1,4).map(c=>c.text),['@mitch','$4','33m ago']);
 assert.ok(doneTable.column_settings.every(c=>c&&typeof c==='object'));assert.ok(doneTable.rows.flat().every(c=>c.type!=='raw_text'||c.text.length>0));
 assert.deepEqual(row[4].elements[0].elements.map(e=>e.url??e.text),['https://app.clickup.com/t/9','  ·  ','https://github.com/a/b/pull/3']);
 const usage=capacity.child_blocks[0];assert.equal(usage.type,'table');
 assert.deepEqual(usage.rows.slice(1).map(r=>r.map(c=>c.text??c.elements[0].elements[0].text)),[
  ['Claude 1','Available','▰▰▰▰▱▱▱▱▱▱  42%','5-hour 42% · weekly 20% · usage 3m ago'],
  ['Claude 2','Blocked','—','weekly limit reached · resume after Oct 28, 2:30 PM EDT'],
  ['Codex 1','Unavailable','—','no reading yet']]);
 assert.equal(bar(3,5),'▰▰▰▱▱');assert.equal(bar(2,40),'');
});
test('escaped characters are decoded for tables and plain text but kept for mrkdwn',()=>{
 const blocks=monitorBlockKit(text.replace('Finished one','Fix &amp; ship &lt;b&gt;'),NOW);
 const done=blocks.find(b=>b.type==='container').child_blocks[0];
 assert.equal(done.rows[1][0].elements[0].elements[0].text,'Fix & ship <b>');
 assert.equal(cards(blocks)[0].title.text,'Curation &amp; parity');
});
test('empty groups say so and non-monitor text gets no blocks',()=>{
 const empty=monitorBlockKit(text.replace(/\n\*Working\*[\s\S]*?\n\n\*Accounts\*/,'\n*Working*\nNo tasks in progress.\n\n*Ready to merge · your action*\nNo tickets waiting to be merged.\n\n*Completed · most recent 6*\nNo completed tasks yet.\n\n*Accounts*'),NOW);
 const all=texts(empty);
 for(const s of ['_Nothing needs your reply._','_Nothing waiting to be merged._','_No tasks in progress._','_No completed tasks yet._'])assert.ok(all.includes(s),s);
 assert.equal(cards(empty).length,0);
 assert.equal(monitorBlockKit('Content withheld by guard'),undefined);
 assert.equal(monitorBlockKit('*📊 Consort master monitor*\nUpdated monitor'),undefined);
});
test('forty open tasks stay inside fifty blocks with every link kept',()=>{
 const many=text.replace('🟠 Feature ·',Array.from({length:38},(_,i)=>`🔄 Feature · <https://slack.example/${i}|Task ${i}> · author: @mitch · RUNNING · Build 3/9 · $1 · 1m\n   Doing work number ${i}\n   <https://github.com/a/b/pull/${i}|github>\n`).join('')+'… 4 more tasks in the CLI\n🟠 Feature ·');
 const blocks=monitorBlockKit(many,NOW);assert.ok(blocks.length<=50,String(blocks.length));
 const all=texts(blocks);for(let i=0;i<38;i++)assert.ok(all.includes(`https://slack.example/${i}`),`missing task ${i}`);
 assert.match(all,/_… 4 more tasks in the CLI_/);
 assert.ok(cards(blocks).some(c=>c.title.text==='Curation &amp; parity'),'the reply card survives');
 for(const b of blocks)if(b.type==='section')assert.ok(b.text.text.length<=3000);
});
test('Slack receives the blocks on the same root and falls back to text sections if it rejects them',async()=>{
 const calls=[];
 const slack=new Slack({botToken:'blocks-test',channel:'C1',userId:'owner'},async(url,init)=>{
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method,body});
  if(method==='chat.update'&&JSON.parse(body.blocks).some(b=>b.type==='card')&&calls.filter(c=>c.method==='chat.update').length===1)return Response.json({ok:false,error:'invalid_blocks',response_metadata:{messages:['[ERROR] bad']}});
  return Response.json({ok:true,ts:'same'});
 },s=>s.replaceAll('Curation','MASKED'));
 await slack.postMonitor(text);
 const posted=JSON.parse(calls.find(c=>c.method==='chat.postMessage').body.blocks);
 assert.equal(posted[0].type,'header');assert.match(texts(posted),/MASKED &amp; parity/);assert.doesNotMatch(texts(posted),/Curation/);
 await slack.updateMonitor('same',text);
 const edits=calls.filter(c=>c.method==='chat.update');assert.equal(edits.length,2);
 assert.ok(JSON.parse(edits[1].body.blocks).every(b=>b.type==='section'));assert.match(edits[1].body.blocks,/MASKED/);
 assert.ok(calls.every(c=>c.body.thread_ts===undefined&&!/^files\./.test(c.method)));
});

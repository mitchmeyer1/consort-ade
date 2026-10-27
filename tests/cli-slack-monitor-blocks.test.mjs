import {test} from 'node:test';
import assert from 'node:assert/strict';
import {monitorBlockKit,bar} from '../src/cli/slackMonitorBlocks.ts';
import {Slack} from '../src/cli/slack.ts';
const text=`*📊 Consort master monitor*
Updated 2026-10-27 16:45 UTC

*Working*
🟠 Feature · <https://slack.example/thread|Curation · parity> · author: <https://github.com/mitch|@mitch> · WAITING · Review 7/9 · $608 · 18m
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
const texts=blocks=>JSON.stringify(blocks);
test('monitor blocks group tasks by what the owner does next, in order',()=>{
 const blocks=monitorBlockKit(text);
 assert.equal(blocks[0].type,'header');assert.equal(blocks[0].text.text,'Consort');
 assert.match(blocks[1].elements[0].text,/^Updated <!date\^1793119500\^\{date_short_pretty\} \{time\}\|Updated 2026-10-27 16:45 UTC>/);
 assert.match(blocks[1].elements[0].text,/1 needs your reply.*1 ready to merge.*3 working.*1 completed/);
 const headings=blocks.filter(b=>b.type==='section'&&/^(🟠|📦|🔄|✅|⚡) \*[A-Za-z ]+\*( · \d+)?$/.test(b.text.text)).map(b=>b.text.text);
 assert.deepEqual(headings,['🟠 *Needs your reply* · 1','📦 *Ready to merge* · 1','🔄 *Working* · 3','✅ *Completed* · 1','⚡ *AI capacity*']);
 const all=texts(blocks);
 assert.ok(all.indexOf('Curation · parity')<all.indexOf('Ship it'));assert.ok(all.indexOf('Ship it')<all.indexOf('Paging shard'));assert.ok(all.indexOf('Stopped one')<all.indexOf('Finished one'));
});
test('a task row keeps its thread link, stage bar, author, cost, age, action and destinations',()=>{
 const blocks=monitorBlockKit(text);
 const reply=blocks.find(b=>b.type==='section'&&b.text.text.includes('Curation · parity')).text.text;
 assert.match(reply,/^\*<https:\/\/slack\.example\/thread\|Curation · parity>\*\n/);
 assert.match(reply,/Review 7\/9 ▰▰▰▰▰▰▱▱▱ · Feature · by <https:\/\/github\.com\/mitch\|@mitch> · \$608 · 18m/);
 assert.match(reply,/\n> Confirm whether parity needs a separate task\.\n/);
 assert.match(reply,/<https:\/\/slack\.example\/thread\|Thread>  ·  <https:\/\/app\.clickup\.com\/t\/123\|ClickUp>  ·  <https:\/\/github\.com\/a\/b\/pull\/1\|GitHub>/);
 assert.doesNotMatch(reply,/WAITING/);
 const working=blocks.find(b=>b.type==='section'&&b.text.text.includes('Stopped one')).text.text;
 assert.match(working,/❌ \*Stopped one\*\nSetup 1\/9 ▱▱▱▱▱▱▱▱▱ · \*STOPPED\* · Feature · PR not created · \$1 · 1d\n> Stopped for consort-cli stop\n_thread pending_/);
 assert.match(working,/\n\n\*Analysis only\*\nTriage 2\/3 ▰▱▱ · Sentry\n> Reading the Sentry issue/);
 const ready=blocks.find(b=>b.type==='section'&&b.text.text.includes('Ship it')).text.text;
 assert.match(ready,/^\*<https:\/\/slack\.example\/ready\|Ship it>\*\n/);
 assert.match(ready,/Approve 5\/5 ▰▰▰▰▰ · Review · by <https:\/\/github\.com\/pmonco\|@pmonco> · \$9 · ready 3m ago\n<https:\/\/slack\.example\/ready\|Thread>  ·  <https:\/\/github\.com\/a\/b\/pull\/2\|Merge PR>/);
 const done=blocks.find(b=>b.type==='section'&&b.text.text.includes('Finished one')).text.text;
 assert.equal(done,'*<https://slack.example/done|Finished one>* · by <https://github.com/mitch|@mitch> · $4 · finished 33m ago · <https://app.clickup.com/t/9|ClickUp> · <https://github.com/a/b/pull/3|GitHub>');
});
test('accounts show a usage meter, or the block reason and resume time',()=>{
 const all=texts(monitorBlockKit(text));
 assert.match(all,/🟢 \*Claude 1\*  ▰▰▰▰▱▱▱▱▱▱ 42%  ·  5-hour 42% · weekly 20% · usage 3m ago/);
 assert.match(all,/🔴 \*Claude 2\*  ·  blocked: weekly limit reached · resume after Oct 28, 2:30 PM EDT/);
 assert.match(all,/⚪ \*Codex 1\*  ·  usage unavailable/);
 assert.equal(bar(3,5),'▰▰▰▱▱');assert.equal(bar(2,40),'');
});
test('empty groups say so and non-monitor text gets no blocks',()=>{
 const empty=monitorBlockKit(text.replace(/\n\*Working\*[\s\S]*?\n\n\*Accounts\*/,'\n*Working*\nNo tasks in progress.\n\n*Ready to merge · your action*\nNo tickets waiting to be merged.\n\n*Completed · most recent 6*\nNo completed tasks yet.\n\n*Accounts*'));
 const all=texts(empty);
 for(const s of ['_Nothing needs your reply._','_Nothing waiting to be merged._','_No tasks in progress._','_No completed tasks yet._'])assert.ok(all.includes(s),s);
 assert.equal(monitorBlockKit('Content withheld by guard'),undefined);
 assert.equal(monitorBlockKit('*📊 Consort master monitor*\nUpdated monitor'),undefined);
});
test('forty tasks stay inside fifty blocks with every link kept',()=>{
 const many=text.replace('🟠 Feature ·',Array.from({length:38},(_,i)=>`🔄 Feature · <https://slack.example/${i}|Task ${i}> · author: @mitch · RUNNING · Build 3/9 · $1 · 1m\n   Doing work number ${i} with a reasonably long description so that sections fill up and need packing across several blocks\n   <https://github.com/a/b/pull/${i}|github>\n`).join('')+'… 4 more tasks in the CLI\n🟠 Feature ·');
 const blocks=monitorBlockKit(many);assert.ok(blocks.length<=50,String(blocks.length));
 const all=texts(blocks);for(let i=0;i<38;i++)assert.ok(all.includes(`https://slack.example/${i}|Task ${i}`),`missing task ${i}`);
 assert.match(all,/_… 4 more tasks in the CLI_/);
 for(const b of blocks)if(b.type==='section')assert.ok(b.text.text.length<=3000);
});
test('Slack receives the blocks on the same root and falls back to text sections if it rejects them',async()=>{
 const calls=[];
 const slack=new Slack({botToken:'blocks-test',channel:'C1',userId:'owner'},async(url,init)=>{
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method,body});
  if(method==='chat.update'&&JSON.parse(body.blocks).some(b=>b.type==='header')&&calls.filter(c=>c.method==='chat.update').length===1)return Response.json({ok:false,error:'invalid_blocks',response_metadata:{messages:['[ERROR] bad']}});
  return Response.json({ok:true,ts:'same'});
 },s=>s.replaceAll('Curation','MASKED'));
 await slack.postMonitor(text);
 const posted=JSON.parse(calls.find(c=>c.method==='chat.postMessage').body.blocks);
 assert.equal(posted[0].type,'header');assert.match(texts(posted),/MASKED · parity/);assert.doesNotMatch(texts(posted),/Curation/);
 await slack.updateMonitor('same',text);
 const edits=calls.filter(c=>c.method==='chat.update');assert.equal(edits.length,2);
 assert.ok(JSON.parse(edits[1].body.blocks).every(b=>b.type==='section'));assert.match(edits[1].body.blocks,/MASKED/);
 assert.ok(calls.every(c=>c.body.thread_ts===undefined&&!/^files\./.test(c.method)));
});

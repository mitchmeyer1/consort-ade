import {test} from 'node:test';
import assert from 'node:assert/strict';
import {monitorBlockKit,bar,usageDot} from '../src/cli/slackMonitorBlocks.ts';
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
👉 Feature · <https://slack.example/nudge|Needs a reviewer> · author: <https://github.com/mitch|@mitch> · RUNNING · Watch PR 9/9 · $12 · 3h
   need one approval from @ada; CI is green. Next check in 3m. Your action: please nudge @ada to review the PR.
   <https://app.clickup.com/t/5|ticket> · <https://github.com/a/b/pull/5|github>

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
const cards=blocks=>blocks.flatMap(b=>b.type==='carousel'?b.elements:b.type==='card'?[b]:[]);
/** a card title is the link to its thread; this is its text */
const name=c=>c.title.text.replace(/^<[^|>]+\|(.*)>$/,'$1');
test('monitor opens with the centered banner, then groups in the order the owner acts, and ends with the update time',()=>{
 const blocks=monitorBlockKit(text,NOW);
 assert.deepEqual(blocks[0],{type:'image',block_id:`head-${NOW}`,image_url:'https://raw.githubusercontent.com/mitchmeyer1/consort-ade/main/build/consort-banner-slack.png',alt_text:'Consort'});
 assert.equal(blocks.at(-1).type,'context');assert.equal(blocks.at(-1).elements[0].text,'Updated <!date^1793119500^{date_short_pretty} {time}|Updated 2026-10-27 16:45 UTC>  ·  Reply in a task’s thread. This message updates in place.');
 assert.ok(!blocks.some(b=>b.type==='header'||b.type==='section'&&/needs your reply/.test(b.text.text)),'no summary line');
 const headings=blocks.filter(b=>b.type==='section'&&/^\*[A-Za-z ]+\*   ·   \d+$/.test(b.text.text)).map(b=>b.text.text);
 assert.deepEqual(headings,['*Needs your reply*   ·   1','*Nudge*   ·   1','*Ready to merge*   ·   1','*Working*   ·   3']);
 assert.deepEqual(cards(blocks).map(name),['Curation &amp; parity','Needs a reviewer','Ship it','Paging shard','Stopped one','Analysis only']);
 assert.deepEqual(blocks.filter(b=>b.type==='container').map(b=>b.title.text),['Completed']);
 assert.doesNotMatch(texts(blocks),/🟠|📦|🔄|✅|⚡|🎉|👉/);
});
test('a task card carries who, cost, age, the action, the stage bar and link buttons with one primary action',()=>{
 const [reply,nudge,ready,sentry,stopped,analysis]=cards(monitorBlockKit(text,NOW));
 assert.equal(reply.subtitle.text,'Feature   ·   by <https://github.com/mitch|@mitch>   ·   $608   ·   18m');
 assert.equal(reply.body.text,'Confirm whether parity needs a separate task.');
 assert.equal(reply.subtext.text,'Review 7/9   ▰▰▰▰▰▰▱▱▱');
 assert.equal(reply.title.text,'<https://slack.example/thread|Curation &amp; parity>','the title is the link to the thread');
 assert.deepEqual(reply.actions.map(b=>[b.text.text,b.url,b.style]),[['Chat','https://slack.example/thread','primary'],['ClickUp','https://app.clickup.com/t/123',undefined],['GitHub','https://github.com/a/b/pull/1',undefined]]);
 assert.deepEqual(ready.actions.map(b=>[b.text.text,b.style]),[['Chat',undefined],['Merge PR','primary']]);
 assert.deepEqual(nudge.actions.map(b=>[b.text.text,b.style]),[['Chat',undefined],['ClickUp',undefined],['GitHub','primary']]);
 assert.match(nudge.body.text,/please nudge @ada/);
 assert.equal(ready.subtext.text,'Approve 5/5   ▰▰▰▰▰');
 assert.equal(sentry.subtitle.text,'Sentry   ·   author unavailable   ·   cost pending   ·   2h');assert.equal(sentry.actions,undefined);
 assert.equal(stopped.subtext.text,'Setup 1/9   ▱▱▱▱▱▱▱▱▱   ·   *STOPPED*   ·   _Slack thread pending_');
 assert.equal(analysis.subtitle.text,'Sentry');assert.equal(analysis.body.text,'Reading the Sentry issue');assert.equal(analysis.subtext.text,'Triage 2/3   ▰▱▱');
 const ids=new Set(cards(monitorBlockKit(text,NOW)).flatMap(c=>(c.actions??[]).map(b=>b.action_id)));assert.equal(ids.size,8);
 assert.ok(cards(monitorBlockKit(text,NOW)).every(c=>c.block_id&&(c.actions??[]).length<=3&&(c.actions??[]).filter(b=>b.style==='primary').length<=1));
});
test('completed work is a table in a titled container; AI usage is a table with a coloured dot per window and when each account frees up',()=>{
 const blocks=monitorBlockKit(text,NOW);
 const [done]=blocks.filter(b=>b.type==='container');
 assert.equal(done.subtitle.text,'most recent 1');assert.equal(done.width,'full');assert.equal(done.is_collapsible,true);
 const doneTable=done.child_blocks[0];assert.equal(doneTable.type,'table');assert.equal(doneTable.block_id,`completed-table-${NOW}`);
 assert.deepEqual(doneTable.rows[0].map(c=>c.elements[0].elements[0].text),['Task','Author','Cost','Finished','Links']);
 const row=doneTable.rows[1];
 assert.deepEqual(row[0].elements[0].elements[0],{type:'link',url:'https://slack.example/done',text:'Finished one'});
 assert.deepEqual(row.slice(1,4).map(c=>c.text),['@mitch','$4','33m ago']);
 assert.ok(doneTable.column_settings.every(c=>c&&typeof c==='object'));assert.ok(doneTable.rows.flat().every(c=>c.type!=='raw_text'||c.text.length>0));
 assert.deepEqual(row[4].elements[0].elements.map(e=>e.url??e.text),['https://app.clickup.com/t/9','  ·  ','https://github.com/a/b/pull/3']);
 const cellText=c=>c.text??c.elements[0].elements.map(e=>e.text).join('');
 const usage=blocks.find(b=>b.block_id===`usage-${NOW}`);
 assert.equal(blocks.indexOf(usage),blocks.indexOf(done)+2,'the AI usage heading and table follow the completed table');
 assert.match(JSON.stringify(blocks[blocks.indexOf(usage)-1]),/\*AI usage\*/);
 assert.deepEqual(usage.rows.map(r=>r.map(cellText)),[['Account','5h','Weekly','Resets'],['Claude 1','⚪ 42%','⚪ 20%',''],['Claude 2','—','—','🔴 blocked until Oct 28 2:30 PM'],['Codex 1','—','—','no reading yet']].map(r=>r.map(c=>c||'—')));
 assert.ok(!blocks.some(b=>b.type==='data_visualization'||b.type==='image'&&b.block_id?.startsWith('usage')),'no chart and no picture');
 assert.equal(bar(3,5),'▰▰▰▱▱');assert.equal(bar(2,40),'');
 const busy=monitorBlockKit(text.replace('5-hour 42% · weekly 20%','5-hour 12% · Weekly 77% · Weekly · Fable 50%').replace('⚪ Codex 1 · usage unavailable','🟠 Codex 1 · available · 5-hour 95%'),NOW);
 const rows=busy.find(b=>b.block_id===`usage-${NOW}`).rows.map(r=>r.map(cellText));
 assert.deepEqual(rows[0],['Account','5h','Weekly','Fable','Resets'],'every window seen becomes a column, the model window included');
 assert.deepEqual(rows[1].slice(1,4),['⚪ 12%','🟡 77%','🟡 50%']);assert.deepEqual(rows[3].slice(1,4),['🟠 95%','—','—']);
 assert.deepEqual([0,49,50,79,80,99,100].map(usageDot),['⚪','⚪','🟡','🟡','🟠','🟠','🔴']);
});
test('escaped characters are decoded for tables and plain text but kept for mrkdwn',()=>{
 const blocks=monitorBlockKit(text.replace('Finished one','Fix &amp; ship &lt;b&gt;'),NOW);
 const done=blocks.find(b=>b.type==='container'&&b.title.text==='Completed').child_blocks[0];
 assert.equal(done.rows[1][0].elements[0].elements[0].text,'Fix & ship <b>');
 assert.equal(name(cards(blocks)[0]),'Curation &amp; parity');
});
test('empty groups and tables are left out, and non-monitor text gets no blocks',()=>{
 const empty=monitorBlockKit(text.replace(/\n\*Working\*[\s\S]*?\n\n\*Accounts\*/,'\n*Working*\nNo tasks in progress.\n\n*Ready to merge · your action*\nNo tickets waiting to be merged.\n\n*Completed · most recent 6*\nNo completed tasks yet.\n\n*Accounts*'),NOW);
 const all=texts(empty);
 assert.doesNotMatch(all,/Needs your reply|Nudge|Ready to merge|\*Working\*|Completed/);
 assert.equal(cards(empty).length,0);assert.equal(empty.filter(b=>b.type==='container').length,0);assert.ok(empty.some(b=>b.block_id===`usage-${NOW}`));
 assert.match(all,/\*AI usage\*/);
 const partial=monitorBlockKit(text.replace(/\n\*Ready to merge · your action\*\n[^\n]+\n[^\n]+\n/,'\n*Ready to merge · your action*\nNo tickets waiting to be merged.\n'),NOW);
 assert.doesNotMatch(texts(partial),/Ready to merge\*|Ship it/);
 const bare=monitorBlockKit(text.replace(/\n\*Working\*[\s\S]*?\n\n\*Accounts\*[\s\S]*?\n\nOpen a ticket/,'\n*Working*\nNo tasks in progress.\n\n*Ready to merge · your action*\nNo tickets waiting to be merged.\n\n*Completed · most recent 6*\nNo completed tasks yet.\n\n*Accounts*\nNo accounts configured.\n\nOpen a ticket'),NOW);
 assert.match(texts(bare),/_Nothing open and nothing finished yet._/);assert.equal(bare.filter(b=>b.type==='container'||b.type==='card'||b.type==='data_visualization').length,0,'only the banner image remains');
 assert.equal(monitorBlockKit('Content withheld by guard'),undefined);
 assert.equal(monitorBlockKit('*📊 Consort master monitor*\nUpdated monitor'),undefined);
});
test('forty open tasks stay inside fifty blocks with every link kept',()=>{
 const many=text.replace('🟠 Feature ·',Array.from({length:38},(_,i)=>`🔄 Feature · <https://slack.example/${i}|Task ${i}> · author: @mitch · RUNNING · Build 3/9 · $1 · 1m\n   Doing work number ${i}\n   <https://github.com/a/b/pull/${i}|github>\n`).join('')+'… 4 more tasks in the CLI\n🟠 Feature ·');
 const blocks=monitorBlockKit(many,NOW);assert.ok(blocks.length<=50,String(blocks.length));
 const all=texts(blocks);for(let i=0;i<38;i++)assert.ok(all.includes(`https://slack.example/${i}`),`missing task ${i}`);
 assert.match(all,/_… 4 more tasks in the CLI_/);
 assert.ok(cards(blocks).some(c=>name(c)==='Curation &amp; parity'),'the reply card survives');
 for(const b of blocks)if(b.type==='section')assert.ok(b.text.text.length<=3000);
});
test('Slack receives the blocks on the same root and falls back to text sections if it rejects them',async()=>{
 const calls=[];
 const slack=new Slack({botToken:'blocks-test',channel:'C1',userId:'owner'},async(url,init)=>{
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method,body});
  if(method==='chat.update'&&JSON.parse(body.blocks).some(b=>b.type==='card'||b.type==='carousel')&&calls.filter(c=>c.method==='chat.update').length===1)return Response.json({ok:false,error:'invalid_blocks',response_metadata:{messages:['[ERROR] bad']}});
  return Response.json({ok:true,ts:'same'});
 },s=>s.replaceAll('Curation','MASKED'));
 await slack.postMonitor(text);
 const posted=JSON.parse(calls.find(c=>c.method==='chat.postMessage').body.blocks);
 assert.equal(posted[0].type,'image');assert.match(texts(posted),/MASKED &amp; parity/);assert.doesNotMatch(texts(posted),/Curation/);
 await slack.updateMonitor('same',text);
 const edits=calls.filter(c=>c.method==='chat.update');assert.equal(edits.length,2);
 assert.ok(JSON.parse(edits[1].body.blocks).every(b=>b.type==='section'));assert.match(edits[1].body.blocks,/MASKED/);
 assert.ok(calls.every(c=>c.body.thread_ts===undefined&&c.method!=='files.completeUploadExternal'),'no thread, and no upload completed without an upload URL');
});

test('a task card with a PR shows its CI verdict after the stage bar, with no turn label',()=>{
 const withPr=text.replace('   need one approval from @ada;','   PR: CI passing\n   need one approval from @ada;').replace('   <https://github.com/a/b/pull/2|merge PR>','   PR: CI failing\n   <https://github.com/a/b/pull/2|merge PR>');
 const [nudge]=cards(monitorBlockKit(withPr,NOW)).filter(c=>name(c)==='Needs a reviewer');
 assert.equal(nudge.subtext.text,'Watch PR 9/9   ▰▰▰▰▰▰▰▰▱   ·   🟢 CI passing');
 assert.match(nudge.body.text,/^need one approval/,'the PR line is not part of the action');
 const ready=cards(monitorBlockKit(withPr,NOW)).find(c=>name(c)==='Ship it');
 assert.match(ready.subtext.text,/🔴 CI failing/);
 assert.doesNotMatch(ready.subtext.text,/turn/);
 assert.ok(!cards(monitorBlockKit(text,NOW)).some(c=>/CI |turn/.test(c.subtext?.text??'')),'no PR line, no labels');
});

test('a group with two or more cards scrolls sideways in carousels of up to ten; a lone card stands alone',()=>{
 const blocks=monitorBlockKit(text,NOW);
 const carousels=blocks.filter(b=>b.type==='carousel');
 assert.ok(carousels.length>=1);assert.ok(carousels.every(c=>c.elements.length>=2&&c.elements.every(e=>e.type==='card')));
 assert.ok(blocks.some(b=>b.type==='card'&&name(b)==='Ship it'),'the one ready card is not wrapped');
 const many=text.replace('*Ready to merge · your action*\n',`*Ready to merge · your action*\n${Array.from({length:12},(_,i)=>`📦 Review · <https://slack.example/r${i}|Ready ${i}> · author: <https://github.com/p|@p> · READY TO MERGE · Approve 5/5 · $1 · ready 1m ago\n   <https://github.com/a/b/pull/${i}|merge PR>\n`).join('')}`);
 const ready=monitorBlockKit(many,NOW).filter(b=>b.type==='carousel'&&b.block_id.startsWith('ready-'));
 assert.deepEqual(ready.map(c=>c.elements.length),[10,3]);
});
test('a thread with unread Consort posts turns Chat red with the count; the title keeps its text', () => {
  const blocks=monitorBlockKit(text.replace('Curation &amp; parity> ·','Curation &amp; parity> (3 unread) ·'),NOW);
  const card=cards(blocks).find(c=>c.block_id&&/Curation/.test(c.title.text));
  assert.equal(name(card),'Curation &amp; parity');
  assert.deepEqual([card.actions[0].text.text,card.actions[0].style],['Chat · 3 new','danger']);
  const other=cards(blocks).find(c=>/Needs a reviewer/.test(c.title.text));
  assert.ok(!other.actions?.some(a=>/new/.test(a.text.text)));
});

test('a task in a test session gets its own "In testing" group with the test link; cards have no Test or Resume buttons', () => {
  const t = `*📊 Consort master monitor*
Updated 2026-10-27 16:45 UTC

*Working*
🧪 Feature · <https://x.slack.com/archives/D0ABC/p1794351179831059|Notes rail> · author: <https://github.com/mitch|@mitch> · WAITING · Review 7/9 · $20 · 1d
   Testing at https://ab12.ngrok-free.app. Say done in the thread when finished.
   <https://ab12.ngrok-free.app|test link> · <https://app.clickup.com/t/9|ticket> · <https://github.com/a/b/pull/9|github>
🔄 Feature · <https://x.slack.com/archives/D0ABC/p1794351000000100|List pages> · author: <https://github.com/mitch|@mitch> · RUNNING · Grilling 2/9 · $3 · 20m
   Reading the jobs page
   <https://app.clickup.com/t/8|ticket> · <https://github.com/a/b/pull/8|github>

*Ready to merge · your action*
No tickets waiting to be merged.`;
  const titles = blocks => blocks.filter(b => b.type === 'section').map(b => b.text.text);
  const all = blocks => blocks.flatMap(b => b.type === 'carousel' ? b.elements : b.type === 'card' ? [b] : []);
  const plain = monitorBlockKit(t, 0);
  assert.ok(titles(plain).some(x => /^\*In testing\*/.test(x)));
  const testing = all(plain).find(c => /Notes rail/.test(c.title.text));
  assert.deepEqual(testing.actions.map(b => [b.text.text, b.url]), [['Chat', 'https://x.slack.com/archives/D0ABC/p1794351179831059'], ['ClickUp', 'https://app.clickup.com/t/9'], ['GitHub', 'https://github.com/a/b/pull/9']]);
  assert.match(testing.body.text, /<https:\/\/ab12\.ngrok-free\.app\|Open the test app>/);
  assert.ok(all(plain).every(c => !c.actions.some(a => /^(?:Test|Resume)$/.test(a.text.text))), 'no Test or Resume buttons');
});

test('a long title is shortened inside its link, never cutting the link; the permalink query is dropped', () => {
  const long = 'x'.repeat(200);
  const t = text.replace('<https://slack.example/thread|Curation &amp; parity>', `<https://acme.slack.com/archives/D0CCFKLGG1H/p1793997279825839?thread_ts=1793997279.825839&amp;cid=D0CCFKLGG1H|${long}>`);
  const card = cards(monitorBlockKit(t, NOW)).find(c => /D0CCFKLGG1H/.test(c.title.text));
  assert.ok(card.title.text.length <= 150);
  assert.match(card.title.text, /^<https:\/\/acme\.slack\.com\/archives\/D0CCFKLGG1H\/p1793997279825839\|x+…>$/);
});

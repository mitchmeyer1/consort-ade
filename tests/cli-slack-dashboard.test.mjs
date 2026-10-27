import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dashboardPanels,dashboardGraphic,dashboardPng} from '../src/cli/slackDashboard.ts';
import {Slack} from '../src/cli/slack.ts';
const text=`*📊 Consort master monitor*
Updated today

*Working*
🟠 Feature · <https://slack.example/thread|Curation> · author: <https://github.com/mitch|@mitch> · WAITING · Review 7/9 · $608 · 18m
   Confirm whether parity needs a separate task.
   <https://app.clickup.com/t/123|ticket> · <https://github.com/a/b/pull/1|github>

*Ready to merge · your action*
No tickets waiting to be merged.

*Completed · most recent 6*
No completed tasks yet.

*Accounts*
🟢 Claude 1 · available · 5-hour 42% · weekly 20%
🔴 Claude 2 · blocked: weekly limit reached · resume after Oct 28, 2:30 PM EDT

STATUS: MONITORING`;
test('branded graphics retain author, workflow, costs, capacity and explicit block reason',()=>{
 const panels=dashboardPanels(text),combined=panels.map(p=>p.svg).join('');
 assert.match(combined,/#f3ead6/);assert.match(combined,/data:image\/png;base64/);
 assert.doesNotMatch(combined,/The work, at a glance|Consort master monitor/);
 assert.match(combined,/@mitch/);assert.match(combined,/Review 7\/9/);assert.match(combined,/\$608/);
 assert.match(combined,/weekly limit reached/);assert.match(combined,/2:30 PM EDT/);
 assert.ok(panels.some(p=>p.links?.includes('https://slack.example/thread')));
 assert.ok(panels.some(p=>p.action?.includes('Confirm whether')));
 const png=dashboardPng(panels[0].svg);assert.equal(png.subarray(1,4).toString(),'PNG');
});
test('guard replacement cannot reconstruct task data into an image',()=>{
 const panels=dashboardPanels('Content withheld by guard');assert.equal(panels.length,1);
 assert.doesNotMatch(panels[0].svg,/Curation|608|mitch/);
});
test('uploads private graphics, updates same root, keeps links native, reuses uploads and retires replaced files',async()=>{
 const calls=[];let n=0;
 const slack=new Slack({botToken:'dashboard-test',channel:'C1',userId:'owner'},async(url,init)=>{
  if(String(url).startsWith('https://upload.example/')){calls.push({method:'transfer'});return new Response('ok');}
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method,body});
  if(method==='files.getUploadURLExternal')return Response.json({ok:true,file_id:`F${++n}`,upload_url:`https://upload.example/${n}`});
  return Response.json({ok:true,ts:'existing'});
 },s=>s);
 await slack.updateMonitor('existing',text);const initial=n;
 const update=calls.find(c=>c.method==='chat.update'),blocks=JSON.parse(update.body.blocks);
 assert.equal(blocks.filter(b=>b.type==='image').length,1);assert.equal(initial,1);
 assert.ok(blocks.some(b=>b.type==='section'&&b.text.text.startsWith('*Curation*\n')&&b.text.text.includes('https://slack.example/thread')));assert.equal(blocks[0].type,'image');
 assert.ok(calls.filter(c=>c.method==='files.completeUploadExternal').every(c=>!c.body.channel_id&&!c.body.thread_ts));
 assert.ok(!calls.some(c=>c.method==='chat.postMessage'));
 await slack.updateMonitor('existing',text);assert.equal(n,initial);
 await slack.updateMonitor('existing',text.replace('$608','$609'));assert.equal(n,initial+1);
 assert.ok(calls.some(c=>c.method==='files.delete'));
});
test('missing files scope retains the complete text monitor',async()=>{
 const calls=[];const slack=new Slack({botToken:'no-images-test',channel:'C1',userId:'owner'},async(url,init)=>{
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method,body});
  return Response.json(method==='files.getUploadURLExternal'?{ok:false,error:'missing_scope'}:{ok:true,ts:'same'});
 },s=>s);
 await slack.updateMonitor('same',text);
 const body=calls.find(c=>c.method==='chat.update').body;
 assert.match(body.blocks,/Curation/);assert.match(body.blocks,/608/);assert.match(body.blocks,/https:\/\/slack.example/);
});
test('Slack image-block rejection falls back without a second root or deleting current images',async()=>{
 let n=0;const calls=[];
 const slack=new Slack({botToken:'rejected-images-test',channel:'C1',userId:'owner'},async(url,init)=>{
  if(String(url).startsWith('https://upload.example/'))return new Response('ok');
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));calls.push({method,body});
  if(method==='files.getUploadURLExternal')return Response.json({ok:true,file_id:`Z${++n}`,upload_url:`https://upload.example/${n}`});
  if(method==='chat.update'&&JSON.parse(body.blocks).some(b=>b.type==='image'))return Response.json({ok:false,error:'invalid_blocks'});
  return Response.json({ok:true,ts:'same'});
 },s=>s);
 await slack.updateMonitor('same',text);
 const edits=calls.filter(c=>c.method==='chat.update');assert.equal(edits.length,2);
 assert.match(edits[1].body.blocks,/Curation/);assert.ok(!calls.some(c=>c.method==='chat.postMessage'||c.method==='files.delete'));
});
test('many task rows remain under Slack block limits without losing task links',async()=>{
 let n=0;let posted;
 const many=text.replace('🟠 Feature ·',Array.from({length:38},(_,i)=>`🔄 Feature · <https://slack.example/${i}|Task ${i}> · author: @mitch · RUNNING · Build 3/9 · $1 · 1m\n   Doing work\n   <https://github.com/a/b/pull/${i}|github>\n`).join('')+'🟠 Feature ·');
 const slack=new Slack({botToken:'many-images-test',channel:'C1',userId:'owner'},async(url,init)=>{
  if(String(url).startsWith('https://upload.example/'))return new Response('ok');
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));
  if(method==='files.getUploadURLExternal')return Response.json({ok:true,file_id:`M${++n}`,upload_url:`https://upload.example/${n}`});
  if(method==='chat.update')posted=JSON.parse(body.blocks);
  return Response.json({ok:true,ts:'same'});
 },s=>s);
 await slack.updateMonitor('same',many);assert.ok(posted.length<=50);
 const all=JSON.stringify(posted);for(let i=0;i<38;i++)assert.ok(all.includes(`https://slack.example/${i}`),`missing task ${i}`);
});

test('single SVG keeps readable titles and task descriptions remain available below',()=>{
 const panels=dashboardPanels(text.replace('Curation','📦 𝐂𝐮𝐫𝐚𝐭𝐢𝐨𝐧'));
 const graphic=dashboardGraphic(panels);
 assert.equal((graphic.svg.match(/<svg /g)??[]).length,1);
 assert.ok(panels.some(p=>p.action?.includes('Confirm whether parity')));
 assert.match(graphic.svg,/Curation/);
 assert.match(graphic.svg,/BLOCKED/);
 assert.doesNotMatch(graphic.svg,/𝐂|📦/);
 assert.equal(dashboardPng(graphic.svg).subarray(1,4).toString(),'PNG');
});

test('Slack image-processing rejection retries the same image and root without another upload',async()=>{
 let uploads=0,edits=0;const delays=[],bodies=[];
 const slack=new Slack({botToken:'image-processing-test',channel:'C1',userId:'owner'},async(url,init)=>{
  if(String(url).startsWith('https://upload.example/'))return new Response('ok');
  const method=String(url).split('/').at(-1),body=Object.fromEntries(new URLSearchParams(init.body));
  if(method==='files.getUploadURLExternal'){uploads++;return Response.json({ok:true,file_id:'PROCESSING',upload_url:'https://upload.example/file'});}
  if(method==='chat.update'){
   edits++;bodies.push(body);
   if(edits<3)return Response.json({ok:false,error:'invalid_blocks',response_metadata:{messages:['[ERROR] invalid slack file [json-pointer:/blocks/0/slack_file]']}});
  }
  assert.notEqual(method,'chat.postMessage');return Response.json({ok:true,ts:'same'});
 },s=>s,async ms=>{delays.push(ms);});
 await slack.updateMonitor('same',text);
 assert.equal(uploads,1);assert.equal(edits,3);assert.deepEqual(delays,[250,750]);
 assert.deepEqual(bodies[0],bodies[2]);assert.equal(JSON.parse(bodies[2].blocks).filter(b=>b.type==='image').length,1);
});

test('Slack overview stays short with four active rows and six completed tasks',()=>{
 const panels=dashboardPanels(text);
 const task=panels.find(p=>p.title);
 const full=[...panels,...Array.from({length:3},(_,i)=>({...task,title:'Active '+i,rank:2})),...Array.from({length:6},(_,i)=>({...task,title:'Completed '+i,rank:3}))];
 const graphic=dashboardGraphic(full);
 assert.ok(Number(graphic.svg.match(/height="(\d+)"/)[1])<=740);
 assert.match(graphic.svg,/6 recently completed/);
 assert.match(graphic.svg,/font-size="25"/);
});

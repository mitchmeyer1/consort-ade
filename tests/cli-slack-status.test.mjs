import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
const compile = name => ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const checked = async c => ({ answer: `Checked: ${c.question}`, model: 'claude-opus-5' });
const down = async () => { throw new Error('no usable AI account'); };
function harness(answer = checked) {
  const contexts = [];
  const task = { id:'t', jobId:'j', ticket:{id:'T1',url:'https://app.clickup.com/t/T1'}, slackThread:'1', slackStatusAfterTs:'1', status:'working', pid:123, updatedAt:Date.now(), envReadyAt:1, reviewsDone:0, accountIds:{}, feature:{stage:'Implementing',built:false,prs:[]}, activity:'Adding the export button' };
  const state = {slack:{userId:'owner'},tasks:[task],jobs:[{id:'j',repo:'/repo'}],accounts:[]};
  const replies = [], patches = [];
  let messages = [], fail = false;
  const mocks = {
    '../shared/headless.ts':headless,
    './state':{loadState:()=>state,updateTask:(id,patch,touch)=>{patches.push(touch);Object.assign(task,typeof patch==='function'?patch(task):patch);}},
    './slackLinks':{taskSlackLinks:async()=>({ticket:task.ticket.url,github:'https://github.com/a/b/pull/1'})},
    './slack':{Slack:class {async threadMessages(){return messages;} async post(text,thread){if(fail) throw new Error('offline');replies.push({text,thread});}}},
    './buildProgress':{stepLabel:name=>name},
    './oversight':{workerLogTail:()=>'2026 [T1] turn 3 at Implementing: ported providerDedup'},
    './sources':{sourceFor:()=>({comments:async()=>[{text:'Please rename the CSV column',by:'will',at:1}]})},
    './ownerUpdates':{isAcknowledgement:t=>/^thanks$/i.test(t),downloadSlackFiles:async()=>({saved:[],failed:[]})},
    'node:fs':{existsSync:()=>true},
  };
  const mod={exports:{}};
  new Function('require','module','exports',compile('slackStatus'))(n=>mocks[n],mod,mod.exports);
  return {task,replies,patches,contexts,run:async()=>{await mod.exports.answerTaskStatusQuestions(()=>true,{answer:async c=>{contexts.push(c);return answer(c);}});await mod.exports.settleOwnerReplies();},messages:m=>{messages=m;},fail:v=>{fail=v;}};
}
test('standalone status requests do not become blocker answers or swallow decisions', () => {
  for (const text of ["Hows this going", "How’s this going?", 'How is this going?', "What's the status?", 'status', 'Any updates?', 'Where are we at?', '<@B123> status?']) assert.equal(headless.isTaskStatusQuestion(text),true,text);
  for (const text of ['Yes', 'retry', 'done', 'How is this going? Use the blue design.', 'Please fix the status column']) assert.equal(headless.isTaskStatusQuestion(text),false,text);
  assert.equal(headless.replyAfter([{ts:'2',user:'owner',text:'Hows this going'}, {ts:'3',user:'owner',text:'Use blue'}],'1','owner'),'Use blue');
  assert.equal(headless.replyAfter([{ts:'2',user:'owner',text:'Hows this going'}],'1','owner'),undefined);
});
test('the oversight agent answers each owner question once, with the log, ticket comments and thread', async () => {
  const h=harness();
  h.messages([{ts:'2',user:'other',text:'status'},{ts:'3',user:'owner',bot_id:'bot',text:'status'},{ts:'4',user:'owner',text:'what percent through the build are you?'}]);
  await h.run(); await h.run();
  assert.equal(h.replies.length,1);
  assert.equal(h.replies[0].thread,'1');
  assert.equal(h.replies[0].text,'✅ Checked: what percent through the build are you?\n\n<https://app.clickup.com/t/T1|ticket> · <https://github.com/a/b/pull/1|github>\n\nSTATUS: RUNNING');
  const c=h.contexts[0];
  assert.equal(c.question,'what percent through the build are you?');
  assert.match(c.logTail,/ported providerDedup/);
  assert.deepEqual(c.ticketComments,[{text:'Please rename the CSV column',by:'will',at:1}]);
  assert.equal(c.workerAlive,true);
  assert.equal(h.task.ownerUpdates,undefined,'a question is not queued as a change');
  assert.equal(h.task.status,'working');
  assert.ok(h.patches.every(touch=>touch===false),'poll cursors must not reset worker activity time');
});
test('approval replies: only a yes or a no answers a review; a question goes to the oversight agent', async () => {
  for (const [text, want] of [['yes', 'yes'], ['LGTM ship it', 'yes'], ['no', 'no'], ['not yet', 'no'], ['hold off', 'no'], ['Whats the point of this? Isnt a view not real data?', undefined], ['yes?', undefined], ['why does it raise the timeout', undefined]]) assert.equal(headless.approvalReply(text), want, text);
  const h=harness();
  Object.assign(h.task,{kind:'review',status:'waiting',pendingQuestion:{questions:['Approve PR #9?'],afterTs:'1'}});
  h.messages([{ts:'2',user:'owner',text:'Whats the point of this? Isnt a view not real data?'},{ts:'3',user:'owner',text:'yes'}]);
  await h.run();
  assert.equal(h.contexts.length,1,'the question is answered');
  assert.equal(h.contexts[0].question,'Whats the point of this? Isnt a view not real data?');
  assert.deepEqual(h.task.answeredTs,['3'],'only the yes is the answer');
});
test('a question back while a build waits on the owner is answered, and the next plain reply is the answer', async () => {
  for (const text of ['What does option B change?', 'Whats the point of this? Isnt a view not real data? Wha', 'which one is safer? not sure', 'can you use the default?']) assert.equal(headless.isClarifyingQuestion(text), true, text);
  for (const text of ['Use option B', 'B, the default is fine', 'yes', 'Use B. Why? It is cheaper', 'no']) assert.equal(headless.isClarifyingQuestion(text), false, text);
  assert.equal(headless.replyAfter([{ts:'2',user:'owner',text:'What does option B change?'},{ts:'3',user:'owner',text:'Use B'}],'1','owner'),'Use B');
  const h=harness();
  Object.assign(h.task,{status:'waiting',pendingQuestion:{questions:['Option A or B for the CSV column?'],afterTs:'1'}});
  h.messages([{ts:'2',user:'owner',text:'What does option B change?'}]);
  await h.run();
  assert.equal(h.contexts.length,1,'the question back goes to the oversight agent');
  assert.match(h.replies[0].text,/Checked: What does option B change\?\n\n• Still waiting on your answer to the question above\./);
  assert.equal(h.task.answeredTs,undefined,'not taken as the answer');
  assert.equal(h.task.ownerUpdates,undefined,'not queued as a change');
});
test('when the agent is down, status questions get the saved status line and changes still reach the worker', async () => {
  const h=harness(down);
  h.messages([{ts:'2',user:'owner',text:'Hows this going'},{ts:'3',user:'owner',text:'Rename the button to Export'}]);
  await h.run();
  assert.match(h.replies[0].text,/^✅ Step 3\/9 \(Build\): Adding the export button\.\n• I could not check the details/);
  assert.equal(h.task.ownerUpdates.length,1);
  assert.equal(h.task.ownerUpdates[0].text,'Rename the button to Export');
  assert.match(h.replies[1].text,/Queued as a change/);
});
test('waiting and completed replies preserve the task state; failed delivery retries', async () => {
  const h=harness(down);
  h.task.status='waiting'; h.task.pauseReason='Waiting for the API key';
  h.messages([{ts:'2',user:'owner',text:'status'}]); h.fail(true);
  await h.run(); assert.equal(h.task.slackStatusAfterTs,'1');
  h.fail(false); await h.run();
  assert.match(h.replies[0].text,/Waiting for the API key[\s\S]*STATUS: WAITING$/);
  assert.equal(h.task.status,'waiting');
  h.task.status='ready'; h.messages([{ts:'3',user:'owner',text:'Any updates?'}]); await h.run();
  assert.match(h.replies[1].text,/^🎉🍭🎊[\s\S]*Step 9\/9 \(Ready to merge\)[\s\S]*STATUS: COMPLETED$/);
});
test('new listeners skip historical status questions', async () => {
  const h=harness();delete h.task.slackStatusAfterTs;
  h.messages([]);await h.run();
  assert.equal(h.replies.length,0);assert.ok(Number(h.task.slackStatusAfterTs)>2);
});
test('Slack thread reader paginates without broadcasting or losing newer messages', async () => {
  const mod={exports:{}};
  new Function('require','module','exports',compile('slack'))(()=>headless,mod,mod.exports);
  const requests=[];
  const slack=new mod.exports.Slack({channel:'C',botToken:'test'},async(_,init)=>{
    const form=new URLSearchParams(init.body);requests.push(form);
    return {json:async()=>requests.length===1?{ok:true,messages:[{ts:'2'}],has_more:true,response_metadata:{next_cursor:'page2'}}:{ok:true,messages:[{ts:'3'}]}};
  });
  assert.deepEqual((await slack.threadMessages('1','1.5')).map(m=>m.ts),['2','3']);
  assert.equal(requests[0].get('oldest'),'1.5');assert.equal(requests[1].get('cursor'),'page2');
});


test('upgrading a daemon answers recent unanswered status questions', async () => {
  const h=harness();delete h.task.slackStatusAfterTs;
  h.messages([{ts:String(Date.now()/1000-60),user:'owner',text:'hows it going'}]);
  await h.run();assert.equal(h.replies.length,1);await h.run();assert.equal(h.replies.length,1);
});

test('status replies call automatic PR monitoring RUNNING',async()=>{
  const h=harness(down);h.task.status='monitoring';h.task.activity='CI running; Consort checks again in 3m. Your action: none.';
  h.messages([{ts:'2',user:'owner',text:'status'}]);await h.run();
  assert.match(h.replies[0].text,/CI running[\s\S]*STATUS: RUNNING$/);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canClaimSentryTicket,sentryOpenTickets,sentryTicketLimit,sentryWorkerJob} from '../src/cli/sentryCapacity.ts';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url), mod={exports:{}};
const code=ts.transpileModule(readFileSync(new URL('../src/cli/capacity.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',code)(n=>n==='./state'?{}:require(n),mod,mod.exports);
const {availableTaskSlots}=mod.exports;
const producer={id:'sentry',name:'Errors',source:'sentry',repo:'/repo',base:'main',filters:{},statuses:{progress:'doing',review:'review',done:'done'},enabled:true,everyMinutes:15,maxParallel:0,sentry:{listId:'inbox',tag:'sentry',status:'to do'}};
test('Sentry defaults to one whole ticket and configures a matching bounded worker',()=>{
  assert.equal(sentryTicketLimit(producer),1);
  const job=sentryWorkerJob(producer);
  assert.equal(job.maxOpenTasks,1);assert.equal(job.maxParallel,1);assert.equal(job.maxEnvironments,1);
  assert.equal(job.sentryProducerId,'sentry');assert.deepEqual(job.scope,{kind:'list',id:'inbox'});
  for(const status of ['working','waiting','monitoring']) assert.equal(availableTaskSlots({tasks:[{jobId:job.id,status}],capacity:{}},job),0,status);
  assert.equal(availableTaskSlots({tasks:[{jobId:job.id,status:'ready'}],capacity:{}},job),1);
});
test('queued tickets consume capacity before a worker claims them; completed workers free it',()=>{
  const tickets=[{id:'1',markdown_description:'[consort-sentry-scanner:sentry] [consort-sentry-group:abc]',status:{type:'open'}},{id:'2',markdown_description:'unrelated'}];
  assert.equal(sentryOpenTickets(producer,tickets),1);
  for(const status of ['working','waiting','monitoring','failed']) assert.equal(sentryOpenTickets(producer,tickets,[{ticket:{id:'1'},status}]),1);
  assert.equal(sentryOpenTickets(producer,tickets,[{ticket:{id:'1'},status:'ready'}]),0);
  assert.equal(sentryOpenTickets(producer,[{...tickets[0],status:{type:'closed'}}]),0);
  assert.equal(sentryOpenTickets(producer,[{...tickets[0],status:{type:'closed'}}],[{ticket:{id:'1'},status:'working'}]),1);
  assert.equal(sentryOpenTickets(producer,[],[{jobId:'sentry-worker',ticket:{id:'1'},status:'monitoring'}]),1);
  assert.equal(sentryWorkerJob({...producer,maxParallel:3}).maxOpenTasks,3);
});

test('only the linked bounded worker can claim a Sentry bundle',()=>{
  assert.equal(canClaimSentryTicket({}, {sentryScannerId:'sentry'}),false);
  assert.equal(canClaimSentryTicket({sentryProducerId:'sentry'},{sentryScannerId:'sentry'}),true);
  assert.equal(canClaimSentryTicket({sentryProducerId:'other'},{sentryScannerId:'sentry'}),false);
  assert.equal(canClaimSentryTicket({sentryProducerId:'sentry'},{}),false);
  assert.equal(canClaimSentryTicket({},{}),true);
});

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'consort-capacity-'));
const require = createRequire(import.meta.url);
for (const name of ['state', 'capacity', 'environment']) {
  let text = ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText.replaceAll('require("./state")', 'require("./state.cjs")').replaceAll('require("./capacity")', 'require("./capacity.cjs")').replaceAll('require("../shared/headless.ts")', `require(${JSON.stringify(new URL('../src/shared/headless.ts', import.meta.url).pathname)})`);
  if(name==='environment') text = `const nativeRequire=require;require=(name)=>name==='node:child_process'?{execFile:(...args)=>args.at(-1)(null,{stdout:'',stderr:''})}:nativeRequire(name);\n` + text;
  writeFileSync(join(dir, `${name}.cjs`), text);
}
process.env.CONSORT_CLI_HOME = join(dir, 'home');
const state = require(join(dir, 'state.cjs'));
const capacity = require(join(dir, 'capacity.cjs'));
const environment = require(join(dir, 'environment.cjs'));
after(() => rmSync(dir, { recursive: true, force: true }));
const seed = () => {
  rmSync(state.HOME, {recursive: true, force: true});
  state.saveState({version:1,accounts:[{id:'a'}],jobs:[{id:'j',maxParallel:2,maxOpenTasks:8,maxEnvironments:2}],tasks:[{id:'t',jobId:'j',status:'working',feature:{stage:'Implementing'},updatedAt:1},{id:'u',jobId:'j',status:'monitoring',updatedAt:1}]});
};
function child(code) {
  return new Promise((resolve,reject) => {
    const p = spawn(process.execPath,['-e', `const s=require(${JSON.stringify(join(dir,'state.cjs'))}); const c=require(${JSON.stringify(join(dir,'capacity.cjs'))}); ${code}`], {env: {...process.env,CONSORT_CLI_HOME:state.HOME}});
    let stdout='',stderr='';p.stdout.on('data',x=>stdout+=x);p.stderr.on('data',x=>stderr+=x);p.on('error',reject);p.on('exit',code=>code===0?resolve(stdout.trim()):reject(new Error(stderr)));
  });
}

test('stale saves preserve other task, account and nested feature edits', () => {
  seed();const stale=state.loadState();const fresh=state.loadState();
  fresh.tasks[0].feature.prs=['one'];fresh.tasks[1].note='review';fresh.accounts[0].blockedWhy='limit';state.saveState(fresh);
  stale.tasks[0].feature.stage='Revising';stale.jobs[0].lastScanAt=10;state.saveState(stale);
  const actual=state.loadState();assert.deepEqual(actual.tasks[0].feature,{stage:'Revising',prs:['one']});assert.equal(actual.tasks[1].note,'review');assert.equal(actual.accounts[0].blockedWhy,'limit');
  stale.jobs[0].lastScanAt=20;state.saveState(stale);assert.equal(state.loadState().tasks[1].note,'review');
});
test('stale snapshot never resurrects deleted tasks or drops newly appended tasks', () => {
  seed();const stale=state.loadState();const fresh=state.loadState();fresh.tasks=fresh.tasks.filter(t=>t.id!=='u');fresh.tasks.push({id:'v',status:'working'});state.saveState(fresh);
  stale.tasks[1].note='late';stale.tasks[0].note='edit';state.saveState(stale);
  assert.deepEqual(state.loadState().tasks.map(t=>t.id),['t','v']);
});
test('six processes increment the same task without losing updates', async () => {
  seed();await Promise.all(Array.from({length:6},()=>child(`for(let i=0;i<15;i++)s.updateTask('t',t=>({reviewsDone:(t.reviewsDone||0)+1}));`)));
  assert.equal(state.loadState().tasks[0].reviewsDone,90);
});
test('simultaneous stale snapshots preserve six independently appended tasks', async () => {
  seed();const gate=join(dir,'barrier');await import('node:fs').then(fs=>fs.mkdirSync(gate));
  await Promise.all(Array.from({length:6},(_,i)=>child(`const fs=require('node:fs');const snapshot=s.loadState();fs.writeFileSync(${JSON.stringify(gate)}+'/'+${i},'');while(fs.readdirSync(${JSON.stringify(gate)}).length<6)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);snapshot.tasks.push({id:'new-${i}',status:'working'});s.saveState(snapshot);`)));
  assert.equal(state.loadState().tasks.length,8);
});
test('a lock left by a dead process is recovered', async () => {
  seed();await child(`require('node:fs').writeFileSync(s.STATE_FILE+'.lock',String(process.pid));`);
  state.updateTask('t',{note:'recovered'});assert.equal(state.loadState().tasks[0].note,'recovered');
});
test('waiting and monitoring consume open capacity but no active turn capacity', () => {
  seed();state.updateTask('t',{status:'waiting'});assert.equal(capacity.availableTaskSlots(state.loadState(),state.loadState().jobs[0]),6);
  const one=capacity.tryAcquireAgentTurn('t','a');const two=capacity.tryAcquireAgentTurn('t','a');assert.ok(one);assert.ok(two);assert.equal(capacity.tryAcquireAgentTurn('u','a'),undefined);
  capacity.releaseAgentTurn('t',one);assert.ok(capacity.tryAcquireAgentTurn('u','a'));
  capacity.releaseAgentTurn('t',one);assert.equal(state.loadState().tasks[0].activeTurns.length,1,'late release cannot erase another lease');
});
test('provider account cap remains independent of job cap', () => {
  seed();state.mutateState(s=>{s.jobs[0].maxParallel=4;s.accounts[0].maxActiveTurns=1;});
  assert.ok(capacity.tryAcquireAgentTurn('t','a'));assert.equal(capacity.tryAcquireAgentTurn('u','a'),undefined);
});
test('concurrent processes honor the active-turn cap and recover crashed leases', async () => {
  seed();state.mutateState(s=>{s.jobs[0].maxParallel=1;});
  const results=await Promise.all(Array.from({length:5},()=>child(`const lease=c.tryAcquireAgentTurn('t','a');console.log(lease?'yes':'no');setTimeout(()=>{},1500);`)));
  assert.equal(results.filter(x=>x==='yes').length,1);
  assert.ok(capacity.tryAcquireAgentTurn('t','a'),'dead process lease is reclaimed');
});
test('withAgentTurn releases after errors and rejects a blocked account', async () => {
  seed();await assert.rejects(capacity.withAgentTurn('t','a',async()=>{throw Error('failed');}),/failed/);
  assert.equal(state.loadState().tasks[0].activeTurns.length,0);
  state.blockAccount('a',Date.now()+10000,'limit');assert.throws(()=>capacity.tryAcquireAgentTurn('t','a'),capacity.AccountUnavailableError);
});
test('environment cap counts persistent allocations separately and releases failed reservations', async () => {
  seed();state.mutateState(s=>{s.jobs[0].maxEnvironments=1;s.tasks[1].portBase=4000;});
  assert.equal(capacity.tryAcquireEnvironment('t'),false);
  state.updateTask('u',{status:'done',portBase:undefined});
  await assert.rejects(capacity.withEnvironmentSlot('t',async()=>{throw Error('allocation failed');}),/allocation failed/);
  assert.equal(state.loadState().tasks[0].environmentReservation,undefined);
  assert.ok(capacity.tryAcquireEnvironment('t'));
});

test('machine turn, task and environment limits apply across scanners', () => {
  seed();state.mutateState(s=>{s.capacity={maxActiveTurns:1,maxOpenTasks:2,maxEnvironments:1};s.jobs.push({id:'other',maxParallel:2});s.tasks[1].jobId='other';});
  const current=state.loadState();assert.equal(capacity.availableTaskSlots(current,current.jobs[0]),0);
  assert.ok(capacity.tryAcquireAgentTurn('t','a'));assert.equal(capacity.tryAcquireAgentTurn('u','a'),undefined);
  assert.ok(capacity.tryAcquireEnvironment('t'));assert.equal(capacity.tryAcquireEnvironment('u'),false);
});

test('concurrent real port probes reserve distinct blocks across worker processes', async () => {
  seed();const modulePath=JSON.stringify(join(dir,'environment.cjs'));
  const results=await Promise.all(['t','u'].map(id=>child(`require(${modulePath}).allocateEnvironment(s.loadState().tasks.find(t=>t.id===${JSON.stringify(id)})).then(env=>console.log(env.CONSORT_PORT_BASE));`)));
  assert.equal(new Set(results).size,2);
  const current=state.loadState();assert.equal(new Set(current.tasks.map(t=>t.portBase)).size,2);
});
test('parallel writer environments isolate names and ports and clean reservations after failure', async () => {
  seed();state.mutateState(s=>{s.jobs[0].maxEnvironments=4;});
  const environments=[];
  await Promise.all(['one','two'].map(id=>environment.withChildEnvironment('t',id,async env=>{environments.push(env);await new Promise(r=>setTimeout(r,20));})));
  assert.equal(new Set(environments.map(env=>env.CONSORT_RUN)).size,2);
  assert.equal(new Set(environments.map(env=>env.CONSORT_PORT_BASE)).size,2);
  assert.equal(state.loadState().tasks[0].childEnvironments.length,0);
  await assert.rejects(environment.withChildEnvironment('t','fail',async()=>{throw Error('writer failed');}),/writer failed/);
  assert.equal(state.loadState().tasks[0].childEnvironments.length,0);
});

test('writer rejects full environment capacity promptly without leaking reservations', async () => {
  seed();state.mutateState(s=>{s.jobs[0].maxEnvironments=1;s.tasks[0].portBase=20000;});
  await assert.rejects(environment.withChildEnvironment('t','full',async()=>{assert.fail('writer must not start');}),environment.EnvironmentCapacityError);
  assert.equal(state.loadState().tasks[0].childEnvironments,undefined);
});

test('review reservations count coordinator and delegate units against every turn cap', async () => {
  seed();assert.equal(capacity.maxAgentTurnUnits('t','a'),2);
  const review=capacity.tryAcquireAgentTurn('t','a',2);assert.ok(review);
  assert.equal(capacity.tryAcquireAgentTurn('u','a'),undefined);
  assert.equal(state.loadState().tasks[0].activeTurns[0].units,2);
  capacity.releaseAgentTurn('t',review);assert.ok(capacity.tryAcquireAgentTurn('u','a'));
  state.updateTask('u',{activeTurns:[]});
  await assert.rejects(capacity.withAgentTurn('t','a',async()=>{throw Error('review failed');},2),/review failed/);
  assert.equal(state.loadState().tasks[0].activeTurns.length,0);
  state.mutateState(s=>{s.accounts[0].maxActiveTurns=1;});assert.equal(capacity.maxAgentTurnUnits('t','a'),1);
  assert.throws(()=>capacity.tryAcquireAgentTurn('t','a',2),/exceeds/);
});

test('account reservation skips full and blocked accounts without exceeding limits',()=>{
  seed();state.mutateState(s=>{s.accounts=[{id:'a',maxActiveTurns:1},{id:'b',maxActiveTurns:1},{id:'blocked',blockedUntil:Date.now()+60000}];});
  const first=capacity.tryAcquireAnyAgentTurn('t',['a','b']);assert.equal(first.accountId,'a');
  const next=capacity.tryAcquireAnyAgentTurn('u',['blocked','a','b']);assert.equal(next.accountId,'b');
  assert.equal(capacity.tryAcquireAnyAgentTurn('u',['a','b']),undefined);
  capacity.releaseAgentTurn('t',first.lease);capacity.releaseAgentTurn('u',next.lease);
  assert.equal(state.loadState().tasks.flatMap(t=>t.activeTurns??[]).length,0);
});

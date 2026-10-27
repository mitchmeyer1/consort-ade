import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync(new URL('../src/cli/workerControl.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(task = {}) {
  const current = {id:'t',jobId:'j',pid:123,status:'monitoring',ticket:{id:'T1'},branch:'mm/t1',feature:{prs:['https://github.com/a/b/pull/7']},...task};
  const notifications=[];
  const state={tasks:[current],envPool:[]};
  const mocks={ './state': {loadState:()=>state,mutateState:fn=>fn(state),processAlive:()=>true,updateTask:(_,patch)=>Object.assign(current,patch)}, './lifecycle':{notifyTask:async(...args)=>notifications.push(args)}, './environment':{releaseEnvironment:async()=>{}}, 'node:child_process':{execFile(){}}, 'node:util':{promisify:f=>f} };
  const mod={exports:{}};
  new Function('require','module','exports',source)(n=>mocks[n],mod,mod.exports);
  return {task:current,state,notifications,...mod.exports};
}
test('deliberate reboot records the requester before SIGTERM and explains the stop', () => {
  const h=harness();h.requestWorkerStop('t',123,'consort-cli tasks reboot');
  assert.equal(h.task.workerStop.pid,123);
  assert.equal(h.task.workerStop.requesterPid,process.pid);
  assert.ok(h.task.workerStop.holdUntil>Date.now());
  assert.match(h.workerStopMessage(h.task,123,'SIGTERM'),/consort-cli tasks reboot.*requested by process.*SIGTERM/);
  assert.match(h.workerStopMessage(h.task,456,'SIGTERM'),/outside Consort/);
});
test('late exit of an old worker cannot stop or erase its replacement', async () => {
  const h=harness({pid:456,lifecycle:'running'});
  await h.handleWorkerExit('t',123,0,null);
  assert.equal(h.task.pid,456);assert.equal(h.task.lifecycle,'running');assert.equal(h.notifications.length,0);
});
test('planned reboot exit does not duplicate the signal handler notification or count as a crash', async () => {
  const h=harness();h.requestWorkerStop('t',123,'consort-cli tasks reboot');
  await h.handleWorkerExit('t',123,0,null);
  assert.equal(h.task.pid,undefined);assert.equal(h.task.restarts,undefined);assert.equal(h.notifications.length,0);
});
test('unexpected signal counts as a crash and notifies for restart', async () => {
  const h=harness();await h.handleWorkerExit('t',123,null,'SIGTERM');
  assert.equal(h.task.restarts,1);assert.equal(h.task.pid,undefined);
  assert.match(h.task.note,/SIGTERM/);assert.equal(h.notifications[0][1],'stopped');
});
test('released task exits do not announce a restart', async () => {
  const h=harness({status:'released'});await h.handleWorkerExit('t',123,0,null);
  assert.equal(h.task.pid,undefined);assert.equal(h.notifications.length,0);
});

test('restart guard rejects a reboot in progress even when the worker has already exited', () => {
  const h=harness({pid:undefined});
  h.requestWorkerStop('t',123,'consort-cli tasks reboot');
  assert.equal(h.canStartWorker(h.task,false),false);
  assert.equal(h.canStartWorker({...h.task,workerStop:undefined},false),true);
  assert.equal(h.canStartWorker({...h.task,workerStop:undefined},true),false);
  assert.equal(h.canStartWorker({...h.task,status:'released'},false),false);
  assert.equal(h.canStartWorker(h.task,false,h.task.workerStop.holdUntil+1),true,'abandoned restart holds expire');
});

function killDeps(o = {}) {
  const live = new Set([123, 900, 901, ...(o.stubborn ?? [])]);
  const sent = [], released = [], said = [];
  return { sent, released, said, live, deps: {
    signal: (pid, sig) => { sent.push(`${sig} ${pid}`); if (sig === 'SIGKILL' || !(o.stubborn ?? []).includes(pid)) { live.delete(pid); if (pid === 123 && sig === 'SIGTERM' && !o.agentsSurvive) { live.delete(900); live.delete(901); } } },
    alive: pid => live.has(pid), children: async pid => (pid === 123 ? [900, 901] : []), wait: async () => {},
    notify: async (_, text) => { said.push(text); }, release: async id => { released.push(id); },
  } };
}
test('tasks kill: the worker stops, its ticket is never claimed again, its services go back, and the owner gets the branch and PR', async () => {
  const h=harness({status:'waiting',pendingQuestion:{questions:['A or B?'],afterTs:'1'}});
  const k=killDeps();
  await h.killTask('t',k.deps);
  assert.deepEqual(k.sent,['SIGTERM 123']);
  assert.equal(h.task.workerStop.command,'consort-cli tasks kill','the daemon holds off restarting it');
  assert.equal(h.task.status,'released');assert.equal(h.task.pid,undefined);assert.equal(h.task.pendingQuestion,undefined);
  assert.match(h.task.note,/killed: you are handling it/);
  assert.equal(h.isKilled(h.state,'j','T1'),true);assert.equal(h.isKilled(h.state,'other','T1'),false);
  assert.deepEqual(k.released,['t']);
  assert.match(k.said[0],/Killed by you; you are handling it from here[\s\S]*Branch `mm\/t1`[\s\S]*pull\/7/);
  await h.killTask('t',killDeps().deps);
  assert.equal(h.state.killedTickets.length,1,'killing twice lists the ticket once');
});
test('tasks kill forces a worker that ignores SIGTERM, and its agent processes, after 20 seconds', async () => {
  const h=harness();
  const k=killDeps({stubborn:[123],agentsSurvive:true});
  await h.killTask('t',k.deps);
  assert.deepEqual(k.sent,['SIGTERM 123','SIGKILL 900','SIGKILL 901','SIGKILL 123']);
});
test('tasks kill on a stopped task only marks it and hands back its services', async () => {
  const h=harness({pid:undefined,status:'failed'});
  const k=killDeps();
  await h.killTask('t',k.deps);
  assert.deepEqual(k.sent,[]);assert.equal(h.task.status,'released');assert.deepEqual(k.released,['t']);
});

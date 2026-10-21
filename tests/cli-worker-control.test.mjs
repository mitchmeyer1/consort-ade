import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync(new URL('../src/cli/workerControl.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(task = {}) {
  const current = {id:'t',pid:123,status:'monitoring',...task};
  const notifications=[];
  const mocks={ './state': {loadState:()=>({tasks:[current]}),updateTask:(_,patch)=>Object.assign(current,patch)}, './lifecycle':{notifyTask:async(...args)=>notifications.push(args)} };
  const mod={exports:{}};
  new Function('require','module','exports',source)(n=>mocks[n],mod,mod.exports);
  return {task:current,notifications,...mod.exports};
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

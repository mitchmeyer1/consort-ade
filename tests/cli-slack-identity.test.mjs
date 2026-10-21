import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import { modelTiers } from '../src/shared/modelTiers.ts';
const code = ts.transpileModule(readFileSync(new URL('../src/cli/slackIdentity.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(result, blocked = false) {
  const task = {id:'t',ticket:{title:'Create new locations map'},worktree:'/repo',accountIds:{}};
  const state = {tasks:[task], accounts:[{id:'c',provider:'claude',...(blocked ? {blockedUntil:Date.now()+60000}: {})}]};
  let calls = 0;
  const mocks = {'../shared/headless.ts':headless,'../shared/modelTiers.ts':{modelTiers},'./agent':{runTurn:async o=>{calls++;assert.equal(o.maxTurns,1);assert.match(o.prompt,/No tools, files, questions/);return result;}},'./state':{loadState:()=>state,updateTask:(_,patch)=>Object.assign(task,typeof patch==='function'?patch(task):patch)}};
  const mod = {exports:{}};
  new Function('require','module','exports',code)(n=>mocks[n],mod,mod.exports);
  return {task,run:()=>mod.exports.ensureSlackIdentity('t'),calls:()=>calls};
}
test('AI selects one stable emoji and title; restarts reuse it',async()=>{
  const h=harness({text:'{"emoji":"🗺️","title":"Create new locations map"}'});
  await h.run();await h.run();assert.equal(h.calls(),1);
  assert.deepEqual(h.task.slackIdentity,{emoji:'🗺️',title:'Create new locations map'});
});
test('blocked accounts and malformed headings do not block the worker',async()=>{
  const h=harness({},true);await h.run();assert.equal(h.calls(),0);assert.equal(h.task.slackIdentity,undefined);
  const bad=harness({text:'{"emoji":"map","title":"Map"}'});await bad.run();assert.equal(bad.task.slackIdentity,undefined);
});
test('headers stay first and preserve update emoji, compact links, and final status',()=>{
  const links={ticket:'https://ticket/1',github:'https://github.com/a/b/pull/1',heading:'🗺️ Create new locations map'};
  const text=headless.slackStatus('✅ Watching the PR','WAITING',links);
  assert.equal(text,'🗺️ *CREATE NEW LOCATIONS MAP*\n✅ Watching the PR\n\n<https://ticket/1|ticket> · <https://github.com/a/b/pull/1|github>\n\nSTATUS: WAITING');
  assert.equal(headless.slackStatus(text,undefined,links),text);
  for(const emoji of ['map','🗺️🎉','<@everyone>']) assert.equal(headless.parseSlackIdentity(JSON.stringify({emoji,title:'Map'})),undefined);
  assert.equal(headless.parseSlackIdentity('{"emoji":"🗺️","title":"<@everyone>"}'),undefined);
});

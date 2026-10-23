import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as grouping from '../src/shared/sentryScanner.ts';
import {modelTiers} from '../src/shared/modelTiers.ts';
import * as phi from '../src/shared/phi.ts';
const code=ts.transpileModule(readFileSync(new URL('../src/cli/sentryBundles.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(blocked=false, results=[], timers={}){
  const events=[];
  const calls=[];
  const state={accounts:[{id:'saved-codex',provider:'codex',configDir:'/existing/login',...(blocked?{blockedUntil:Date.now()+60000}:{})}],slack:{botToken:'do-not-send'}};
  const groups=[{key:'one',title:'One',issues:[{id:'1',title:'error',project:{slug:'node'}}]},{key:'two',title:'Two',issues:[{id:'2',title:'different error',project:{slug:'web'}}]}];
  const mocks={'../shared/phi.ts':phi,'./statusLog':{statusEvent:(tone,text)=>events.push({tone,text})},'./state.ts':{loadState:()=>state},'./agent':{runTurn:async o=>{calls.push(o);if(results.length) { const next=results.shift(); return typeof next === "function" ? next(o) : next; }return {text:JSON.stringify({bundles:[{groupKeys:['one','two'],title:'One bug',reason:'Shared failing endpoint'}]})};}},'../shared/headless.ts':headless,'../shared/modelTiers.ts':{modelTiers},'../shared/sentryScanner.ts':grouping};
  const mod={exports:{}};new Function('require','module','exports','setTimeout','clearTimeout','setInterval','clearInterval',code)(n=>mocks[n],mod,mod.exports,timers.setTimeout??setTimeout,timers.clearTimeout??clearTimeout,timers.setInterval??setInterval,timers.clearInterval??clearInterval);
  return {calls,events,run:()=>mod.exports.planSentryBundles({repo:'/existing/repo'},groups)};
}
test('bundle planner reuses a saved provider account and considers the whole scan without Slack secrets',async()=>{
  const h=harness();assert.equal((await h.run()).length,1);
  assert.equal(h.calls[0].account.id,'saved-codex');assert.equal(h.calls[0].account.configDir,'/existing/login');
  assert.match(h.calls[0].prompt,/"id":"1"/);assert.match(h.calls[0].prompt,/"id":"2"/);
  assert.doesNotMatch(h.calls[0].prompt,/do-not-send/);assert.match(h.calls[0].prompt,/read-only tools/);
});
test('all shared accounts blocked defers bundle creation',async()=>{
  const h=harness(true);await assert.rejects(h.run(),/No tickets created/);assert.equal(h.calls.length,0);
});

test('whole-scan grouping has a larger read-only investigation budget', async () => {
  const h=harness(); await h.run();
  assert.equal(h.calls[0].maxTurns,32);
  assert.equal(h.calls[0].readOnly,true);
});
test('turn exhaustion resumes the same account session to finalize the complete plan', async () => {
  const plan={text:JSON.stringify({bundles:[{groupKeys:['one','two'],title:'One bug',reason:'Shared failing endpoint'}]})};
  const h=harness(false,[{error:'Claude Code returned an error result: Reached maximum number of turns (32)',sessionId:'saved-investigation'},plan]);
  assert.equal((await h.run()).length,1);
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[1].resume,'saved-investigation');
  assert.equal(h.calls[1].account,h.calls[0].account);
  assert.equal(h.calls[1].readOnly,true);
  assert.equal(h.calls[1].maxTurns,4);
  assert.match(h.calls[1].prompt,/do not call more tools/);
  assert.match(h.calls[1].prompt,/"key":"one"/);
  assert.match(h.calls[1].prompt,/"key":"two"/);
});
test('turn exhaustion without a recoverable session reports its actual cause',async()=>{
  const h=harness(false,[{error:'Reached maximum number of turns (32)'}]);
  await assert.rejects(h.run(),/exhausted its investigation\/finalization turn budget/);
  assert.equal(h.calls.length,1);
});
test('usage limits and agent failures are distinguished from a turn budget',async()=>{
  await assert.rejects(harness(false,[{limit:{text:'quota'}}]).run(),/account usage limit/);
  await assert.rejects(harness(false,[{error:'Connection reset'}]).run(),/Connection reset/);
});

test('grouping reports progress and completion without dumping issue text',async()=>{
  const h=harness();await h.run();
  assert.match(h.events[0].text,/Grouping 2 Sentry groups/);
  assert.match(h.events.at(-1).text,/into 1 bug bundles/);
  assert.doesNotMatch(JSON.stringify(h.events),/secret|do-not-send|different error/);
  assert.ok(h.calls[0].signal instanceof AbortSignal);
});
test('a hung grouping turn is aborted and timers are cleared',async()=>{
  let cancelDeadline=0,cancelProgress=0,signal;
  const h=harness(false,[o=>new Promise(resolve=>{signal=o.signal;o.signal.addEventListener('abort',()=>resolve({error:'aborted'}));})],{
    setTimeout:fn=>{queueMicrotask(fn);return 1;},clearTimeout:()=>cancelDeadline++,
    setInterval:()=>2,clearInterval:()=>cancelProgress++,
  });
  await assert.rejects(h.run(),/exceeded five minutes/);
  assert.equal(signal.aborted,true);
  assert.equal(cancelDeadline,1);
  assert.equal(cancelProgress,1);
});

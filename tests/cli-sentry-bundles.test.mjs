import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as grouping from '../src/shared/sentryScanner.ts';
import {modelTiers} from '../src/shared/modelTiers.ts';
import * as phi from '../src/shared/phi.ts';
const code=ts.transpileModule(readFileSync(new URL('../src/cli/sentryBundles.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function harness(blocked=false){
  const calls=[];
  const state={accounts:[{id:'saved-codex',provider:'codex',configDir:'/existing/login',...(blocked?{blockedUntil:Date.now()+60000}:{})}],slack:{botToken:'do-not-send'}};
  const groups=[{key:'one',title:'One',issues:[{id:'1',title:'error',project:{slug:'node'}}]},{key:'two',title:'Two',issues:[{id:'2',title:'different error',project:{slug:'web'}}]}];
  const mocks={'../shared/phi.ts':phi,'./state.ts':{loadState:()=>state},'./agent':{runTurn:async o=>{calls.push(o);return {text:JSON.stringify({bundles:[{groupKeys:['one','two'],title:'One bug',reason:'Shared failing endpoint'}]})};}},'../shared/headless.ts':headless,'../shared/modelTiers.ts':{modelTiers},'../shared/sentryScanner.ts':grouping};
  const mod={exports:{}};new Function('require','module','exports',code)(n=>mocks[n],mod,mod.exports);
  return {calls,run:()=>mod.exports.planSentryBundles({repo:'/existing/repo'},groups)};
}
test('bundle planner reuses a saved provider account and considers the whole scan without Slack secrets',async()=>{
  const h=harness();assert.equal((await h.run()).length,1);
  assert.equal(h.calls[0].account.id,'saved-codex');assert.equal(h.calls[0].account.configDir,'/existing/login');
  assert.match(h.calls[0].prompt,/"id":"1"/);assert.match(h.calls[0].prompt,/"id":"2"/);
  assert.doesNotMatch(h.calls[0].prompt,/do-not-send/);assert.match(h.calls[0].prompt,/read-only tools/);
});
test('all shared accounts blocked defers bundle creation',async()=>{
  const h=harness(true);await assert.rejects(h.run(),/no tickets created/);assert.equal(h.calls.length,0);
});

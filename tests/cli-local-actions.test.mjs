import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { monitorBlockKit } from '../src/cli/slackMonitorBlocks.ts';

const compile = () => ts.transpileModule(readFileSync(new URL('../src/cli/localActions.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(tasks) {
  const state = { tasks };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile())(n => n === './state' ? { loadState: () => state, mutateState: f => f(state) } : require(n), mod, mod.exports);
  return mod.exports;
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('a click with the right secret runs the action for the task whose thread it names', async () => {
  const api = load([{ id: 't1', slackThread: '1794351000.000100', ticket: { title: 'Notes rail' } }]);
  const o = { port: 47821, key: 'sekret' };
  const ran = [];
  const handlers = { test: async id => { ran.push(['test', id]); return 'Starting a test session.'; }, resume: async id => { ran.push(['resume', id]); return 'Closing.'; } };
  const ok = await api.handleLocalAction('/test?thread=1794351000.000100&k=sekret', o, handlers);
  assert.equal(ok.status, 200);
  assert.match(ok.html, /Notes rail[\s\S]*Starting a test session\. You can close this tab\./);
  assert.equal((await api.handleLocalAction('/resume?thread=1794351000.000100&k=sekret', o, handlers)).status, 200);
  assert.deepEqual(ran, [['test', 't1'], ['resume', 't1']]);
});

test('a wrong secret, an unknown task or an unknown path runs nothing', async () => {
  const api = load([{ id: 't1', slackThread: '1794351000.000100', ticket: { title: 'x' } }]);
  const o = { port: 47821, key: 'sekret' };
  const ran = [];
  const handlers = { test: async id => { ran.push(id); return ''; }, resume: async id => { ran.push(id); return ''; } };
  assert.equal((await api.handleLocalAction('/test?thread=1794351000.000100&k=nope', o, handlers)).status, 403);
  assert.equal((await api.handleLocalAction('/test?thread=1&k=sekret', o, handlers)).status, 404);
  assert.equal((await api.handleLocalAction('/merge?thread=1794351000.000100&k=sekret', o, handlers)).status, 404);
  assert.deepEqual(ran, []);
});

test('with the local page set up, Test and Resume are plain links to it', () => {
  const t = `*📊 Consort master monitor*
Updated 2026-10-27 16:45 UTC

*Working*
🧪 Feature · <https://x.slack.com/archives/D0ABC/p1794351179831059|Notes rail> · author: <https://github.com/mitch|@mitch> · WAITING · Review 7/9 · $20 · 1d
   Testing at https://ab12.ngrok-free.app.
   <https://ab12.ngrok-free.app|test link> · <https://app.clickup.com/t/9|ticket> · <https://github.com/a/b/pull/9|github>
🔄 Feature · <https://x.slack.com/archives/D0ABC/p1794351000000100|List pages> · author: <https://github.com/mitch|@mitch> · RUNNING · Grilling 2/9 · $3 · 20m
   Reading
   <https://app.clickup.com/t/8|ticket> · <https://github.com/a/b/pull/8|github>

*Ready to merge · your action*
No tickets waiting to be merged.`;
  const cards = monitorBlockKit(t, 0, undefined, { links: { port: 47821, key: 'k1' } }).flatMap(b => b.type === 'carousel' ? b.elements : b.type === 'card' ? [b] : []);
  const test = cards.find(c => /List pages/.test(c.title.text)).actions[0];
  assert.equal(test.text.text, 'Test');
  assert.equal(test.url, 'http://127.0.0.1:47821/test?thread=1794351000.000100&k=k1');
  const resume = cards.find(c => /Notes rail/.test(c.title.text)).actions[0];
  assert.equal(resume.url, 'http://127.0.0.1:47821/resume?thread=1794351179.831059&k=k1');
});

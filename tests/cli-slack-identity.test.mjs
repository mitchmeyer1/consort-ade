import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
const code = ts.transpileModule(readFileSync(new URL('../src/cli/slackIdentity.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(title = 'Create new locations map') {
  const task = { id: 't', ticket: { title }, worktree: '/repo', accountIds: {} };
  const state = { tasks: [task], accounts: [] };
  const mocks = { '../shared/headless.ts': headless, './state': { loadState: () => state, updateTask: (_, patch) => Object.assign(task, patch) } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(n => { assert.ok(mocks[n], `Unexpected dependency ${n}`); return mocks[n]; }, mod, mod.exports);
  return { task, run: () => mod.exports.ensureSlackIdentity('t'), identity: mod.exports.slackIdentityFor };
}
test('headings need no model account and restarts preserve the first heading', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.task.slackIdentity, { emoji: '🗺️', title: 'Create new locations map' });
  h.task.ticket.title = 'Changed title';
  await h.run();
  assert.equal(h.task.slackIdentity.title, 'Create new locations map');
});
test('task headings remove mentions and stay short', () => {
  const h = harness();
  assert.deepEqual(h.identity('<@everyone> Fix broken auth'), { emoji: '🔐', title: 'Fix broken auth' });
  assert.ok(h.identity('A '.repeat(100)).title.length <= 60);
  assert.equal(h.identity('   ').title, 'Task');
});
test('headers stay first and preserve update emoji, compact links, and final status',()=>{
  const links={ticket:'https://ticket/1',github:'https://github.com/a/b/pull/1',heading:'🗺️ Create new locations map'};
  const text=headless.slackStatus('✅ Watching the PR','WAITING',links);
  assert.equal(text,'🗺️ *CREATE NEW LOCATIONS MAP*\n✅ Watching the PR\n\n<https://ticket/1|ticket> · <https://github.com/a/b/pull/1|github>\n\nSTATUS: WAITING');
  assert.equal(headless.slackStatus(text,undefined,links),text);
  for(const emoji of ['map','🗺️🎉','<@everyone>']) assert.equal(headless.parseSlackIdentity(JSON.stringify({emoji,title:'Map'})),undefined);
  assert.equal(headless.parseSlackIdentity('{"emoji":"🗺️","title":"<@everyone>"}'),undefined);
});

test('review titles drop the prefix, stay 5 words, and each open task gets its own emoji', () => {
  const h = harness();
  const a = h.identity('Review: ci: honest deploy card when the run lists no deploy step');
  assert.deepEqual(a, { emoji: '🚀', title: 'honest deploy card when the' });
  assert.notEqual(h.identity('Review: ci: honest deploy card when the run lists no deploy step', ['🚀']).emoji, '🚀');
  const b = h.identity('Review: chore(frontend): retire the DB Admin sidebar link; db-admin is deprecated');
  assert.equal(b.title, 'retire the DB Admin sidebar');
  assert.notEqual(b.emoji, '🛠️');
  const taken = ['🦊', '🐙'];
  assert.ok(!taken.includes(h.identity('Quarterly zebra work', taken).emoji), 'no word matches: a palette emoji nobody uses');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { githubBranchUrl, slackHeading, slackProgress } from '../src/shared/headless.ts';

test('ticket links switch from origin branch to PR and retry failed remote lookups', async () => {
  const source = ts.transpileModule(readFileSync(new URL('../src/cli/slackLinks.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let calls = 0, fail = true;
  const mocks = {
    'node:child_process': {},
    'node:util': { promisify: () => async (cmd, args, options) => {
      calls++;
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['remote', 'get-url', 'origin']);
      assert.equal(options.cwd, '/repo');
      if (fail) throw new Error('temporary failure');
      return { stdout: 'git@github.com:team/project.git\n' };
    } },
    '../shared/headless.ts': { githubBranchUrl, slackHeading, slackProgress },
    './buildProgress': { buildProgress: () => undefined },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(n => mocks[n], mod, mod.exports);
  const task = { ticket: { title: 'Map locations', url: 'https://app.clickup.com/t/T1' }, branch: 'feature/T1', feature: { prs: [] } };
  assert.equal((await mod.exports.taskSlackLinks(task, '/repo')).github, undefined);
  fail = false;
  const links = await mod.exports.taskSlackLinks(task, '/repo');
  assert.equal(links.github, 'https://github.com/team/project/tree/feature%2FT1');
  await mod.exports.taskSlackLinks(task, '/repo');
  assert.equal(calls, 2);
  task.feature.prs.push('https://github.com/team/project/pull/42');
  assert.deepEqual(await mod.exports.taskSlackLinks(task, '/repo'), { ticket: task.ticket.url, github: task.feature.prs[0], heading: "📋 Map locations", progress: '▸ *Env* · ○ Grill · ○ Build · ○ Test · ○ Review · ○ Evidence · ○ PR' });
  assert.equal(calls, 2);
});

test('a post that needs the owner to reply leads with ⚠️ and reads as WAITING', async () => {
  const { slackAsk, slackStatus } = await import('../src/shared/headless.ts');
  assert.equal(slackAsk('❓ *Need you*'), '⚠️ *Need you*');
  assert.equal(slackAsk('❌ *Stuck at build*'), '⚠️ *Stuck at build*');
  assert.equal(slackAsk('Adds a CSV export.'), '⚠️ Adds a CSV export.');
  assert.match(slackStatus(slackAsk('Approve?')), /STATUS: WAITING$/);
});

test('a review task has its own five steps, not the build steps', async () => {
  const { taskStep, slackProgress } = await import('../src/shared/headless.ts');
  const t = { kind: 'review', status: 'working', reviewStep: 3, reviewsDone: 0, feature: { stage: 'Grilling' } };
  assert.deepEqual(taskStep(t), { n: 3, total: 5, name: 'Reviewers', next: 'Verify' });
  assert.equal(slackProgress(t), '✓ Setup · ✓ Overview · ▸ *Reviewers* · ○ Verify · ○ Approve');
  assert.deepEqual(taskStep({ ...t, status: 'done' }), { n: 5, total: 5, name: 'Done', next: '' });
});

test('the thread card says at a glance: working, needs the owner, or done', async () => {
  const { slackCard } = await import('../src/shared/headless.ts');
  const links = { ticket: 'https://t/1', github: 'https://github.com/a/b/pull/2', heading: '📦 Migrate Curation to Mono', progress: '✓ Env · ▸ *Build*' };
  const base = { status: 'working', envReadyAt: 1, reviewsDone: 0, feature: { stage: 'Spec\'d' } };
  const working = slackCard(base, links, { ownerId: 'U1', at: 1_700_000_000_000 });
  assert.equal(working.key, '📦 *MIGRATE CURATION TO MONO*\n🟢 *Working* · Step 3/9 Build\n✓ Env · ▸ *Build*\n<https://t/1|ticket> · <https://github.com/a/b/pull/2|github>');
  assert.match(working.text, /Step 3\/9 Build · <!date\^1700000000\^updated \{time\}\|updated \d\d:\d\d UTC>\n/);
  assert.equal(slackCard(base, links, { at: 5 }).key, working.key, 'the time alone never edits the post');
  const asking = slackCard({ ...base, status: 'waiting', pendingQuestion: { questions: ['⚠️ *Need you* (<https://t/1|ticket>)\n• Which design? — recommend: A\n_Reply in this thread._'] } }, links, { ownerId: 'U1', at: 1 });
  assert.match(asking.key, /\n🟠 \*Needs <@U1>\* · Step 3\/9 Build\n_Which design\? — recommend: A_\n/);
  assert.match(slackCard({ ...base, status: 'ready' }, links, { at: 1 }).key, /\n✅ \*Ready to merge\*\n/);
  assert.match(slackCard({ ...base, status: 'monitoring' }, links, { at: 1 }).key, /🔵 \*Waiting on PR reviews and CI\*/);
  assert.match(slackCard(base, links, { at: 1, limited: true }).key, /🟡 \*Waiting for AI credits\*/);
});

test('a running task whose worker was restarted still reads as working', async () => {
  const { slackCard } = await import('../src/shared/headless.ts');
  const t = { status: 'working', lifecycle: 'stopped', kind: 'review', reviewStep: 3, reviewsDone: 0, feature: { stage: 'Grilling' } };
  assert.match(slackCard(t, { ticket: 'https://github.com/a/b/pull/1', github: 'https://github.com/a/b/pull/1' }, { at: 1 }).key, /^🟢 \*Working\* · Step 3\/5 Reviewers\n<https:\/\/github.com\/a\/b\/pull\/1\|ticket>$/);
});

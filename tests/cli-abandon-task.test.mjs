import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as commands from '../src/cli/abandonCommands.ts';
import * as headless from '../src/shared/headless.ts';

const require = createRequire(import.meta.url);
function compile(name, mocks) {
  const source = ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(n => n in mocks ? mocks[n] : n.startsWith('node:') ? require(n) : {}, mod, mod.exports);
  return mod.exports;
}

test('abandon commands distinguish a destructive request, confirmation, cancellation and negation', () => {
  for (const t of ['kill and clean up', 'kill and cleanup', 'please abandon this', 'discard this task', 'scrap it', 'kill this task']) assert.equal(commands.isAbandonRequest(t), true, t);
  for (const t of ["don't abandon this", 'do not kill and clean up', 'kill the test server', 'the process died', 'yes abandon', 'rename the cancel button']) assert.equal(commands.isAbandonRequest(t), false, t);
  assert.equal(commands.abandonReply('yes, abandon'), 'confirm');
  assert.equal(commands.abandonReply('cancel abandon'), 'cancel');
  for (const t of ['yes', 'no', 'abandon', 'yes abandon but keep the PR']) assert.equal(commands.abandonReply(t), undefined, t);
});

function chat(overrides = {}) {
  const task = { id: 't', jobId: 'j', branch: 'mm/task', worktree: '/work/task', status: 'working', ticket: { id: 'T1' }, slackThread: '1', slackStatusAfterTs: '1', ...overrides };
  const state = { tasks: [task], jobs: [{ id: 'j', repo: '/repo' }], slack: { userId: 'owner' } };
  const posts = [], calls = []; let messages = [];
  const status = compile('slackStatus', {
    '../shared/headless.ts': headless,
    './state': { loadState: () => state, updateTask: (_, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch) },
    './slack': { Slack: class { async threadMessages() { return messages; } async post(text) { posts.push(text); return String(3 + posts.length - 1); } } },
    './abandonCommands': commands,
    './abandonTask': { abandonTask: async id => { calls.push(id); if (task.failCleanup) throw new Error('push rejected'); task.status = 'released'; return 'Closed PRs and removed branch, worktree and resources.'; } },
  });
  return { task, posts, calls, async send(text, ts = '2', user = 'owner', extra = {}) {
    messages = [{ text, ts, user, ...extra }];
    await status.answerTaskStatusQuestions(() => true, { answer: async () => { throw new Error('must not call oversight'); } });
    await status.settleOwnerReplies();
  } };
}

test('asking only posts the full warning; cancellation keeps the worker and resources', async () => {
  const h = chat({ pid: 123, testSession: { url: 'https://test' }, pendingQuestion: { afterTs: '1' } });
  await h.send('kill and clean up');
  assert.equal(h.task.pendingAbandon.promptTs, '3');
  assert.match(h.posts[0], /Are you sure[\s\S]*close every unmerged PR[\s\S]*remote branch[\s\S]*local worktree[\s\S]*uncommitted work[\s\S]*resources/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.task.ownerUpdates, undefined);
  assert.equal(h.task.pid, 123);
  assert.equal(h.task.answeredTs, undefined);
  await h.send('cancel abandon', '4');
  assert.equal(h.task.pendingAbandon, undefined);
  assert.equal(h.task.status, 'working');
  assert.equal(h.task.testSession.url, 'https://test');
  assert.deepEqual(h.calls, []);
});

test('only a fresh explicit confirmation from the owner performs cleanup', async () => {
  const h = chat();
  await h.send('yes abandon');
  assert.deepEqual(h.calls, []);
  await h.send('abandon this', '3');
  await h.send('yes abandon', '5', 'someone-else');
  await h.send('yes abandon', '6', 'owner', { bot_id: 'bot' });
  assert.deepEqual(h.calls, []);
  await h.send('yes', '7');
  assert.deepEqual(h.calls, []);
  await h.send('yes abandon', '8');
  assert.deepEqual(h.calls, ['t']);
  assert.equal(h.task.status, 'released');
  assert.equal(h.task.pendingAbandon, undefined);
});

test('stale confirmations, changed targets and review tasks never delete anything', async () => {
  const stale = chat(); await stale.send('abandon this'); await stale.send('yes abandon', '2.5'); assert.deepEqual(stale.calls, []);
  const changed = chat(); await changed.send('abandon this'); changed.task.branch = 'mm/other'; await changed.send('yes abandon', '4'); assert.deepEqual(changed.calls, []);
  const review = chat({ kind: 'review' }); await review.send('abandon this'); assert.equal(review.task.pendingAbandon, undefined); assert.deepEqual(review.calls, []);
});

test('cleanup failures are reported as incomplete and require a new confirmation', async () => {
  const h = chat({ failCleanup: true }); await h.send('abandon this'); await h.send('yes abandon', '4');
  assert.match(h.posts.at(-1), /did not finish: push rejected/);
  assert.equal(h.task.pendingAbandon, undefined);
  await h.send('yes abandon', '5'); assert.equal(h.calls.length, 1);
});

test('confirmation survives a daemon restart through the saved task state', async () => {
  const h = chat({ pendingAbandon: { promptTs: '2', branch: 'mm/task', worktree: '/work/task' } });
  await h.send('yes abandon', '3');
  assert.deepEqual(h.calls, ['t']);
});

function cleanupHarness(options = {}) {
  const task = { id: 't', jobId: 'j', branch: 'mm/task', worktree: '/work/task', status: 'working', feature: { prs: [] }, ...options.task };
  const state = { tasks: [task, ...(options.others ?? [])], jobs: [{ id: 'j', repo: '/repo', base: 'main' }] };
  const calls = [];
  const impl = compile('abandonTask', {
    'node:fs': { existsSync: () => false, rmSync: path => calls.push(['remove-metadata', path]) },
    './state': { loadState: () => state, updateTask: (_, patch) => Object.assign(task, patch) },
  });
  const deps = {
    stop: async () => { calls.push(['stop']); if (options.stopFails) throw new Error('worker still alive'); },
    cleanup: async () => { calls.push(['cleanup']); if (options.cleanupFails) throw new Error('Docker failed'); },
    run: async (cmd, args, cwd) => {
      calls.push([cmd, ...args]); assert.equal(cwd, '/repo');
      if (options.failPush && args[0] === 'push') throw new Error('push rejected');
      if (args[0] === 'remote') return 'git@github.com:owner/repo.git';
      if (args[0] === 'repo') return JSON.stringify({ defaultBranchRef: { name: options.defaultBranch ?? 'main' } });
      if (args[0] === 'worktree' && args[1] === 'list') return `worktree /repo\nbranch refs/heads/main\n\nworktree /work/task\nbranch refs/heads/${options.worktreeBranch ?? 'mm/task'}\n\nworktree /work/.parallel-task/work-1\ndetached\n\nworktree /work/other\nbranch refs/heads/mm/other\n`;
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([
        { number: 7, state: 'OPEN', headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'repo' } },
        { number: 8, state: 'MERGED', headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'repo' } },
        { number: 9, state: 'OPEN', headRepositoryOwner: { login: 'someone' }, headRepository: { name: 'repo' } },
      ]);
      if (args[0] === 'ls-remote') return options.remoteMissing ? '' : 'abc refs/heads/mm/task';
      if (args[0] === 'branch' && args[1] === '--list') return 'mm/task';
      return '';
    },
  };
  return { task, calls, run: () => impl.abandonTask('t', deps) };
}

test('cleanup stops workers before closing owned PRs, deleting the branch, resources and exact worktrees', async () => {
  const h = cleanupHarness(); await h.run();
  const start = h.calls.findIndex(c => c[0] === 'stop');
  assert.ok(h.calls.slice(0, start).every(c => !['push', 'close', 'remove'].some(x => c.includes(x))));
  assert.deepEqual(h.calls.filter(c => c[1] === 'pr' && c[2] === 'close'), [['gh', 'pr', 'close', '7', '--repo', 'owner/repo']]);
  assert.deepEqual(h.calls.filter(c => c[1] === 'push'), [['git', 'push', 'origin', '--delete', 'mm/task']]);
  assert.deepEqual(h.calls.filter(c => c[1] === 'worktree' && c[2] === 'remove').map(c => c.at(-1)), ['/work/.parallel-task/work-1', '/work/task']);
  assert.equal(h.task.status, 'released'); assert.equal(h.task.testSession, undefined);
});

test('cleanup refuses protected branches, changed worktrees, and never deletes while workers still run', async () => {
  for (const options of [{ task: { branch: 'main' } }, { task: { worktree: '/repo' } }, { defaultBranch: 'mm/task' }, { worktreeBranch: 'mm/other' },
    { others: [{ id: 'other', jobId: 'j', branch: 'mm/task', worktree: '/work/other', status: 'working' }] },
    { others: [{ id: 'other', jobId: 'j', branch: 'mm/other', worktree: '/work/.parallel-task/work-2', status: 'working' }] },
  ]) {
    const h = cleanupHarness(options); await assert.rejects(h.run()); assert.ok(!h.calls.some(c => c[0] === 'stop'));
  }
  const alive = cleanupHarness({ stopFails: true }); await assert.rejects(alive.run(), /still alive/);
  assert.ok(!alive.calls.some(c => c[1] === 'push' || c[2] === 'close' || c[2] === 'remove'));
});

test('failed remote deletion never removes the local worktree; missing remote branches allow a retry', async () => {
  const failed = cleanupHarness({ failPush: true }); await assert.rejects(failed.run(), /push rejected/);
  assert.ok(!failed.calls.some(c => c[2] === 'remove'));
  const retry = cleanupHarness({ remoteMissing: true }); await retry.run(); assert.ok(!retry.calls.some(c => c[1] === 'push'));
  const resources = cleanupHarness({ cleanupFails: true }); await assert.rejects(resources.run(), /Docker failed/); assert.ok(!resources.calls.some(c => c[2] === 'remove'));
});

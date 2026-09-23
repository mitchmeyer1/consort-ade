import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitAll, createWorkspaceTree, removeWorkspaceTree, workspaceCommitInfo, workspaceDiff, workspaceStatuses } from '../src/main/workspaces.ts';
import { addWorktree } from '../src/main/git.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const exists = (p) => stat(p).then(() => true, () => false);

/** two repos, each with a bare origin so pushes work, plus an empty library folder */
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'consort-ws-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repos = [];
  for (const name of ['api', 'web']) {
    const origin = join(dir, `${name}.git`), repo = join(dir, name);
    git(dir, 'init', '-q', '--bare', origin);
    git(dir, 'init', '-q', '-b', 'main', repo);
    for (const [k, v] of [['user.name', 'Test'], ['user.email', 't@example.invalid'], ['commit.gpgsign', 'false']]) git(repo, 'config', k, v);
    await writeFile(join(repo, 'README.md'), name);
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'initial');
    git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', '-u', 'origin', 'main');
    repos.push({ projectId: name, name, dir: name, repo, base: 'origin/main' });
  }
  return { dir, lib: join(dir, 'lib'), repos };
}

test('a worktree can be created in the library folder outside the repo', async (t) => {
  const { dir, lib, repos } = await fixture(t);
  const path = await addWorktree(repos[0].repo, 'feature-a', 'feature/a', 'origin/main', join(lib, 'worktrees', 'api'));
  assert.equal(path, join(lib, 'worktrees', 'api', 'feature-a'));
  assert.equal(git(path, 'branch', '--show-current'), 'feature/a');
  assert.equal(await exists(join(repos[0].repo, '.consort-worktrees')), false, 'nothing is written inside the repo');
  assert.equal(git(repos[0].repo, 'status', '--porcelain'), '');
  await assert.rejects(addWorktree(repos[0].repo, '../escape', 'x', 'origin/main', join(dir, 'lib')));
});

test('a workspace checks out every repo on one branch and commits fan out to the repos with changes', async (t) => {
  const { lib, repos } = await fixture(t);
  const root = join(lib, 'workspaces', 'billing');
  const targets = await createWorkspaceTree(root, 'mm/billing', repos);
  assert.deepEqual(targets.map((x) => x.path), [join(root, 'api'), join(root, 'web')]);
  for (const x of targets) assert.equal(git(x.path, 'branch', '--show-current'), 'mm/billing');

  await writeFile(join(root, 'api', 'a.txt'), 'change');
  const statuses = await workspaceStatuses(targets);
  assert.deepEqual(statuses.map((s) => [s.target.dir, s.status.dirty]), [['api', 1], ['web', 0]]);
  const diff = await workspaceDiff(targets);
  assert.match(diff.files, /^\?\? api\/a\.txt$/m);
  assert.match(diff.patch, /══ api/);

  const results = await commitAll(targets, 'mm/billing', 'Add a.txt');
  assert.deepEqual(results.map((r) => [r.name, r.ok, !!r.skipped]), [['api', true, false], ['web', true, true]]);
  assert.equal(git(join(root, 'api'), 'log', '-1', '--format=%s'), 'Add a.txt');
  assert.equal(git(repos[0].repo, 'log', '-1', '--format=%s', 'origin/mm/billing'), 'Add a.txt', 'pushed to the api origin');
  assert.equal(git(repos[1].repo, 'branch', '-r', '--list', 'origin/mm/billing'), '', 'web had nothing to push');
  const info = await workspaceCommitInfo(targets, 'mm/billing');
  assert.equal(info.changed, 0);
  assert.ok(info.log.some((c) => c.subject === '[api] Add a.txt'));

  await removeWorkspaceTree(root, targets);
  assert.equal(await exists(root), false);
  assert.equal(git(repos[0].repo, 'worktree', 'list').split('\n').length, 1, 'the api repo has only its main checkout again');
});

test('a failure part-way through creation leaves nothing behind', async (t) => {
  const { lib, repos } = await fixture(t);
  const root = join(lib, 'workspaces', 'broken');
  await assert.rejects(createWorkspaceTree(root, 'mm/broken', [repos[0], { ...repos[1], repo: join(lib, 'missing-repo') }]));
  assert.equal(await exists(root), false);
  assert.equal(git(repos[0].repo, 'worktree', 'list').split('\n').length, 1);
});

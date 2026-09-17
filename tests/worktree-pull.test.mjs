import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pullWorktree } from '../src/main/git.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'consort-checkout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), source = join(dir, 'source');
  git(dir, 'init', '-b', 'main', root);
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'code.txt'), 'original');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  git(root, 'worktree', 'add', '-b', 'feature', source);
  return { root, source };
}


async function remoteFixture(t) {
  const { root, source } = await fixture(t);
  const remote = join(root, '..', 'remote.git'), peer = join(root, '..', 'peer');
  git(root, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', 'origin', 'main', 'feature');
  git(root, 'clone', '-b', 'main', remote, peer);
  git(peer, 'config', 'user.name', 'Test');
  git(peer, 'config', 'user.email', 'test@example.invalid');
  git(peer, 'config', 'commit.gpgsign', 'false');
  const advance = async (branch) => {
    git(peer, 'switch', branch);
    await writeFile(join(peer, 'remote.txt'), branch);
    git(peer, 'add', '.'); git(peer, 'commit', '-m', 'Remote update'); git(peer, 'push', 'origin', branch);
    return git(peer, 'rev-parse', 'HEAD');
  };
  return { root, source, advance };
}
test('pulls current root and linked branches from origin regardless of upstream', async (t) => {
  const { root, source, advance } = await remoteFixture(t);
  const rootHead = await advance('main');
  await pullWorktree(root, 'main');
  assert.equal(git(root, 'rev-parse', 'HEAD'), rootHead);
  git(source, 'branch', '--set-upstream-to=origin/main');
  const featureHead = await advance('feature');
  await pullWorktree(source, 'feature');
  assert.equal(git(source, 'rev-parse', 'HEAD'), featureHead);
  assert.equal(git(root, 'rev-parse', 'HEAD'), rootHead);
});
test('rejects dirty, stale, and detached checkouts without discarding changes', async (t) => {
  const { root } = await remoteFixture(t);
  await writeFile(join(root, 'code.txt'), 'local edits');
  await assert.rejects(pullWorktree(root, 'main'), /Commit or stash/);
  await assert.rejects(pullWorktree(root, 'feature'), /branch changed/);
  git(root, 'switch', '--detach');
  await assert.rejects(pullWorktree(root, 'main'), /detached/);
  assert.equal(await readFile(join(root, 'code.txt'), 'utf8'), 'local edits');
});
test('diverged branch fails without merging, rebasing, or changing local HEAD', async (t) => {
  const { root, advance } = await remoteFixture(t);
  await advance('main');
  await writeFile(join(root, 'local.txt'), 'local');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Local commit');
  const head = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(pullWorktree(root, 'main'), /fast-forward/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkoutAtRoot, rootStatus } from '../src/main/git.ts';

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
  const remote = join(dir, 'remote.git');
  git(dir, 'init', '--bare', remote);
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'worktree', 'add', '-b', 'feature', source);
  return { root, source };
}
test('pushes committed code, transfers the branch to root, and pulls there', async (t) => {
  const { root, source } = await fixture(t);
  const main = git(root, 'rev-parse', 'main');
  await writeFile(join(source, 'code.txt'), 'feature');
  git(source, 'commit', '-am', 'feature');
  const result = await checkoutAtRoot(root, source);
  assert.equal(result.branch, 'feature');
  assert.equal(result.commit, git(source, 'rev-parse', 'HEAD'));
  assert.equal(git(source, 'branch', '--show-current'), '');
  assert.equal(git(root, 'rev-parse', 'origin/feature'), result.commit);
  assert.equal(git(root, 'rev-parse', 'FETCH_HEAD'), result.commit);
  assert.equal(git(root, 'rev-parse', 'main'), main);
  assert.equal(await readFile(join(root, 'code.txt'), 'utf8'), 'feature');
});
test('requires a message for dirty source, then commits tracked and untracked files', async (t) => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'code.txt'), 'updated');
  await writeFile(join(source, 'new.txt'), 'new');
  await assert.rejects(checkoutAtRoot(root, source), /commit message/);
  assert.equal((await rootStatus(root)).branch, 'main');
  await checkoutAtRoot(root, source, 'Ready at root');
  assert.equal(git(source, 'log', '-1', '--format=%s'), 'Ready at root');
  assert.equal(await readFile(join(root, 'new.txt'), 'utf8'), 'new');
  assert.equal((await rootStatus(source)).dirty, false);
});
test('dirty root prevents any source commit or checkout', async (t) => {
  const { root, source } = await fixture(t);
  const before = git(source, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'local.txt'), 'keep');
  await writeFile(join(source, 'code.txt'), 'change');
  await assert.rejects(checkoutAtRoot(root, source, 'should not commit'), /root has uncommitted/);
  assert.equal(git(source, 'rev-parse', 'HEAD'), before);
  assert.equal(await readFile(join(root, 'local.txt'), 'utf8'), 'keep');
});
test('rejects an unrelated repository and the root itself', async (t) => {
  const a = await fixture(t), b = await fixture(t);
  await assert.rejects(checkoutAtRoot(a.root, b.source), /linked worktree/);
  await assert.rejects(checkoutAtRoot(a.root, a.root), /linked worktree/);
});
test('failed commit leaves root unchanged and source changes available', async (t) => {
  const { root, source } = await fixture(t);
  await writeFile(join(source, 'code.txt'), 'change');
  git(source, 'config', 'core.hooksPath', join(root, '.git', 'hooks'));
  await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(checkoutAtRoot(root, source, 'blocked'));
  assert.equal((await rootStatus(root)).branch, 'main');
  assert.equal(await readFile(join(source, 'code.txt'), 'utf8'), 'change');
});
test('rejected push preserves the local commit and leaves both checkouts attached', async (t) => {
  const { root, source } = await fixture(t);
  const remote = git(root, 'remote', 'get-url', 'origin');
  await writeFile(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(source, 'code.txt'), 'saved locally');
  await assert.rejects(checkoutAtRoot(root, source, 'saved commit'), /Push failed.*local commit is saved/);
  assert.equal((await rootStatus(root)).branch, 'main');
  assert.equal((await rootStatus(source)).branch, 'feature');
  assert.equal(git(source, 'log', '-1', '--format=%s'), 'saved commit');
});
test('pull failure reports that branch transfer already completed', async (t) => {
  const { root, source } = await fixture(t);
  // Simulate connectivity disappearing only after the root switches branches.
  await writeFile(join(root, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\nif [ "$(basename "$PWD")" = root ]; then git config remote.origin.url /nonexistent/consort-test-remote; fi\n', { mode: 0o755 });
  await assert.rejects(checkoutAtRoot(root, source), /root switched to feature, but pull failed/);
  assert.equal((await rootStatus(root)).branch, 'feature');
  assert.equal((await rootStatus(source)).branch, null);
});

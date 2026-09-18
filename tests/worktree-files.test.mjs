import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, chmod, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyHooks, copyLocalEnv, hooksDirectory, localEnvFiles, prepareWorktree } from '../src/main/worktreeFiles.ts';
import { addWorktree } from '../src/main/git.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'consort-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(root, '.gitignore'), '.env\n.env.*\nnode_modules\n');
  await writeFile(join(root, 'code.txt'), 'initial');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  return root;
}

test('an env file the repo keeps untracked reaches a new worktree', async (t) => {
  const root = await repo(t);
  await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://local\n');
  const path = await addWorktree(root, 'feature-one', 'feature/one', 'main');
  assert.deepEqual(await copyLocalEnv(root, path), ['.env']);
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'DATABASE_URL=postgres://local\n');
  // What we copied is untracked in the repo, so the worktree inherits the same ignore rule.
  assert.equal(git(path, 'status', '--porcelain'), '');
});

test('every env variant travels, samples and tracked files do not', async (t) => {
  const root = await repo(t);
  for (const name of ['.env', '.env.local', '.env.test', '.env.example', '.env.sample'])
    await writeFile(join(root, name), `from ${name}\n`);
  git(root, 'add', '-f', '.env.example');
  git(root, 'commit', '-m', 'sample');

  assert.deepEqual(await localEnvFiles(root), ['.env', '.env.local', '.env.test']);
  const path = await addWorktree(root, 'feature-two', 'feature/two', 'main');
  assert.deepEqual(await copyLocalEnv(root, path), ['.env', '.env.local', '.env.test']);
  // .env.example is tracked, so the checkout already carried it; .env.sample is documentation.
  assert.equal(await readFile(join(path, '.env.example'), 'utf8'), 'from .env.example\n');
  assert.equal(await readdir(path).then(f => f.includes('.env.sample')), false);
});

test('a nested env file keeps its path; vendored trees are never scanned', async (t) => {
  const root = await repo(t);
  await mkdir(join(root, 'packages', 'api'), { recursive: true });
  await writeFile(join(root, 'packages', 'api', 'service.ts'), 'export const x = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'package');
  await writeFile(join(root, 'packages', 'api', '.env'), 'PORT=3000\n');
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'left-pad', '.env'), 'SHOULD_NOT_TRAVEL=1\n');

  assert.deepEqual(await localEnvFiles(root), ['packages/api/.env']);
  const path = await addWorktree(root, 'feature-three', 'feature/three', 'main');
  assert.deepEqual(await copyLocalEnv(root, path), ['packages/api/.env']);
  assert.equal(await readFile(join(path, 'packages', 'api', '.env'), 'utf8'), 'PORT=3000\n');
});

test("a worktree's own edits survive a re-copy, and missing files are restored", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, '.env'), 'SHARED=1\n');
  await writeFile(join(root, '.env.local'), 'LOCAL=1\n');
  const path = await addWorktree(root, 'feature-four', 'feature/four', 'main');
  await copyLocalEnv(root, path);

  await writeFile(join(path, '.env'), 'SHARED=edited-in-worktree\n');
  await rm(join(path, '.env.local'));
  assert.deepEqual(await copyLocalEnv(root, path), ['.env.local'], 'only the missing file is restored');
  assert.equal(await readFile(join(path, '.env'), 'utf8'), 'SHARED=edited-in-worktree\n');
  assert.equal(await readFile(join(path, '.env.local'), 'utf8'), 'LOCAL=1\n');
});

test('a restrictive mode carries over, and the repo root is never a target', async (t) => {
  const root = await repo(t);
  await writeFile(join(root, '.env'), 'SECRET=1\n');
  await chmod(join(root, '.env'), 0o600);
  const path = await addWorktree(root, 'feature-five', 'feature/five', 'main');
  await copyLocalEnv(root, path);
  assert.equal((await stat(join(path, '.env'))).mode & 0o777, 0o600);
  assert.deepEqual(await copyLocalEnv(root, root), [], 'the repo is its own source; nothing to do');
});

test('a repo with no env files is a no-op', async (t) => {
  const root = await repo(t);
  const path = await addWorktree(root, 'feature-six', 'feature/six', 'main');
  assert.deepEqual(await localEnvFiles(root), []);
  assert.deepEqual(await copyLocalEnv(root, path), []);
});

test("one worktree's env file is never handed to its siblings", async (t) => {
  const root = await repo(t);
  await writeFile(join(root, '.env'), 'SHARED=1\n');
  const first = await addWorktree(root, 'feature-seven', 'feature/seven', 'main');
  await copyLocalEnv(root, first);
  // A worktree may hold config of its own; that is its business, not the next worktree's.
  await writeFile(join(first, '.env.worktree-only'), 'PRIVATE=1\n');

  assert.deepEqual(await localEnvFiles(root), ['.env'], 'the scan stops at the repo itself');
  const second = await addWorktree(root, 'feature-eight', 'feature/eight', 'main');
  assert.deepEqual(await copyLocalEnv(root, second), ['.env']);
  assert.equal(await readdir(second).then(f => f.includes('.env.worktree-only')), false);
  assert.equal(await readdir(second).then(f => f.includes('.consort-worktrees')), false);
});

test('a worktree parked outside the ignore rule is still not a source', async (t) => {
  const root = await repo(t);
  await writeFile(join(root, '.env'), 'SHARED=1\n');
  // `git worktree add` straight into the repo, with no ignore entry — what a user does by hand.
  git(root, 'worktree', 'add', '-q', join(root, 'plain-worktree'), '-b', 'plain');
  await writeFile(join(root, 'plain-worktree', '.env'), 'STRAY=1\n');
  assert.deepEqual(await localEnvFiles(root), ['.env']);
});

// Husky v9 exactly: a tracked hook, plus a `_` runner that `prepare` generates and git ignores.
async function husky(root, { hook = 'echo "HOOK RAN"; echo generated > generated.txt\n' } = {}) {
  await mkdir(join(root, '.husky', '_'), { recursive: true });
  await writeFile(join(root, '.husky', 'pre-commit'), hook);
  await writeFile(join(root, '.husky', '_', '.gitignore'), '*\n');
  await writeFile(join(root, '.husky', '_', 'pre-commit'), '#!/bin/sh\n. "$(dirname "$0")/h"\n');
  await writeFile(join(root, '.husky', '_', 'h'), 'sh -e "$(dirname "$0")/../$(basename "$0")"\n');
  await chmod(join(root, '.husky', '_', 'pre-commit'), 0o755);
  git(root, 'add', '-A');
  git(root, 'commit', '-m', 'husky');
  git(root, 'config', 'core.hooksPath', '.husky/_');
}

test('a worktree runs the pre-commit gate, generated files and all', async (t) => {
  const root = await repo(t);
  await husky(root);
  const path = await addWorktree(root, 'hooked', 'feature/hooked', 'main');

  // Reproduces the reported bug: git resolves the relative hooksPath against this
  // worktree, finds no `.husky/_`, and skips the hook without a word.
  await writeFile(join(path, 'a.txt'), 'a\n');
  git(path, 'add', 'a.txt');
  git(path, 'commit', '-m', 'before');
  assert.equal(await readdir(path).then(f => f.includes('generated.txt')), false, 'hook silently skipped');

  assert.deepEqual(await copyHooks(root, path), ['.husky/_/.gitignore', '.husky/_/h', '.husky/_/pre-commit']);
  await writeFile(join(path, 'b.txt'), 'b\n');
  git(path, 'add', 'b.txt');
  git(path, 'commit', '-m', 'after');
  assert.equal(await readFile(join(path, 'generated.txt'), 'utf8'), 'generated\n', 'the hook ran and generated its file');
  assert.equal((await stat(join(path, '.husky', '_', 'pre-commit'))).mode & 0o111, 0o111, 'shims stay executable');
});

test("a branch's own hook wins over the repo's copy", async (t) => {
  const root = await repo(t);
  await husky(root);
  const path = await addWorktree(root, 'own-hook', 'feature/own-hook', 'main');
  // `.husky/pre-commit` is tracked, so the branch may have changed it; only the generated
  // `_` runner is missing. Copying must not drag the root's version over the checkout.
  await writeFile(join(path, '.husky', 'pre-commit'), 'echo "BRANCH HOOK"; echo branch > generated.txt\n');
  git(path, 'commit', '-am', 'branch hook');

  await copyHooks(root, path);
  await writeFile(join(path, 'c.txt'), 'c\n');
  git(path, 'add', 'c.txt');
  git(path, 'commit', '-m', 'run');
  assert.equal(await readFile(join(path, 'generated.txt'), 'utf8'), 'branch\n');
  assert.equal(await readFile(join(root, '.husky', 'pre-commit'), 'utf8'), 'echo "HOOK RAN"; echo generated > generated.txt\n');
});

test('hooks git already shares across worktrees are left alone', async (t) => {
  const root = await repo(t);
  // Unset: every worktree reads $GIT_COMMON_DIR/hooks already.
  assert.equal(await hooksDirectory(root), undefined);
  // Absolute: the same directory from anywhere.
  git(root, 'config', 'core.hooksPath', join(root, '.husky', '_'));
  assert.equal(await hooksDirectory(root), undefined);
  // Pointing outside the repo, or at nothing at all, is not ours to copy either.
  git(root, 'config', 'core.hooksPath', '../elsewhere');
  assert.equal(await hooksDirectory(root), undefined);
  git(root, 'config', 'core.hooksPath', '.husky/_');
  assert.equal(await hooksDirectory(root), undefined, 'nothing generated yet');
  await mkdir(join(root, '.husky', '_'), { recursive: true });
  assert.equal(await hooksDirectory(root), '.husky/_');
});

test('preparing a worktree settles env and hooks together', async (t) => {
  const root = await repo(t);
  await husky(root);
  await writeFile(join(root, '.env'), 'DATABASE_URL=postgres://local\n');
  const path = await addWorktree(root, 'both', 'feature/both', 'main');
  const done = await prepareWorktree(root, path);
  assert.deepEqual(done.env, ['.env']);
  assert.deepEqual(done.hooks, ['.husky/_/.gitignore', '.husky/_/h', '.husky/_/pre-commit']);
  assert.equal(git(path, 'status', '--porcelain'), '', 'nothing copied is newly committable');
  // Re-running is a no-op, not a re-copy.
  assert.deepEqual(await prepareWorktree(root, path), { env: [], hooks: [] });
});

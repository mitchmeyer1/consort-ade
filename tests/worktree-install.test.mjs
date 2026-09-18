import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCommand } from '../src/main/worktreeInstall.ts';

async function pair(t, { lockfile, repoInstalled = true, worktreeInstalled = false, manifest = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'consort-install-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const worktree = join(base, 'wt');
  await mkdir(repo, { recursive: true });
  await mkdir(worktree, { recursive: true });
  if (repoInstalled) await mkdir(join(repo, 'node_modules'), { recursive: true });
  if (worktreeInstalled) await mkdir(join(worktree, 'node_modules'), { recursive: true });
  if (manifest) await writeFile(join(worktree, 'package.json'), '{"name":"x"}');
  if (lockfile) await writeFile(join(worktree, lockfile), '');
  return { repo, worktree };
}

test('each lockfile picks its own manager, frozen to the branch and offline first', async (t) => {
  const expected = {
    'pnpm-lock.yaml': 'pnpm install --frozen-lockfile --prefer-offline',
    'bun.lockb': 'bun install --frozen-lockfile',
    'bun.lock': 'bun install --frozen-lockfile',
    'yarn.lock': 'yarn install --immutable',
    'package-lock.json': 'npm ci --prefer-offline --no-audit --no-fund',
  };
  for (const [lockfile, command] of Object.entries(expected)) {
    const { repo, worktree } = await pair(t, { lockfile });
    assert.equal(await installCommand(repo, worktree), command, lockfile);
  }
});

test('a worktree that already has dependencies is left alone', async (t) => {
  const { repo, worktree } = await pair(t, { lockfile: 'pnpm-lock.yaml', worktreeInstalled: true });
  assert.equal(await installCommand(repo, worktree), undefined);
});

test('a repo that was never installed is not installed on our initiative', async (t) => {
  const { repo, worktree } = await pair(t, { lockfile: 'pnpm-lock.yaml', repoInstalled: false });
  assert.equal(await installCommand(repo, worktree), undefined, 'the first install is the user\'s call');
});

test('a project with no manifest or no lockfile asks for nothing', async (t) => {
  const noLock = await pair(t, {});
  assert.equal(await installCommand(noLock.repo, noLock.worktree), undefined);
  const noManifest = await pair(t, { lockfile: 'pnpm-lock.yaml', manifest: false });
  assert.equal(await installCommand(noManifest.repo, noManifest.worktree), undefined);
});

test('pnpm wins when a repo carries more than one lockfile', async (t) => {
  const { repo, worktree } = await pair(t, { lockfile: 'pnpm-lock.yaml' });
  await writeFile(join(worktree, 'package-lock.json'), '');
  await writeFile(join(worktree, 'yarn.lock'), '');
  assert.equal(await installCommand(repo, worktree), 'pnpm install --frozen-lockfile --prefer-offline');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpoint } from '../src/cli/checkpoint.ts';
import { pushGuard } from '../src/cli/phiGate.ts';
import { phiSettings } from '../src/shared/phi.ts';
import * as pii from './helpers/fake-pii.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'consort-ckpt-')); t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), work = join(root, 'work');
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', '-b', 'main', work);
  git(work, 'config', 'user.email', 't@t'); git(work, 'config', 'user.name', 't');
  await writeFile(join(work, 'a.txt'), 'one\n'); git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'base');
  git(work, 'remote', 'add', 'origin', remote);
  git(work, 'checkout', '-q', '-b', 'feature');
  // a hook that would block both commit and push: checkpoints skip hooks
  await writeFile(join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  return { remote, work };
}

test('uncommitted work is committed and the branch pushed; secrets are never staged', async (t) => {
  const { remote, work } = await repo(t);
  await writeFile(join(work, 'a.txt'), 'two\n');
  await mkdir(join(work, 'src'));
  await writeFile(join(work, 'src', 'new.ts'), 'export {}\n');
  await writeFile(join(work, '.env'), 'SECRET=1\n');
  await writeFile(join(work, 'server.pem'), 'KEY\n');
  const r = await checkpoint(work, 'feature', 'Consort checkpoint: Implementing (Build 3/8)');
  assert.deepEqual(r, { committed: true, pushed: true });
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'feature'), 'Consort checkpoint: Implementing (Build 3/8)');
  assert.deepEqual(git(remote, 'show', '--name-only', '--format=', 'feature').split('\n').sort(), ['a.txt', 'src/new.ts']);
  assert.match(git(work, 'status', '--porcelain'), /\.env[\s\S]*server\.pem/, 'secrets stay untracked');
});

test('nothing new: no commit and no push; commits the agent made itself are still pushed', async (t) => {
  const { remote, work } = await repo(t);
  await writeFile(join(work, 'a.txt'), 'two\n');
  await checkpoint(work, 'feature', 'first');
  assert.deepEqual(await checkpoint(work, 'feature', 'again'), { committed: false, pushed: false });
  await writeFile(join(work, 'a.txt'), 'three\n'); git(work, 'commit', '-q', '--no-verify', '-am', 'agent commit');
  assert.deepEqual(await checkpoint(work, 'feature', 'after agent'), { committed: false, pushed: true });
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'feature'), 'agent commit');
});

test('a failed push is reported, not thrown', async (t) => {
  const { work } = await repo(t);
  git(work, 'remote', 'set-url', 'origin', join(work, 'missing.git'));
  await writeFile(join(work, 'a.txt'), 'two\n');
  const r = await checkpoint(work, 'feature', 'x');
  assert.equal(r.committed, true); assert.equal(r.pushed, false); assert.ok(r.error);
});

test('checkpoints work when .env is gitignored, and never stage a new secret file', async (t) => {
  const { remote, work } = await repo(t);
  await writeFile(join(work, '.gitignore'), '.env\n.consort\n');
  await writeFile(join(work, '.env'), 'SECRET=1\n');
  await writeFile(join(work, 'deploy.key'), 'KEY\n');
  await mkdir(join(work, '.consort'), { recursive: true }); await writeFile(join(work, '.consort', 'x'), 'x');
  await writeFile(join(work, 'a.txt'), 'two\n');
  const r = await checkpoint(work, 'feature', 'with ignored files');
  assert.deepEqual(r, { committed: true, pushed: true });
  assert.deepEqual(git(remote, 'show', '--name-only', '--format=', 'feature').split('\n').sort(), ['.gitignore', 'a.txt']);
});

test('under the PHI/PII guard a checkpoint commits but does not push lines carrying an identifier', async (t) => {
  const { remote, work } = await repo(t);
  const gate = { phi: phiSettings({ phi: { guard: true } }), record() {} };
  const base = git(work, 'rev-parse', 'HEAD');
  await writeFile(join(work, 'fixture.ts'), `export const member = "${pii.ssn()}";\n`);
  const held = await checkpoint(work, 'feature', 'Consort checkpoint: Implementing', undefined, pushGuard(base, gate));
  assert.equal(held.committed, true);
  assert.equal(held.pushed, false);
  assert.equal(held.withheld, true);
  assert.match(held.error, /^Not pushed, by the PII gate: fixture\.ts:1 ssn ×1\./);
  assert.equal(git(remote, 'branch', '--list', 'feature'), '');
  git(work, 'reset', '-q', '--soft', base);
  await writeFile(join(work, 'fixture.ts'), `export const member = "${pii.placeholderSsn()}";\n`);
  const clean = await checkpoint(work, 'feature', 'Consort checkpoint: Implementing', undefined, pushGuard(base, gate));
  assert.equal(clean.pushed, true);
});

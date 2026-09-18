import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerLifecycle } from '../src/main/dockerLifecycle.ts';

async function fixture(t, isAlive = () => false) {
  const dir = await mkdtemp(join(tmpdir(), 'consort-docker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  let failure = false;
  const manager = new DockerLifecycle(dir, async args => {
    calls.push(args);
    if (failure) throw new Error('Docker unavailable');
    return args[0] === 'ps' ? 'a'.repeat(64) + '\n' : '';
  }, isAlive);
  return { dir, calls, manager, fail: value => { failure = value; } };
}

test('each run has its own Consort code; cleanup uses exact labels and never prunes volumes', async t => {
  const { manager, calls } = await fixture(t);
  const first = manager.begin('worktree-one');
  const second = manager.begin('worktree-one');
  assert.notEqual(first.code, second.code);
  assert.match(first.code, /^consort-/);
  await manager.finish(first);
  assert.deepEqual(calls, [
    ['ps', '-aq', '--no-trunc', '--filter', `label=com.docker.compose.project=${first.code}`],
    ['ps', '-aq', '--no-trunc', '--filter', `label=io.consort.run=${first.code}`],
    ['rm', '--force', 'a'.repeat(64)],
  ]);
});

test('recovery removes old orphan runs but skips live processes and recent startup races', async t => {
  const { manager, dir, calls } = await fixture(t, pid => pid === 1234);
  const live = manager.begin('live');
  const orphan = manager.begin('orphan');
  const recent = manager.begin('recent');
  live.pid = 1234;
  orphan.pid = recent.pid = 4321;
  live.startedAt = orphan.startedAt = Date.now() - 3600000;
  for (const run of [live, orphan, recent]) await writeFile(join(dir, `${run.code}.json`), JSON.stringify(run));
  await manager.sweep();
  assert.equal(calls.length, 3);
  assert.ok(calls[0].at(-1).includes(orphan.code));
});

test('failed cleanup persists for retry; finished receipts catch late containers even with a live owner', async t => {
  const { manager, dir, calls, fail } = await fixture(t, () => true);
  const run = manager.begin('wt');
  fail(true);
  await assert.rejects(manager.finish(run), /Docker unavailable/);
  assert.equal(JSON.parse(await readFile(join(dir, `${run.code}.json`), 'utf8')).finished, true);
  fail(false);
  calls.length = 0;
  await manager.sweep();
  assert.equal(calls.filter(c => c[0] === 'rm').length, 1);
  calls.length = 0;
  await manager.sweep();
  assert.equal(calls.filter(c => c[0] === 'rm').length, 1);
  run.startedAt = Date.now() - 2 * 86400000;
  await writeFile(join(dir, `${run.code}.json`), JSON.stringify(run));
  await manager.sweep();
  assert.deepEqual(await readdir(dir), []);
});

test('malformed ownership records cannot broaden cleanup', async t => {
  const { manager, dir, calls } = await fixture(t);
  await writeFile(join(dir, 'unsafe.json'), JSON.stringify({ code: '', pid: 1, startedAt: 1, finished: true }));
  await manager.sweep();
  assert.deepEqual(calls, []);
});

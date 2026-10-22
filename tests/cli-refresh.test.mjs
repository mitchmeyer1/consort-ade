import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsInstall, refresh } from '../src/cli/refresh.ts';

function deps(over = {}) {
  const calls = [];
  let running = new Set([11, 21, 22]);
  const d = {
    calls,
    run: async (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); if (over.fail === `${cmd} ${args.join(' ')}`) throw new Error('boom'); },
    has: async cmd => cmd === 'pnpm',
    tasks: () => over.tasks ?? [{ id: 't1', ticket: { id: 'T1' }, pid: 21 }, { id: 't2', ticket: { id: 'T2' }, pid: 22 }],
    alive: pid => running.has(pid),
    daemonPid: () => 11,
    stopAll: () => { calls.push('stop all'); setTimeout(() => { running = new Set(over.stuck ?? []); }, 5); return { daemon: 11, workers: [21, 22] }; },
    kill: pid => calls.push(`kill ${pid}`),
    startDaemon: entry => { calls.push(`start ${entry}`); return 99; },
    wait: ms => new Promise(r => setTimeout(r, Math.min(ms, 5))),
    log: line => calls.push(`log ${line}`),
  };
  return d;
}

test('builds first, then stops everything, waits for exit, and starts the daemon on the new build', async () => {
  const d = deps();
  await refresh({ root: '/pkg', pull: true, skipInstall: true }, d);
  const order = d.calls.filter(c => !c.startsWith('log '));
  assert.deepEqual(order, ['git pull --ff-only', 'pnpm run build:cli', 'stop all', 'start /pkg/out/cli/index.js']);
  assert.ok(d.calls.some(c => /restarts the 2 task workers/.test(c)));
  assert.ok(d.calls.some(c => /reopen any consort-cli view/.test(c)));
});

test('a failed build leaves the running processes alone', async () => {
  const d = deps({ fail: 'pnpm run build:cli' });
  await assert.rejects(refresh({ root: '/pkg', skipInstall: true }, d), /boom/);
  assert.ok(!d.calls.includes('stop all'));
});

test('a running parallel wave stops the restart unless --force', async () => {
  const tasks = [{ id: 't1', ticket: { id: 'T1' }, pid: 21, childEnvironments: [{ id: 'c', pid: 21, portBase: 1, runCode: 'r' }] }];
  const d = deps({ tasks });
  await assert.rejects(refresh({ root: '/pkg', skipInstall: true }, d), /T1 has a parallel wave running/);
  assert.ok(d.calls.includes('pnpm run build:cli'), 'still built');
  assert.ok(!d.calls.includes('stop all'));
  const f = deps({ tasks });
  await refresh({ root: '/pkg', skipInstall: true, force: true }, f);
  assert.ok(f.calls.includes('stop all'));
});

test('a process that will not exit is forced after the wait', async () => {
  const d = deps({ stuck: [22] });
  await refresh({ root: '/pkg', skipInstall: true, stopWaitMs: 30 }, d);
  assert.ok(d.calls.includes('kill 22'));
  assert.ok(!d.calls.includes('kill 21'));
});

test('install runs only when the lockfile is newer than the last install', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'consort-refresh-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'pnpm-lock.yaml'), 'a');
  assert.equal(needsInstall(root), true, 'no node_modules yet');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'node_modules', '.modules.yaml'), 'x');
  const past = new Date(Date.now() - 60_000);
  await utimes(join(root, 'pnpm-lock.yaml'), past, past);
  assert.equal(needsInstall(root), false);
  const later = new Date(Date.now() + 60_000);
  await utimes(join(root, 'pnpm-lock.yaml'), later, later);
  assert.equal(needsInstall(root), true);
});

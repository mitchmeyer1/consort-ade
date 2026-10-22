import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { implementationFrontier, runResearch, runImplementation, readImplementationTasks } from '../src/cli/parallel.ts';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'consort-parallel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); await mkdir(cwd);
  git(cwd, 'init'); git(cwd, 'config', 'user.email', 'test@example.com'); git(cwd, 'config', 'user.name', 'Test');
  await writeFile(join(cwd, 'a.txt'), 'a\n'); await writeFile(join(cwd, 'b.txt'), 'b\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial');
  return { cwd, directory: join(root, 'parallel') };
}
const tasks = [{ id: 'a', files: ['a.txt'], prompt: 'first' }, { id: 'b', files: ['b.txt'], prompt: 'second' }];

test('frontier rejects overlapping files and unresolved dependencies; caps concurrency at the asked size, at most six', () => {
  const input = [tasks[0], { id: 'overlap', files: ['a.txt'], prompt: '' }, { id: 'blocked', files: ['c'], blockedBy: ['a'], prompt: '' }, tasks[1], { id: 'c', files: ['d'], prompt: '' }];
  assert.deepEqual(implementationFrontier(input, 2).map((x) => x.id), ['a', 'b']);
  assert.deepEqual(implementationFrontier(input).map((x) => x.id), ['a', 'b', 'c'], 'default allows more than two');
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, files: [`f${i}`], prompt: '' }));
  assert.equal(implementationFrontier(many, 20).length, 6);
  assert.throws(() => implementationFrontier([{ id: 'bad', files: ['../other'], prompt: '' }]), /Unsafe/);
});

test('research actually overlaps in isolated worktrees and caches only unchanged relevant revisions', async (t) => {
  const o = await repository(t); let active = 0; let peak = 0; let calls = 0;
  const dirs = new Set();
  const run = async ({ cwd, id }) => {
    dirs.add(cwd); assert.notEqual(cwd, o.cwd); calls++; peak = Math.max(peak, ++active);
    for (const until = Date.now() + 5000; calls < 2 && active < 2 && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
    active--;
    return { text: `${id}: ${await readFile(join(cwd, `${id}.txt`), 'utf8')}` };
  };
  const first = await runResearch({ ...o, tasks, run }); assert.equal(first.reused, false); assert.equal(peak, 2); assert.equal(dirs.size, 2);
  assert.equal((await runResearch({ ...o, tasks, run })).reused, true); assert.equal(calls, 2);
  await writeFile(join(o.cwd, 'a.txt'), 'new uncommitted content');
  const changed = await runResearch({ ...o, tasks, run }); assert.equal(changed.reused, false); assert.match(changed.summary, /new uncommitted content/);
  assert.equal(git(o.cwd, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('independent writers run concurrently, coordinator integrates then checks', async (t) => {
  const o = await repository(t); let active = 0; let peak = 0; let checks = 0;
  const result = await runImplementation({ ...o, tasks, run: async ({ cwd, id }) => {
    peak = Math.max(peak, ++active);
    // Wait for the other writer instead of a fixed sleep; worktree setup time varies under load.
    for (const until = Date.now() + 5000; active < 2 && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
    await writeFile(join(cwd, `${id}.txt`), `changed ${id}\n`); active--; return { text: 'done' };
  }, check: async (cwd) => {
    checks++; assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'changed a\n'); assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'changed b\n');
  } });
  assert.equal(peak, 2); assert.equal(checks, 1); assert.deepEqual(result.completed, ['a', 'b']); assert.equal(result.commits.length, 2);
  assert.equal(git(o.cwd, 'status', '--porcelain'), '');
  assert.equal(git(o.cwd, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('out-of-scope edits reject the batch before integration and cleanup all writers', async (t) => {
  const o = await repository(t); const head = git(o.cwd, 'rev-parse', 'HEAD'); let checked = false;
  await assert.rejects(runImplementation({ ...o, tasks, run: async ({ cwd, id }) => {
    await writeFile(join(cwd, id === 'a' ? 'forbidden.txt' : 'b.txt'), 'oops'); return { text: 'done' };
  }, check: async () => { checked = true; } }), /outside its scope/);
  assert.equal(git(o.cwd, 'rev-parse', 'HEAD'), head); assert.equal(checked, false);
  assert.equal(git(o.cwd, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('ticket parser requires explicit scopes and resolves completed blockers', async (t) => {
  const o = await repository(t); const issues = join(o.cwd, '.consort/ship/issues'); await mkdir(issues, { recursive: true });
  await writeFile(join(issues, '01-first.md'), '**Status:** done\n**Files:** a.txt\n**Blocked by:** none\n');
  await writeFile(join(issues, '02-second.md'), '**Status:** ready-for-agent\n**Files:** b.txt\n**Blocked by:** 01\n');
  await writeFile(join(issues, '03-old.md'), '**Status:** ready-for-agent\n**Blocked by:** none\n');
  const ready = await readImplementationTasks(o.cwd); assert.equal(ready.length, 1); assert.deepEqual(ready[0].blockedBy, []); assert.deepEqual(ready[0].files, ['b.txt']);
});

test('writers receive ignored spec context and a failed final check does not replay integrated tickets', async (t) => {
  const o = await repository(t); const issues = join(o.cwd, '.consort/ship/issues'); await mkdir(issues, { recursive: true });
  await writeFile(join(o.cwd, '.consort/ship/SPEC.md'), 'owner approved the change');
  for (const task of tasks) await writeFile(join(issues, `${task.id}.md`), '**Status:** ready-for-agent\n');
  let calls = 0;
  const run = async ({ cwd, id }) => {
    calls++; assert.equal(await readFile(join(cwd, '.consort/ship/SPEC.md'), 'utf8'), 'owner approved the change');
    await writeFile(join(cwd, `${id}.txt`), 'implemented'); return { text: 'done' };
  };
  await assert.rejects(runImplementation({ ...o, tasks, run, check: async () => { throw new Error('check failed'); } }), /check failed/);
  assert.equal(calls, 2);
  for (const task of tasks) assert.match(await readFile(join(issues, `${task.id}.md`), 'utf8'), /Status:\*\* done/);
  const again = await runImplementation({ ...o, tasks, run, check: async () => {} });
  assert.deepEqual(again.completed, []); assert.equal(calls, 2);
  assert.equal(git(o.cwd, 'for-each-ref', 'refs/consort/parallel'), '');
  assert.equal(git(o.cwd, 'ls-files', '.consort'), '');
});

test('an owner question stops integration and restores ready status', async (t) => {
  const o = await repository(t); const head = git(o.cwd, 'rev-parse', 'HEAD');
  await assert.rejects(runImplementation({ ...o, tasks, run: async () => ({ text: '[ask-user: This breaks billing. Proceed?]' }), check: async () => assert.fail('must not check') }), /ask-user/);
  assert.equal(git(o.cwd, 'rev-parse', 'HEAD'), head);
  assert.equal(git(o.cwd, 'worktree', 'list', '--porcelain').split('worktree ').length - 1, 1);
});

test('a tracked caller outside the initial scope invalidates cached research', async (t) => {
  const o = await repository(t); let calls = 0;
  const run = async () => { calls++; return { text: 'report' }; };
  await runResearch({ ...o, tasks: [tasks[0]], run });
  await writeFile(join(o.cwd, 'b.txt'), 'changed caller');
  const result = await runResearch({ ...o, tasks: [tasks[0]], run });
  assert.equal(result.reused, false); assert.equal(calls, 2);
});

test('automatic reader scopes exclude credentials and symlinks; unsafe direct scopes fail', async (t) => {
  const { prepareResearchTasks } = await import('../src/cli/parallel.ts');
  const { symlink } = await import('node:fs/promises');
  const o = await repository(t);
  await writeFile(join(o.cwd, '.env.production'), 'SECRET=hidden');
  await symlink('/etc/passwd', join(o.cwd, 'external-link'));
  git(o.cwd, 'add', '.'); git(o.cwd, 'commit', '-m', 'secret and link fixtures');
  const prepared = await prepareResearchTasks(o.cwd, 'Add a thing');
  const scopes = prepared.flatMap((task) => task.files);
  assert(!scopes.includes('.env.production')); assert(!scopes.includes('external-link'));
  await assert.rejects(runResearch({ ...o, tasks: [{ id: 'link', files: ['external-link'], prompt: '' }], run: async () => assert.fail('must refuse symlink') }), /symlink refused/);
});

test('CLI coordinator yields after breakdown and each serial ticket; desktop keeps approval flow', async () => {
  const { shipPrompt } = await import('../src/shared/shipPrompt.ts');
  const { newShipFeature } = await import('../src/shared/ship.ts');
  const input = { feature: { ...newShipFeature({ source: 'github', id: '1', title: 'Task', url: 'https://example.com/1', repo: 'test/repo' }, 'task', 1), stage: "Spec'd" }, form: { form: 'resume' }, worktree: '/repo', branch: 'task', base: 'main' };
  const cli = shipPrompt({ ...input, headless: true, runtimeParallel: true });
  assert.match(cli, /write all ticket files with Status: ready-for-agent/);
  assert.match(cli, /END THE TURN before implementation/);
  assert.match(cli, /implement at most ONE serial ticket/);
  assert.match(cli, /Files:\*\* explicit comma-separated/);
  const desktop = shipPrompt(input);
  assert.match(desktop, /Breakdown proposed: <n> tickets/);
  assert.doesNotMatch(desktop, /implement at most ONE serial ticket/);
});

test('startup recovery detects a landed cherry-pick and resets unfinished writers to ready', async (t) => {
  const { recoverImplementation } = await import('../src/cli/parallel.ts');
  const o = await repository(t); const base = git(o.cwd, 'rev-parse', 'HEAD');
  const issues = join(o.cwd, '.consort/ship/issues'); await mkdir(issues, { recursive: true });
  for (const task of tasks) await writeFile(join(issues, `${task.id}.md`), `**Status:** in-progress\n**Files:** ${task.files[0]}\n**Blocked by:** none\n`);
  await writeFile(join(o.cwd, 'a.txt'), 'landed before crash');
  git(o.cwd, 'add', 'a.txt'); git(o.cwd, 'commit', '-m', 'Implement a\n\nConsort-Parallel: a');
  const commit = git(o.cwd, 'rev-parse', 'HEAD');
  const refs = ['refs/consort/parallel/aaaaaaaa', 'refs/consort/parallel/bbbbbbbb'];
  for (const ref of refs) git(o.cwd, 'update-ref', ref, commit);
  await mkdir(o.directory, { recursive: true });
  await writeFile(join(o.directory, 'implementation.json'), JSON.stringify({ base, tasks: tasks.map((task, i) => ({ id: task.id, ref: refs[i], commit })), integrated: [] }));
  assert.deepEqual(await recoverImplementation(o.cwd, o.directory), ['a']);
  assert.match(await readFile(join(issues, 'a.md'), 'utf8'), /Status:\*\* done/);
  assert.match(await readFile(join(issues, 'b.md'), 'utf8'), /Status:\*\* ready-for-agent/);
  assert.deepEqual((await readImplementationTasks(o.cwd)).map((task) => task.id), ['b']);
  assert.equal(git(o.cwd, 'for-each-ref', 'refs/consort/parallel'), '');
});

test('recovery refuses an unrelated coordinator history before changing tickets', async (t) => {
  const { recoverImplementation } = await import('../src/cli/parallel.ts');
  const o = await repository(t); const issues = join(o.cwd, '.consort/ship/issues'); await mkdir(issues, { recursive: true });
  await writeFile(join(issues, 'a.md'), '**Status:** in-progress\n');
  const initial = git(o.cwd, 'rev-parse', 'HEAD');
  await writeFile(join(o.cwd, 'a.txt'), 'other branch'); git(o.cwd, 'add', 'a.txt'); git(o.cwd, 'commit', '-m', 'future wave base');
  const base = git(o.cwd, 'rev-parse', 'HEAD'); const ref = 'refs/consort/parallel/cccccccc'; git(o.cwd, 'update-ref', ref, base);
  git(o.cwd, 'checkout', '--detach', initial);
  await mkdir(o.directory, { recursive: true }); await writeFile(join(o.directory, 'implementation.json'), JSON.stringify({ base, tasks: [{ id: 'a', ref, commit: base }], integrated: [] }));
  await assert.rejects(recoverImplementation(o.cwd, o.directory), /not an ancestor/);
  assert.equal(await readFile(join(issues, 'a.md'), 'utf8'), '**Status:** in-progress\n');
  assert.equal(git(o.cwd, 'for-each-ref', 'refs/consort/parallel'), '');
});

test('the real layout works: journal inside .consort/ship/parallel, child worktrees beside the task worktree', async (t) => {
  const o = await repository(t);
  await mkdir(join(o.cwd, '.consort', 'ship'), { recursive: true });
  await writeFile(join(o.cwd, '.consort', 'ship', 'SPEC.md'), 'spec');
  const directory = join(o.cwd, '.consort', 'ship', 'parallel');
  const seen = [];
  const run = async ({ cwd }) => { seen.push(cwd); assert.equal(await readFile(join(cwd, '.consort', 'ship', 'SPEC.md'), 'utf8'), 'spec'); assert.ok(!cwd.startsWith(o.cwd + '/'), 'child worktree is outside the task worktree'); return { text: 'ok' }; };
  const r = await runResearch({ cwd: o.cwd, directory, tasks, run });
  assert.equal(r.reused, false);
  assert.equal(seen.length, 2);
});

test('recovering an old crashed wave never reverts a ticket finished since', async (t) => {
  const { recoverImplementation } = await import('../src/cli/parallel.ts');
  const o = await repository(t);
  const issues = join(o.cwd, '.consort', 'ship', 'issues'); await mkdir(issues, { recursive: true });
  await writeFile(join(issues, '12-a.md'), '# 12\n**Status:** done\n');
  await writeFile(join(issues, '13-b.md'), '# 13\n**Status:** in-progress\n');
  await mkdir(o.directory, { recursive: true });
  const base = git(o.cwd, 'rev-parse', 'HEAD');
  await writeFile(join(o.directory, 'implementation.json'), JSON.stringify({ base, tasks: [{ id: '12-a', ref: 'refs/consort/parallel/0', commit: '' }, { id: '13-b', ref: 'refs/consort/parallel/1', commit: '' }], integrated: [] }));
  await recoverImplementation(o.cwd, o.directory);
  assert.match(await readFile(join(issues, '12-a.md'), 'utf8'), /Status:\*\* done/);
  assert.match(await readFile(join(issues, '13-b.md'), 'utf8'), /Status:\*\* ready-for-agent/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { implementationFrontier, runResearch, runImplementation, readImplementationTasks, runResourceResearch } from '../src/cli/parallel.ts';

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

test('an out-of-scope ticket is held back while the rest of the wave lands; all out of scope rejects; writers are cleaned up', async (t) => {
  const o = await repository(t); const head = git(o.cwd, 'rev-parse', 'HEAD'); let checked = false;
  const r = await runImplementation({ ...o, tasks, run: async ({ cwd, id }) => {
    await writeFile(join(cwd, id === 'a' ? 'forbidden.txt' : 'b.txt'), 'oops'); return { text: 'done' };
  }, check: async () => { checked = true; } });
  assert.deepEqual(r.completed, ['b']); assert.match(r.failed[0].error, /outside its scope/); assert.equal(checked, true);
  assert.ok(!git(o.cwd, 'ls-files').includes('forbidden.txt'));
  const o2 = await repository(t); const head2 = git(o2.cwd, 'rev-parse', 'HEAD');
  await assert.rejects(runImplementation({ ...o2, tasks, run: async ({ cwd, id }) => { await writeFile(join(cwd, `forbidden-${id}.txt`), 'oops'); return { text: 'done' }; }, check: async () => {} }), /outside its scope/);
  assert.equal(git(o2.cwd, 'rev-parse', 'HEAD'), head2);
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
  assert.match(cli, /implement at most ONE ticket, and only one that cannot run in parallel/);
  assert.match(cli, /Files:\*\* explicit comma-separated/);
  const desktop = shipPrompt(input);
  assert.match(desktop, /Breakdown proposed: <n> tickets/);
  assert.doesNotMatch(desktop, /implement at most ONE ticket, and only one that cannot run in parallel/);
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

test('recovery removes child worktrees a stopped worker left behind', async (t) => {
  const { recoverImplementation } = await import('../src/cli/parallel.ts');
  const o = await repository(t);
  const { dirname, basename } = await import('node:path');
  const left = join(dirname(o.cwd), `.parallel-${basename(o.cwd)}`, 'work-stale');
  await mkdir(dirname(left), { recursive: true });
  git(o.cwd, 'worktree', 'add', '--detach', left, 'HEAD');
  assert.equal(git(o.cwd, 'worktree', 'list').split('\n').length, 2);
  await recoverImplementation(o.cwd, o.directory);
  assert.equal(git(o.cwd, 'worktree', 'list').split('\n').length, 1);
});

test('a failed child keeps its work under refs/consort/wip and the next run starts from it', async (t) => {
  const o = await repository(t);
  const two = [{ id: 'a', files: ['a.txt'], prompt: '' }, { id: 'b', files: ['b.txt'], prompt: '' }];
  let round = 0;
  const run = async ({ cwd, id, prompt }) => {
    if (round === 0) { await writeFile(join(cwd, `${id}.txt`), `${id} half done\n`); throw new Error('usage limit hit'); }
    if (id === 'a') assert.match(prompt, /interrupted run of this ticket saved work/);
    assert.equal(await readFile(join(cwd, `${id}.txt`), 'utf8'), `${id} half done\n`, 'resumed from the saved work');
    await writeFile(join(cwd, `${id}.txt`), `${id} finished\n`);
    return { text: 'ok' };
  };
  await assert.rejects(runImplementation({ ...o, tasks: two, run, check: async () => {} }), /usage limit hit/);
  assert.ok(git(o.cwd, 'rev-parse', '--verify', 'refs/consort/wip/a'), 'saved after the failure');
  round = 1;
  const r = await runImplementation({ ...o, tasks: two, run, check: async () => {} });
  assert.deepEqual(r.completed.sort(), ['a', 'b']);
  assert.equal(await readFile(join(o.cwd, 'a.txt'), 'utf8'), 'a finished\n');
  assert.throws(() => git(o.cwd, 'rev-parse', '--verify', '--quiet', 'refs/consort/wip/a'), 'the saved ref is dropped once integrated');
});

test('stopping saves every running child, and cleanup after a crash salvages instead of deleting', async (t) => {
  const { saveLiveChildren } = await import('../src/cli/parallel.ts');
  const o = await repository(t);
  const two = [{ id: 'a', files: ['a.txt'], prompt: '' }, { id: 'b', files: ['b.txt'], prompt: '' }];
  let release;
  const gate = new Promise(r => { release = r; });
  let started = 0;
  const run = async ({ cwd, id }) => { await writeFile(join(cwd, `${id}.txt`), `${id} in flight\n`); started++; await gate; throw new Error('stopped'); };
  const wave = runImplementation({ ...o, tasks: two, run, check: async () => {} }).catch(e => e);
  for (const until = Date.now() + 5000; started < 2 && Date.now() < until;) await new Promise(r => setTimeout(r, 10));
  await saveLiveChildren();
  assert.match(git(o.cwd, 'show', 'refs/consort/wip/a:a.txt'), /a in flight/, 'saved while still running');
  release(); await wave;
  // a crash that left a folder behind: the marker lets recovery save it before removing the folder
  const { recoverImplementation } = await import('../src/cli/parallel.ts');
  const { dirname, basename } = await import('node:path');
  const left = join(dirname(o.cwd), `.parallel-${basename(o.cwd)}`, 'work-left');
  git(o.cwd, 'worktree', 'add', '--detach', left, 'HEAD');
  const base = git(left, 'rev-parse', 'HEAD');
  await writeFile(`${left}.json`, JSON.stringify({ main: o.cwd, ticket: 'c', base }));
  await writeFile(join(left, 'c.txt'), 'c unsaved\n');
  await recoverImplementation(o.cwd, o.directory);
  assert.match(git(o.cwd, 'show', 'refs/consort/wip/c:c.txt'), /c unsaved/);
  assert.equal(git(o.cwd, 'worktree', 'list').split('\n').length, 1);
});

test('one ticket failing does not sink the wave: the others are integrated, the failed one goes back to ready', async (t) => {
  const o = await repository(t);
  const issues = join(o.cwd, '.consort', 'ship', 'issues'); await mkdir(issues, { recursive: true });
  for (const id of ['a', 'b']) await writeFile(join(issues, `${id}.md`), `# ${id}\n**Status:** ready-for-agent\n`);
  const run = async ({ cwd, id }) => { await writeFile(join(cwd, `${id}.txt`), `${id} new\n`); if (id === 'b') throw new Error('The agent exceeded 90 minutes on one turn'); return { text: 'ok' }; };
  let started;
  const r = await runImplementation({ ...o, tasks, run, check: async () => {}, onStart: async ids => { started = ids; } });
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(r.completed, ['a']);
  assert.deepEqual(r.failed.map(f => f.id), ['b']);
  assert.match(r.failed[0].error, /90 minutes/);
  assert.equal(await readFile(join(o.cwd, 'a.txt'), 'utf8'), 'a new\n');
  assert.match(await readFile(join(issues, 'a.md'), 'utf8'), /Status:\*\* done/);
  assert.match(await readFile(join(issues, 'b.md'), 'utf8'), /Status:\*\* ready-for-agent/);
  assert.match(git(o.cwd, 'show', 'refs/consort/wip/b:b.txt'), /b new/, 'the failed ticket keeps its work');
});

test('a child commits even when .consort and .env are gitignored', async (t) => {
  const o = await repository(t);
  await writeFile(join(o.cwd, '.gitignore'), '.consort\n.env\n'); git(o.cwd, 'add', '.gitignore'); git(o.cwd, 'commit', '-m', 'ignore');
  const run = async ({ cwd, id }) => { await writeFile(join(cwd, `${id}.txt`), `${id} ok\n`); await writeFile(join(cwd, '.env'), 'SECRET=1\n'); return { text: 'ok' }; };
  const r = await runImplementation({ ...o, tasks, run, check: async () => {} });
  assert.deepEqual(r.completed.sort(), ['a', 'b']);
  assert.ok(!git(o.cwd, 'log', '--name-only', '--format=', '-2').includes('.env'));
});

async function notesRepo(t) {
  const root = await mkdtemp(join(tmpdir(), 'consort-notes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'vault'); await mkdir(join(cwd, 'decisions'), { recursive: true });
  git(cwd, 'init'); git(cwd, 'config', 'user.email', 'test@example.com'); git(cwd, 'config', 'user.name', 'Test');
  await writeFile(join(cwd, 'README.md'), '# Team notes\n\n- decisions/2026-07-24-ticketing.md\n');
  await writeFile(join(cwd, 'decisions', '2026-07-24-ticketing.md'), '# Support tickets are opened by the messaging platform, not the app\n');
  git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'notes');
  return { cwd, directory: join(root, 'parallel') };
}

test('resource readers read each checkout in place, report to the planner with paths and dates, and reuse an unchanged report', async (t) => {
  const notes = await notesRepo(t);
  const calls = [];
  const run = async (job) => { calls.push(job); return { text: 'Relevant: support tickets are opened by the messaging platform (2026-07-24, decisions/2026-07-24-ticketing.md)' }; };
  const o = { resources: [{ id: 'res_1', name: 'team-notes', kind: 'markdown', path: notes.cwd }], directory: notes.directory, ticketBody: 'Open a support ticket from the app', run };
  const first = await runResourceResearch(o);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, notes.cwd, 'read in place, not in a worktree');
  assert.equal(calls[0].kind, 'resource');
  assert.match(calls[0].prompt, /read-only/);
  assert.match(calls[0].prompt, /Open a support ticket from the app/);
  assert.match(first.summary, /^## Prior decisions \(project info resources\)\n### team-notes\nRelevant: support tickets/);
  assert.equal(first.sections[0].reused, false);
  const report = await readFile(join(notes.directory, 'RESOURCES.md'), 'utf8');
  assert.match(report, /## team-notes/);
  assert.ok(report.includes(git(notes.cwd, 'rev-parse', 'HEAD')), 'the report names the commit it read');

  const again = await runResourceResearch(o);
  assert.equal(calls.length, 1, 'same checkout and ticket: the report is reused');
  assert.equal(again.sections[0].reused, true);
  assert.equal(again.summary, first.summary);
  await runResourceResearch({ ...o, ticketBody: 'Something else' });
  assert.equal(calls.length, 2, 'a different ticket is read again');
  await writeFile(join(notes.cwd, 'decisions', 'draft.md'), 'not committed yet\n');
  await runResourceResearch(o);
  assert.equal(calls.length, 3, 'an uncommitted edit is read again');
  git(notes.cwd, 'add', '.'); git(notes.cwd, 'commit', '-m', 'draft');
  await runResourceResearch(o);
  assert.equal(calls.length, 4, 'a new commit is read again');
  assert.equal(git(notes.cwd, 'status', '--porcelain'), '', 'nothing was written into the notes');
  assert.equal(git(notes.cwd, 'worktree', 'list').split('\n').length, 1, 'no worktree was made');
});

test('a resource that cannot be read is reported as failed while the others still count; nothing relevant adds no section; failures are not cached', async (t) => {
  const quiet = await notesRepo(t), broken = await notesRepo(t);
  const calls = [];
  const run = async (job) => { calls.push(job.cwd); return job.cwd === quiet.cwd ? { text: '[resource: none]' } : { text: '', error: 'reader crashed' }; };
  const resources = [
    { id: 'r1', name: 'quiet', kind: 'markdown', path: quiet.cwd },
    { id: 'r2', name: 'broken', kind: 'markdown', path: broken.cwd },
    { id: 'r3', name: 'missing', kind: 'markdown', path: join(quiet.cwd, 'nope') },
    { id: 'r4', name: 'relative', kind: 'markdown', path: 'notes' },
  ];
  const o = { resources, directory: quiet.directory, ticketBody: 'ticket', run };
  const r = await runResourceResearch(o);
  assert.equal(r.summary, '', 'no section when nothing bore on the ticket');
  assert.deepEqual(r.sections.map((s) => [s.name, s.empty]), [['quiet', true]]);
  assert.deepEqual(r.failed.map((f) => f.name), ['broken', 'missing', 'relative']);
  assert.match(r.failed[0].error, /reader crashed/);
  assert.match(r.failed[1].error, /not a git checkout/);
  assert.match(r.failed[2].error, /not an absolute path/);
  await runResourceResearch(o);
  // readers run concurrently, so count per checkout rather than in order
  assert.deepEqual([calls.filter((c) => c === quiet.cwd).length, calls.filter((c) => c === broken.cwd).length], [1, 2], 'the empty report is reused, the failed one is asked again');
});

test('a resource report is masked before it reaches the planner', async (t) => {
  const notes = await notesRepo(t);
  const address = ['someone', 'example.org'].join('@');
  const r = await runResourceResearch({ resources: [{ id: 'r1', name: 'team-notes', kind: 'markdown', path: notes.cwd }], directory: notes.directory, ticketBody: 'ticket', run: async () => ({ text: `Relevant: escalations go to ${address}` }) });
  assert.ok(!r.summary.includes(address));
  assert.match(r.summary, /escalations go to \*\*\*\*/);
});

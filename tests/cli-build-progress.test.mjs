import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgress, countBuildTickets, stepLabel, ticketStatus } from '../src/cli/buildProgress.ts';

test('ticket status lines are read in the formats the agent writes', () => {
  assert.equal(ticketStatus('# 01\n**Status:** done\n'), 'done');
  assert.equal(ticketStatus('Status: In-Progress'), 'in-progress');
  assert.equal(ticketStatus('- **Status:** `ready-for-agent`'), 'ready-for-agent');
  assert.equal(ticketStatus('no status here'), undefined);
});

test('only done tickets count; tickets without a status are left out', () => {
  assert.deepEqual(countBuildTickets(['done', 'in-progress', 'ready-for-agent', 'completed', undefined]), { done: 2, total: 4 });
  assert.equal(countBuildTickets([undefined]), undefined);
});

test('the build step shows tickets done out of total; other steps and missing tickets stay plain', async (t) => {
  const wt = await mkdtemp(join(tmpdir(), 'consort-build-')); t.after(() => rm(wt, { recursive: true, force: true }));
  assert.equal(stepLabel('Build', wt, 1), 'Build');
  const dir = join(wt, '.consort', 'ship', 'issues');
  await mkdir(dir, { recursive: true });
  for (const [i, s] of ['done', 'done', 'in-progress', 'ready-for-agent'].entries()) await writeFile(join(dir, `0${i}-x.md`), `# t\n**Status:** ${s}\n`);
  await writeFile(join(dir, 'notes.txt'), 'Status: done');
  assert.deepEqual(buildProgress(wt, 10_000), { done: 2, total: 4 });
  assert.equal(stepLabel('Build', wt, 20_000), 'Build 2/4');
  assert.equal(stepLabel('Test', wt, 20_000), 'Test');
});

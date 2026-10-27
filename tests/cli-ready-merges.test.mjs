import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CONSORT_CLI_HOME = mkdtempSync(join(tmpdir(), 'ready-merges-'));
const { loadState, saveState } = await import('../src/cli/state.ts');
const { settleReadyMerges } = await import('../src/cli/readyMerges.ts');

test('a ready task whose PR was merged becomes done; an open one stays ready and is not read again within two minutes', async () => {
  const s = loadState();
  s.jobs = [{ id: 'j1', repo: '/repo' }];
  const task = (id, branch) => ({ id, jobId: 'j1', branch, status: 'ready', ticket: { id: `T-${id}`, title: id }, startedAt: 0, updatedAt: 0, finishedAt: 1 });
  s.tasks = [task('merged', 'b-merged'), task('open', 'b-open'), { ...task('working', 'b-work'), status: 'working' }];
  saveState(s);
  const reads = [];
  const read = async (repo, branch) => { reads.push(`${repo}:${branch}`); return branch === 'b-merged' ? 'MERGED' : 'OPEN'; };
  const announced = [];
  const after = async (t, job, merged) => { announced.push([t.id, merged]); };
  assert.deepEqual(await settleReadyMerges(1_000_000, read, after), ['merged']);
  assert.deepEqual(announced, [['merged', true]]);
  assert.deepEqual(reads, ['/repo:b-merged', '/repo:b-open'], 'only ready tasks are read');
  const byId = Object.fromEntries(loadState().tasks.map(t => [t.id, t]));
  assert.equal(byId.merged.status, 'done'); assert.equal(byId.merged.note, 'merged'); assert.equal(byId.merged.finishedAt, 1_000_000);
  assert.equal(byId.open.status, 'ready'); assert.equal(byId.working.status, 'working');
  await settleReadyMerges(1_060_000, read, after);
  assert.equal(reads.length, 2, 'not read again within two minutes');
});

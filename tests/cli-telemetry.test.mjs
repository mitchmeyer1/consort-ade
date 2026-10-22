import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordTurn, readTurns, summarize, renderReport, historyTurns, sinceMs, sumUsage } from '../src/cli/telemetry.ts';

const T = Date.UTC(2026, 9, 22, 12, 0);
const rec = (over = {}) => ({ at: T, durationMs: 10 * 60_000, ticket: 'T1', title: 'Feature', kind: 'build', stage: 'Implementing', step: 'Implementing t1', provider: 'claude', account: 'A', model: 'claude-sonnet-5', resumed: false, outcome: 'ok', usd: 1, tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 10 }, ...over });

test('turns are appended per month and read back by ticket and time', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'consort-tel-')); t.after(() => rm(home, { recursive: true, force: true }));
  recordTurn(home, rec());
  recordTurn(home, rec({ ticket: 'T2', at: T + 1000 }));
  recordTurn(home, rec({ at: Date.UTC(2026, 10, 2) }));
  assert.match(await readFile(join(home, 'telemetry', 'turns-2026-10.jsonl'), 'utf8'), /"ticket":"T1"/);
  assert.equal(readTurns(home).length, 3);
  assert.equal(readTurns(home, { ticket: 'T1' }).length, 2);
  assert.equal(readTurns(home, { since: T + 500 }).length, 2);
});

test('the summary measures real parallelism, waste and the split by stage, model and parallel ticket', () => {
  const rs = [
    rec({ step: 'parallel ticket 08', at: T, durationMs: 60 * 60_000 }),
    rec({ step: 'parallel ticket 13', at: T, durationMs: 60 * 60_000, account: 'B' }),
    rec({ step: 'parallel ticket 15', at: T, durationMs: 15 * 60_000, outcome: 'timeout', usd: 0.5 }),
    rec({ step: 'Implementing t2', at: T + 60 * 60_000, durationMs: 30 * 60_000, model: 'claude-fable-5-1', usd: 3 }),
  ];
  const r = summarize(rs);
  assert.equal(r.turns, 4);
  assert.equal(r.wallMs, 90 * 60_000);
  assert.equal(r.agentMs, 165 * 60_000);
  assert.equal(r.parallelism.toFixed(2), (165 / 90).toFixed(2));
  assert.equal(r.wasted.turns, 1);
  assert.equal(r.byStep.length, 3, 'only parallel tickets and review areas');
  assert.deepEqual(r.byModel.map(([m]) => m), ['claude-sonnet-5', 'claude-fable-5-1']);
  const md = renderReport('Agent report: T1', rs);
  assert.match(md, /\*\*Wall clock:\*\* 1h 30m · \*\*agent time:\*\* 2h 45m · \*\*parallelism:\*\* 1\.8×/);
  assert.match(md, /## Turns that did not finish[\s\S]*parallel ticket 15[\s\S]*timeout/);
  assert.match(renderReport('Nothing', []), /No agent turns recorded/);
});

test('older turns come from the task history; durations, usage and since are parsed', () => {
  const task = { id: 'task-1', ticket: { id: 'T1', title: 'Feature' }, turnHistory: [
    { at: T, stage: 'Implementing', role: 'implementation', provider: 'claude', model: 'claude-sonnet-5', durationMs: 900000, error: 'Timed out after 900000ms' },
    { at: T + 5, stage: 'Implementing', role: 'implementation', provider: 'claude', model: 'claude-sonnet-5', durationMs: 1, usage: [{ model: 'm', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, usd: 0.5 }] },
  ] };
  const h = historyTurns(task, T + 1);
  assert.equal(h.length, 1, 'only turns before the first logged one');
  assert.equal(h[0].outcome, 'timeout');
  assert.deepEqual(sumUsage(task.turnHistory[1].usage), { usd: 0.5, tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  assert.equal(sinceMs('7d'), 7 * 86_400_000); assert.equal(sinceMs('90m'), 90 * 60_000); assert.equal(sinceMs('soon'), undefined);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { needsLinks, subtaskTargets, syncSubtasks, writeSubtaskFile } from '../src/cli/subtasks.ts';

const subs = [{ id: '17thtp0p4yp', name: '1. Proposal data model', url: 'u1' }, { id: '17thtp0p4yq', name: '2. Promotion service', url: 'u2' }, { id: '17thtp0p4yv', name: '5. ClaudeCodeClient', url: 'u5' }];
const t = (id, status, clickup) => ({ id, title: `${id}: ticket ${id}`, status, blockedBy: [], files: [], clickup });
const fake = () => { const calls = []; return { calls, source: { setStatus: async (id, s) => calls.push(`status ${id} ${s}`), comment: async (id, text) => calls.push(`comment ${id} ${text}`) } }; };

test('a subtask is in progress once any ticket starts and in review once all are built; unlinked ones stay put', () => {
  const tickets = [t('01', 'done', ['17thtp0p4yp']), t('02', 'done', ['17thtp0p4yq']), t('03', 'in-progress', ['17thtp0p4yq']), t('09', 'ready-for-agent', ['17thtp0p4yv'])];
  const m = subtaskTargets(subs, tickets);
  assert.equal(m.get('17thtp0p4yp').state, 'review');
  assert.equal(m.get('17thtp0p4yq').state, 'progress');
  assert.equal(m.get('17thtp0p4yv').state, undefined);
  assert.equal(needsLinks(subs, tickets), false);
  assert.equal(needsLinks(subs, [t('01', 'ready-for-agent', [])]), true);
  assert.equal(needsLinks([], [t('01', 'ready-for-agent', [])]), false);
});

test('sync moves forward only, comments on each subtask, and posts one roll-up on the parent', async () => {
  const f = fake();
  const tickets = [t('01', 'done', ['17thtp0p4yp']), t('03', 'in-progress', ['17thtp0p4yq'])];
  const saved = await syncSubtasks({ source: f.source, parentId: 'P', subtasks: subs, tickets, saved: {}, where: 'Commit abc on b.' });
  assert.deepEqual(saved, { '17thtp0p4yp': 'review', '17thtp0p4yq': 'progress' });
  assert.ok(f.calls.includes('status 17thtp0p4yp review'));
  assert.ok(f.calls.some(c => /^comment 17thtp0p4yp Consort built this: ticket 01\. Commit abc on b\.$/.test(c)));
  assert.ok(f.calls.some(c => /^comment P Consort progress: 1 of 3 subtasks built\.\n• 1\. Proposal data model → built, in review\n• 2\. Promotion service → in progress$/.test(c)));
  const g = fake();
  assert.deepEqual(await syncSubtasks({ source: g.source, parentId: 'P', subtasks: subs, tickets, saved }), saved);
  assert.equal(g.calls.length, 0, 'nothing new, nothing posted');
  const merged = fake();
  const done = await syncSubtasks({ source: merged.source, parentId: 'P', subtasks: subs, tickets, saved, force: 'done' });
  assert.equal(done['17thtp0p4yq'], 'done');
  assert.equal(done['17thtp0p4yv'], undefined, 'a subtask no ticket delivers is not touched');
});

test('a failed move is logged and retried next step', async () => {
  const logs = [];
  const saved = await syncSubtasks({ source: { setStatus: async () => { throw new Error('no such status'); }, comment: async () => {} }, parentId: 'P', subtasks: subs, tickets: [t('01', 'done', ['17thtp0p4yp'])], saved: {}, log: l => logs.push(l) });
  assert.deepEqual(saved, {});
  assert.match(logs[0], /1\. Proposal data model not moved: no such status/);
});

test('the subtask file lists IDs and names for the agent', async (tt) => {
  const wt = await mkdtemp(join(tmpdir(), 'consort-subs-')); tt.after(() => rm(wt, { recursive: true, force: true }));
  writeSubtaskFile(wt, subs);
  assert.match(await readFile(join(wt, '.consort', 'ship', 'SUBTASKS.md'), 'utf8'), /- 17thtp0p4yp: 1\. Proposal data model/);
});

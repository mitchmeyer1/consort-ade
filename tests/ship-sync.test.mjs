import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncTicket, clickupStatusFor } from '../src/main/ship.ts';
import { newShipFeature, syncRetryDelay } from '../src/shared/ship.ts';

const ticket = { source: 'clickup', id: '86akm7a8g', url: 'https://app.clickup.com/t/86akm7a8g', title: 'HRIS address' };

/** a ClickUp that has one task on one list with the given status names, recording every write */
function fakeClickup(t, statuses) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = String(url).replace('https://api.clickup.com/api/v2', '');
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (path === '/task/86akm7a8g' && !init.method) return json({ id: '86akm7a8g', list: { id: '901' } });
    if (path === '/list/901') return json({ statuses: statuses.map((s) => ({ status: s })) });
    if (path === '/task/86akm7a8g' && init.method === 'PUT') return json({});
    if (path === '/task/86akm7a8g/comment') return json({});
    return new Response('nope', { status: 404 });
  });
  return calls;
}

test("the ClickUp status is the list's own spelling of the stage, found by name not assumed", async (t) => {
  const calls = fakeClickup(t, ['TO DO', 'Grilling', 'SPECD', 'Ready To Test', 'in review', 'complete']);
  assert.equal(await clickupStatusFor('k', '86akm7a8g', "Spec'd"), 'SPECD');
  assert.equal(await clickupStatusFor('k', '86akm7a8g', 'Ready to Test'), 'Ready To Test');
  assert.equal(await clickupStatusFor('k', '86akm7a8g', 'In Review'), 'in review');
  assert.equal(await clickupStatusFor('k', '86akm7a8g', 'Merged'), undefined);
  const f = { ...newShipFeature(ticket, 'hris', 1), stage: 'Ready to Test' };
  const sync = await syncTicket(f, '4/4 pass', { repoPath: '/r', clickupKey: 'k' }, '/w');
  assert.equal(sync.ok, true);
  assert.equal(sync.note, undefined);
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(put.body, { status: 'Ready To Test' });
  assert.match(calls.find((c) => c.path.endsWith('/comment')).body.comment_text, /\/ship → Ready to Test: 4\/4 pass/);
});

test('a list without the stage still syncs: the comment carries the stage and the sync is ok with a note', async (t) => {
  const calls = fakeClickup(t, ['to do', 'in progress', 'complete']);
  const f = { ...newShipFeature(ticket, 'hris', 1), stage: 'Grilling' };
  const sync = await syncTicket(f, 'Started.', { repoPath: '/r', clickupKey: 'k' }, '/w');
  assert.equal(sync.ok, true);
  assert.match(sync.note, /no "Grilling" status/);
  assert.ok(!calls.some((c) => c.method === 'PUT'));
  assert.ok(calls.some((c) => c.path.endsWith('/comment')));
});

test('a ClickUp that cannot be reached is a failed sync the caller retries, not an exception', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fetch failed'); });
  const sync = await syncTicket(newShipFeature(ticket, 'hris', 1), undefined, { repoPath: '/r', clickupKey: 'k' }, '/w');
  assert.equal(sync.ok, false);
  assert.equal(sync.error, 'fetch failed');
  const noKey = await syncTicket(newShipFeature(ticket, 'hris', 1), undefined, { repoPath: '/r' }, '/w');
  assert.match(noKey.error, /No ClickUp API key/);
});

test('retries back off from 30 seconds and settle at ten minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(syncRetryDelay), [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
});

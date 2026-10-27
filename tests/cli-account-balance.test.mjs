import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leastLoaded, modelLoad, rankAccounts, weeklyReset } from '../src/shared/usage.ts';

const now = Date.now();
const claude = (wk, fable, extra = []) => ({ keyId: 'k', at: now, windows: [{ id: '5h', label: '5-hour', percent: 5 }, { id: 'wk', label: 'Weekly', percent: wk }, { id: 'model:Fable', label: 'Weekly · Fable', percent: fable, model: 'Fable' }, ...extra] });

test('load is the fullest plan-wide window plus the windows that meter that model', () => {
  const u = claude(40, 90);
  assert.equal(modelLoad(u, 'claude-opus-5'), 40, 'an Opus call ignores the Fable meter');
  assert.equal(modelLoad(u, 'claude-fable-5-1'), 90, 'a frontier call counts the Fable meter');
  assert.equal(modelLoad(claude(40, 90, [{ id: 'opus', label: 'Weekly · Opus', percent: 70, model: 'Opus' }]), 'claude-opus-5'), 70);
  assert.equal(modelLoad({ keyId: 'k', at: now, windows: [], unavailable: 'API key' }, 'claude-opus-5'), undefined);
});

test('the least-used account wins, per model', () => {
  const accounts = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const usage = new Map([['a', claude(20, 95)], ['b', claude(60, 10)], ['c', claude(35, 40)]]);
  assert.equal(leastLoaded(accounts, 'claude-opus-5', usage).id, 'a', 'Opus: lowest plan-wide use');
  assert.equal(leastLoaded(accounts, 'claude-fable-5-1', usage).id, 'c', 'Fable: lowest of max(plan, Fable)');
});

test('spent model windows are skipped; unmetered accounts go last; ties go to the least recently used', () => {
  const usage = new Map([['spent', claude(5, 100)], ['metered', claude(80, 80)]]);
  assert.equal(leastLoaded([{ id: 'spent' }, { id: 'metered' }, { id: 'unknown' }], 'claude-fable-5-1', usage).id, 'metered');
  assert.equal(leastLoaded([{ id: 'x', lastUsedAt: 9 }, { id: 'y', lastUsedAt: 2 }], 'claude-opus-5', new Map()).id, 'y');
});

const H = 60 * 60_000;
const week = (wk, fable, endsIn) => ({ keyId: 'k', at: now, windows: [{ id: 'session:0', label: '5-hour', percent: 10, resetsAt: now + 2 * H }, { id: 'weekly_all:1', label: 'Weekly', percent: wk, resetsAt: now + endsIn }, { id: 'weekly_scoped:Fable', label: 'Weekly · Fable', percent: fable, model: 'Fable', resetsAt: now + endsIn }] });
const ids = (list) => list.map((a) => a.id);

test('the login whose week ends soonest goes first, even when it is the most used', () => {
  const usage = new Map([['tomorrow', week(77, 82, 10 * H)], ['sunday', week(25, 30, 105 * H)], ['monday', week(31, 42, 132 * H)]]);
  const order = rankAccounts([{ id: 'sunday' }, { id: 'monday' }, { id: 'tomorrow' }].map((a) => ({ a, model: 'claude-fable-5-1', usage: usage.get(a.id) })), now);
  assert.deepEqual(ids(order), ['tomorrow', 'sunday', 'monday']);
  assert.equal(weeklyReset(usage.get('tomorrow'), 'claude-fable-5-1', now), now + 10 * H, 'the 5-hour window is not a weekly reset');
  assert.equal(leastLoaded([{ id: 'sunday' }, { id: 'tomorrow' }], 'claude-fable-5-1', usage, now).id, 'tomorrow');
});

test('resets within 6 hours tie, and the one with more room wins', () => {
  const usage = new Map([['a', week(70, 70, 20 * H)], ['b', week(20, 20, 23 * H)]]);
  assert.deepEqual(ids(rankAccounts([{ id: 'a' }, { id: 'b' }].map((a) => ({ a, model: 'claude-opus-5', usage: usage.get(a.id) })), now)), ['b', 'a']);
});

test('a busy login waits behind quieter ones; a full one goes last; a spent one is dropped', () => {
  const usage = new Map([['soon', week(50, 50, 10 * H)], ['later', week(10, 10, 100 * H)], ['latest', week(10, 10, 150 * H)], ['spent', week(50, 100, 5 * H)]]);
  const rank = (running, full = {}) => ids(rankAccounts(['soon', 'later', 'latest', 'spent'].map((id) => ({ a: { id }, model: 'claude-fable-5-1', usage: usage.get(id), running: running[id] ?? 0, full: !!full[id] })), now));
  assert.deepEqual(rank({ soon: 1 }), ['soon', 'later', 'latest'], 'one more turn than the quietest is still fine');
  assert.deepEqual(rank({ soon: 2 }), ['later', 'latest', 'soon'], 'two more than the quietest: spread');
  assert.deepEqual(rank({ soon: 2, later: 1, latest: 1 }), ['soon', 'later', 'latest'], 'the others are busy too: preference holds');
  assert.deepEqual(rank({ soon: 1 }, { soon: true }), ['later', 'latest', 'soon'], 'at its turn cap');
});

test('logins with no reset time go after the ones that have one', () => {
  const usage = new Map([['metered', week(90, 90, 100 * H)], ['api', { keyId: 'k', at: now, windows: [], unavailable: 'API key' }]]);
  assert.deepEqual(ids(rankAccounts([{ id: 'api' }, { id: 'metered' }].map((a) => ({ a, model: 'claude-opus-5', usage: usage.get(a.id) })), now)), ['metered', 'api']);
});

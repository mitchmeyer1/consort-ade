import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leastLoaded, modelLoad } from '../src/shared/usage.ts';

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

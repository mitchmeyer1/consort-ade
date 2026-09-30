import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as seatPool from '../src/shared/seatPool.ts';
const { applyRateInfo, describeLimit, earliestReset, isUsageLimitText, limitFromRateEvent, modelFamily, parseChooser, poolUsage, seatLoad, seatName } = seatPool;

const require = createRequire(import.meta.url);
const main = (() => {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/main/seatPool.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => (name === '../shared/seatPool' ? seatPool : require(name)), mod, mod.exports);
  return mod.exports;
})();

const NOW = Date.parse('2026-09-25T12:00:00Z');
const chooserJson = {
  pick: '/u/.claude-mr', pick_blocked: false, note: 'mr has the most headroom',
  seats: [
    { dir: '/u/.claude', name: 'claude', email: 'a@x', live: true, source: 'live', blocked: true, age_s: 30,
      five_hour: { pct: 97.4, resets_at: '2026-09-25T14:00:00Z' }, seven_day: { pct: 40, resets_at: '2026-09-29T00:00:00Z' }, models: { fable: { pct: 12 } } },
    { dir: '/u/.claude-mr', name: 'mr', live: true, source: 'cache', blocked: false,
      five_hour: { pct: 10, resets_at: '2026-09-25T13:00:00Z' }, seven_day: { pct: 55 }, models: { fable: { pct: 91, resets_at: '2026-09-27T00:00:00Z' } } },
  ],
};
const pool = () => parseChooser(JSON.stringify(chooserJson), NOW);

test('the chooser JSON becomes a pool snapshot, and anything else is refused', () => {
  const p = pool();
  assert.equal(p.at, NOW);
  assert.equal(p.pick, '/u/.claude-mr');
  assert.equal(p.pickBlocked, false);
  assert.equal(p.seats.length, 2);
  assert.deepEqual(p.seats[0].fiveHour, { pct: 97, resetsAt: Date.parse('2026-09-25T14:00:00Z') });
  assert.equal(p.seats[0].blocked, true);
  assert.equal(p.seats[0].ageS, 30);
  assert.equal(p.seats[1].email, undefined);
  assert.deepEqual(p.seats[1].models.fable, { pct: 91, resetsAt: Date.parse('2026-09-27T00:00:00Z') });
  assert.throws(() => parseChooser('{"pick":"x"}', NOW), /not seat-chooser output/);
  assert.throws(() => parseChooser('Using seat mr', NOW));
});

test('seat names come from the snapshot, else from the folder', () => {
  const p = pool();
  assert.equal(seatName(p, '/u/.claude-mr'), 'mr');
  assert.equal(seatName(p, '/u/.claude-pete'), 'pete');
  assert.equal(seatName(undefined, '/u/.claude'), 'default');
  assert.equal(seatName(p, undefined), 'no seat');
});

test('a seat\'s load is its tightest window for the chat\'s model family', () => {
  const [a, b] = pool().seats;
  assert.equal(modelFamily('claude-fable-5-1'), 'fable');
  assert.equal(modelFamily('claude-opus-5-5'), 'opus');
  assert.equal(modelFamily(undefined), undefined);
  assert.equal(seatLoad(a, 'claude-opus-5-5'), 97);
  assert.equal(seatLoad(b, 'claude-opus-5-5'), 55);
  assert.equal(seatLoad(b, 'claude-fable-5-1'), 91);
});

test('the earliest reset is the soonest spent window still ahead', () => {
  assert.equal(earliestReset(pool(), NOW), Date.parse('2026-09-25T14:00:00Z'));
  assert.equal(earliestReset(pool(), Date.parse('2026-09-25T15:00:00Z')), Date.parse('2026-09-27T00:00:00Z'));
  assert.equal(earliestReset(undefined, NOW), undefined);
});

test('usage-limit notices are recognized; ordinary errors are not', () => {
  assert.equal(isUsageLimitText("You've hit your limit · resets 3pm (America/New_York)"), true);
  assert.equal(isUsageLimitText("  You've reached your weekly usage limit"), true);
  assert.equal(isUsageLimitText('Claude AI usage limit reached|1760000000'), true);
  assert.equal(isUsageLimitText('API Error: 529 overloaded'), false);
  assert.equal(isUsageLimitText(undefined), false);
});

test('a rejected rate-limit event is a limit unless extra usage covers it', () => {
  assert.deepEqual(limitFromRateEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790000000 }), { text: '', window: 'five_hour', resetsAt: 1790000000000 });
  assert.equal(limitFromRateEvent({ status: 'rejected', overageStatus: 'allowed' }), undefined);
  assert.equal(limitFromRateEvent({ status: 'rejected', isUsingOverage: true }), undefined);
  assert.equal(limitFromRateEvent({ status: 'allowed_warning' }), undefined);
  assert.equal(limitFromRateEvent(undefined), undefined);
  assert.equal(describeLimit({ text: '', window: 'seven_day' }), 'weekly limit');
  assert.equal(describeLimit({ text: 'Fable 5 requires usage credits' }), 'Fable limit');
  assert.equal(describeLimit({ text: "You've hit your limit" }), 'usage limit');
});

test('a turn\'s rate-limit report updates only its own seat, and only the windows it names', () => {
  const p = pool();
  const next = applyRateInfo(p, '/u/.claude-mr', { unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1790000000 } } });
  assert.notEqual(next, p);
  assert.deepEqual(next.seats[1].fiveHour, { pct: 42, resetsAt: 1790000000000 });
  assert.deepEqual(next.seats[1].sevenDay, p.seats[1].sevenDay);
  assert.equal(next.seats[1].ageS, 0);
  assert.equal(next.seats[0], p.seats[0]);
  assert.equal(applyRateInfo(p, '/u/.claude-pete', { unifiedWindows: { five_hour: { utilization: 1 } } }), p);
  assert.equal(applyRateInfo(p, '/u/.claude-mr', {}), p);
});

test('the pool\'s meters show each window at its lowest seat', () => {
  const u = poolUsage('pool', pool());
  assert.equal(u.plan, undefined, 'the connector line already says seat pool');
  assert.match(u.account, /2 seats · best now: mr/);
  assert.deepEqual(u.windows.map((w) => [w.id, w.percent]), [['five_hour', 10], ['seven_day', 40], ['seven_day_fable', 12]]);
  assert.equal(u.windows[2].model, 'Fable');
  assert.match(poolUsage('pool', undefined).unavailable, /hasn't reported/);
  assert.equal(poolUsage('pool', { at: 1, pickBlocked: false, seats: [], error: 'boom' }).unavailable, 'boom');
});

test('the pool connector appears once a chooser exists, and takes over as the default Claude connector', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-pool-'));
  try {
    const chooser = join(dir, 'chooser.sh');
    const state = { keys: [{ id: 'login-claude', provider: 'claude', name: 'Claude', auth: 'login', phiAllowed: false, defaultModel: 'claude-opus-5-5' }, { id: 'login-codex', provider: 'codex' }], defaultKeyId: 'login-claude' };
    main.ensurePoolKey(state, chooser);
    assert.equal(state.seatChooser, undefined, 'no chooser on disk, no pool');
    writeFileSync(chooser, '#!/bin/sh\n');
    main.ensurePoolKey(state, chooser);
    assert.equal(state.seatChooser, chooser);
    assert.deepEqual(state.keys.map((k) => k.id), ['login-claude', 'pool-claude', 'login-codex']);
    assert.equal(state.keys[1].pool, true);
    assert.equal(state.keys[1].defaultModel, 'claude-opus-5-5');
    assert.equal(state.defaultKeyId, 'pool-claude');
    // turning the chooser off keeps the connector; a later launch doesn't turn it back on
    state.seatChooser = '';
    state.defaultKeyId = 'login-codex';
    main.ensurePoolKey(state, chooser);
    assert.equal(state.seatChooser, '');
    assert.equal(state.defaultKeyId, 'login-codex');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a session resumes on a seat only when that seat can see its transcript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-pool-'));
  try {
    mkdirSync(join(dir, 'projects', '-Users-x-repo'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-Users-x-repo', 'abc.jsonl'), '{}\n');
    assert.equal(main.sessionOnSeat(dir, 'abc'), true);
    assert.equal(main.sessionOnSeat(dir, 'def'), false);
    assert.equal(main.sessionOnSeat(join(dir, 'missing'), 'abc'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the seat monitor shares one read, and a failed read keeps the last seats with the reason', async () => {
  const published = [];
  let calls = 0;
  let fail = false;
  let last;
  const run = async (_cmd, opts) => { calls++; if (fail) throw new Error('usage endpoint 429'); return { ...pool(), maxAge: opts.maxAge }; };
  const monitor = main.createSeatMonitor({ command: () => '/bin/chooser', publish: (p) => { last = p; published.push(p); }, last: () => last, run });
  const [a, b] = await Promise.all([monitor.refresh(20), monitor.refresh(20)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.maxAge, 20);
  fail = true;
  const failed = await monitor.refresh();
  assert.equal(failed.error, 'usage endpoint 429');
  assert.equal(failed.seats.length, 2);
  assert.equal(published.length, 2);
  const off = main.createSeatMonitor({ command: () => '', publish: () => assert.fail('nothing to publish'), last: () => undefined, run });
  assert.equal(await off.refresh(), undefined);
});

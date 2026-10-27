import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as seatPool from '../src/shared/seatPool.ts';
const { applyRateInfo, buildPool, describeLimit, earliestReset, isCodexLimitText, isUsageLimitText, limitFromRateEvent, modelFamily, pickSeat, poolUsage, seatFromUsage, seatLoad, seatName } = seatPool;

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
const login = (id, provider = 'claude', extra = {}) => ({ id, name: id, provider, auth: 'login', ...extra });
const usage = (keyId, windows, extra = {}) => ({ keyId, at: NOW - 30_000, windows, ...extra });
const w = (id, label, percent, extra = {}) => ({ id, label, percent, ...extra });

const seats = () => [
  seatFromUsage(login('a'), '/u/.claude', usage('a', [w('five_hour', '5-hour', 97, { resetsAt: Date.parse('2026-09-25T14:00:00Z') }), w('seven_day', 'Weekly', 40, { resetsAt: Date.parse('2026-09-29T00:00:00Z') }), w('model:Fable', 'Weekly · Fable', 12, { model: 'Fable' })], { account: 'a@x' }), undefined, NOW),
  seatFromUsage(login('mr'), '/u/.claude-mr', usage('mr', [w('five_hour', '5-hour', 10, { resetsAt: Date.parse('2026-09-25T13:00:00Z') }), w('seven_day', 'Weekly', 55), w('model:Fable', 'Weekly · Fable', 91, { model: 'Fable', resetsAt: Date.parse('2026-09-27T00:00:00Z') })]), undefined, NOW),
  seatFromUsage(login('cx', 'codex'), '/u/.codex', usage('cx', [w('primary', '5-hour', 30), w('secondary', 'Weekly', 70)], { plan: 'plus' }), undefined, NOW),
];
const pool = () => buildPool(seats(), NOW);

test('a connector\'s usage becomes a seat: windows by kind, per-model families, and the ceiling marks it blocked', () => {
  const [a, mr, cx] = seats();
  assert.equal(a.provider, 'claude');
  assert.equal(a.keyId, 'a');
  assert.equal(a.email, 'a@x');
  assert.deepEqual(a.fiveHour, { pct: 97, resetsAt: Date.parse('2026-09-25T14:00:00Z') });
  assert.deepEqual(a.models.fable, { pct: 12 });
  assert.equal(a.blocked, true, 'over the ceiling on the 5-hour window');
  assert.equal(mr.blocked, false);
  assert.equal(mr.live, true);
  assert.deepEqual(cx.fiveHour, { pct: 30 });
  assert.deepEqual(cx.sevenDay, { pct: 70 });
  // a read that failed keeps the previous numbers and says so
  const stale = seatFromUsage(login('mr'), '/u/.claude-mr', { keyId: 'mr', at: NOW, windows: [], unavailable: 'The CLI did not answer in time.' }, mr, NOW);
  assert.equal(stale.live, false);
  assert.equal(stale.note, 'The CLI did not answer in time.');
  assert.deepEqual(stale.fiveHour, mr.fiveHour);
  const shut = seatFromUsage(login('a'), '/u/.claude', usage('a', [w('five_hour', '5-hour', 5)], { blocked: 'Credits depleted' }), undefined, NOW);
  assert.equal(shut.blocked, true);
  assert.equal(shut.note, 'Credits depleted');
});

test('the pick is the open seat with the most headroom for the model, per provider; every seat spent names the least bad one and flags it', () => {
  const p = pool();
  assert.deepEqual(p.picks.claude, { dir: '/u/.claude-mr', keyId: 'mr', blocked: false });
  assert.deepEqual(p.picks.codex, { dir: '/u/.codex', keyId: 'cx', blocked: false });
  assert.equal(pickSeat(p, 'claude', { exclude: ['/u/.claude-mr'] }).blocked, true, 'only the spent seat is left');
  assert.equal(pickSeat(p, 'claude', { exclude: ['/u/.claude-mr', '/u/.claude'] }), undefined);
  assert.equal(pickSeat(undefined, 'claude'), undefined);
  // the model's own window counts: mr is nearly out of Fable, a is not
  const fable = pickSeat({ ...p, seats: p.seats.map((s) => (s.keyId === 'a' ? { ...s, fiveHour: { pct: 50 }, blocked: false } : s)) }, 'claude', { model: 'claude-fable-5-1' });
  assert.equal(fable.dir, '/u/.claude');
  const stale = buildPool(p.seats.map((s) => ({ ...s, live: false })), NOW);
  assert.equal(stale.picks.claude.blocked, true, 'nothing live is not offered as open');
});

test('seat names come from the connector, else from the folder', () => {
  const p = pool();
  assert.equal(seatName(p, '/u/.claude-mr'), 'mr');
  assert.equal(seatName(p, '/u/.claude-pete'), 'pete');
  assert.equal(seatName(undefined, '/u/.codex'), 'default');
  assert.equal(seatName(p, undefined), 'no seat');
});

test('a seat\'s load is its tightest window for the chat\'s model family', () => {
  const [a, b] = seats();
  assert.equal(modelFamily('claude-fable-5-1'), 'fable');
  assert.equal(modelFamily('claude-opus-5-5'), 'opus');
  assert.equal(modelFamily(undefined), undefined);
  assert.equal(seatLoad(a, 'claude-opus-5-5'), 97);
  assert.equal(seatLoad(b, 'claude-opus-5-5'), 55);
  assert.equal(seatLoad(b, 'claude-fable-5-1'), 91);
});

test('the earliest reset is the soonest spent window still ahead, per provider', () => {
  assert.equal(earliestReset(pool(), 'claude', NOW), Date.parse('2026-09-25T14:00:00Z'));
  assert.equal(earliestReset(pool(), 'claude', Date.parse('2026-09-25T15:00:00Z')), undefined, 'the Fable window is under the ceiling');
  assert.equal(earliestReset(pool(), 'codex', NOW), undefined);
  assert.equal(earliestReset(undefined, 'claude', NOW), undefined);
});

test('usage-limit notices are recognized for both providers; ordinary errors are not', () => {
  assert.equal(isUsageLimitText("You've hit your limit · resets 3pm (America/New_York)"), true);
  assert.equal(isUsageLimitText("  You've reached your weekly usage limit"), true);
  assert.equal(isUsageLimitText('Claude AI usage limit reached|1760000000'), true);
  assert.equal(isUsageLimitText('API Error: 529 overloaded'), false);
  assert.equal(isUsageLimitText(undefined), false);
  assert.equal(isCodexLimitText("You've hit your usage limit. Try again at 3pm."), true);
  assert.equal(isCodexLimitText('usage_limit_reached'), true);
  assert.equal(isCodexLimitText('rate_limit_exceeded'), true);
  assert.equal(isCodexLimitText('stream disconnected before completion'), false);
});

test('a rejected rate-limit event is a limit unless extra usage covers it', () => {
  assert.deepEqual(limitFromRateEvent({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1790000000 }), { text: '', window: 'five_hour', resetsAt: 1790000000000 });
  assert.equal(limitFromRateEvent({ status: 'rejected', overageStatus: 'allowed' }), undefined);
  assert.equal(limitFromRateEvent({ status: 'rejected', isUsingOverage: true }), undefined);
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
  assert.equal(next.seats[0], p.seats[0]);
  assert.equal(applyRateInfo(p, '/u/.claude-mr', { unifiedWindows: { five_hour: { utilization: 1 } } }).seats[1].blocked, true, 'a spent window blocks the seat');
  assert.equal(applyRateInfo(p, '/u/.claude-pete', { unifiedWindows: { five_hour: { utilization: 1 } } }), p);
  assert.equal(applyRateInfo(p, '/u/.claude-mr', {}), p);
});

test('the pool\'s meters show each window at its lowest seat of that provider', () => {
  const u = poolUsage('pool-claude', pool(), 'claude');
  assert.match(u.account, /2 seats · best now: mr/);
  assert.deepEqual(u.windows.map((x) => [x.id, x.percent]), [['five_hour', 10], ['seven_day', 40], ['seven_day_fable', 12]]);
  assert.equal(u.windows[2].model, 'Fable');
  assert.match(poolUsage('pool-codex', pool(), 'codex').account, /1 seat · best now: cx/);
  assert.match(poolUsage('pool', undefined, 'claude').unavailable, /No seats/);
  assert.equal(poolUsage('pool', { at: 1, seats: [], picks: {}, error: 'boom' }, 'claude').unavailable, 'boom');
});

test('each provider with a login gets an "Any …" connector ahead of its logins, and loses it with its last login', () => {
  const state = { keys: [login('login-claude', 'claude', { defaultModel: 'claude-opus-5-5' }), login('login-codex', 'codex'), login('work')], defaultKeyId: 'login-claude' };
  main.ensurePoolKeys(state);
  assert.deepEqual(state.keys.map((k) => k.id), ['pool-claude', 'login-claude', 'pool-codex', 'login-codex', 'work']);
  assert.equal(state.keys[0].name, 'Any Claude');
  assert.equal(state.keys[0].pool, true);
  assert.equal(state.keys[0].defaultModel, 'claude-opus-5-5');
  assert.equal(state.defaultKeyId, 'pool-claude', 'the built-in login was the default, so the pool takes over');
  main.ensurePoolKeys(state);
  assert.equal(state.keys.length, 5, 'idempotent');
  // a chosen default stays
  const chosen = { keys: [login('login-claude'), login('work')], defaultKeyId: 'work' };
  main.ensurePoolKeys(chosen);
  assert.equal(chosen.defaultKeyId, 'work');
  // no Codex logins, no Codex pool
  state.keys = state.keys.filter((k) => k.id !== 'login-codex');
  main.ensurePoolKeys(state);
  assert.equal(state.keys.some((k) => k.id === 'pool-codex'), false);
  // an API key is not a seat
  const apiOnly = { keys: [{ id: 'k', provider: 'codex', auth: 'key', name: 'key' }], defaultKeyId: undefined };
  main.ensurePoolKeys(apiOnly);
  assert.equal(apiOnly.keys.length, 1);
});

test('a session resumes on a seat only when that seat can see its transcript, for either provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-pool-'));
  try {
    mkdirSync(join(dir, 'projects', '-Users-x-repo'), { recursive: true });
    writeFileSync(join(dir, 'projects', '-Users-x-repo', 'abc.jsonl'), '{}\n');
    assert.equal(main.sessionOnSeat(dir, 'abc'), true);
    assert.equal(main.sessionOnSeat(dir, 'def'), false);
    assert.equal(main.sessionOnSeat(join(dir, 'missing'), 'abc'), false);
    mkdirSync(join(dir, 'sessions', '2026', '09', '29'), { recursive: true });
    writeFileSync(join(dir, 'sessions', '2026', '09', '29', 'rollout-2026-09-29T16-18-15-01a0eed1-5e80.jsonl'), '{}\n');
    assert.equal(main.sessionOnSeat(dir, '01a0eed1-5e80', 'codex'), true);
    assert.equal(main.sessionOnSeat(dir, 'nope', 'codex'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the monitor reads every login once per refresh, keeps a failed seat stale, and errors only when nothing reads', async () => {
  const published = [];
  let last;
  const calls = [];
  let fail = new Set();
  const read = async (key, force) => {
    calls.push([key.id, force]);
    if (fail.has(key.id)) throw new Error('usage endpoint 429');
    return usage(key.id, [w('five_hour', '5-hour', key.id === 'a' ? 20 : 60), w('seven_day', 'Weekly', 10)]);
  };
  const keys = () => [login('a'), login('b'), { id: 'k', provider: 'claude', auth: 'key', name: 'api' }, login('cx', 'codex')];
  const monitor = main.createSeatMonitor({ keys, read, publish: (p) => { last = p; published.push(p); }, last: () => last, now: () => NOW });
  const [p1, p2] = await Promise.all([monitor.refresh(true), monitor.refresh(true)]);
  assert.equal(p1, p2, 'one read shared');
  assert.deepEqual(calls.map(([id]) => id), ['a', 'b', 'cx'], 'API keys are not seats');
  assert.equal(calls[0][1], true);
  assert.equal(p1.picks.claude.dir.endsWith('/.claude') || p1.seats[0].keyId === 'a', true);
  assert.equal(p1.picks.claude.keyId, 'a');
  fail = new Set(['a']);
  const p3 = await monitor.refresh();
  assert.equal(p3.error, undefined);
  assert.equal(p3.seats.find((s) => s.keyId === 'a').live, false);
  assert.match(p3.seats.find((s) => s.keyId === 'a').note, /429/);
  assert.equal(p3.seats.find((s) => s.keyId === 'a').fiveHour.pct, 20, 'stale numbers kept');
  assert.equal(p3.picks.claude.keyId, 'b', 'a stale seat is not the pick');
  fail = new Set(['a', 'b', 'cx']);
  const p4 = await monitor.refresh();
  assert.match(p4.error, /a: usage endpoint 429/);
  assert.equal(published.length, 3);
});

test('the seat whose week ends soonest wins, unless it is running more chats than the others', () => {
  const H = 60 * 60_000;
  const seat = (id, weekly, endsIn) => seatFromUsage(login(id), `/u/.claude-${id}`, usage(id, [w('five_hour', '5-hour', 10), w('seven_day', 'Weekly', weekly, { resetsAt: NOW + endsIn })]), undefined, NOW);
  const p = buildPool([seat('later', 20, 100 * H), seat('soon', 70, 10 * H), seat('mid', 30, 50 * H)], NOW);
  assert.equal(pickSeat(p, 'claude', { now: NOW }).dir, '/u/.claude-soon', 'most used, but its credits expire first');
  assert.equal(pickSeat(p, 'claude', { now: NOW, busy: { '/u/.claude-soon': 1 } }).dir, '/u/.claude-soon', 'one chat ahead is fine');
  assert.equal(pickSeat(p, 'claude', { now: NOW, busy: { '/u/.claude-soon': 2 } }).dir, '/u/.claude-mid', 'two ahead: the next soonest');
  assert.equal(pickSeat(p, 'claude', { now: NOW, busy: { '/u/.claude-soon': 2, '/u/.claude-mid': 1, '/u/.claude-later': 1 } }).dir, '/u/.claude-soon', 'everyone busy: preference holds');
});

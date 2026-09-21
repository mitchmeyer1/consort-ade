import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(new URL('../src/shared/usage.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled)(() => ({}), mod, mod.exports);
const { claudeUsageFrom, codexUsageFrom, connectorAccess, connectorBlock, modelBlock, formatReset, formatAge, usageTone, windowLabel } = mod.exports;

const NOW = Date.parse('2026-09-17T15:00:00Z');
const H = 3600_000;

test('claude: server rows win, keep server order, and label scoped weekly meters by model', () => {
  const u = claudeUsageFrom('login-claude', {
    subscription_type: 'team', rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 67, resets_at: '2026-09-17T19:40:00Z' },
      seven_day: { utilization: 7, resets_at: '2026-09-21T08:00:00Z' },
      limits: [
        { kind: 'session', group: 'session', percent: 67.4, resets_at: '2026-09-17T19:40:00Z', scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 7, resets_at: '2026-09-21T08:00:00Z', scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 10, resets_at: '2026-09-21T08:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      ],
    },
  }, NOW);
  assert.equal(u.plan, 'team');
  assert.equal(u.unavailable, undefined);
  assert.deepEqual(u.windows.map(w => [w.label, w.percent]), [['5-hour', 67], ['Weekly', 7], ['Weekly · Fable', 10]]);
  assert.equal(u.windows[0].resetsAt, Date.parse('2026-09-17T19:40:00Z'));
  assert.equal(new Set(u.windows.map(w => w.id)).size, 3, 'ids are unique');
});

test('claude: without server rows the fixed windows and model_scoped entries are used', () => {
  const u = claudeUsageFrom('k', {
    subscription_type: 'max', rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 12.6, resets_at: '2026-09-17T16:00:00Z' },
      seven_day: { utilization: null, resets_at: null },
      seven_day_opus: { utilization: 40, resets_at: null },
      model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: '2026-09-21T08:00:00Z' }],
    },
  }, NOW);
  assert.deepEqual(u.windows.map(w => [w.label, w.percent, w.resetsAt]), [
    ['5-hour', 13, Date.parse('2026-09-17T16:00:00Z')],
    ['Weekly · Opus', 40, undefined],
    ['Weekly · Fable', 3, Date.parse('2026-09-21T08:00:00Z')],
  ]);
});

test('claude: an API-key session has no plan meters and says so', () => {
  const u = claudeUsageFrom('k', { subscription_type: null, rate_limits_available: false, rate_limits: null }, NOW);
  assert.deepEqual(u.windows, []);
  assert.match(u.unavailable, /No plan limits/);
  assert.equal(claudeUsageFrom('k', {}, NOW).unavailable, u.unavailable, 'a malformed answer degrades the same way');
});

test('claude: a locked window surfaces as a block', () => {
  const u = claudeUsageFrom('k', { rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: null, locked_reason: 'out_of_credits' } } }, NOW);
  assert.equal(u.blocked, 'Out of credits');
  assert.equal(u.windows[0].percent, 100);
});

test('codex: primary/secondary become 5-hour and weekly meters with epoch-second resets', () => {
  const u = codexUsageFrom('login-codex', {
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: 'codex', primary: { usedPercent: 94, windowDurationMins: 300, resetsAt: 1789669224 }, secondary: { usedPercent: 46, windowDurationMins: 10080, resetsAt: 1790191935 }, planType: 'team', rateLimitReachedType: null },
  }, { account: { type: 'chatgpt', email: 'mitch@example.com', planType: 'team' } }, NOW);
  assert.equal(u.plan, 'team');
  assert.equal(u.account, 'mitch@example.com');
  assert.equal(u.blocked, undefined);
  assert.deepEqual(u.windows, [
    { id: 'primary', label: '5-hour', percent: 94, resetsAt: 1789669224_000 },
    { id: 'secondary', label: 'Weekly', percent: 46, resetsAt: 1790191935_000 },
  ]);
});

test('codex: a depleted workspace reads as a block while the meters still show', () => {
  const u = codexUsageFrom('k', {
    ordinaryUsageAllowed: false,
    rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1789669224 }, secondary: null, planType: 'team', rateLimitReachedType: 'workspace_member_credits_depleted' },
  }, null, NOW);
  assert.equal(u.blocked, 'Workspace credits depleted');
  assert.deepEqual(u.windows.map(w => w.label), ['5-hour']);
  const paused = codexUsageFrom('k', { ordinaryUsageAllowed: false, rateLimits: { primary: null, secondary: null } }, null, NOW);
  assert.equal(paused.blocked, 'Usage paused by the provider');
  const odd = codexUsageFrom('k', { rateLimits: { rateLimitReachedType: 'some_new_reason' } }, null, NOW);
  assert.equal(odd.blocked, 'Some new reason');
});

test('codex: no rate limit body means nothing to meter; unknown plans are ignored', () => {
  const u = codexUsageFrom('k', { rateLimits: null }, { account: { email: 'a@b.c', planType: 'unknown' } }, NOW);
  assert.match(u.unavailable, /No plan limits/);
  assert.equal(u.plan, undefined);
  assert.equal(u.account, 'a@b.c');
});

test('window labels cover the common lengths and fall back to the raw duration', () => {
  assert.equal(windowLabel(300), '5-hour');
  assert.equal(windowLabel(10080), 'Weekly');
  assert.equal(windowLabel(1440), '1-day');
  assert.equal(windowLabel(120), '2-hour');
  assert.equal(windowLabel(90), '90-minute');
  assert.equal(windowLabel(null), 'Window');
});

test('resets read relative to now and never claim less than a minute', () => {
  assert.equal(formatReset(undefined, NOW), '');
  assert.equal(formatReset(NOW - 1000, NOW), 'resets now');
  assert.equal(formatReset(NOW + 20_000, NOW), 'resets in 1m');
  assert.equal(formatReset(NOW + 12 * 60_000, NOW), 'resets in 12m');
  assert.equal(formatReset(NOW + 2 * H + 10 * 60_000, NOW), 'resets in 2h 10m');
  assert.equal(formatReset(NOW + 3 * H, NOW), 'resets in 3h');
  assert.equal(formatReset(NOW + 3 * 24 * H + 18 * H, NOW), 'resets in 3d 18h');
  assert.equal(formatReset(NOW + 4 * 24 * H, NOW), 'resets in 4d');
});

test('snapshot age is coarse and never negative', () => {
  assert.equal(formatAge(NOW + 5000, NOW), 'just now');
  assert.equal(formatAge(NOW - 30_000, NOW), 'just now');
  assert.equal(formatAge(NOW - 4 * 60_000, NOW), '4m ago');
  assert.equal(formatAge(NOW - 2 * H, NOW), '2h ago');
  assert.equal(formatAge(NOW - 50 * H, NOW), '2d ago');
});

test('claude: scoped windows remember their model family; a lock on one shuts only that family', () => {
  const rows = claudeUsageFrom('k', { rate_limits_available: true, rate_limits: { limits: [
    { kind: 'session', percent: 10, scope: null },
    { kind: 'weekly_scoped', percent: 100, scope: { model: { display_name: 'Fable' }, surface: null } },
    { kind: 'weekly_scoped', percent: 5, scope: { model: null, surface: { display_name: 'Claude Code' } } },
  ] } }, NOW);
  assert.deepEqual(rows.windows.map(w => w.model), [undefined, 'Fable', undefined], 'only model scopes count as a family');
  const fixed = claudeUsageFrom('k', { rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 20 }, seven_day_opus: { utilization: 88, locked_reason: 'model_paused' },
  } }, NOW);
  assert.equal(fixed.blocked, undefined, 'a per-model lock is not a plan-wide block');
  assert.deepEqual(fixed.windows.map(w => [w.model, w.locked]), [[undefined, undefined], ['Opus', true]]);
  assert.equal(modelBlock(fixed, 'claude-opus-5'), 'Weekly · Opus limit reached');
  assert.equal(modelBlock(fixed, 'claude-fable-5-1'), undefined);
});

const CLAUDE = ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5'];
const snap = (windows, extra = {}) => ({ keyId: 'k', at: NOW, windows, ...extra });

test('access: no snapshot or nothing metered reads as open', () => {
  assert.deepEqual(connectorAccess(undefined, CLAUDE), { level: 'ok' });
  assert.deepEqual(connectorAccess(snap([], { unavailable: 'API key' }), CLAUDE), { level: 'ok' });
  assert.deepEqual(connectorAccess(snap([{ id: 'w', label: '5-hour', percent: 99 }, { id: 'f', label: 'Weekly · Fable', percent: 99, model: 'Fable' }]), CLAUDE), { level: 'ok' });
  assert.equal(modelBlock(undefined, 'claude-opus-5'), undefined);
});

test('access: a provider block or a spent plan-wide window makes the connector and every model red', () => {
  const blocked = snap([{ id: 'w', label: '5-hour', percent: 40 }], { blocked: 'Out of credits' });
  assert.deepEqual(connectorAccess(blocked, CLAUDE), { level: 'blocked', reason: 'Out of credits' });
  assert.equal(connectorBlock(blocked), 'Out of credits');
  for (const m of CLAUDE) assert.equal(modelBlock(blocked, m), 'Out of credits');
  const spent = snap([{ id: 'primary', label: '5-hour', percent: 100 }, { id: 'secondary', label: 'Weekly', percent: 30 }]);
  assert.deepEqual(connectorAccess(spent, ['gpt-6-astra']), { level: 'blocked', reason: '5-hour limit reached' });
  assert.equal(modelBlock(spent, 'gpt-6-astra'), '5-hour limit reached');
});

test('access: a spent model family reads orange on the connector and red only on its models', () => {
  const u = snap([{ id: 's', label: '5-hour', percent: 30 }, { id: 'f', label: 'Weekly · Fable', percent: 100, model: 'Fable' }]);
  assert.deepEqual(connectorAccess(u, CLAUDE), { level: 'partial', reason: 'Weekly · Fable limit reached' });
  assert.equal(connectorBlock(u), undefined);
  assert.equal(modelBlock(u, 'claude-fable-5-1'), 'Weekly · Fable limit reached');
  assert.equal(modelBlock(u, 'claude-opus-5'), undefined);
  assert.equal(modelBlock(u, 'claude-sonnet-5'), undefined);
  assert.equal(modelBlock(snap([{ id: 'o', label: 'Weekly · Opus', percent: 100, model: 'Claude Opus' }]), 'claude-opus-5'), 'Weekly · Opus limit reached', 'multi-word family names still match');
});

test('access: every offered model spent is as red as a plan-wide block', () => {
  const u = snap([
    { id: 'f', label: 'Weekly · Fable', percent: 100, model: 'Fable' },
    { id: 'o', label: 'Weekly · Opus', percent: 100, model: 'Opus' },
    { id: 's', label: 'Weekly · Sonnet', percent: 100, model: 'Sonnet' },
  ]);
  assert.equal(connectorAccess(u, CLAUDE).level, 'blocked');
  assert.match(connectorAccess(u, CLAUDE).reason, /^All models at their limit/);
  assert.equal(connectorAccess(u, [...CLAUDE, 'claude-haiku-4-5-20251001']).level, 'partial', 'an unmetered model keeps the connector usable');
  assert.equal(connectorAccess(u, []).level, 'partial', 'with no model list the family windows alone cannot prove a full block');
});

test('tone warns from 80% and reads as spent from 95%', () => {
  assert.equal(usageTone(0), 'ok');
  assert.equal(usageTone(79), 'ok');
  assert.equal(usageTone(80), 'high');
  assert.equal(usageTone(94), 'high');
  assert.equal(usageTone(95), 'full');
  assert.equal(usageTone(100), 'full');
});

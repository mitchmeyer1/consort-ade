import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as cliModels from '../src/shared/cliModels.ts';
import * as usageMod from '../src/shared/usage.ts';

const require = createRequire(import.meta.url);
const compile = name => ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(runTurn = async () => ({ text: '' })) {
  const mocks = { '../shared/headless.ts': headless, '../shared/cliModels.ts': cliModels, './agent': { runTurn }, './state': { LOG_DIR: '/no/such/dir' }, './usage': { usageFor: async () => new Map() }, '../shared/usage.ts': usageMod };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile('oversight'))(n => mocks[n] ?? require(n), mod, mod.exports);
  return mod.exports;
}
const now = Date.parse('2026-10-21T20:30:00Z');
const context = (over = {}) => ({
  question: 'Did you address Will\'s comments on the ClickUp ticket?',
  workerAlive: true, now,
  task: { id: 't', jobId: 'j', worktree: '/wt', branch: 'feature', pid: 9, status: 'working', reviewsDone: 0, startedAt: now - 3 * 3_600_000, updatedAt: now - 60_000, envReadyAt: 1, activity: 't4 · porting nppesVerification', recent: ['ported providerDedup'],
    ticket: { id: 'T1', title: 'Migrate curation to mono', url: 'https://app.clickup.com/t/T1' }, feature: { stage: 'Implementing', prs: [] },
    turnHistory: [{ at: now - 40 * 60_000, stage: 'Implementing', role: 'implementation', provider: 'claude', model: 'claude-sonnet-5', durationMs: 25 * 60_000 }],
    activeTurns: [{ id: 'a', pid: 9, accountId: 'c', startedAt: now - 12 * 60_000 }],
    ownerUpdates: [{ ts: '5', text: 'Handle Will\'s comments', files: [], at: now }] },
  state: { jobs: [{ id: 'j' }], accounts: [{ id: 'x', provider: 'codex', name: 'Codex' }, { id: 'c', provider: 'claude', name: 'Claude' }] },
  thread: [{ from: 'owner', text: 'what percent done?', at: now - 11 * 60_000 }],
  ticketComments: [{ text: 'Please keep the old CSV column names', by: 'will', at: now - 5 * 3_600_000 }],
  logTail: '[T1] turn 3 at Implementing: ported existingProviderMatcher',
  ...over,
});

test('oversight runs on Opus or Sol, not the top tier, unless the job names a model', () => {
  const o = load();
  assert.equal(o.oversightModel('claude'), 'claude-opus-5');
  assert.equal(o.oversightModel('codex'), 'gpt-5.6-sol');
  assert.equal(o.oversightModel('claude', { coordination: { claude: 'claude-sonnet-5' } }), 'claude-sonnet-5');
});

test('accounts: blocked ones are skipped, Claude goes first', () => {
  const o = load();
  const accounts = [{ id: 'x', provider: 'codex' }, { id: 'c1', provider: 'claude', blockedUntil: now + 1 }, { id: 'c2', provider: 'claude' }];
  assert.deepEqual(o.oversightAccounts(accounts, now).map(a => a.id), ['c2', 'x']);
});

test('the prompt carries the question, timings, worker state, comments, thread and log', () => {
  const p = load().oversightPrompt(context());
  assert.match(p, /## The owner's message\nDid you address Will's comments/);
  assert.match(p, /Worker process: running \(pid 9\)/);
  assert.match(p, /started .*\(12 min ago\)/);
  assert.match(p, /Implementing, implementation on claude-sonnet-5, 25 min/);
  assert.match(p, /by will: Please keep the old CSV column names/);
  assert.match(p, /owner: what percent done\?/);
  assert.match(p, /ported existingProviderMatcher/);
  assert.match(p, /Owner updates queued, not yet applied: "Handle Will's comments"/);
  assert.match(p, /\[queue-update:/);
});

test('a change request is split from the answer', () => {
  const o = load();
  assert.deepEqual(o.parseOversight('Not yet: none of the 3 comments are in the spec.\n[queue-update: Apply Will\'s 3 ClickUp comments to the spec and code]'), { answer: 'Not yet: none of the 3 comments are in the spec.', update: 'Apply Will\'s 3 ClickUp comments to the spec and code' });
  assert.deepEqual(o.parseOversight('About 60% done.'), { answer: 'About 60% done.' });
});

test('answering is read-only in the worktree and moves to the next account on a limit', async () => {
  const calls = [];
  const o = load(async opts => { calls.push(opts); return opts.account.provider === 'claude' ? { text: '', limit: { provider: 'claude' } } : { text: 'About 60% done.' }; });
  const reply = await o.answerOwner(context());
  assert.deepEqual(reply, { answer: 'About 60% done.', model: 'gpt-5.6-sol' });
  assert.deepEqual(calls.map(c => [c.account.id, c.model, c.readOnly, c.cwd, c.maxDelegates]), [['c', 'claude-opus-5', true, '/wt', 0], ['x', 'gpt-5.6-sol', true, '/wt', 0]]);
});

test('no usable account is an error the daemon falls back from', async () => {
  const o = load(async () => ({ text: '', error: 'boom' }));
  await assert.rejects(o.answerOwner(context()), /Claude: boom; Codex: boom/);
});

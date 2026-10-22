import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as seatPool from '../src/shared/seatPool.ts';
import * as cliModels from '../src/shared/cliModels.ts';
import * as cliTurnPolicy from '../src/shared/cliTurnPolicy.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/cli/pipeline.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const blockedAtStart of [true, false]) {
  test(`worker switches to Codex ${blockedAtStart ? 'after restart with Claude blocked' : 'when Claude hits a limit during a turn'}`, async () => {
    const task = { id: 't', jobId: 'j', ticket: { id: 'ticket' }, worktree: '/virtual', accountIds: { claude: 'c' }, sessions: { claude: 'claude-session' }, feature: { stage: 'Implementing' } };
    const state = { tasks: [task], jobs: [{ id: 'j' }], accounts: [
      { id: 'c', provider: 'claude', name: 'Claude', ...(blockedAtStart ? { blockedUntil: Date.now() + 60000 } : {}) },
      { id: 'x', provider: 'codex', name: 'Codex' },
    ] };
    const calls = [];
    const reachedCodex = new Error('Codex turn reached');
    const mocks = {
      'node:fs': { existsSync: () => true },
      '../shared/headless.ts': headless,
      '../shared/seatPool.ts': seatPool,
      '../shared/cliModels.ts': cliModels, '../shared/cliTurnPolicy.ts': cliTurnPolicy,
      './capacity': { AccountUnavailableError: class extends Error {}, withAgentTurn: async (_, __, fn) => fn(), withEnvironmentSlot: async (_, fn) => fn() },
      './parallel': { prepareResearchTasks: async () => [], recoverImplementation: async () => [], readImplementationTasks: async () => [], runImplementation: async () => ({ completed: [], commits: [] }), runResearch: async () => ({ summary: 'No conflicting flows found', results: [], reused: false }) },
      '../main/ship': { excludeConsortDir: async () => {}, fetchTicket: async () => ({}), writeTicketFile: () => '' },
      './slackIdentity': { ensureSlackIdentity: async () => {} },
      './lifecycle': { notifyTask: async () => {} },
      './checkpoint': { checkpoint: async () => ({ committed: false, pushed: false }) },
      './buildProgress': { stepLabel: name => name },
      './draftPr': { draftTitle: t => t.title, draftBody: () => '', ensureDraftPr: async () => ({ error: 'test' }), updateDraftBody: async () => {} },
      './usage': { readUsage: async () => ({ at: Date.now(), windows: [] }), saveUsage() {}, usageFor: async list => new Map(list.map(a => [a.id, { at: Date.now(), windows: [] }])) },
      '../shared/usage.ts': { usageBlock: () => undefined },
      './sources': { sourceFor: () => ({}) },
      './environment': { allocateEnvironment: async () => ({}) },
      './slackIdentity': { ensureSlackIdentity: async () => {} },
      './state': {
        loadState: () => state,
        updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch),
        touchAccount: () => {},
        blockAccount: id => { state.accounts.find(a => a.id === id).blockedUntil = Date.now() + 60000; },
      },
      './agent': { runTurn: async o => {
        calls.push(o);
        if (o.account.provider === 'claude') return { text: '', limit: { text: "You've hit your usage limit" } };
        throw reachedCodex;
      } },
    };
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? (name.startsWith('.') ? {} : require(name)), mod, mod.exports);
    await assert.rejects(mod.exports.workTask('t'), e => e === reachedCodex);
    const codex = calls.at(-1);
    assert.equal(codex.account.id, 'x');
    // the first turn is the environment setup, a routine turn, so it lands on Codex's worker tier (Sol, not Astra)
    assert.equal(codex.model, cliModels.selectCliModel('codex', headless.seedModels().codex, 'implementation'));
    assert.equal(codex.resume, undefined, 'Claude session must never be passed to Codex');
    assert.equal(task.activeProvider, 'codex');
    assert.equal(task.accountIds.codex, 'x');
    assert.match(task.activity, /running codex/);
    assert.equal(calls.length, blockedAtStart ? 1 : 2);
  });
}

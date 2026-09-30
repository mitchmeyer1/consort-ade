import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as planProgress from '../src/shared/planProgress.ts';
import * as featureProgress from '../src/shared/featureProgress.ts';
import * as skillSections from '../src/shared/skillSections.ts';
import * as followups from '../src/shared/followups.ts';
import * as instructions from '../src/shared/instructions.ts';
import * as deliverables from '../src/shared/deliverables.ts';
import * as processContext from '../src/shared/processContext.ts';
import * as shipPrompt from '../src/shared/shipPrompt.ts';
import * as context from '../src/shared/context.ts';
import * as commands from '../src/shared/commands.ts';
import * as ship from '../src/shared/ship.ts';
import * as seatPool from '../src/shared/seatPool.ts';
import * as autopilot from '../src/shared/autopilot.ts';
import * as codexDiagnostics from '../src/shared/codexDiagnostics.ts';
import * as cliUpdates from '../src/shared/cliUpdates.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const TOO_OLD = "API Error: 400 Claude Code 2.1.273 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";

/**
 * A Claude chat whose first turn is refused for the CLI version. `binaries` is what claudeBin()
 * answers per call; `update` is what the download reports; the SDK fails while the old binary
 * runs and succeeds on the new one.
 */
function fixture({ update, errors = [TOO_OLD] }) {
  const chat = { id: 'chat', worktreeId: 'wt', provider: 'claude', keyId: 'login', model: 'claude-fable-5-1', phase: 'waiting', messages: [] };
  const store = { data: { chats: [chat], keys: [{ id: 'login', provider: 'claude' }], worktrees: [{ id: 'wt', path: '/nonexistent-test-worktree' }] }, chat: () => chat, save() {}, getSecret: () => '' };
  const calls = [];
  const updates = [];
  let binary = '/bundled/claude';
  const mocks = {
    './dockerLifecycle': { beginDockerRun: () => '', dockerRunEnvironment: () => ({}), finishDockerRun: async () => {} },
    './store': { store },
    './seatPool': { DEFAULT_SEAT: '/personal', runChooser: async () => { throw new Error('no chooser in tests'); }, sessionOnSeat: () => true },
    './auth': { loginEnv: () => ({}), claudeBin: () => binary, codexBin: () => '/bundled/codex' },
    './cliRuntime': { updateCli: async (provider, need) => { updates.push({ provider, need }); const ok = await update(); if (ok) binary = '/downloaded/claude'; return ok; } },
    '../shared/cliUpdates': cliUpdates,
    './agentEnvironment': { TESTING_PROMPT: '', agentEnvironment: (_, env) => env },
    './agentBrowser': { startAgentBrowser: async () => ({ prompt: '', close: async () => {} }) },
    './autopilotBridge': { startAutopilotBridge: async () => ({ prompt: '', close: async () => {} }) },
    '../shared/types': { PHASES: [] },
    '../shared/planProgress': planProgress, '../shared/featureProgress': featureProgress, '../shared/skillSections': skillSections,
    '../shared/followups': followups, '../shared/instructions': instructions, '../shared/deliverables': deliverables, '../shared/processContext': processContext, '../shared/shipPrompt': shipPrompt, '../shared/seatPool': seatPool, '../shared/ship': ship, '../shared/commands': commands, '../shared/context': context,
    '../shared/autopilot': autopilot, '../shared/codexDiagnostics': codexDiagnostics,
    '@openai/codex-sdk': { Codex: class {} },
    '@anthropic-ai/claude-agent-sdk': { query: args => (async function* () {
      calls.push(args.options.pathToClaudeCodeExecutable);
      yield { type: 'system', subtype: 'init', session_id: `session-${calls.length}` };
      const error = errors[calls.length - 1];
      yield error ? { type: 'result', subtype: 'error_during_execution', errors: [error] } : { type: 'result', subtype: 'success' };
    })() },
    'node:child_process': { execFile: (_cmd, _args, _opts, cb) => cb(null, ''), execFileSync: () => { throw new Error('no git fixture'); } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), mod, mod.exports);
  const send = async () => {
    await mod.exports.send(chat.id, 'hello');
    for (let i = 0; i < 200 && (chat.running || !calls.length); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(chat.running, false);
  };
  return { chat, calls, updates, send };
}

test('a turn refused for the CLI version downloads the newer CLI and runs again on it, once, telling the chat why', async () => {
  const { chat, calls, updates, send } = fixture({ update: async () => true });
  await send();
  assert.deepEqual(calls, ['/bundled/claude', '/downloaded/claude']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].need.required, '2.1.280');
  assert.equal(chat.error, undefined);
  assert.equal(chat.phase, 'complete');
  const note = chat.messages.find((m) => m.role === 'system');
  assert.match(note.blocks[0].text, /Claude Code 2\.1\.273 is too old for this model; 2\.1\.280 or newer is required\. Claude Code was updated; retrying\./);
});

test('when nothing newer can be fetched the error stands and nothing is retried', async () => {
  const { chat, calls, updates, send } = fixture({ update: async () => false });
  await send();
  assert.deepEqual(calls, ['/bundled/claude']);
  assert.equal(updates.length, 1);
  assert.match(chat.error, /2\.1\.280 or newer is required/);
  assert.equal(chat.queuePaused, true);
});

test('a download that fails leaves the original error, and a second refusal after an update is not retried again', async () => {
  const failing = fixture({ update: async () => { throw new Error('registry down'); } });
  await failing.send();
  assert.deepEqual(failing.calls, ['/bundled/claude']);
  assert.match(failing.chat.error, /2\.1\.280/);
  const twice = fixture({ update: async () => true, errors: [TOO_OLD, TOO_OLD] });
  await twice.send();
  assert.deepEqual(twice.calls, ['/bundled/claude', '/downloaded/claude']);
  assert.equal(twice.updates.length, 1);
  assert.match(twice.chat.error, /2\.1\.280/);
});

test('an error a new CLI would not fix never triggers a download', async () => {
  const { calls, updates, send, chat } = fixture({ update: async () => true, errors: ['API Error: 401 invalid x-api-key'] });
  await send();
  assert.deepEqual(calls, ['/bundled/claude']);
  assert.equal(updates.length, 0);
  assert.match(chat.error, /401/);
});

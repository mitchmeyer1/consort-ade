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
import * as seatPool from '../src/shared/seatPool.ts';
import * as ship from '../src/shared/ship.ts';
import * as commands from '../src/shared/commands.ts';
import * as context from '../src/shared/context.ts';
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture() {
  const chat = { id: 'chat', worktreeId: 'wt', provider: 'claude', keyId: 'personal', model: 'model', sessionId: 'old-session', sessionKeyId: 'personal', phase: 'waiting', messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Fix the dropdown contrast' }] }] };
  const keys = [{ id: 'personal', provider: 'claude', phiAllowed: false }, { id: 'work', provider: 'claude', phiAllowed: true, configDir: '/isolated/work' }, { id: 'codex-login', name: 'Codex CLI login', provider: 'codex', phiAllowed: false }];
  const calls = [];
  const store = { data: { chats: [chat], keys, worktrees: [{ id: 'wt', path: '/nonexistent-test-worktree' }] }, chat: () => chat, save() {}, getSecret: () => '' };
  const mocks = {
    "./dockerLifecycle": { beginDockerRun: () => "", dockerRunEnvironment: () => ({}), finishDockerRun: async () => {} },
    './store': { store },
    './auth': { loginEnv: key => ({ CLAUDE_CONFIG_DIR: key.configDir ?? '/personal' }) },
    './agentEnvironment': { TESTING_PROMPT: '', agentEnvironment: (_, env) => env },
    './agentBrowser': { startAgentBrowser: async () => ({ prompt: '', close: async () => {} }) },
    '../shared/types': { PHASES: [] },
    '../shared/planProgress': planProgress,
    '../shared/featureProgress': featureProgress,
    '../shared/skillSections': skillSections,
    '../shared/followups': followups,
    '../shared/instructions': instructions,
    '../shared/deliverables': deliverables,
    '../shared/seatPool': seatPool,
    '../shared/ship': ship,
    '../shared/commands': commands,
    '../shared/context': context,
    './seatPool': { DEFAULT_SEAT: '/personal', runChooser: async () => { throw new Error('no chooser in tests'); }, sessionOnSeat: () => true },
    '@openai/codex-sdk': { Codex: class {
      startThread() { return this.resumeThread(); }
      resumeThread() { return { runStreamed: async () => ({ events: (async function* () {
        yield { type: 'error', message: 'Account quota exhausted; switch accounts.' };
        yield { type: 'turn.failed', error: { message: 'Account quota exhausted; switch accounts.' } };
        throw new Error('Codex Exec exited with code 1: Reading prompt from stdin...');
      })() }) }; }
    } },
    '@anthropic-ai/claude-agent-sdk': { query: args => (async function* () {
      calls.push(args);
      yield { type: 'system', subtype: 'init', session_id: 'new-session' };
    })() },
    'node:child_process': { execFile: (_cmd, _args, _opts, cb) => cb(null, ''), execFileSync: () => { throw new Error('no git fixture'); } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), mod, mod.exports);
  const send = async text => {
    await mod.exports.send(chat.id, text);
    for (let i = 0; i < 100 && (chat.running || !calls.length); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(chat.running, false);
    assert.equal(chat.error, undefined);
    assert.equal(calls.length, 1);
    return calls[0];
  };
  return { agents: mod.exports, chat, calls, keys, send };
}
test('same-provider account switch starts a fresh session with history and the selected credentials', async () => {
  const { agents, chat, send } = fixture();
  await agents.switchAgent(chat.id, 'work', 'model');
  assert.equal(chat.sessionId, undefined);
  const call = await send('Continue');
  assert.equal(call.options.resume, undefined);
  assert.equal(call.options.env.CLAUDE_CONFIG_DIR, '/isolated/work');
  assert.match(call.prompt, /Fix the dropdown contrast/);
  assert.match(call.prompt, /Current user message:\nContinue/);
  assert.equal(chat.messages.at(-1).blocks[0].text, 'Continue');
  assert.equal(chat.sessionKeyId, 'work');
});
test('model-only change preserves the same-account session', async () => {
  const { agents, chat, send } = fixture();
  await agents.switchAgent(chat.id, 'personal', 'another-model');
  const call = await send('Continue');
  assert.equal(call.options.resume, 'old-session');
  assert.equal(call.options.model, 'another-model');
});
test('manual PHI connector switch does not resume another account session', async () => {
  const { agents, chat, send } = fixture();
  agents.setPhiMode(chat, true, 'manual');
  const call = await send('Check the patient data');
  assert.equal(chat.keyId, 'work');
  assert.equal(call.options.resume, undefined);
  assert.match(call.prompt, /Fix the dropdown contrast/);
});
test('an existing missing-session error recovers on the next message', async () => {
  const { chat, send } = fixture();
  chat.error = 'No conversation found with session ID: old-session';
  const call = await send('Continue');
  assert.equal(call.options.resume, undefined);
  assert.match(call.prompt, /Fix the dropdown contrast/);
});
test('unrelated failures retain the session', async () => {
  const { chat, send } = fixture();
  chat.error = 'Rate limit exceeded';
  assert.equal((await send('Continue')).options.resume, 'old-session');
});

test('Continue recovers a missing session with a transcript handoff', async () => {
  const { agents, chat, calls } = fixture();
  chat.error = "Couldn't find the session old-session";
  await agents.continueChat(chat.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.resume, undefined);
  assert.match(calls[0].prompt, /Fix the dropdown contrast/);
  assert.equal(chat.error, undefined);
});

test('Codex provider diagnostic survives a later SDK process-exit exception', async () => {
  const { agents, chat } = fixture();
  chat.provider = 'codex';
  await agents.send(chat.id, 'Continue', [], { silent: true });
  assert.equal(chat.error, 'Account quota exhausted; switch accounts.\n\nCodex Exec exited with code 1: Reading prompt from stdin...');
  assert.equal(chat.running, false);
  assert.equal(chat.queuePaused, true);
});

test('PHI keywords do not switch the selected connector', async () => {
  const { chat, send } = fixture();
  const call = await send('Check production patient data in snowflake, PHI, DOB and medical records');
  assert.equal(chat.keyId, 'personal');
  assert.equal(call.options.resume, 'old-session');
});


test('Codex pins a thread to its model; Claude does not', () => {
  const { agents } = fixture();
  assert.equal(agents.modelPinsSession('codex'), true);
  assert.equal(agents.modelPinsSession('claude'), false);
});

test('a Codex model change starts a fresh session and hands the transcript over', async () => {
  const { agents, chat } = fixture();
  chat.provider = 'codex';
  chat.keyId = 'codex-login';
  chat.model = 'gpt-6-astra';
  await agents.switchAgent(chat.id, 'codex-login', 'gpt-5.6-sol');
  assert.equal(chat.model, 'gpt-5.6-sol');
  assert.equal(chat.sessionId, undefined, 'the old thread cannot be resumed on the new model');
  const note = chat.messages.find((m) => m.role === 'system' && m.blocks[0].text.includes('gpt-5.6-sol'));
  assert.ok(note, 'the switch is recorded in the transcript');
  // the handoff turn ran on Codex: the fixture's Codex mock always reports a quota error
  assert.match(chat.error, /Account quota exhausted/);
});

test('a Codex chat with no session yet just changes model', async () => {
  const { agents, chat } = fixture();
  chat.provider = 'codex';
  chat.keyId = 'codex-login';
  chat.sessionId = undefined;
  await agents.switchAgent(chat.id, 'codex-login', 'gpt-5.6-sol');
  assert.equal(chat.model, 'gpt-5.6-sol');
  assert.equal(chat.error, undefined, 'nothing to hand over, so no turn is spent');
  assert.equal(chat.messages.filter((m) => m.role === 'system').length, 0);
});

test('re-picking the model a Codex chat is already on leaves the session alone', async () => {
  const { agents, chat } = fixture();
  chat.provider = 'codex';
  chat.keyId = 'codex-login';
  await agents.switchAgent(chat.id, 'codex-login', chat.model);
  assert.equal(chat.sessionId, 'old-session');
  assert.equal(chat.error, undefined);
});

test('a session the provider will not resume on this model recovers on the next message', async () => {
  const { chat, send } = fixture();
  chat.error = 'This conversation was originally started with model gpt-6-astra; resume it with that model.';
  const call = await send('Continue');
  assert.equal(call.options.resume, undefined);
  assert.match(call.prompt, /Fix the dropdown contrast/);
});

test('a resumed review gets the skill\'s file schema and link rule back, since the digest drops them', async () => {
  const { agents, chat, calls } = fixture();
  chat.name = 'PR #449 wnstck';
  chat.interrupted = true;
  chat.messages = [{ role: 'user', blocks: [{ type: 'text', text: `Run the pr-writeup skill for PR 449.\n\n## Phase 0 — scope\nlook\n\n## Phase 5 — the review file\nSave it to pr-<n>.review.json with keys a, b, c.\n\n## Phase 6 — summary and link\nEnd with the link.\n\n## Voice\nplain\n` }] }];
  await agents.continueChat(chat.id);
  for (let i = 0; i < 100 && (chat.running || !calls.length); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  const prompt = calls[0].prompt;
  assert.match(prompt, /deliverable is `\.consort\/pr-review\/pr-449\.review\.json`/);
  assert.match(prompt, /## Phase 5 — the review file\nSave it to pr-<n>\.review\.json with keys a, b, c\./);
  assert.match(prompt, /## Phase 6 — summary and link/);
});

test('an ordinary interrupted chat resumes without any review talk', async () => {
  const { agents, chat, calls } = fixture();
  chat.interrupted = true;
  await agents.continueChat(chat.id);
  for (let i = 0; i < 100 && (chat.running || !calls.length); i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].prompt, /pr-writeup|review\.json/);
});

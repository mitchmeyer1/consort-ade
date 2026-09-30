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
import * as cliUpdates from '../src/shared/cliUpdates.ts';
import * as autopilot from '../src/shared/autopilot.ts';
import * as codexDiagnostics from '../src/shared/codexDiagnostics.ts';
import * as seatPool from '../src/shared/seatPool.ts';
import * as ship from '../src/shared/ship.ts';
import * as commands from '../src/shared/commands.ts';
import * as context from '../src/shared/context.ts';
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/agents.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const LIMIT = "You've hit your limit · resets 3pm (America/New_York)";
const seat = (dir, pct) => ({ dir, name: dir.split('/').pop().replace(/^\.claude-?/, '') || 'default', live: true, source: 'live', blocked: pct >= 90, fiveHour: { pct, resetsAt: Date.now() + 3600_000 }, sevenDay: { pct: 10 }, models: {} });

/**
 * One pool chat on seat a. Each Claude turn plays the next script: 'limit' ends the turn the way a spent
 * seat does, 'ok' finishes it. The chooser answers from `headroom`, the seats with room left.
 */
function fixture({ scripts, headroom = ['/s/.claude-b'], key = 'pool', sessionOnSeat = () => true, provider = 'claude' }) {
  const chat = { id: 'chat', worktreeId: 'wt', provider, keyId: key, model: provider === 'claude' ? 'claude-opus-5-5' : 'gpt-6-astra', seatDir: key === 'pool' ? '/s/.claude' : undefined, sessionId: 's1', sessionKeyId: key, phase: 'waiting', autoApprove: true, messages: [{ id: 'm', role: 'user', blocks: [{ type: 'text', text: 'Build the thing' }], ts: 1 }] };
  const keys = [{ id: 'pool', name: 'Any Claude', provider: 'claude', pool: true, auth: 'login' }, { id: 'personal', name: 'Claude', provider: 'claude', auth: 'login' }, { id: 'work', name: 'Claude work', provider: 'claude', auth: 'login', configDir: '/s/.claude-b' },
    { id: 'pool-codex', name: 'Any Codex', provider: 'codex', pool: true, auth: 'login' }, { id: 'cx1', name: 'Codex', provider: 'codex', auth: 'login' }, { id: 'cx2', name: 'Codex 2', provider: 'codex', auth: 'login', configDir: '/s/.codex-b' }];
  const calls = [];
  const chooser = [];
  const seatOf = (dir, prov, pct) => ({ provider: prov, keyId: dir, dir, name: dir.split('/').pop().replace(/^\.(claude|codex)-?/, '') || 'default', live: true, blocked: pct >= 95, fiveHour: { pct, resetsAt: Date.now() + 3600_000 }, sevenDay: { pct: 10 }, models: {}, at: Date.now() });
  const allSeats = () => [seatOf('/s/.claude', 'claude', 50), seatOf('/s/.claude-b', 'claude', 50), seatOf('/s/.claude-c', 'claude', 50), seatOf('/s/.codex', 'codex', 50), seatOf('/s/.codex-b', 'codex', 50)]
    .map((s) => (headroom.includes(s.dir) || s.dir === '/s/.claude' || s.dir === '/s/.codex' ? s : { ...s, blocked: true, fiveHour: { pct: 100, resetsAt: Date.now() + 3600_000 } }));
  const store = { data: { chats: [chat], keys, worktrees: [{ id: 'wt', path: '/nonexistent-test-worktree' }], seatPool: { at: 1, seats: allSeats(), picks: {} } }, chat: () => chat, save() {}, getSecret: () => '' };
  const readPool = async (opts = {}) => {
    chooser.push(opts);
    // the seat that just hit its limit reports as spent on the next read
    const spent = new Set(chat.seatTried ?? []);
    const current = store.data.seatPool?.seats?.length ? store.data.seatPool.seats : allSeats();
    store.data.seatPool = { at: Date.now(), seats: current.map((s) => (spent.has(s.dir) ? { ...s, blocked: true, fiveHour: { pct: 100, resetsAt: Date.now() + 3600_000 } } : s)), picks: {} };
    return store.data.seatPool;
  };
  const mocks = {
    './dockerLifecycle': { beginDockerRun: () => '', dockerRunEnvironment: () => ({}), finishDockerRun: async () => {} },
    './store': { store },
    './cliRuntime': { updateCli: async () => false },
    './auth': { loginEnv: (k) => ({ CLAUDE_CONFIG_DIR: k?.configDir ?? '/s/.claude-login-pick' }), claudeBin: () => '/bundled/claude', codexBin: () => '/bundled/codex' },
    './agentEnvironment': { TESTING_PROMPT: '', agentEnvironment: (_, env) => env, isInstallCommand: () => false },
    './agentBrowser': { startAgentBrowser: async () => ({ prompt: '', close: async () => {} }) },
    './autopilotBridge': { startAutopilotBridge: async () => ({ prompt: '', close: async () => {} }) },
    './seatPool': { defaultSeat: (p) => (p === 'claude' ? '/s/.claude' : '/s/.codex'), readPool, pickSeat: seatPool.pickSeat, sessionOnSeat },
    '../shared/types': { PHASES: [] },
    '../shared/planProgress': planProgress,
    '../shared/featureProgress': featureProgress,
    '../shared/skillSections': skillSections,
    '../shared/followups': followups,
    '../shared/instructions': instructions,
    '../shared/deliverables': deliverables,
    '../shared/processContext': processContext,
    '../shared/shipPrompt': shipPrompt,
    '../shared/cliUpdates': cliUpdates,
    '../shared/autopilot': autopilot,
    '../shared/codexDiagnostics': codexDiagnostics,
    '../shared/seatPool': seatPool,
    '../shared/ship': ship,
    '../shared/commands': commands,
    '../shared/context': context,
    '@openai/codex-sdk': { Codex: class { constructor(o) { this.o = o; } startThread(opts) { return this.thread(opts); } resumeThread(_id, opts) { return this.thread(opts); } thread(opts) { const self = this; return { runStreamed: async (prompt) => { const script = scripts[calls.length] ?? 'ok'; calls.push({ prompt, options: { env: self.o.env, model: opts.model } }); return { events: (async function* () { yield { type: 'thread.started', thread_id: 's1' }; if (script === 'limit') yield { type: 'turn.failed', error: { message: "You've hit your usage limit. Try again later." } }; else yield { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }; })() }; } }; } } },
    '@anthropic-ai/claude-agent-sdk': { query: (args) => (async function* () {
      const script = scripts[calls.length] ?? 'ok';
      calls.push(args);
      yield { type: 'system', subtype: 'init', session_id: args.options.resume ?? 'fresh' };
      if (script === 'limit') {
        yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.floor(Date.now() / 1000) + 3600, unifiedWindows: { five_hour: { utilization: 1 } } } };
        yield { type: 'result', subtype: 'success', is_error: true, result: LIMIT };
      } else yield { type: 'result', subtype: 'success', result: 'done [phase:complete]' };
    })() },
    'node:child_process': { execFile: (_cmd, _args, _opts, cb) => cb(null, ''), execFileSync: () => { throw new Error('no git fixture'); } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => mocks[name] ?? require(name), mod, mod.exports);
  const settle = async (turns) => {
    for (let i = 0; i < 400 && (chat.running || calls.length < turns); i++) await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const notes = () => chat.messages.filter((m) => m.role === 'system').map((m) => m.blocks[0].text);
  return { agents: mod.exports, chat, calls, chooser, store, settle, notes };
}

test('a pool chat that hits its seat\'s limit resumes the same session on the next seat and carries on', async () => {
  const { agents, chat, calls, chooser, store, settle, notes } = fixture({ scripts: ['limit', 'ok'] });
  await agents.send(chat.id, 'Now wire the tests');
  await settle(2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/s/.claude', 'the chat keeps its own seat, not the pool\'s current pick');
  assert.equal(calls[0].options.settings.autoContinueAtUsageLimit, false);
  assert.deepEqual(chooser.at(-1), { force: true });
  assert.equal(calls[1].options.env.CLAUDE_CONFIG_DIR, '/s/.claude-b');
  assert.equal(calls[1].options.resume, 's1');
  assert.match(calls[1].prompt, /continues on another account/);
  assert.doesNotMatch(calls[1].prompt, /Transcript so far|fresh provider session/, 'the session came along, so no transcript is replayed');
  assert.equal(chat.seatDir, '/s/.claude-b');
  assert.equal(chat.error, undefined);
  assert.equal(chat.seatTried, undefined);
  assert.equal(chat.running, false);
  assert.ok(notes().some((n) => /default hit its 5-hour limit .*Continuing on b\./.test(n)), notes().join('\n'));
  assert.equal(store.data.seatPool.seats[0].fiveHour.pct, 100, 'the spent seat\'s meter shows it');
});

test('a limit on every seat stops with when the first one reopens, without looping', async () => {
  const { agents, chat, calls, settle } = fixture({ scripts: ['limit', 'limit', 'limit'], headroom: ['/s/.claude-b'] });
  await agents.send(chat.id, 'Now wire the tests');
  await settle(2);
  await settle(2);
  assert.equal(calls.length, 2, 'a then b, then nowhere left');
  assert.match(chat.error, /b hit its 5-hour limit .*no other seat has headroom/);
  assert.equal(chat.seatTried, undefined);
  assert.equal(chat.queuePaused, true);
});

test('a limit off the pool says so and points at the seat switch', async () => {
  const { agents, chat, calls, settle } = fixture({ scripts: ['limit'], key: 'personal' });
  await agents.send(chat.id, 'Now wire the tests');
  await settle(1);
  assert.equal(calls.length, 1);
  assert.match(chat.error, /Claude hit its 5-hour limit.*Switch seat to continue on another account/);
});

test('switching seats moves the chat onto the pool, keeps its session and continues the failed turn', async () => {
  const { agents, chat, calls, settle, notes } = fixture({ scripts: ['ok'], key: 'personal' });
  chat.error = LIMIT;
  await agents.switchSeat(chat.id);
  await settle(1);
  assert.equal(chat.keyId, 'pool');
  assert.equal(chat.seatDir, '/s/.claude-b');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.resume, 's1');
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, '/s/.claude-b');
  assert.equal(chat.error, undefined);
  assert.ok(notes().some((n) => n === 'Moved to seat b from default.'), notes().join('\n'));
});

test('a seat that can\'t see the session starts fresh with the transcript', async () => {
  const { agents, chat, calls, settle } = fixture({ scripts: ['ok'], sessionOnSeat: () => false, headroom: ['/s/.claude-b', '/s/.claude-c'] });
  chat.error = LIMIT;
  await agents.switchSeat(chat.id, '/s/.claude-c');
  await settle(1);
  assert.equal(chat.seatDir, '/s/.claude-c');
  assert.equal(calls[0].options.resume, undefined);
  assert.match(calls[0].prompt, /Build the thing/);
});

test('a Codex pool chat that hits its usage limit moves to the next Codex login and carries on', async () => {
  const { agents, chat, calls, settle, notes } = fixture({ scripts: ['limit', 'ok'], key: 'pool-codex', provider: 'codex', headroom: ['/s/.codex-b'] });
  chat.seatDir = '/s/.codex';
  await agents.send(chat.id, 'Now wire the tests');
  await settle(2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.CODEX_HOME, '/s/.codex');
  assert.equal(calls[1].options.env.CODEX_HOME, '/s/.codex-b');
  assert.match(calls[1].prompt, /continues on another account/);
  assert.equal(chat.seatDir, '/s/.codex-b');
  assert.equal(chat.error, undefined);
  assert.ok(notes().some((n) => /default hit its usage limit\. Continuing on b\./.test(n)), `notes: ${notes().join(' | ')} error: ${chat.error} seatTried: ${chat.seatTried}`);
});

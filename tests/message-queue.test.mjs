import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import * as planProgress from '../src/shared/planProgress.ts';
import * as featureProgress from '../src/shared/featureProgress.ts';
import * as skillSections from '../src/shared/skillSections.ts';
import * as followups from '../src/shared/followups.ts';
import * as instructions from '../src/shared/instructions.ts';
import * as deliverables from '../src/shared/deliverables.ts';
import * as processContext from '../src/shared/processContext.ts';
import * as shipPrompt from '../src/shared/shipPrompt.ts';
import * as codexDiagnostics from '../src/shared/codexDiagnostics.ts';
import * as cliUpdates from '../src/shared/cliUpdates.ts';
import * as autopilot from '../src/shared/autopilot.ts';
import * as seatPool from '../src/shared/seatPool.ts';
import * as ship from '../src/shared/ship.ts';
import * as commands from '../src/shared/commands.ts';
import * as context from '../src/shared/context.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(await readFile(new URL('../src/main/agents.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.fail('Queue did not reach the expected state');
}
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-queue-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  const chat = { id: 'chat', worktreeId: 'wt', provider: 'codex', keyId: 'key', phase: 'waiting', running: false, messages: [] };
  const runs = [];
  const thread = { runStreamed: async (prompt, { signal }) => {
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    signal.addEventListener('abort', () => finish(), { once: true });
    runs.push({ prompt, finish });
    return { events: (async function* () {
      const event = await done;
      for (const item of Array.isArray(event) ? event : [event]) if (item) yield item;
    })() };
  } };
  const store = { data: { chats: [chat], keys: [{ id: 'key' }], worktrees: [{ id: 'wt', path: cwd }] }, chat: () => chat, getSecret: () => 'fake', save() {} };
  const mocks = {
    "./dockerLifecycle": { beginDockerRun: () => "", dockerRunEnvironment: () => ({}), finishDockerRun: async () => {} },
    './store': { store },
    './dockerLifecycle': { beginDockerRun: () => '', dockerRunEnvironment: () => ({}), finishDockerRun: async () => {} },
    './auth': { loginEnv: () => ({}), claudeBin: () => '/bundled/claude', codexBin: () => '/bundled/codex' },
    './cliRuntime': { updateCli: async () => false },
    '../shared/cliUpdates': cliUpdates,
    './agentBrowser': { startAgentBrowser: async () => ({ prompt: '', close: async () => {} }) },
    './autopilotBridge': { startAutopilotBridge: async () => ({ prompt: '', close: async () => {} }) },
    './agentEnvironment': { TESTING_PROMPT: '', agentEnvironment: (_, env) => env },
    '../shared/types': { PHASES: ['waiting', 'planning', 'executing', 'validating', 'complete'] },
    '../shared/planProgress': planProgress,
    '../shared/featureProgress': featureProgress,
    '../shared/skillSections': skillSections,
    '../shared/followups': followups,
    '../shared/instructions': instructions,
    '../shared/deliverables': deliverables,
    '../shared/processContext': processContext,
    '../shared/shipPrompt': shipPrompt,
    '../shared/codexDiagnostics': codexDiagnostics,
    '../shared/autopilot': autopilot,
    '../shared/seatPool': seatPool,
    '../shared/ship': ship,
    '../shared/commands': commands,
    '../shared/context': context,
    './seatPool': { DEFAULT_SEAT: '/personal', runChooser: async () => { throw new Error('no chooser in tests'); }, sessionOnSeat: () => true },
    '@anthropic-ai/claude-agent-sdk': {},
    '@openai/codex-sdk': { Codex: class { startThread() { return thread; } resumeThread() { return thread; } } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), mod, mod.exports);
  return { agents: mod.exports, chat, runs, cwd, store };
}

test('messages submitted during a run execute once in FIFO order, with independent attachments', async t => {
  const { agents, chat, runs, cwd } = await fixture(t);
  await agents.send(chat.id, 'first');
  await until(() => runs.length === 1);
  const file = join(cwd, 'note.txt');
  await writeFile(file, 'second attachment');
  await agents.send(chat.id, 'second', [file]);
  await writeFile(file, 'third attachment');
  await agents.send(chat.id, 'third', [file]);
  assert.equal(runs.length, 1);
  assert.deepEqual(chat.queuedMessages.map(m => m.text), ['second', 'third']);
  const paths = chat.queuedMessages.map(m => m.files[0]);
  assert.equal(await readFile(paths[0], 'utf8'), 'second attachment');
  assert.equal(await readFile(paths[1], 'utf8'), 'third attachment');
  runs[0].finish();
  await until(() => runs.length === 2);
  assert.match(runs[1].prompt, /second/);
  runs[1].finish();
  await until(() => runs.length === 3);
  assert.match(runs[2].prompt, /third/);
  runs[2].finish();
  await until(() => !chat.running);
  assert.equal(chat.queuedMessages.length, 0);
  assert.equal(chat.messages.filter(m => m.role === 'user').length, 3);
});

test('Stop pauses pending messages until explicitly resumed', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'first');
  await until(() => runs.length === 1);
  await agents.send(chat.id, 'later');
  agents.stop(chat.id);
  await until(() => !chat.running);
  assert.equal(chat.queuePaused, true);
  assert.equal(chat.queuedMessages.length, 1);
  await agents.flushQueued(chat.id);
  assert.equal(runs.length, 1);
  chat.queuePaused = false;
  const draining = agents.flushQueued(chat.id);
  await until(() => runs.length === 2);
  runs[1].finish();
  await draining;
  assert.equal(chat.queuedMessages.length, 0);
});

test('a provider failure retains and pauses queued follow-ups', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'first');
  await until(() => runs.length === 1);
  await agents.send(chat.id, 'later');
  runs[0].finish({ type: 'turn.failed', error: { message: 'provider unavailable' } });
  await until(() => !chat.running);
  assert.equal(chat.error, 'provider unavailable');
  assert.equal(chat.queuePaused, true);
  assert.equal(chat.queuedMessages[0].text, 'later');
  assert.equal(runs.length, 1);
});

test('a Codex skill-budget notice still completes successfully', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'finish normally');
  await until(() => runs.length === 1);
  runs[0].finish([
    { type: 'error', message: 'Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter.' },
    { type: 'turn.completed', usage: {} },
  ]);
  await until(() => !chat.running);
  assert.equal(chat.error, undefined);
  assert.equal(chat.phase, 'complete');
  assert.equal(chat.unreadCompletion, true);
  assert.equal(chat.queuePaused, false);
});

test('an opted-in turn receives supervisor and desktop-driver instructions', async t => {
  const { agents, chat, runs } = await fixture(t);
  chat.autopilot = true;
  await agents.send(chat.id, 'configure the visible app');
  await until(() => runs.length === 1);
  assert.match(runs[0].prompt, /Autopilot is enabled for this turn/);
  assert.match(runs[0].prompt, /configured cheaper agent/);
  runs[0].finish();
  await until(() => !chat.running);
});

test('oversized input is bounded and archived without changing the visible message', async t => {
  const { agents, chat, runs } = await fixture(t);
  const original = 'Original requirement\n' + 'x'.repeat(1_055_378) + '\nLatest correction';
  await agents.send(chat.id, original);
  await until(() => runs.length === 1);
  assert.ok(runs[0].prompt.length < 125_000, `prompt length ${runs[0].prompt.length}`);
  assert.match(runs[0].prompt, /Original requirement/);
  assert.match(runs[0].prompt, /Latest correction/);
  const archive = /Full input: (.+?)\. Read/.exec(runs[0].prompt)[1];
  assert.ok((await readFile(archive, 'utf8')).includes(original));
  assert.equal(chat.messages.find(m => m.role === 'user').blocks[0].text, original);
  runs[0].finish();
  await until(() => !chat.running);
});

test('a context-size failure retries once with a fresh session and preserved history', async t => {
  const { agents, chat, runs } = await fixture(t);
  chat.sessionId = 'oversized-session';
  chat.messages.push({ role: 'user', blocks: [{ type: 'text', text: 'Original task: review every file' }] });
  await agents.send(chat.id, 'Continue with the final artifact');
  await until(() => runs.length === 1);
  runs[0].finish({ type: 'turn.failed', error: { message: 'input_too_large' } });
  await until(() => runs.length === 2);
  assert.equal(chat.sessionId, undefined);
  assert.match(runs[1].prompt, /Original task: review every file/);
  assert.match(runs[1].prompt, /Continue with the final artifact/);
  assert.match(runs[1].prompt, /\[steps:3\] or \[steps:5\]/); // the runtime instructions ride along on the retry
  const archive = /Full prior transcript: (.+?);/.exec(runs[1].prompt)[1];
  assert.equal(JSON.parse(await readFile(archive, 'utf8'))[0].blocks[0].text, 'Original task: review every file');
  runs[1].finish({ type: 'turn.failed', error: { message: 'input_too_large' } });
  await until(() => !chat.running);
  assert.equal(runs.length, 2);
  assert.match(chat.error, /input_too_large/);
  assert.equal(chat.queuePaused, true);
});

test('compact handoff retains the original task and latest correction within budget', async t => {
  const { agents, chat } = await fixture(t);
  chat.messages = Array.from({ length: 50 }, (_, i) => ({ role: 'user', blocks: [{ type: 'text', text: `Message ${i}: ` + 'x'.repeat(3000) + ` end ${i}` }] }));
  const before = JSON.stringify(chat.messages);
  const digest = agents.transcriptDigest(chat);
  assert.ok(digest.length <= 9000);
  assert.match(digest, /Message 0:/);
  assert.match(digest, /end 49/);
  assert.equal(JSON.stringify(chat.messages), before);
});

test('successful context recovery completes the chat without leaving the queue paused', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'Finish the task');
  await until(() => runs.length === 1);
  runs[0].finish({ type: 'error', message: 'Input exceeds the maximum length of 1048576 characters.' });
  await until(() => runs.length === 2);
  runs[1].finish();
  await until(() => !chat.running);
  assert.equal(chat.error, undefined);
  assert.equal(chat.phase, 'complete');
  assert.equal(chat.queuePaused, false);
});

test('an existing oversized-session error resets the session on the next request', async t => {
  const { agents, chat, runs } = await fixture(t);
  chat.sessionId = 'old-session';
  chat.error = 'input_too_large';
  await agents.send(chat.id, 'Continue');
  await until(() => runs.length === 1);
  assert.equal(chat.sessionId, undefined);
  assert.match(runs[0].prompt, /Continue the same task after a context-size failure/);
  runs[0].finish();
  await until(() => !chat.running);
  assert.equal(chat.error, undefined);
});

test('each prompt starts assessment afresh and simple progress applies to the current turn only', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'When was Isaac Newton born?');
  await until(() => runs.length === 1);
  assert.equal(chat.phase, 'waiting');
  assert.equal(chat.assessingPrompt, true);
  assert.equal(chat.phaseSteps, 5);
  runs[0].finish({ type: 'item.completed', item: { type: 'agent_message', text: '[steps:3]\n[phase:executing]\nA simple answer.\n[phase:complete]' } });
  await until(() => !chat.running);
  assert.equal(chat.phaseSteps, 3);
  assert.equal(chat.phase, 'complete');
  assert.ok(!chat.messages.at(-1).blocks[0].text.includes('[steps:'));
  await agents.send(chat.id, 'Implement a feature');
  await until(() => runs.length === 2);
  assert.equal(chat.phaseSteps, 5);
  assert.equal(chat.phase, 'waiting');
  runs[1].finish({ type: 'item.completed', item: { type: 'agent_message', text: '[steps:5]\n[phase:planning]\nPlan.\n[phase:executing]\nWork.\n[phase:validating]\nChecked.\n[phase:complete]' } });
  await until(() => !chat.running);
  assert.equal(chat.phaseSteps, 5);
  assert.equal(chat.phase, 'complete');
});

test('planning or validation upgrades a simple flow to five steps', async t => {
  const { agents, chat, runs } = await fixture(t);
  await agents.send(chat.id, 'Task');
  await until(() => runs.length === 1);
  runs[0].finish({ type: 'item.completed', item: { type: 'agent_message', text: '[steps:3]\n[phase:planning]\nThis needs a plan.\n[phase:waiting]\nPlease clarify.' } });
  await until(() => !chat.running);
  assert.equal(chat.phaseSteps, 5);
  assert.equal(chat.phase, 'waiting');
  assert.equal(chat.assessingPrompt, false);
});

test('continuing a /ship chat re-attaches the stage prompt and the plan it was on, so the pipeline keeps moving', async t => {
  const { agents, chat, runs, store } = await fixture(t);
  const wt = store.data.worktrees[0];
  wt.projectId = 'p'; wt.branch = 'mm/hris-494';
  wt.ship = ship.newShipFeature({ source: 'github', id: '494', url: 'https://github.com/o/r/issues/494', title: 'HRIS address' }, 'hris', 1);
  store.data.projects = [{ id: 'p', path: wt.path, defaultBase: 'origin/development' }];
  chat.messages.push({ id: 'u', role: 'user', blocks: [{ type: 'text', text: '/ship' }], ts: 1 }, { id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'Q1…' }], ts: 2 });
  chat.plan = { steps: [{ label: 'read the ticket', doneAt: 1 }, { label: 'ask round one' }], current: 1, ts: 1 };
  chat.interrupted = true;
  const resumed = agents.continueChat(chat.id); // resolves when the resumed turn ends
  // the continue reads git and the .consort folder for real before it sends, so this wait is on the clock, not ticks
  for (let i = 0; i < 250 && runs.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
  assert.match(runs[0].prompt, /This chat is a \/ship run/);
  assert.match(runs[0].prompt, /Grilling — interrogate the idea/);
  assert.match(runs[0].prompt, /\[ship-stage: <stage> \| <one-line note>\]/);
  assert.match(runs[0].prompt, /Continue from step 2 \(ask round one\)/);
  runs[0].finish({ type: 'turn.completed', usage: {} });
  await resumed;
  await until(() => !chat.running);
  // a plain new message on a live session gets neither: the session already knows
  chat.sessionId = 'live';
  await agents.send(chat.id, 'thanks');
  await until(() => runs.length === 2);
  assert.doesNotMatch(runs[1].prompt, /This chat is a \/ship run/);
  runs[1].finish({ type: 'turn.completed', usage: {} });
  await until(() => !chat.running);
});

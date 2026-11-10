import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as owner from '../src/cli/ownerUpdates.ts';
import * as session from '../src/cli/testSession.ts';

test('asking to test or demo starts a session; ordinary messages do not', () => {
  for (const text of ['I want to test it', 'i wanna try it', 'cool can you spin up a server with a localhost and check it out so i can demo it', 'let me click through it', 'give me a test link', 'start a test session', 'can I test this myself?', 'send me an ngrok link'])
    assert.equal(session.isTestRequest(text), true, text);
  for (const text of ['so why all over your ngrok does it say partially mocked?', 'i didn\'t ask for a test session, i asked you a question', 'I want to see why CI failed', 'did you test it?', 'run the tests again', 'add a CSV export', 'status', 'thanks', 'why is CI red', 'the test for notes is flaky'])
    assert.equal(session.isTestRequest(text), false, text);
});

test('"done" and its variants end a session; other replies do not', () => {
  for (const text of ['done', 'Done!', 'ok done', "I'm done testing", 'all done', 'finished', 'continue', 'go ahead', 'done, but the save button is grey']) assert.equal(session.isTestDone(text), true, text);
  for (const text of ['not done yet', 'the save button is grey', 'is it done?', 'what is left to be done']) assert.equal(session.isTestDone(text), false, text);
  assert.equal(session.isBareDone('ok done'), true);
  assert.equal(session.isBareDone('done, but the save button is grey when I add a note'), false);
});

test('the prompt is about any repo: env setup, one port, a login per role, local data only, the session file', () => {
  const p = session.testSessionPrompt({ repo: '/r', worktree: '/w', stage: 'In Review', ports: '20400-20499', prUrl: 'https://github.com/a/b/pull/1' });
  assert.match(p, /ENV\.md/);
  assert.match(p, /20400-20499/);
  assert.match(p, /nohup/);
  assert.match(p, /ngrok/);
  assert.match(p, /one login per role in the LOCAL database only/);
  assert.match(p, /Never touch production/);
  assert.match(p, /\.consort\/test-session\/session\.json/);
  assert.match(p, /\[test-ready\][\s\S]*\[test-failed:/);
  assert.equal(session.parseTestFailed('x [test-failed: docker is not running]'), 'docker is not running');
});

test('the session file is read defensively', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'consort-test-session-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(session.readSessionFile(root), undefined);
  await mkdir(join(root, session.TEST_DIR), { recursive: true });
  await writeFile(join(root, session.SESSION_FILE), JSON.stringify({ port: 'nope' }));
  assert.equal(session.readSessionFile(root), undefined);
  await writeFile(join(root, session.SESSION_FILE), JSON.stringify({ port: 5173, path: '/apc-admin/1', pids: [1, 4242, 'x'], logins: [{ role: 'admin', username: 'admin@test.local', password: 'pw1' }, { role: 'bad' }], notes: ['seeded one group'], stop: ' ./down.sh ' }));
  assert.deepEqual(session.readSessionFile(root), { port: 5173, path: '/apc-admin/1', pids: [4242], logins: [{ role: 'admin', username: 'admin@test.local', password: 'pw1' }], notes: ['seeded one group'], stop: './down.sh' });
});

test('the ready message has the link, the local address, every login and the done line', () => {
  const text = session.testReadyMessage({ url: 'https://ab12.ngrok-free.app', localUrl: 'http://localhost:5173', session: { port: 5173, path: '/apc-admin/1', logins: [{ role: 'admin', username: 'a@test.local', password: 'pw', notes: 'edits all notes' }, { role: 'support', username: 's@test.local', password: 'pw2' }], notes: ['seeded group 1'] } });
  assert.match(text, /<https:\/\/ab12\.ngrok-free\.app\/apc-admin\/1\|/);
  assert.match(text, /http:\/\/localhost:5173\/apc-admin\/1/);
  assert.match(text, /\*admin:\* `a@test\.local` \/ `pw` · edits all notes/);
  assert.match(text, /\*support:\* `s@test\.local` \/ `pw2`/);
  assert.match(text, /seeded group 1/);
  assert.match(text, /Tell me 'done' when you are ready for me to continue\.$/);
  const noTunnel = session.testReadyMessage({ localUrl: 'http://localhost:3000', session: { port: 3000 }, tunnelError: 'ngrok is not installed' });
  assert.match(noTunnel, /No public link: ngrok is not installed/);
  assert.match(noTunnel, /No login needed/);
});

test('only files the session changed are put back', () => {
  const before = ['src/a.ts'];
  const now = ' M src/a.ts\n M vite.config.ts\n?? .env.local\n?? .consort/test-session/app.log\n';
  assert.deepEqual(session.changedBySession(before, now), [{ path: 'vite.config.ts', untracked: false }, { path: '.env.local', untracked: true }]);
});

test('ngrok: the https address is read from its log, errors are passed on', async (t) => {
  assert.equal(session.tunnelUrlFrom('{"lvl":"info","msg":"started tunnel","url":"https://x.ngrok-free.app"}'), 'https://x.ngrok-free.app');
  assert.equal(session.tunnelUrlFrom('{"lvl":"info","msg":"x"}'), undefined);
  assert.equal(session.tunnelErrorFrom('{"lvl":"eror","err":"authentication failed"}'), 'authentication failed');
  const root = await mkdtemp(join(tmpdir(), 'consort-ngrok-')); t.after(() => rm(root, { recursive: true, force: true }));
  const good = join(root, 'ngrok-good'), bad = join(root, 'ngrok-bad');
  await writeFile(good, '#!/bin/sh\necho \'{"lvl":"info","msg":"starting"}\'\necho \'{"lvl":"info","msg":"started tunnel","url":"https://t1.ngrok-free.app"}\'\nsleep 30\n');
  await writeFile(bad, '#!/bin/sh\necho \'{"lvl":"eror","err":"ERR_NGROK_4018 authtoken missing"}\'\nexit 1\n');
  await chmod(good, 0o755); await chmod(bad, 0o755);
  const ok = await session.startTunnel(5173, { bin: good, timeoutMs: 5_000 });
  assert.equal(ok.url, 'https://t1.ngrok-free.app');
  session.killTree(ok.pid);
  const failed = await session.startTunnel(5173, { bin: bad, timeoutMs: 5_000 });
  assert.match(failed.error, /exited 1: ERR_NGROK_4018 authtoken missing/);
  const missing = await session.startTunnel(5173, { bin: join(root, 'nope'), timeoutMs: 5_000 });
  assert.match(missing.error, /ngrok is not installed/);
});

test('the start message tells the owner they can ask to test', () => {
  assert.match(headless.slackLines.claimed('Notes', 'https://x', 'mm/notes'), /Say \*I want to test it\* here any time/);
});

const compile = name => ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function daemon(overrides = {}) {
  const task = { id: 't', jobId: 'j', worktree: '/wt', branch: 'mm/x', ticket: { id: 'T1', url: 'https://app.clickup.com/t/T1' }, slackThread: '1', slackStatusAfterTs: '1', status: 'working', updatedAt: Date.now(), reviewsDone: 0, accountIds: {}, feature: { stage: 'Implementing', built: false, prs: [] }, ...overrides };
  const state = { slack: { userId: 'owner', botToken: 'xoxb' }, tasks: [task], jobs: [{ id: 'j', repo: '/repo' }], accounts: [] };
  const replies = [], asked = [], stops = []; let messages = [];
  const mocks = {
    '../shared/headless.ts': headless,
    './state': { loadState: () => state, updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch), processAlive: () => false },
    './slackLinks': { taskSlackLinks: async () => ({ ticket: task.ticket.url }) },
    './slack': { Slack: class { async threadMessages() { return messages; } async post(text) { replies.push(text); } } },
    './ownerUpdates': owner,
    'node:fs': { existsSync: () => true },
    './oversight': { workerLogTail: () => '' },
    './buildProgress': { stepLabel: name => name },
    './sources': { sourceFor: () => ({ comments: async () => [] }) },
    './testSession': session,
    './workerControl': { requestWorkerStop: (id, pid, why) => stops.push([id, pid, why]) },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile('slackStatus'))(n => mocks[n], mod, mod.exports);
  return { task, replies, asked, stops, run: async () => { await mod.exports.answerTaskStatusQuestions(() => true, { answer: async c => { asked.push(c.question); return { answer: `Checked: ${c.question}`, model: 'm' }; } }); await mod.exports.settleOwnerReplies(); }, messages: m => { messages = m; } };
}

test('"I want to test it" marks the task, stops the worker and skips the oversight agent', async () => {
  const h = daemon();
  h.messages([{ ts: '2', user: 'owner', text: 'I want to test it' }]);
  await h.run();
  assert.equal(h.task.testSession.requestTs, '2');
  assert.deepEqual(h.asked, []);
  assert.equal(h.task.ownerUpdates, undefined);
  assert.match(h.replies[0], /Starting a test session/);
});

test('a finished task reopens for a session; a closed one and a review do not', async () => {
  const ready = daemon({ status: 'ready' });
  ready.messages([{ ts: '2', user: 'owner', text: 'let me test it' }]);
  await ready.run();
  assert.equal(ready.task.status, 'monitoring');
  assert.ok(ready.task.testSession);
  const closed = daemon({ status: 'done', note: 'merged' });
  closed.messages([{ ts: '2', user: 'owner', text: 'let me test it' }]);
  await closed.run();
  assert.equal(closed.task.testSession, undefined);
  assert.match(closed.replies[0], /closed \(merged\)[\s\S]*mm\/x/);
  const review = daemon({ kind: 'review' });
  review.messages([{ ts: '2', user: 'owner', text: 'let me test it' }]);
  await review.run();
  assert.equal(review.task.testSession, undefined);
});

test('during a session: "done" is left for the worker; feedback is answered and queued, never taken as an old question\'s answer', async () => {
  const h = daemon({ testSession: { requestedAt: 1, requestTs: '2', readyTs: '3' }, pendingQuestion: { questions: ['Pick A or B?'], afterTs: '1.5' } });
  h.messages([{ ts: '4', user: 'owner', text: 'done' }, { ts: '5', user: 'owner', text: 'the save button is grey, change it to blue' }]);
  await h.run();
  assert.deepEqual(h.asked, ['the save button is grey, change it to blue']);
  assert.equal(h.task.answeredTs, undefined);
  assert.equal(h.replies.length, 1);
  const again = daemon({ testSession: { requestedAt: 1, requestTs: '2', readyTs: '3' } });
  again.messages([{ ts: '4', user: 'owner', text: 'so why all over your ngrok does it say "partially mocked" on many surfaces… what does that mean?' }, { ts: '5', user: 'owner', text: 'i didn\'t ask for a test session, i asked you a question… can we remove this "partial mock" label?' }]);
  await again.run();
  assert.equal(again.asked.length, 2, 'questions during a session reach the oversight agent');
  assert.ok(again.replies.every(r => !/already open/.test(r)));
});

test('a stop command that would take the services down is recognised; stopping a process is not', () => {
  for (const cmd of ['.consort/env/down.sh', 'bash .consort/env/down.sh', 'docker compose -p x down', 'docker stop web']) assert.equal(session.tearsDownEnvironment(cmd), true, cmd);
  for (const cmd of ['kill 4242', 'pkill -f "vite --port 20000"']) assert.equal(session.tearsDownEnvironment(cmd), false, cmd);
  assert.match(session.testSessionPrompt({ repo: '/r', worktree: '/w', stage: 'In Review' }), /Never put the environment's own teardown/);
});

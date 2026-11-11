import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as blocks from '../src/cli/slackMonitorBlocks.ts';

const compile = () => ts.transpileModule(readFileSync(new URL('../src/cli/slackSocket.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const load = () => { const mod = { exports: {} }; new Function('require', 'module', 'exports', compile())(n => n === './slackMonitorBlocks.ts' ? blocks : n === './slack' ? { Slack: class {} } : undefined, mod, mod.exports); return mod.exports; };

test('a Test click is acknowledged and relayed into the task thread with the clicker in its metadata', async () => {
  const socket = load();
  const acks = [], posts = [], logs = [];
  const frame = JSON.stringify({ envelope_id: 'e1', type: 'interactive', payload: { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'consort-test-3', value: 'D0ABC:1794351000.000100' }] } });
  await socket.handleFrame(frame, id => acks.push(id), { botToken: 'xoxb', userId: 'U1', appToken: 'xapp' }, { slack: () => ({ postRelay: async (...a) => { posts.push(a); return '9'; } }), log: l => logs.push(l) });
  assert.deepEqual(acks, ['e1']);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0][0], posts[0][1], posts[0][3], posts[0][4]], ['D0ABC', '1794351000.000100', 'consort_test', { user: 'U1' }]);
});

test('other frames are acknowledged and ignored', async () => {
  const socket = load();
  const acks = [], posts = [];
  const deps = { slack: () => ({ postRelay: async (...a) => { posts.push(a); } }), log: () => {} };
  await socket.handleFrame(JSON.stringify({ type: 'hello' }), id => acks.push(id), {}, deps);
  await socket.handleFrame(JSON.stringify({ envelope_id: 'e2', type: 'interactive', payload: { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'github-1' }] } }), id => acks.push(id), {}, deps);
  await socket.handleFrame('not json', id => acks.push(id), {}, deps);
  assert.deepEqual(acks, ['e2']);
  assert.equal(posts.length, 0);
});

test('a thread permalink gives the channel and ts the Test button carries', () => {
  assert.equal(blocks.threadRef('https://acme.slack.com/archives/D0ABC/p1794351179831059'), 'D0ABC:1794351179.831059');
  assert.equal(blocks.threadRef('https://slack.example/thread'), undefined);
});

test('a Resume click is relayed as consort_resume', async () => {
  const socket = load();
  const posts = [];
  const frame = JSON.stringify({ envelope_id: 'e3', type: 'interactive', payload: { type: 'block_actions', user: { id: 'U1' }, actions: [{ action_id: 'consort-resume-0', value: 'D0ABC:1794351000.000100' }] } });
  await socket.handleFrame(frame, () => {}, {}, { slack: () => ({ postRelay: async (...a) => { posts.push(a); } }), log: () => {} });
  assert.equal(posts[0][3], 'consort_resume');
  assert.match(posts[0][2], /Resume/);
});

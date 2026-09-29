import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as ship from '../src/shared/ship.ts';
const { denyAllBut, mcpPrefix, parseFilterResult, shipSyncDue, shipSyncNotes, toShipTask, SHIP_SYNC_MAX_AGE } = ship;

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/shipSync.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const main = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => (name === '../shared/ship' ? ship : name === './ship' ? { SHIP_HOME: '/nonexistent-ship-home' } : require(name)), main, main.exports);
const { createShipSync } = main.exports;

const OWN = 'mcp__clickup__clickup_filter_tasks';
const LIST = '901329088698';
const page = (tasks, more = false) => JSON.stringify({ tasks, count: tasks.length, page: 0, has_more: more, next_page: more ? 1 : null });
const task = (id, status) => ({ id, name: `Task ${id}`, status, url: `https://app.clickup.com/t/${id}`, priority: null });

/**
 * A fake Agent SDK. Each seat (by CLAUDE_CONFIG_DIR) starts with its own tools; a fetch session plays
 * `turns`: each is a tool call's input plus the result ClickUp gives it, or a final text.
 */
function fakeQuery({ seats, turns }) {
  const calls = [];
  const query = ({ prompt, options }) => (async function* () {
    calls.push({ prompt, options });
    const seat = seats[options.env.CLAUDE_CONFIG_DIR] ?? { tools: [], servers: [] };
    yield { type: 'system', subtype: 'init', tools: seat.tools, mcp_servers: seat.servers.map((name) => ({ name, status: 'connected' })) };
    if (options.abortController) { assert.ok(options.abortController.signal.aborted, 'the probe stops at init'); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
    let n = 0;
    for (const t of turns) {
      if (t.text) { yield { type: 'assistant', message: { content: [{ type: 'text', text: t.text }] } }; continue; }
      const id = `tu${n++}`;
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: t.name ?? OWN, input: t.input }] } };
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: t.result }] } };
    }
    yield { type: 'result', subtype: 'success', result: 'done' };
  })();
  return { query, calls };
}

const input = (over = {}) => ({ list_ids: [LIST], include_closed: true, subtasks: false, ...over });
const SEATS = {
  '/s/.claude': { tools: ['Bash', 'mcp__github__get_issue', 'mcp__claude_ai_Figma__get_file'], servers: ['github', 'claude.ai Figma'] },
  '/s/.claude-mr': { tools: ['Bash', 'mcp__github__get_issue', OWN, 'mcp__clickup__clickup_create_task', 'mcp__notion__search'], servers: ['github', 'clickup', 'notion', 'claude.ai Figma'] },
};

function fixture({ seats = SEATS, turns, order = ['/s/.claude', '/s/.claude-mr'], reconcile } = {}) {
  const { query, calls } = fakeQuery({ seats, turns });
  const published = [];
  const handed = [];
  const sync = createShipSync({
    seats: () => order, model: () => 'claude-haiku-4-5-20251001', publish: (s) => published.push(s), query, listId: () => LIST, home: '/ship-home',
    reconcile: reconcile ?? (async (file) => { handed.push(JSON.parse(readFileSync(file, 'utf8'))); return { changed: [{ slug: 'login', ticket: 'a1', from: 'In Review', to: 'Closed' }], remote: [], unmapped: [] }; }),
  });
  return { sync, calls, published, handed };
}

test('a server name becomes the prefix its tools carry, and everything but the one tool is denied', () => {
  assert.equal(mcpPrefix('claude.ai Figma'), 'mcp__claude_ai_Figma');
  assert.equal(mcpPrefix('clickup'), 'mcp__clickup');
  assert.deepEqual(denyAllBut(OWN, SEATS['/s/.claude-mr'].tools, SEATS['/s/.claude-mr'].servers),
    ['mcp__github', 'mcp__notion', 'mcp__claude_ai_Figma', 'mcp__clickup__clickup_create_task']);
  assert.deepEqual(denyAllBut('mcp__claude_ai_ClickUp__clickup_filter_tasks', ['mcp__claude_ai_ClickUp__clickup_filter_tasks', 'mcp__claude_ai_ClickUp__clickup_get_task'], ['claude.ai ClickUp', 'claude.ai Canva']),
    ['mcp__claude_ai_Canva', 'mcp__claude_ai_ClickUp__clickup_get_task']);
});

test('a filter_tasks result parses whether its status is a string or ClickUp\'s object', () => {
  assert.deepEqual(toShipTask({ id: 'a1', status: { status: 'complete', color: '#fff' }, name: 'A' }), { id: 'a1', status: 'complete', name: 'A' });
  assert.equal(toShipTask({ id: 'a1' }), undefined);
  assert.deepEqual(parseFilterResult(page([task('a1', 'complete')], true)), { tasks: [{ id: 'a1', status: 'complete', name: 'Task a1', url: 'https://app.clickup.com/t/a1' }], more: true });
  assert.deepEqual(parseFilterResult([{ type: 'text', text: page([task('b2', 'in review')]) }]).tasks.map((t) => t.id), ['b2']);
  assert.equal(parseFilterResult('Structured output provided successfully'), undefined);
});

test('the board syncs on open once the last sync is stale, and notes what moved', () => {
  assert.equal(shipSyncDue(undefined, 1), true);
  assert.equal(shipSyncDue({ at: 1000 }, 1000 + SHIP_SYNC_MAX_AGE), false);
  assert.equal(shipSyncDue({ at: 1000 }, 1001 + SHIP_SYNC_MAX_AGE), true);
  assert.deepEqual(shipSyncNotes({ at: 1, changed: [{ slug: 'login', ticket: 'a1', from: 'In Review', to: 'Closed' }], remote: [], unmapped: [{ slug: 'x', status: 'to do' }] }),
    ['login: In Review → Closed (from ClickUp)', 'x: ClickUp says "to do", which isn\'t a /ship stage; left as is']);
});

test('a sync skips a seat without ClickUp, reads the list with one tool in context, and hands ClickUp\'s own tasks to reconcile', async () => {
  const prior = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const { sync, calls, published, handed } = fixture({ turns: [
      { input: input(), result: page([task('a1', 'complete'), task('b2', 'in review')], true) },
      { input: input({ page: 1 }), result: page([task('c3', 'grilling'), task('a1', 'complete')]) },
      { input: input({ list_ids: ['999'] }), result: page([task('zz', 'to do')]) },
      { text: 'done. a1 is "in review"' },
    ] });
    const s = await sync.sync();
    assert.equal(calls.length, 3, 'probe seat 1, probe seat 2, fetch on seat 2');
    const fetch = calls[2].options;
    assert.equal(fetch.env.CLAUDE_CONFIG_DIR, '/s/.claude-mr');
    assert.equal(fetch.env.ANTHROPIC_API_KEY, undefined, 'the seat\'s login, never an API key');
    assert.equal(fetch.cwd, '/ship-home');
    assert.equal(fetch.model, 'claude-haiku-4-5-20251001');
    assert.deepEqual(fetch.tools, []);
    assert.deepEqual(fetch.allowedTools, [OWN]);
    assert.ok(fetch.disallowedTools.includes('mcp__github') && fetch.disallowedTools.includes('mcp__claude_ai_Figma') && fetch.disallowedTools.includes('mcp__clickup__clickup_create_task'));
    assert.ok(!fetch.disallowedTools.includes('mcp__clickup'), 'its own server stays');
    assert.match(calls[2].prompt, new RegExp(LIST));
    assert.deepEqual(handed[0].tasks.map((t) => `${t.id}:${t.status}`), ['a1:complete', 'b2:in review', 'c3:grilling'], 'both pages, deduped; the other list and the model\'s text don\'t count');
    assert.equal(s.seat, 'mr');
    assert.equal(s.error, undefined);
    assert.deepEqual(s.changed, [{ slug: 'login', ticket: 'a1', from: 'In Review', to: 'Closed' }]);
    assert.deepEqual(published, [s]);
  } finally { if (prior === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prior; }
});

test('callers that ask during a sync share it', async () => {
  const { sync, calls, published } = fixture({ order: ['/s/.claude-mr'], turns: [{ input: input(), result: page([task('a1', 'complete')]) }] });
  const [a, b] = await Promise.all([sync.sync(), sync.sync()]);
  assert.equal(a, b);
  assert.equal(calls.length, 2);
  assert.equal(published.length, 1);
  await sync.sync();
  assert.equal(calls.length, 4, 'a later sync runs again');
});

test('a sync fails plainly when no seat has ClickUp, when ClickUp has pages left, or when reconcile fails', async () => {
  const none = fixture({ order: ['/s/.claude', '/s/.claude-pete'], turns: [] });
  assert.match((await none.sync.sync()).error, /No ClickUp connector on seats default, pete/);
  assert.equal(none.handed.length, 0);

  const partial = fixture({ order: ['/s/.claude-mr'], turns: [{ input: input(), result: page([task('a1', 'complete')], true) }, { text: 'done' }] });
  assert.match((await partial.sync.sync()).error, /before ClickUp's last page/);
  assert.equal(partial.handed.length, 0, 'nothing reconciles from half a list');

  const wrong = fixture({ order: ['/s/.claude-mr'], turns: [{ input: input({ include_closed: false }), result: page([task('a1', 'in review')]) }] });
  assert.match((await wrong.sync.sync()).error, /no task list/, 'a list without closed tasks would miss exactly the ones that closed');

  const broken = fixture({ order: ['/s/.claude-mr'], turns: [{ input: input(), result: page([task('a1', 'complete')]) }], reconcile: async () => { throw new Error('ship: cannot read tasks'); } });
  const s = await broken.sync.sync();
  assert.equal(s.error, 'ship: cannot read tasks');
  assert.deepEqual(broken.published, [s]);
});

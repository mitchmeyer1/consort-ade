import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickupSource, pickStatus } from '../src/cli/sources.ts';
import { Slack } from '../src/cli/slack.ts';

const job = { id: 'j', name: 'demo', source: 'clickup', repo: '/r', base: 'main', listId: '901', filters: {}, everyMinutes: 15, maxParallel: 2, enabled: true, createdAt: 0, statuses: { progress: 'in progress', review: 'in review', done: 'complete' } };

/** a ClickUp with one list of two tasks; records every request */
function fakeClickup(t) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const path = String(url).replace('https://api.clickup.com/api/v2', '');
    calls.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (path.startsWith('/list/901/task')) return json({ tasks: [
      { id: 'a1', name: 'Export roster', status: { status: 'to do' }, tags: [{ name: 'ai-handle' }], assignees: [{ username: 'sam', email: 's@x.io' }], url: 'https://app.clickup.com/t/a1', date_updated: '1700000000000' },
      { id: 'a2', name: 'Fix typo', status: { status: 'to do' }, tags: [], assignees: [], url: 'https://app.clickup.com/t/a2' },
    ], last_page: true });
    if (path === '/task/a1/comment' && !init.method) return json({ comments: [{ comment_text: 'hi', date: '1' }] });
    if (path === '/task/a1/comment' && init.method === 'POST') return json({ id: 'c77' });
    if (path === '/comment/c77' && init.method === 'DELETE') return json({});
    if (path === '/task/a1') return init.method === 'PUT' ? json({}) : json({ id: 'a1', list: { id: '901' } });
    if (path === '/list/901') return json({ statuses: [{ status: 'TO DO' }, { status: 'IN PROGRESS' }, { status: 'IN REVIEW' }, { status: 'COMPLETE' }] });
    return new Response('nope', { status: 404 });
  });
  return calls;
}

test("the list's own status spelling is used, with synonyms when the configured name is not on the list", () => {
  const list = ['TO DO', 'Doing', 'Code Review', 'Done'];
  assert.equal(pickStatus(list, 'in progress', 'progress'), 'Doing');
  assert.equal(pickStatus(list, 'in review', 'review'), 'Code Review');
  assert.equal(pickStatus(list, 'complete', 'done'), 'Done');
  assert.equal(pickStatus(list, 'to do', 'progress'), 'TO DO', 'an exact match wins');
  assert.equal(pickStatus(['Open', 'Closed'], 'in review', 'review'), undefined);
});

test('a ClickUp job scans its list into tickets; a claim is a marker comment that can be taken back, and the status moves separately', async (t) => {
  const calls = fakeClickup(t);
  const src = clickupSource('k', job);
  const tickets = await src.scan();
  assert.deepEqual(tickets.map((x) => [x.id, x.title, x.status, x.tags, x.assignees]), [['a1', 'Export roster', 'to do', ['ai-handle'], ['sam', 's@x.io']], ['a2', 'Fix typo', 'to do', [], []]]);
  assert.equal(tickets[0].updatedAt, 1700000000000);
  assert.deepEqual(await src.comments('a1'), [{ text: 'hi', at: 1 }]);
  const handle = await src.claim('a1', 'box-a', Date.UTC(2026, 9, 20));
  const posted = calls.find((c) => c.path === '/task/a1/comment' && c.method === 'POST');
  assert.match(posted.body.comment_text, /^\[consort-claim host=box-a at=2026-10-20T00:00:00\.000Z\]/);
  assert.equal(handle, 'c77');
  assert.equal(calls.some((c) => c.method === 'PUT'), false, 'claiming alone does not move the status');
  await src.unclaim('a1', handle);
  assert.ok(calls.some((c) => c.path === '/comment/c77' && c.method === 'DELETE'), 'a lost claim is deleted');
  await src.setStatus('a1', 'progress');
  const put = calls.find((c) => c.path === '/task/a1' && c.method === 'PUT');
  assert.deepEqual(put.body, { status: 'IN PROGRESS' });
});

test('Slack: a DM is opened once, messages go to the thread, and the wait resolves on the owner\'s reply', async (t) => {
  const calls = [];
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const method = String(url).split('/api/')[1];
    assert.match(init.headers['Content-Type'], /x-www-form-urlencoded/, 'Slack read methods reject JSON bodies');
    const body = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, body, auth: init.headers.Authorization });
    const json = (o) => new Response(JSON.stringify({ ok: true, ...o }), { status: 200 });
    if (method === 'conversations.open') return json({ channel: { id: 'D123' } });
    if (method === 'chat.postMessage') return json({ ts: `${1000 + calls.length}.0` });
    if (method === 'conversations.replies') { polls++; return json({ messages: polls < 2 ? [] : [{ ts: '2000.0', user: 'UOWNER', text: 'include archived' }] }); }
    return json({});
  });
  const slack = new Slack({ botToken: 'xoxb-1', userId: 'UOWNER' });
  const root = await slack.post('Picked up a ticket');
  const q = await slack.post('question?', root);
  assert.equal(calls.filter((c) => c.method === 'conversations.open').length, 1);
  assert.equal(calls[0].auth, 'Bearer xoxb-1');
  assert.equal(calls.find((c) => c.method === 'chat.postMessage' && c.body.thread_ts).body.thread_ts, root);
  const reply = await slack.waitForReply(root, q, { pollMs: 1 });
  assert.equal(reply, 'include archived');
  assert.ok(polls >= 2);
});

test('a space scanner lists the space\'s lists for the wizard, but scans with one workspace-wide search filtered to the space and tag', async (t) => {
  const { clickupLists, clickupTeamFor } = await import('../src/cli/sources.ts');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = decodeURIComponent(String(url).replace('https://api.clickup.com/api/v2', ''));
    calls.push(path);
    const json = (o) => new Response(JSON.stringify(o), { status: 200 });
    if (path === '/space/9/list?archived=false') return json({ lists: [{ id: 'L1', name: 'Loose' }] });
    if (path === '/space/9/folder?archived=false') return json({ folders: [{ id: 'F1', name: 'Sprint', lists: [{ id: 'L2', name: 'Backend' }, { id: 'L3', name: 'Frontend' }] }] });
    if (path === '/team') return json({ teams: [{ id: '77', name: 'Acme' }, { id: '78', name: 'Other' }] });
    if (path === '/team/77/space?archived=false') return json({ spaces: [{ id: '9' }] });
    if (path.startsWith('/team/77/task?') && path.includes('page=0')) return json({ tasks: [{ id: 'a', name: 'One', status: { status: 'to do' }, tags: [{ name: 'ai-handle' }], assignees: [] }, { id: 'b', name: 'Two', status: { status: 'to do' }, tags: [{ name: 'ai-handle' }], assignees: [] }], last_page: false });
    if (path.startsWith('/team/77/task?') && path.includes('page=1')) return json({ tasks: [{ id: 'a', name: 'One', status: { status: 'to do' }, tags: [], assignees: [] }], last_page: true });
    return new Response('nope', { status: 404 });
  });
  assert.deepEqual((await clickupLists('k', { kind: 'space', id: '9' })).map((l) => l.id), ['L1', 'L2', 'L3']);
  assert.equal(await clickupTeamFor('k', { kind: 'space', id: '9' }), '77', 'the workspace is found among the token\'s when the URL did not carry it');
  const src = clickupSource('k', { ...job, listId: undefined, scope: { kind: 'space', id: '9', teamId: '77' }, filters: { tags: ['AI-Handle'] } });
  const tickets = await src.scan();
  assert.deepEqual(tickets.map((x) => x.id), ['a', 'b'], 'two pages, one task repeated, counted once');
  const search = calls.find((p) => p.startsWith('/team/77/task?'));
  assert.ok(search.includes('space_ids[]=9') && search.includes('tags[]=ai-handle') && search.includes('subtasks=true'), search);
  assert.ok(!calls.some((p) => p.startsWith('/list/')), 'no per-list reads');
});

test('a ClickUp 429 is retried once after the window', async (t) => {
  let n = 0;
  t.mock.method(globalThis, 'fetch', async () => (++n === 1 ? new Response('{"err":"Rate limit reached"}', { status: 429, headers: { 'retry-after': '0' } }) : new Response(JSON.stringify({ teams: [{ id: '1' }] }), { status: 200 })));
  const { clickupTeamFor } = await import('../src/cli/sources.ts');
  assert.equal(await clickupTeamFor('k', { kind: 'space', id: '9' }), '1');
  assert.equal(n, 2);
});

test('a Slack call with no fields sends no body at all; Slack hangs on an empty one', async (t) => {
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { bodies.push([String(url).split('/api/')[1], init.body]); return new Response(JSON.stringify({ ok: true, user: 'bot', team: 'T', channel: { id: 'D1' } }), { status: 200 }); });
  const slack = new Slack({ botToken: 'xoxb-1', userId: 'U1' });
  await slack.test(); await slack.channel();
  assert.deepEqual(bodies, [['auth.test', undefined], ['conversations.open', 'users=U1']]);
});

test('a ClickUp owner update replaces the description with Markdown', async (t) => {
  const calls = fakeClickup(t);
  await clickupSource('k', job).updateBody('a1', '## Goal\n- Export CSV');
  assert.deepEqual(calls.at(-1), { path: '/task/a1', method: 'PUT', body: { markdown_content: '## Goal\n- Export CSV' } });
});

test('Slack: posts and card edits leave with names, emails, phones and addresses masked', async (t) => {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    sent.push({ method: String(url).split('/api/')[1], body: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify({ ok: true, ts: '1.0' }), { status: 200 });
  });
  const slack = new Slack({ botToken: 'xoxb-1', userId: 'U1', channel: 'C1' });
  await slack.post('Patient Mary Jones (mary@x.org, 555-123-4567) at 12 Elm St asked <@U1>');
  await slack.update('1.0', 'card for John Smith');
  assert.match(sent[0].body.text, /^✅ Patient \*\*\*\* \(\*\*\*\*, \*\*\*\*\) at \*\*\*\* asked <@U1>/);
  assert.equal(sent[1].body.text, 'card for ****');
});

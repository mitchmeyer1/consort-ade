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
    if (path === '/task/a1/comment' && init.method === 'POST') return json({});
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

test('a ClickUp job scans its list into tickets, and claiming writes the marker comment then moves the status', async (t) => {
  const calls = fakeClickup(t);
  const src = clickupSource('k', job);
  const tickets = await src.scan();
  assert.deepEqual(tickets.map((x) => [x.id, x.title, x.status, x.tags, x.assignees]), [['a1', 'Export roster', 'to do', ['ai-handle'], ['sam', 's@x.io']], ['a2', 'Fix typo', 'to do', [], []]]);
  assert.equal(tickets[0].updatedAt, 1700000000000);
  assert.deepEqual(await src.comments('a1'), [{ text: 'hi', at: 1 }]);
  await src.claim('a1', 'box-a', Date.UTC(2026, 9, 20));
  const posted = calls.find((c) => c.path === '/task/a1/comment' && c.method === 'POST');
  assert.match(posted.body.comment_text, /^\[consort-claim host=box-a at=2026-10-20T00:00:00\.000Z\]/);
  const put = calls.find((c) => c.path === '/task/a1' && c.method === 'PUT');
  assert.deepEqual(put.body, { status: 'IN PROGRESS' });
});

test('Slack: a DM is opened once, messages go to the thread, and the wait resolves on the owner\'s reply', async (t) => {
  const calls = [];
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const method = String(url).split('/api/')[1];
    const body = JSON.parse(init.body);
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

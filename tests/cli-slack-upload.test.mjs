import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Slack } from '../src/cli/slack.ts';

test('a file goes up privately, then into the thread with its gated comment', async () => {
  const calls = [];
  const slack = new Slack({ botToken: 'upload-test', channel: 'C1', userId: 'owner' }, async (url, init) => {
    if (String(url) === 'https://upload.example/1') { calls.push({ method: 'transfer', bytes: init.body.length, type: init.headers['Content-Type'] }); return new Response('ok'); }
    const method = String(url).split('/').at(-1), body = Object.fromEntries(new URLSearchParams(init.body)); calls.push({ method, body });
    if (method === 'files.getUploadURLExternal') return Response.json({ ok: true, file_id: 'F9', upload_url: 'https://upload.example/1' });
    return Response.json({ ok: true });
  }, s => s.replaceAll('SECRET', 'MASKED'));
  const id = await slack.uploadFile({ filename: 'pr-9.html', title: 'What PR 9 does', content: '<html>é</html>', thread: '12.34', comment: 'Read SECRET first' });
  assert.equal(id, 'F9');
  assert.deepEqual(calls.map(c => c.method), ['files.getUploadURLExternal', 'transfer', 'files.completeUploadExternal']);
  assert.equal(calls[0].body.filename, 'pr-9.html'); assert.equal(calls[0].body.length, String(Buffer.byteLength('<html>é</html>')));
  assert.equal(calls[1].bytes, Buffer.byteLength('<html>é</html>')); assert.equal(calls[1].type, 'application/octet-stream');
  const done = calls[2].body;
  assert.deepEqual(JSON.parse(done.files), [{ id: 'F9', title: 'What PR 9 does' }]);
  assert.equal(done.channel_id, 'C1'); assert.equal(done.thread_ts, '12.34'); assert.equal(done.initial_comment, 'Read MASKED first');
});

test('a failed transfer or a missing upload URL is an error, and nothing is shared', async () => {
  const calls = [];
  const slack = new Slack({ botToken: 't', channel: 'C1', userId: 'o' }, async (url) => {
    const method = String(url).split('/').at(-1); calls.push(method);
    if (method === 'files.getUploadURLExternal') return Response.json({ ok: true, file_id: 'F1', upload_url: 'https://upload.example/x' });
    if (String(url).startsWith('https://upload.example/')) return new Response('nope', { status: 500 });
    return Response.json({ ok: true });
  }, s => s);
  await assert.rejects(slack.uploadFile({ filename: 'a.html', title: 'a', content: 'x' }), /Slack file transfer: HTTP 500/);
  assert.ok(!calls.includes('files.completeUploadExternal'));
  const none = new Slack({ botToken: 't', channel: 'C1', userId: 'o' }, async () => Response.json({ ok: true }), s => s);
  await assert.rejects(none.uploadFile({ filename: 'a.html', title: 'a', content: 'x' }), /upload URL unavailable/);
});

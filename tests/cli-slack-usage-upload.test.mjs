import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Slack } from '../src/cli/slack.ts';
const text = `*📊 Consort master monitor*
Updated 2026-10-27 16:45 UTC

*Working*
🔄 Feature · <https://slack.example/t|Task one> · author: @mitch · RUNNING · Build 3/9 · $1 · 1m
   Working away
   <https://github.com/a/b/pull/1|github>

*Ready to merge · your action*
No tickets waiting to be merged.

*Completed · most recent 6*
No completed tasks yet.

*Accounts*
🟢 Claude 1 · available · 5-hour 42% · Weekly 20% · usage 3m ago

STATUS: MONITORING`;
function fake(opts = {}) {
  const calls = []; let n = 0;
  const slack = new Slack({ botToken: `tok-${Math.random()}`, channel: 'C1', userId: 'owner' }, async (url, init) => {
    if (String(url).startsWith('https://upload.example/')) { calls.push({ method: 'transfer', bytes: init.body.length }); return new Response('ok'); }
    const method = String(url).split('/').at(-1), body = Object.fromEntries(new URLSearchParams(init.body)); calls.push({ method, body });
    if (method === 'files.getUploadURLExternal') return opts.noScope ? Response.json({ ok: false, error: 'missing_scope' }) : Response.json({ ok: true, file_id: `F${++n}`, upload_url: `https://upload.example/${n}` });
    if (method === 'chat.update' || method === 'chat.postMessage') {
      const blocks = JSON.parse(body.blocks), withImage = JSON.stringify(blocks).includes('slack_file');
      const edits = calls.filter(c => c.method === method).length;
      if (withImage && opts.processing && edits <= opts.processing) return Response.json({ ok: false, error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] invalid slack file [json-pointer:/blocks/4/child_blocks/0/slack_file]'] } });
      if (withImage && opts.rejectImage) return Response.json({ ok: false, error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] no'] } });
    }
    return Response.json({ ok: true, ts: 'same' });
  }, s => s, async ms => { (opts.delays ??= []).push(ms); });
  return { slack, calls, opts };
}
const sent = calls => calls.filter(c => c.method === 'chat.update').map(c => JSON.parse(c.body.blocks));

test('the panel is uploaded once per picture, shown as slack_file full width, reused while unchanged, and old files retire a generation late', async () => {
  const { slack, calls, opts } = fake();
  slack.setUsageFile({ file: 'OLD', key: 'old-key', stale: 'OLDER' });
  await slack.updateMonitor('same', text);
  assert.deepEqual(calls.map(c => c.method), ['files.getUploadURLExternal', 'transfer', 'files.completeUploadExternal', 'chat.update', 'files.delete']);
  assert.deepEqual(opts.delays, [1500], 'the upload settles before the edit');
  assert.equal(calls[0].body.filename, 'consort-usage.png'); assert.ok(calls[1].bytes > 1000);
  assert.deepEqual(JSON.parse(calls[2].body.files), [{ id: 'F1', title: 'AI usage' }]); assert.equal(calls[2].body.channel_id, undefined);
  const blocks = sent(calls)[0];
  const panel = blocks.find(b => b.type === 'container' && b.child_blocks?.[0]?.slack_file);
  assert.deepEqual(panel.child_blocks[0], { type: 'image', slack_file: { id: 'F1' }, alt_text: 'AI usage: Claude 1 5h 42%, wk 20%' });
  assert.ok(!blocks.some(b => b.type === 'data_visualization'));
  assert.equal(calls[4].body.file, 'OLDER', 'the file two generations back is deleted; the one just replaced waits');
  const saved = slack.getUsageFile(); assert.equal(saved.file, 'F1'); assert.equal(saved.stale, 'OLD'); assert.equal(typeof saved.key, 'string');
  await slack.updateMonitor('same', text.replace('Updated 2026-10-27 16:45', 'Updated 2026-10-27 16:46'));
  assert.deepEqual(calls.slice(5).map(c => c.method), ['chat.update'], 'same numbers a minute later: no upload, no delete');
  assert.ok(JSON.stringify(sent(calls)[1]).includes('"id":"F1"')); assert.deepEqual(slack.getUsageFile(), saved);
  await slack.updateMonitor('same', text.replace('42%', '43%'));
  assert.deepEqual(calls.slice(6).map(c => c.method), ['files.getUploadURLExternal', 'transfer', 'files.completeUploadExternal', 'chat.update', 'files.delete']);
  assert.equal(calls.at(-1).body.file, 'OLD'); assert.deepEqual([slack.getUsageFile().file, slack.getUsageFile().stale], ['F2', 'F1']);
});

test('an image Slack has not finished processing is retried on the same layout with growing waits', async () => {
  const { slack, calls, opts } = fake({ processing: 2 });
  await slack.updateMonitor('same', text);
  const edits = calls.filter(c => c.method === 'chat.update');
  assert.equal(edits.length, 3); assert.deepEqual(opts.delays, [1500, 250, 750]);
  assert.equal(edits[0].body.blocks, edits[2].body.blocks); assert.equal(calls.filter(c => c.method === 'files.getUploadURLExternal').length, 1, 'one upload');
});

test('when Slack rejects the image layout the chart layout goes out and the unshown upload is deleted', async () => {
  const { slack, calls } = fake({ rejectImage: true });
  await slack.updateMonitor('same', text);
  const layouts = sent(calls);
  assert.equal(layouts.length, 2); assert.ok(JSON.stringify(layouts[0]).includes('slack_file')); assert.ok(layouts[1].some(b => b.type === 'data_visualization'));
  assert.deepEqual(calls.filter(c => c.method === 'files.delete').map(c => c.body.file), ['F1']); assert.deepEqual(slack.getUsageFile(), {});
});

test('without files:write the chart layout is used and the upload is not tried again', async () => {
  const { slack, calls } = fake({ noScope: true });
  await slack.updateMonitor('same', text); await slack.updateMonitor('same', text.replace('42%', '44%'));
  assert.equal(calls.filter(c => c.method === 'files.getUploadURLExternal').length, 1);
  assert.ok(sent(calls).every(blocks => blocks.some(b => b.type === 'data_visualization') && !JSON.stringify(blocks).includes('slack_file')));
});

test('a monitor without accounts uploads nothing; a non-monitor text stays plain sections', async () => {
  const { slack, calls } = fake();
  await slack.updateMonitor('same', text.replace(/\n\*Accounts\*\n[^\n]+\n/, '\n*Accounts*\nNo accounts configured.\n'));
  await slack.postMonitor('*📊 Consort master monitor*\nUpdated monitor');
  assert.ok(!calls.some(c => /^files\./.test(c.method)));
  assert.ok(JSON.parse(calls.find(c => c.method === 'chat.postMessage').body.blocks).every(b => b.type === 'section'));
});

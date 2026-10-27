import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Slack } from '../src/cli/slack.ts';
import { headGraphic, headSvg } from '../src/cli/slackHeadGraphic.ts';
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
const headKey = t => createHash('sha256').update(headGraphic(t).svg).digest('hex');
function fake(opts = {}) {
  const calls = []; let n = 0;
  const slack = new Slack({ botToken: `tok-${Math.random()}`, channel: 'C1', userId: 'owner' }, async (url, init) => {
    if (String(url).startsWith('https://upload.example/')) { calls.push({ method: 'transfer', bytes: init.body.length }); return new Response('ok'); }
    const method = String(url).split('/').at(-1), body = Object.fromEntries(new URLSearchParams(init.body));
    // The Home tab copy is checked on its own; the upload tests count only the post's calls.
    if (method === 'views.publish') { const view = JSON.parse(body.view); (opts.home ??= []).push(view); const no = opts.homeError?.(view); return Response.json(no ? { ok: false, error: no } : { ok: true }); }
    calls.push({ method, body });
    if (method === 'files.getUploadURLExternal') return opts.noScope ? Response.json({ ok: false, error: 'missing_scope' }) : Response.json({ ok: true, file_id: `F${++n}`, upload_url: `https://upload.example/${n}` });
    if (method === 'chat.update' || method === 'chat.postMessage') {
      const blocks = JSON.parse(body.blocks), withImage = JSON.stringify(blocks).includes('slack_file');
      const edits = calls.filter(c => c.method === method).length;
      if (withImage && opts.processing && edits <= opts.processing) return Response.json({ ok: false, error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] invalid slack file [json-pointer:/blocks/4/child_blocks/0/slack_file]'] } });
      if (withImage && opts.rejectImage) return Response.json({ ok: false, error: 'invalid_blocks', response_metadata: { messages: ['[ERROR] no'] } });
    }
    return Response.json({ ok: true, ts: 'same' });
  }, s => s, async ms => { (opts.delays ??= []).push(ms); });
  // The header is already shown unless a test asks for a fresh one, so the usage tests see only the panel's calls.
  if (!opts.freshHead) slack.setHeadFile({ file: 'HEAD', key: headKey(text) });
  return { slack, calls, opts };
}
const sent = calls => calls.filter(c => c.method === 'chat.update').map(c => JSON.parse(c.body.blocks));

test('the panel is uploaded once per picture, shown as a slack_file image, reused while unchanged, and old files retire a generation late', async () => {
  const { slack, calls, opts } = fake();
  slack.setUsageFile({ file: 'OLD', key: 'old-key', stale: 'OLDER' });
  await slack.updateMonitor('same', text);
  assert.deepEqual(calls.map(c => c.method), ['files.getUploadURLExternal', 'transfer', 'files.completeUploadExternal', 'chat.update', 'files.delete']);
  assert.deepEqual(opts.delays, [1500], 'the upload settles before the edit');
  assert.equal(calls[0].body.filename, 'consort-usage.png'); assert.ok(calls[1].bytes > 1000);
  assert.deepEqual(JSON.parse(calls[2].body.files), [{ id: 'F1', title: 'AI usage' }]); assert.equal(calls[2].body.channel_id, undefined);
  const blocks = sent(calls)[0];
  const panel = blocks.find(b => b.type === 'image' && b.block_id.startsWith('usage-'));
  assert.deepEqual({ ...panel, block_id: undefined }, { type: 'image', block_id: undefined, slack_file: { id: 'F1' }, alt_text: 'AI usage: Claude 1 5h 42%, wk 20%' });
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

test('the header shows a count for every open group, zeros included, and uploads again only when a count changes', async () => {
  const { slack, calls } = fake({ freshHead: true });
  slack.setUsageFile({ file: 'USAGE', key: 'stale-key' });
  await slack.updateMonitor('same', text);
  const uploads = calls.filter(c => c.method === 'files.getUploadURLExternal').map(c => c.body.filename);
  assert.deepEqual(uploads, ['consort-usage.png', 'consort-head.png']);
  const head = sent(calls)[0][0];
  assert.deepEqual({ ...head, block_id: undefined }, { type: 'image', block_id: undefined, slack_file: { id: 'F2' }, alt_text: 'Consort: 0 reply, 0 nudge, 0 ready, 1 working' });
  assert.equal(slack.getHeadFile().file, 'F2');
  const before = calls.length;
  await slack.updateMonitor('same', text.replace('42%', '45%'));
  assert.deepEqual(calls.slice(before).filter(c => c.method === 'files.getUploadURLExternal').map(c => c.body.filename), ['consort-usage.png'], 'same counts: the header is reused');
  const svg = headSvg({ reply: 0, nudge: 2, ready: 0, working: 1 });
  for (const label of ['REPLY', 'NUDGE', 'READY', 'WORKING']) assert.ok(svg.includes(`>${label}<`), label);
  assert.equal((svg.match(/>0</g) ?? []).length, 2, 'zeros are drawn'); assert.match(svg, /<image [^>]*href="data:image\/png;base64,/);
});

test('every accepted post is copied to the owner Home tab with the same blocks', async () => {
  const { slack, calls, opts } = fake();
  await slack.updateMonitor('same', text);
  assert.equal(opts.home.length, 1); assert.equal(opts.home[0].type, 'home');
  assert.deepEqual(opts.home[0].blocks, sent(calls)[0]);
});

test('a Home tab failure never fails the post; rejected blocks fall back to the next layout', async () => {
  const rejectCards = fake({ homeError: v => JSON.stringify(v.blocks).includes('slack_file') ? 'invalid_blocks' : undefined });
  await rejectCards.slack.updateMonitor('same', text);
  assert.equal(rejectCards.opts.home.length, 2); assert.ok(!JSON.stringify(rejectCards.opts.home[1].blocks).includes('slack_file'));
  const disabled = fake({ homeError: () => 'not_enabled' });
  await disabled.slack.updateMonitor('same', text);
  assert.equal(disabled.opts.home.length, 1, 'a non-block error is not retried'); assert.equal(sent(disabled.calls).length, 1);
});

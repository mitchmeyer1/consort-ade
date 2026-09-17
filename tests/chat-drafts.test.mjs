import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatDraftCache } from '../src/shared/chatDrafts.ts';

test('draft text and attachments survive unsubscribe/remount and remain isolated by chat', () => {
  const cache = new ChatDraftCache();
  const unsubscribe = cache.subscribe(() => {});
  cache.update('a', { text: 'unfinished prompt', files: ['/tmp/attachment.png'] });
  unsubscribe();
  cache.update('b', { text: 'another prompt' });
  const remount = cache.subscribe(() => {});
  assert.deepEqual(cache.get('a'), { text: 'unfinished prompt', files: ['/tmp/attachment.png'] });
  assert.deepEqual(cache.get('b'), { text: 'another prompt', files: [] });
  cache.update('a', { files: [] });
  assert.equal(cache.get('a').text, 'unfinished prompt');
  remount();
});
test('successful send clears only the submitted chat; rejected sends preserve its draft', async () => {
  const cache = new ChatDraftCache();
  cache.update('a', { text: 'send me', files: ['/tmp/file.txt'] });
  cache.update('b', { text: 'keep me' });
  await assert.rejects(cache.submit('a', async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(cache.get('a'), { text: 'send me', files: ['/tmp/file.txt'] });
  await cache.submit('a', async draft => assert.deepEqual(draft, { text: 'send me', files: ['/tmp/file.txt'] }));
  assert.deepEqual(cache.get('a'), { text: '', files: [] });
  assert.equal(cache.get('b').text, 'keep me');
});
test('edits made while sending survive acknowledgement, and duplicate submissions are suppressed', async () => {
  const cache = new ChatDraftCache();
  cache.update('a', { text: 'first' });
  let finish;
  const sending = cache.submit('a', () => new Promise(resolve => { finish = resolve; }));
  cache.update('a', { text: 'next', files: ['/tmp/new.txt'] });
  await cache.submit('a', async () => assert.fail('duplicate submission'));
  finish();
  await sending;
  assert.deepEqual(cache.get('a'), { text: 'next', files: ['/tmp/new.txt'] });
});
test('attachment-only drafts can be submitted', async () => {
  const cache = new ChatDraftCache();
  cache.update('a', { files: ['/tmp/image.png'] });
  let called = false;
  await cache.submit('a', async draft => { called = true; assert.deepEqual(draft.files, ['/tmp/image.png']); });
  assert.ok(called);
  assert.deepEqual(cache.get('a'), { text: '', files: [] });
});

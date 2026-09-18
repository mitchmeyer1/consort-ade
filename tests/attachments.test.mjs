import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentName, isImageAttachment } from '../src/shared/attachments.ts';

test('images are recognised by extension, whatever the case', () => {
  for (const p of ['/tmp/a/Shot.PNG', '/tmp/photo.jpeg', 'diagram.svg', '/x/y/z.webp']) assert.equal(isImageAttachment(p), true, p);
  for (const p of ['/tmp/notes.md', '/tmp/archive.zip', 'png', '/tmp/.png', '/tmp/image.png.txt']) assert.equal(isImageAttachment(p), false, p);
});

test('the name is the last path segment', () => {
  assert.equal(attachmentName('/a/b/c/Screenshot 1.png'), 'Screenshot 1.png');
  assert.equal(attachmentName('bare.png'), 'bare.png');
});

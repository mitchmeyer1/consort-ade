import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrollMemory, canRestore, scrollKey } from '../src/shared/scrollMemory.ts';

test('offsets are kept per key and a return to the top forgets the entry', () => {
  const m = new ScrollMemory();
  m.set('chat:a|markdown|README.md', 640);
  m.set('chat:b|markdown|README.md', 120);
  assert.equal(m.get('chat:a|markdown|README.md'), 640, 'the same file in another chat keeps its own place');
  assert.equal(m.get('chat:b|markdown|README.md'), 120);
  assert.equal(m.get('chat:c|markdown|README.md'), undefined);
  m.set('chat:a|markdown|README.md', 0);
  assert.equal(m.get('chat:a|markdown|README.md'), undefined);
  assert.equal(m.size, 1);
});

test('forget clears a view and everything under it, but not a view that merely shares a prefix', () => {
  const m = new ScrollMemory();
  m.set('chat:a|markdown|x.md', 10);
  m.set('chat:a|code|y.ts', 20);
  m.set('chat:ab|markdown|x.md', 30);
  m.forget('chat:a');
  assert.equal(m.get('chat:a|markdown|x.md'), undefined);
  assert.equal(m.get('chat:a|code|y.ts'), undefined);
  assert.equal(m.get('chat:ab|markdown|x.md'), 30);
});

test('a remembered offset waits until the content is tall enough, with a pixel of slack', () => {
  // 640px down needs at least 640px of overflow: content still loading is shorter and must wait
  assert.equal(canRestore(640, 500, 400), false);
  assert.equal(canRestore(640, 1040, 400), true);
  assert.equal(canRestore(640, 1039.5, 400), true, 'fractional layout rounding is tolerated');
  assert.equal(canRestore(640, 1000, 400), false);
  assert.equal(canRestore(0, 100, 400), true, 'the top is always reachable');
});

test('keys join view, tab and file, with a missing file leaving an empty slot', () => {
  assert.equal(scrollKey('chat:a', 'markdown', 'docs/x.md'), 'chat:a|markdown|docs/x.md');
  assert.equal(scrollKey('chat:a', 'diff', undefined), 'chat:a|diff|');
  assert.notEqual(scrollKey('chat:a', 'markdown', 'x.md'), scrollKey('chat:a', 'code', 'x.md'), 'viewing and editing the same file are different places');
});

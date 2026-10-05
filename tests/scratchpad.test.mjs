import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activateScratchTab, activeScratchTab, addScratchTab, emptyScratchpad, nextScratchTitle, normalizeScratchpad, removeScratchTab, renameScratchTab, SCRATCH_TEXT_MAX, setScratchText } from '../src/shared/scratchpad.ts';

test('tabs are added with the next free "Note N" title and become active; the first removed makes its neighbour active', () => {
  let pad = addScratchTab(emptyScratchpad(), 'a', 1);
  pad = addScratchTab(pad, 'b', 2);
  pad = addScratchTab(pad, 'c', 3);
  assert.deepEqual(pad.tabs.map((t) => t.title), ['Note 1', 'Note 2', 'Note 3']);
  assert.equal(pad.activeId, 'c');
  pad = renameScratchTab(pad, 'b', '  groceries  ');
  assert.equal(pad.tabs[1].title, 'groceries');
  assert.equal(nextScratchTitle(pad), 'Note 2', 'the freed default name is reused');
  pad = activateScratchTab(pad, 'b');
  pad = removeScratchTab(pad, 'b');
  assert.deepEqual(pad.tabs.map((t) => t.id), ['a', 'c']);
  assert.equal(pad.activeId, 'c', 'the tab that moved into the slot');
  pad = removeScratchTab(pad, 'c');
  assert.equal(pad.activeId, 'a', 'the last one when the removed tab was last');
  assert.deepEqual(removeScratchTab(pad, 'a'), { tabs: [] });
  assert.equal(removeScratchTab(pad, 'zzz'), pad);
  assert.equal(activateScratchTab(pad, 'zzz'), pad);
});

test('text is kept per tab and capped; renaming to blank keeps the old name', () => {
  let pad = addScratchTab(addScratchTab(emptyScratchpad(), 'a', 1), 'b', 2);
  pad = setScratchText(pad, 'a', 'hello', 10);
  assert.equal(pad.tabs[0].text, 'hello');
  assert.equal(pad.tabs[0].at, 10);
  assert.equal(pad.tabs[1].text, '');
  assert.equal(setScratchText(pad, 'a', 'x'.repeat(SCRATCH_TEXT_MAX + 5), 11).tabs[0].text.length, SCRATCH_TEXT_MAX);
  assert.equal(renameScratchTab(pad, 'a', '   ').tabs[0].title, 'Note 1');
  assert.equal(activeScratchTab(pad)?.id, 'b');
});

test('what was saved is read back leniently: bad rows dropped, duplicate ids dropped, the active tab must exist', () => {
  assert.deepEqual(normalizeScratchpad(undefined), { tabs: [] });
  assert.deepEqual(normalizeScratchpad({ tabs: 'nope', activeId: 'x' }), { tabs: [] });
  const pad = normalizeScratchpad({ tabs: [
    { id: 'a', title: 'first', text: 'one', at: 1 },
    { id: 'a', title: 'dup', text: '', at: 2 },
    { id: 'b', title: '', text: 42, at: 'soon' },
    { title: 'no id' },
    null,
  ], activeId: 'gone' });
  assert.deepEqual(pad, { tabs: [{ id: 'a', title: 'first', text: 'one', at: 1 }, { id: 'b', title: 'Note 2', text: '', at: 0 }], activeId: 'a' });
  const full = addScratchTab(addScratchTab(emptyScratchpad(), 'a', 1), 'b', 2);
  assert.deepEqual(normalizeScratchpad(JSON.parse(JSON.stringify(full))), full, 'a round trip is exact');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, editNote, emptyNotes, noteSummary, NOTES_FILE, parseNotes, pinNote, pinnedNote, removeNote, serializeNotes } from '../src/shared/notes.ts';

test('notes live in the worktree under .consort, outside git', () => {
  assert.equal(NOTES_FILE, '.consort/notes.json');
});

test('a malformed or missing file reads as no notes; a good one keeps its bullets in order with at most one pin', () => {
  assert.deepEqual(parseNotes(undefined), emptyNotes());
  assert.deepEqual(parseNotes('{not json'), emptyNotes());
  assert.deepEqual(parseNotes({ notes: 'nope' }), emptyNotes());
  const doc = parseNotes(JSON.stringify({ version: 1, notes: [
    { id: 'a', text: '  first  ', at: 1 },
    { id: 'b', text: 'second', at: 2, pinned: true },
    { id: 'c', text: 'third', at: 3, pinned: true },
    { id: 'b', text: 'dup id dropped', at: 4 },
    { id: 'd', text: '   ', at: 5 },
    { text: 'no id', at: 6 },
  ] }));
  assert.deepEqual(doc.notes.map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(doc.notes[0].text, 'first');
  assert.equal(pinnedNote(doc)?.id, 'b', 'only the first pin survives');
  assert.equal(doc.notes[2].pinned, undefined);
});

test('add, edit, remove: blank text adds nothing and editing to blank removes', () => {
  let doc = addNote(emptyNotes(), 'a', 'ship the thing', 10);
  doc = addNote(doc, 'b', '   ', 11);
  assert.deepEqual(doc.notes, [{ id: 'a', text: 'ship the thing', at: 10 }]);
  doc = editNote(doc, 'a', 'ship the other thing');
  assert.equal(doc.notes[0].text, 'ship the other thing');
  doc = addNote(doc, 'b', 'two', 12);
  doc = editNote(doc, 'b', '');
  assert.deepEqual(doc.notes.map((n) => n.id), ['a']);
  assert.deepEqual(removeNote(doc, 'a').notes, []);
});

test('one pin at a time: pinning moves it, pinning the pinned note unpins', () => {
  let doc = addNote(addNote(emptyNotes(), 'a', 'A', 1), 'b', 'B', 2);
  doc = pinNote(doc, 'a');
  assert.equal(pinnedNote(doc)?.id, 'a');
  doc = pinNote(doc, 'b');
  assert.equal(pinnedNote(doc)?.id, 'b');
  assert.equal(doc.notes[0].pinned, undefined);
  doc = pinNote(doc, 'b');
  assert.equal(pinnedNote(doc), undefined);
});

test('the file round-trips and the sidebar summary is the first line, shortened', () => {
  const doc = pinNote(addNote(emptyNotes(), 'a', 'line one\nline two', 1), 'a');
  assert.deepEqual(parseNotes(serializeNotes(doc)), doc);
  assert.ok(serializeNotes(doc).endsWith('\n'));
  assert.equal(noteSummary('line one\nline two'), 'line one');
  assert.equal(noteSummary('x'.repeat(200), 20), `${'x'.repeat(19)}…`);
});

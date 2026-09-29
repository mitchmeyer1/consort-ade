import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSlashCommand, shipIdeaName, withAttachments } from '../src/shared/ship.ts';

test('a new-feature chat is named from the first six words of the idea', () => {
  assert.equal(shipIdeaName('Consort: /ship new dialog, slash menu, quiet tool rows'), 'Consort: /ship new dialog, slash menu,…');
  assert.equal(shipIdeaName('  two   words \n here '), 'two words here');
  assert.equal(shipIdeaName(''), '');
});

test('a slash command is recognised only at the start, and attachments ride along as arguments', () => {
  assert.equal(isSlashCommand('/ship new idea'), true);
  assert.equal(isSlashCommand('/clear'), true);
  assert.equal(isSlashCommand('not /ship'), false);
  assert.equal(isSlashCommand('/ 1'), false);
  assert.equal(withAttachments('/ship new x', []), '/ship new x');
  assert.match(withAttachments('/ship new x', ['/a.png']), /Attached files \(read them from disk\):\n- \/a\.png/);
});

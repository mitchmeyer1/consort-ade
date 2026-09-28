import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ship from '../src/shared/ship.ts';
const { isSlashCommand, shipChatName, shipIdeaName, withAttachments } = ship;

test('a new-feature chat is named from the first six words of the idea', () => {
  assert.equal(shipIdeaName('Consort: /ship new dialog, slash menu, quiet tool rows'), 'Consort: /ship new dialog, slash menu,…');
  assert.equal(shipIdeaName('  two   words \n here '), 'two words here');
  assert.equal(shipIdeaName(''), '');
  assert.equal(shipChatName('new', undefined, shipIdeaName('Fix the seat chooser cache')), 'ship · Fix the seat chooser cache · new');
});

test('the slug wins over the typed name, and a blank name falls back to new', () => {
  assert.equal(shipChatName('new', 'consort-ship-chat-ux', 'whatever'), 'ship · consort-ship-chat-ux · new');
  assert.equal(shipChatName('approve', undefined, '  '), 'ship · new · approve');
});

test('attachments appended to a slash command keep it a slash command', () => {
  const text = withAttachments('/ship new add a screenshot to the idea box', ['/Users/p/command-center/.consort/shot.png']);
  assert.ok(isSlashCommand(text));
  assert.match(text, /^\/ship new add a screenshot to the idea box\n\nAttached files \(read them from disk\):\n- \/Users\/p\/command-center\/\.consort\/shot\.png$/);
  assert.equal(withAttachments('/clear', []), '/clear');
});

test('a new feature folder relinks the unlinked new chat whose name shares its title', () => {
  const { matchNewChats } = ship;
  const chats = [
    { id: 'a', name: 'ship · Consort: /ship new dialog, slash… · new', since: 1000, action: 'new' },
    { id: 'b', name: 'ship · Roster reconciliation cron · new', since: 2000, action: 'new' },
    { id: 'c', name: 'ship · seat-pool-and-ship · approve', since: 500, slug: 'seat-pool-and-ship', action: 'approve' },
  ];
  const features = [
    { slug: 'seat-pool-and-ship', title: 'Seat pool', at: 400 },
    { slug: 'roster-reconciliation', title: 'Roster reconciliation cron', at: 3000 },
    { slug: 'consort-ship-chat-ux', title: 'Consort: /ship new dialog, slash menu, quiet tool rows', at: 2500 },
  ];
  assert.deepEqual(matchNewChats(chats, features), [
    { chatId: 'a', slug: 'consort-ship-chat-ux' },
    { chatId: 'b', slug: 'roster-reconciliation' },
  ]);
});

test('a folder older than the chat, or one with no word in common when several chats wait, is left alone', () => {
  const { matchNewChats } = ship;
  const chats = [
    { id: 'a', name: 'ship · alpha idea · new', since: 5000, action: 'new' },
    { id: 'b', name: 'ship · beta idea · new', since: 5000, action: 'new' },
  ];
  assert.deepEqual(matchNewChats(chats, [{ slug: 'old-thing', title: 'Old thing', at: 1000 }]), []);
  assert.deepEqual(matchNewChats(chats, [{ slug: 'gamma', title: 'Gamma', at: 6000 }]), []);
  // a lone waiting chat takes the lone new folder whatever its title
  assert.deepEqual(matchNewChats([chats[0]], [{ slug: 'gamma', title: 'Gamma', at: 6000 }]), [{ chatId: 'a', slug: 'gamma' }]);
});

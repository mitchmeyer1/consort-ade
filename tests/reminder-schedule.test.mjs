import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/reminders.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(chats, viewing = () => false) {
  const shown = [];
  const opened = [];
  let changes = 0;
  const electron = { Notification: class {
    constructor(opts) { this.opts = opts; this.handlers = {}; }
    static isSupported() { return true; }
    on(event, cb) { this.handlers[event] = cb; return this; }
    show() { shown.push(this); }
  } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => name === 'electron' ? electron : require(name), mod, mod.exports);
  const reminders = new mod.exports.Reminders(() => chats, (id) => opened.push(id), () => { changes++; }, viewing);
  return { reminders, shown, opened, changes: () => changes };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('a reminder set for later notifies when its time comes, and names the chat', async () => {
  const chats = [{ id: 'c1', name: 'Sidebar polish', remindAt: Date.now() + 15 }];
  const f = fixture(chats);
  f.reminders.sync();
  assert.equal(f.shown.length, 0, 'nothing fires before the time');
  await tick(40);
  assert.equal(f.shown.length, 1);
  assert.equal(f.shown[0].opts.subtitle, 'Sidebar polish');
  assert.equal(f.changes(), 1, 'the renderer is told, so the dot turns purple');
  f.shown[0].handlers.click();
  assert.deepEqual(f.opened, ['c1']);
  f.reminders.stop();
});

test('a reminder already past due is not announced again on startup', async () => {
  const f = fixture([{ id: 'c1', name: 'Old', remindAt: Date.now() - 60_000 }]);
  f.reminders.sync();
  await tick(20);
  assert.equal(f.shown.length, 0);
  f.reminders.stop();
});

test('clearing a reminder cancels its pending notification', async () => {
  const chats = [{ id: 'c1', name: 'Later', remindAt: Date.now() + 25 }];
  const f = fixture(chats);
  f.reminders.sync();
  chats[0].remindAt = undefined;
  f.reminders.sync();
  await tick(50);
  assert.equal(f.shown.length, 0);
  f.reminders.stop();
});

test('a reminder pushed further out replaces the earlier timer', async () => {
  const chats = [{ id: 'c1', name: 'Moved', remindAt: Date.now() + 20 }];
  const f = fixture(chats);
  f.reminders.sync();
  chats[0].remindAt = Date.now() + 10_000;
  f.reminders.sync();
  await tick(60);
  assert.equal(f.shown.length, 0, 'the old timer no longer fires');
  f.reminders.stop();
});

test('a chat deleted before its reminder lands drops the timer', async () => {
  const chats = [{ id: 'c1', name: 'Gone', remindAt: Date.now() + 15 }];
  const f = fixture(chats);
  f.reminders.sync();
  chats.length = 0;
  f.reminders.sync();
  await tick(40);
  assert.equal(f.shown.length, 0);
  f.reminders.stop();
});

test('a reminder pulled earlier lands at the new time, not the old one', async () => {
  const chats = [{ id: 'c1', name: 'Sooner', remindAt: Date.now() + 10_000 }];
  const f = fixture(chats);
  f.reminders.sync();
  chats[0].remindAt = Date.now() + 15;
  f.reminders.sync();
  await tick(60);
  assert.equal(f.shown.length, 1, 'the earlier time wins');
  f.reminders.stop();
});

test('a reminder landing on the chat you are looking at does not notify', async () => {
  const chats = [{ id: 'c1', name: 'On screen', remindAt: Date.now() + 15 }];
  const f = fixture(chats, (id) => id === 'c1');
  f.reminders.sync();
  await tick(40);
  assert.equal(f.shown.length, 0, 'you are already there');
  assert.equal(f.changes(), 1, 'the app still hears about it, which is what clears the reminder');
  f.reminders.stop();
});

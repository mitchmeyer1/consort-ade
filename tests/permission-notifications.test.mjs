import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../src/main/permissionNotifications.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture(supported = true) {
  const alerts = [], answers = [], opened = [];
  let chats = [{ id: 'chat', name: 'Review', permissions: [{ id: 'first', tool: 'Bash' }, { id: 'second', tool: 'Edit' }] }];
  class Notification extends EventEmitter {
    static isSupported() { return supported; }
    constructor(options) { super(); this.options = options; this.closed = false; alerts.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; this.emit('close', {}); }
  }
  const mod = { exports: {} };
  new Function('require', 'exports', 'process', code)(() => ({ Notification }), mod.exports, { platform: 'darwin' });
  const manager = new mod.exports.PermissionNotifications(() => chats, (id, allow) => {
    answers.push([id, allow]);
    chats[0].permissions = chats[0].permissions.filter(p => p.id !== id);
    manager.sync();
  }, id => opened.push(id));
  return { manager, alerts, answers, opened, get chats() { return chats; }, removeChat() { chats = []; } };
}
test('each permission has one persistent alert with Allow/Block and an open-chat click', () => {
  const f = fixture(); f.manager.sync(); f.manager.sync();
  assert.equal(f.alerts.length, 2);
  assert.deepEqual(f.alerts[0].options.actions.map(a => a.text), ['Allow', 'Block']);
  assert.equal(f.alerts[0].options.timeoutType, 'never');
  f.alerts[0].emit('click'); assert.deepEqual(f.opened, ['chat']);
  assert.deepEqual(f.answers, []);
});
test('actions resolve only their request, close resolved alerts, and ignore stale or duplicate clicks', () => {
  const f = fixture(); f.manager.sync();
  f.alerts[1].emit('action', { actionIndex: 1 }, 0);
  assert.deepEqual(f.answers, [['second', false]]);
  assert.equal(f.alerts[1].closed, true);
  assert.equal(f.alerts[0].closed, false);
  f.alerts[1].emit('action', { actionIndex: 0 });
  f.alerts[0].emit('action', {}, 0);
  assert.deepEqual(f.answers, [['second', false], ['first', true]]);
  assert.ok(f.alerts.every(n => n.closed));
});
test('dismissal leaves permission pending; in-chat answers, stops and chat deletion invalidate alerts', () => {
  const f = fixture(); f.manager.sync();
  f.alerts[0].emit('close', {}); f.manager.sync();
  assert.deepEqual(f.answers, []); assert.equal(f.alerts.length, 2);
  f.chats[0].permissions.shift();
  f.alerts[0].emit('action', { actionIndex: 0 });
  assert.deepEqual(f.answers, []);
  f.manager.sync(); assert.equal(f.alerts[0].closed, true);
  f.removeChat(); f.manager.sync(); assert.equal(f.alerts[1].closed, true);
  f.alerts[1].emit('action', { actionIndex: 0 }); assert.deepEqual(f.answers, []);
});
test('unsupported notifications leave in-app permission handling untouched', () => {
  const f = fixture(false); f.manager.sync(); assert.equal(f.alerts.length, 0); assert.equal(f.chats[0].permissions.length, 2);
});

test('while Consort is active a pending permission is shown in-app once and no system notification is built', () => {
  const shown = [];
  const inApp = [];
  class Notification extends EventEmitter { constructor(opts) { super(); this.opts = opts; shown.push(this); } static isSupported() { return true; } show() {} close() {} }
  const mod = { exports: {} };
  new Function('require', 'exports', 'process', code)(() => ({ Notification }), mod.exports, { platform: 'darwin' });
  const chats = [{ id: 'c1', name: 'Review', permissions: [{ id: 'p1', chatId: 'c1', tool: 'Bash', input: {} }] }];
  const manager = new mod.exports.PermissionNotifications(() => chats, () => {}, () => {}, (chat, request) => { inApp.push(`${chat.id}:${request.id}`); return true; });
  manager.sync();
  manager.sync();
  assert.deepEqual(inApp, ['c1:p1'], 'the toast is shown once, not on every sync');
  assert.equal(shown.length, 0);
  chats[0].permissions = [];
  manager.sync();
  chats[0].permissions = [{ id: 'p2', chatId: 'c1', tool: 'Edit', input: {} }];
  manager.sync();
  assert.deepEqual(inApp, ['c1:p1', 'c1:p2']);
});

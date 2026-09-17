import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let declaration;
source.forEachChild(node => {
  if (ts.isVariableStatement(node)) for (const item of node.declarationList.declarations) {
    if (item.name.getText(source) === 'handlers') declaration = item.initializer;
  }
});
const properties = declaration.properties.filter(p => ['addQuickAction', 'setQuickActionPinned', 'deleteQuickAction'].includes(p.name.getText(source)));
const compiled = ts.transpileModule(`const handlers = {${properties.map(p => p.getText(source)).join(',')}}; return handlers;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('quick actions persist only on the selected worktree, preserve Bash, and delete independently', () => {
  let worktrees = [{ id: 'root' }, { id: 'branch' }];
  let disk;
  const wt = id => { const w = worktrees.find(w => w.id === id); if (!w) throw new Error('Worktree not found'); return w; };
  const store = { save: () => { disk = JSON.stringify(worktrees); } };
  const handlers = new Function('wt', 'store', 'randomUUID', compiled)(wt, store, randomUUID);
  const command = "printf '%s\\n' 'build here'\npnpm package:mac\n";
  handlers.addQuickAction('root', ' BUILD ', command);
  worktrees = JSON.parse(disk);
  assert.equal(worktrees[0].quickActions[0].title, 'BUILD');
  assert.equal(worktrees[0].quickActions[0].command, command);
  assert.equal(worktrees[1].quickActions, undefined);
  handlers.addQuickAction('branch', 'TEST', 'pnpm test');
  const branchAction = worktrees[1].quickActions[0];
  const rootId = worktrees[0].quickActions[0].id;
  handlers.setQuickActionPinned('root', rootId, true);
  worktrees = JSON.parse(disk);
  assert.equal(worktrees[0].quickActions[0].pinned, true);
  assert.equal(worktrees[1].quickActions[0].pinned, undefined);
  assert.throws(() => handlers.setQuickActionPinned('branch', rootId, true));
  handlers.setQuickActionPinned('root', rootId, false);
  worktrees = JSON.parse(disk);
  assert.equal(worktrees[0].quickActions[0].pinned, false);
  handlers.setQuickActionPinned('root', rootId, true);
  handlers.deleteQuickAction('root', branchAction.id);
  assert.equal(worktrees[1].quickActions.length, 1);
  handlers.deleteQuickAction('root', worktrees[0].quickActions[0].id);
  worktrees = JSON.parse(disk);
  assert.deepEqual(worktrees[0].quickActions, []);
  assert.deepEqual(worktrees[1].quickActions, [branchAction]);
  assert.throws(() => handlers.addQuickAction('root', ' ', 'echo ok'));
  assert.throws(() => handlers.addQuickAction('root', 'BUILD', '\n '));
  assert.throws(() => handlers.addQuickAction('missing', 'BUILD', 'echo ok'));
});

test('running an action opens a fresh terminal in its workspace and preserves shell quoting', async () => {
  const { execFileSync } = await import('node:child_process');
  const appSource = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8');
  const app = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let action;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(app) === 'runQuickAction') action = node.initializer;
    node.forEachChild(visit);
  }
  visit(app);
  const code = ts.transpileModule('return ' + action.getText(app), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const tabs = new Map(), labels = new Map(), commands = new Map(), events = [];
  let panel;
  const run = new Function('crypto', 'termTabs', 'termLabels', 'pendingCmd', 'setTab', 'window', 'CustomEvent', 'let wantTab; ' + code)(
    { randomUUID }, tabs, labels, commands, tab => { panel = tab; }, { dispatchEvent: e => events.push(e) }, class { constructor(name, data) { this.type = name; this.detail = data.detail; } });
  const script = "printf '%s\\n' \"a'b\" '$literal'\nprintf '%s' done";
  run({ id: 'branch', path: '/tmp' }, { title: 'CHECK', command: script });
  assert.equal(panel, 'terminal');
  assert.equal(tabs.has('root'), false);
  const id = tabs.get('branch')[1];
  assert.equal(labels.get(`branch:${id}`), 'CHECK');
  assert.equal(events[0].detail.scopeId, 'branch');
  assert.equal(execFileSync('/bin/zsh', ['-c', commands.get(`branch:${id}`)], { encoding: 'utf8' }), "a'b\n$literal\ndone");
  run({ id: 'branch' }, { title: 'CHECK', command: script });
  assert.equal(new Set(tabs.get('branch')).size, 3);
});

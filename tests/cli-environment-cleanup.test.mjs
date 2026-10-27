import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';

function load(execFile, state) {
  const mocks = { 'node:child_process': { execFile }, '../shared/headless.ts': headless, './capacity': { environmentLimit: () => 4 }, './state': { loadState: () => state, mutateState: () => undefined, processAlive: () => true } };
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/cli/environment.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(n => mocks[n] ?? process.getBuiltinModule(n), mod, mod.exports);
  return mod.exports;
}

test('the hourly sweep removes only leftovers: unowned environments of ours, and unused volumes that are anonymous, ours or a finished desktop turn', async () => {
  const now = Date.parse('2026-10-27T18:00:00Z');
  const old = '2026-10-27T15:00:00Z', fresh = '2026-10-27T17:30:00Z';
  const app = 'consort-a028d0b3-90560883-dd37-4230-ace0-7dca5f209a7b';
  const volumes = [
    ['anon-old', old, 'anon', '', ''], ['anon-fresh', fresh, 'anon', '', ''],
    ['mine-named', old, '', '', 'aligned-mono'], ['app-old', old, '', '', app],
    ['gone-task', old, '', '', 'consort-mvjwblglyp5c'], ['pool-set', old, '', '', 'consort-env-0a1b2c3d'],
  ];
  const calls = [];
  const execFile = (cmd, args, _o, cb) => {
    calls.push(args.join(' '));
    let out = '';
    if (args[0] === 'ps' && args[1] === '-a' && args[2] === '--format') out = 'consort-env-0a1b2c3d\tconsort-env-0a1b2c3d\n\tconsort-mvjyp38xhdve\n\taligned-mono\n' + app + '\t' + app;
    else if (args[0] === 'volume' && args[1] === 'ls' && args[2] === '--format') out = '\tconsort-mvjwblglyp5c\n\tconsort-env-0a1b2c3d';
    else if (args[0] === 'volume' && args[1] === 'ls' && args.includes('dangling=true')) out = volumes.map(v => v[0]).join('\n');
    else if (args[0] === 'volume' && args[1] === 'inspect') out = volumes.filter(v => args.includes(v[0])).map(v => v.join('\t')).join('\n');
    cb(null, { stdout: out, stderr: '' });
  };
  const state = { tasks: [{ id: 'task-mvopen00task', status: 'working', runCode: 'consort-mvopen00task' }], envPool: [{ runCode: 'consort-env-0a1b2c3d' }] };
  const env = load(execFile, state);
  const dry = await env.sweepLeftovers({ dryRun: true, now });
  assert.deepEqual(dry, { environments: ['consort-mvjwblglyp5c', 'consort-mvjyp38xhdve'], volumes: 3 });
  assert.ok(!calls.some(c => c.startsWith('rm ') || c.startsWith('volume rm')), 'a dry run removes nothing');
  calls.length = 0;
  await env.sweepLeftovers({ now });
  const removed = calls.find(c => c.startsWith('volume rm ') && !c.startsWith('volume rm -f'));
  assert.equal(removed, 'volume rm anon-old app-old gone-task', 'not fresh, not another project, not a pool set');
  assert.ok(calls.some(c => c.includes('label=io.consort.run=consort-mvjyp38xhdve')), 'the unowned environment is cleaned');
  assert.ok(!calls.some(c => c.includes('label=io.consort.run=consort-env-0a1b2c3d')), 'a pool set is never touched');
  assert.ok(!calls.some(c => c.includes(app) && c.includes('label=')), 'a desktop turn\'s containers are left to the app');
});

test('cleanup removes a set\'s containers with their unnamed volumes, then its networks and named volumes', async () => {
  const calls = [];
  const execFile = (cmd, args, _o, cb) => {
    calls.push([cmd, ...args].join(' '));
    const out = args[0] === 'ps' && args.at(-1) === 'label=io.consort.run=consort-env-x' ? 'c1\nc2' : args[0] === 'volume' && args[1] === 'ls' && args.at(-1).startsWith('label=com.docker.compose.project') ? 'v1' : '';
    cb(null, { stdout: out, stderr: '' });
  };
  const mocks = { 'node:child_process': { execFile }, '../shared/headless.ts': headless, './capacity': { environmentLimit: () => 4 }, './state': { loadState: () => ({ tasks: [] }), mutateState: () => undefined, processAlive: () => true } };
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/cli/environment.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(n => mocks[n] ?? (await_import(n)), mod, mod.exports);
  function await_import(n) { return globalThis.process.getBuiltinModule(n); }
  const r = await mod.exports.cleanupEnvironment('consort-env-x');
  assert.ok(calls.includes('docker rm -f -v c1 c2'), 'unnamed volumes go with their containers');
  assert.ok(calls.includes('docker volume rm -f v1'));
  assert.deepEqual(r, { containers: 2, networks: 0, volumes: 1 });
});

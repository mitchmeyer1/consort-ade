import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';

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

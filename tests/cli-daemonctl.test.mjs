import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/cli/daemonctl.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

for (const error of [undefined, 'EPERM', 'ESRCH']) {
  test(`worker liveness handles ${error ?? 'a running process'} without false restarts`, () => {
    const mod = { exports: {} };
    const fakeProcess = { kill: (pid, signal) => { assert.equal(pid, 123); assert.equal(signal, 0); if (error) throw Object.assign(new Error(error), { code: error }); } };
    new Function('require', 'module', 'exports', 'process', code)(n => n === './workerControl' ? { requestWorkerStop() {} } : n === './state.ts' ? { HOME: '/virtual', LOG_DIR: '/virtual/logs' } : require(n), mod, mod.exports, fakeProcess);
    assert.equal(mod.exports.alive(123), error !== 'ESRCH');
  });
}

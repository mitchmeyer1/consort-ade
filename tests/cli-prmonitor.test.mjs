import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(readFileSync(new URL('../src/cli/prmonitor.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('PR polling notices a new human reply in an existing thread and top-level review comments', async () => {
  let comment = { author: { login: 'ada' }, body: 'Please change label', url: 'url', createdAt: '2026-10-20T10:00:00Z' };
  const mocks = {
    'node:child_process': { execFile() {} },
    'node:util': { promisify: () => async (_, args) => ({ stdout: JSON.stringify(args[0] === 'pr' ? {
      state: 'OPEN', url: 'url', reviews: [{ id: 'r', author: { login: 'bob' }, body: 'Design question', state: 'CHANGES_REQUESTED', submittedAt: 'now' }], statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    } : args[0] === 'repo' ? { nameWithOwner: 'org/repo' } : { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ id: 'thread', isResolved: false, comments: { nodes: [{ author: { login: 'ada' }, body: 'Original', createdAt: 'old' }, comment] } }] } } } } }) }) },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(n => mocks[n], mod, mod.exports);
  const before = await mod.exports.readPr('/virtual', 1);
  comment = { ...comment, body: 'Follow-up request', createdAt: '2026-10-20T11:00:00Z' };
  const after = await mod.exports.readPr('/virtual', 1);
  assert.notEqual(before.unresolved[0].id, after.unresolved[0].id);
  assert.match(after.unresolved[0].body, /GitHub thread ID: thread\nFollow-up request/);
  assert.equal(after.feedback[0].author, 'bob');
  assert.match(after.feedback[0].body, /Top-level review \(no thread\): Design question/);
  assert.equal(after.ci, 'pass');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';

const require = createRequire(import.meta.url);
function load(home) {
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(new URL('../src/cli/repoEnv.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(n => n === './state' ? { HOME: home } : n === '../shared/headless.ts' ? headless : require(n), mod, mod.exports);
  return mod.exports;
}

test('a proven setup is saved per repository and the next task, build or review, starts from it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'consort-repoenv-')); t.after(() => rm(root, { recursive: true, force: true }));
  const { saveRepoEnv, environmentPrompt, PREVIOUS_DIR } = load(join(root, 'home'));
  const env = headless.taskEnv('consort-a', 20000);
  const repo = join(root, 'repo'), first = join(root, 'wt1'), second = join(root, 'wt2');
  await mkdir(repo); await mkdir(second, { recursive: true });
  assert.match(environmentPrompt(repo, second, env), /work out what it takes to run this repository/, 'nothing saved yet: from scratch');
  await mkdir(join(first, '.consort', 'ship'), { recursive: true }); await mkdir(join(first, '.consort', 'env'), { recursive: true });
  await writeFile(join(first, '.consort', 'ship', 'ENV.md'), 'postgres + redis; pnpm dev');
  await writeFile(join(first, '.consort', 'env', 'up.sh'), 'docker compose up');
  await writeFile(join(first, '.consort', 'env', '.env.consort'), 'DATABASE_URL=task-only');
  await writeFile(join(first, '.consort', 'env', 'app.pid'), '123');
  assert.equal(saveRepoEnv(repo, first), true);
  const prompt = environmentPrompt(repo, second, env);
  assert.match(prompt, /starting from the saved setup/);
  assert.equal(await readFile(join(second, PREVIOUS_DIR, 'ENV.md'), 'utf8'), 'postgres + redis; pnpm dev');
  assert.equal(await readFile(join(second, PREVIOUS_DIR, 'env', 'up.sh'), 'utf8'), 'docker compose up');
  assert.ok(!existsSync(join(second, PREVIOUS_DIR, 'env', '.env.consort')), "a task's own overrides are not shared");
  assert.ok(!existsSync(join(second, PREVIOUS_DIR, 'env', 'app.pid')));
  assert.match(environmentPrompt(join(root, 'other-repo'), second, env), /work out what it takes/, 'another repository starts from scratch');
});

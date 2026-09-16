import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentEnvironment } from '../src/main/agentEnvironment.ts';

const run = promisify(execFile);

test('agent caches belong to each checkout while credentials and PATH are preserved', () => {
  const inherited = { PATH: '/bin', HOME: '/home/user', ANTHROPIC_API_KEY: 'test', npm_config_cache: '/outside', OMITTED: undefined };
  const env = agentEnvironment('/work/branch', inherited);
  assert.equal(env.PATH, inherited.PATH);
  assert.equal(env.HOME, inherited.HOME);
  assert.equal(env.ANTHROPIC_API_KEY, inherited.ANTHROPIC_API_KEY);
  assert.equal('OMITTED' in env, false);
  for (const key of ['npm_config_cache', 'npm_config_store_dir', 'YARN_CACHE_FOLDER', 'COREPACK_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(env[key].startsWith('/work/branch/.consort/cache'));
    assert.notEqual(env[key], agentEnvironment('/work/other', inherited)[key]);
  }
  assert.equal(inherited.npm_config_cache, '/outside');
});

test('a fresh checkout can install a missing dev test runner and execute it with the agent environment', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-test-setup-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runner = join(cwd, 'runner');
  await mkdir(runner);
  await writeFile(join(runner, 'package.json'), JSON.stringify({ name: 'fixture-test-runner', version: '1.0.0', bin: { 'fixture-test-runner': 'run.cjs' } }));
  await writeFile(join(runner, 'run.cjs'), '#!/usr/bin/env node\nrequire("node:assert/strict").equal(require("node:fs").readFileSync("branch.txt", "utf8"), "current branch"); console.log("branch test passed");\n', { mode: 0o755 });
  await writeFile(join(cwd, 'branch.txt'), 'current branch');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', private: true, scripts: { test: 'fixture-test-runner' }, devDependencies: { 'fixture-test-runner': 'file:./runner' } }));
  const env = agentEnvironment(cwd, process.env);
  const options = { cwd, env, timeout: 30_000 };
  await assert.rejects(run('npm', ['test'], options));
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], options);
  const lock = await readFile(join(cwd, 'package-lock.json'), 'utf8');
  await run('npm', ['ci', '--include=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], options);
  const result = await run('npm', ['test'], options);
  assert.match(result.stdout, /branch test passed/);
  assert.equal(await readFile(join(cwd, 'package-lock.json'), 'utf8'), lock);
  const cache = await run('npm', ['config', 'get', 'cache'], options);
  assert.equal(cache.stdout.trim(), join(cwd, '.consort', 'cache', 'npm'));
});

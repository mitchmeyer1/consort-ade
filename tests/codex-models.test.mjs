import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/codexModels.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const FALLBACK = ['gpt-6-astra', 'gpt-5.5'];

function load(home = '/nonexistent-home') {
  const mocks = {
    '../shared/types': { MODELS: { claude: ['claude-opus-5'], codex: FALLBACK } },
    'node:os': { homedir: () => home },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), mod, mod.exports);
  return mod.exports;
}

function catalog(models) {
  const dir = mkdtempSync(join(tmpdir(), 'consort-codex-'));
  writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({ models }));
  return dir;
}

test('offers the models Codex lists, in Codex order, then any built-ins it did not mention', () => {
  const dir = catalog([
    { slug: 'gpt-5.6-luna', visibility: 'list', priority: 2 },
    { slug: 'codex-auto-review', visibility: 'hide', priority: 43 },
    { slug: 'gpt-5.6-sol', visibility: 'list', priority: 0 },
    { slug: 'gpt-6-astra', visibility: 'list', priority: 3 },
  ]);
  const { codexModels } = load();
  assert.deepEqual(codexModels([{ id: 'k', provider: 'codex', configDir: dir }]),
    ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-5.5']);
});

test('falls back to the built-in list when the catalog is missing or unreadable', () => {
  const broken = mkdtempSync(join(tmpdir(), 'consort-codex-'));
  writeFileSync(join(broken, 'models_cache.json'), 'not json');
  assert.deepEqual(load().codexModels([{ id: 'k', provider: 'codex', configDir: broken }]), FALLBACK);
  assert.deepEqual(load().codexModels([{ id: 'k', provider: 'codex', configDir: '/nonexistent-codex-home' }]), FALLBACK);
  assert.deepEqual(load().codexModels([]), FALLBACK);
});

test('covers every codex connector, and reads the default home when one has no config dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'consort-home-'));
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', visibility: 'list', priority: 0 }] }));
  const work = catalog([{ slug: 'gpt-work-only', visibility: 'list', priority: 1 }]);
  const { codexModels } = load(home);
  assert.deepEqual(codexModels([
    { id: 'login-codex', provider: 'codex' },
    { id: 'work', provider: 'codex', configDir: work },
    { id: 'claude', provider: 'claude', configDir: '/ignored' },
  ]), ['gpt-5.6-sol', 'gpt-work-only', 'gpt-6-astra', 'gpt-5.5']);
});

test('re-reads the catalog after the cache window, so new models appear without a restart', () => {
  const dir = catalog([{ slug: 'gpt-5.6-sol', visibility: 'list', priority: 0 }]);
  const { codexModels, forgetCodexModels } = load();
  const keys = [{ id: 'k', provider: 'codex', configDir: dir }];
  assert.deepEqual(codexModels(keys, 1_000), ['gpt-5.6-sol', ...FALLBACK]);
  writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-7', visibility: 'list', priority: 0 }] }));
  assert.deepEqual(codexModels(keys, 5_000), ['gpt-5.6-sol', ...FALLBACK], 'reads stay cheap inside the window');
  assert.deepEqual(codexModels(keys, 40_000), ['gpt-7', ...FALLBACK]);
  forgetCodexModels();
  assert.deepEqual(codexModels(keys, 40_001), ['gpt-7', ...FALLBACK]);
});

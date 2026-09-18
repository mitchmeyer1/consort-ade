import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);

const compile = (rel) => ts.transpileModule(readFileSync(new URL(rel, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const shared = { exports: {} };
new Function('require', 'module', 'exports', compile('../src/shared/usage.ts'))(() => ({}), shared, shared.exports);

function load() {
  const mocks = {
    electron: { app: { getPath: () => '/nonexistent', getVersion: () => '0.0.0' } },
    './auth': { codexBin: () => 'codex', loginEnv: () => ({}) },
    '../shared/usage': shared.exports,
    '@anthropic-ai/claude-agent-sdk': { query: () => { throw new Error('no CLI in tests'); } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile('../src/main/usage.ts'))(name => mocks[name] ?? require(name), mod, mod.exports);
  return mod.exports;
}

const login = (id, provider = 'claude') => ({ id, name: id, provider, phiAllowed: false, auth: 'login' });
const snapshot = (keyId, at, percent = 50) => ({ keyId, at, windows: [{ id: 'w', label: '5-hour', percent }] });

test('api keys never spawn a probe and are reported as billed per token', async () => {
  const { createUsageReader } = load();
  let probed = 0;
  const reader = createUsageReader({ claude: async () => { probed++; }, codex: async () => { probed++; } });
  const u = await reader.read({ id: 'phi', provider: 'claude', auth: 'key' });
  assert.equal(probed, 0);
  assert.match(u.unavailable, /API key/);
  assert.deepEqual(u.windows, []);
});

test('probes dispatch by provider and their answers are cached for the TTL', async () => {
  const { createUsageReader } = load();
  const calls = [];
  const reader = createUsageReader({
    claude: async (k) => { calls.push(['claude', k.id]); return snapshot(k.id, 1000, 67); },
    codex: async (k) => { calls.push(['codex', k.id]); return snapshot(k.id, 1000, 94); },
  }, 60_000);
  const a = await reader.read(login('login-claude'), { now: 1000 });
  const b = await reader.read(login('login-codex', 'codex'), { now: 1000 });
  assert.equal(a.windows[0].percent, 67);
  assert.equal(b.windows[0].percent, 94);
  assert.deepEqual(calls, [['claude', 'login-claude'], ['codex', 'login-codex']]);
  assert.equal(await reader.read(login('login-claude'), { now: 30_000 }), a, 'inside the TTL the snapshot is reused');
  assert.equal(calls.length, 2);
  await reader.read(login('login-claude'), { now: 61_001 });
  assert.equal(calls.length, 3, 'past the TTL the CLI is asked again');
});

test('force re-asks even inside the TTL, and concurrent readers share one probe', async () => {
  const { createUsageReader } = load();
  let probes = 0, release;
  const reader = createUsageReader({ claude: (k) => new Promise((res) => { probes++; release = () => res(snapshot(k.id, 5000)); }), codex: async () => {} }, 60_000);
  const first = reader.read(login('login-claude'), { now: 5000 });
  const second = reader.read(login('login-claude'), { now: 5000, force: true });
  assert.equal(probes, 1, 'the second caller joins the in-flight probe rather than starting another');
  release();
  assert.equal(await first, await second);
  const third = reader.read(login('login-claude'), { now: 6000, force: true });
  assert.equal(probes, 2, 'force bypasses a fresh cache entry');
  release();
  await third;
});

test('a failing probe degrades to an unavailable snapshot instead of throwing', async () => {
  const { createUsageReader } = load();
  const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  const reader = createUsageReader({
    claude: async () => { throw new Error('Claude usage timed out'); },
    codex: async () => { throw enoent; },
  });
  const c = await reader.read(login('login-claude'), { now: 1 });
  assert.equal(c.unavailable, 'The CLI did not answer in time.');
  assert.equal(c.at, 1);
  const x = await reader.read(login('login-codex', 'codex'), { now: 1 });
  assert.equal(x.unavailable, 'CLI not found.');
  const other = await createUsageReader({ claude: async () => { throw new Error('boom\nstack'); }, codex: async () => {} }).read(login('k'));
  assert.equal(other.unavailable, 'Usage unavailable: boom');
});

test('forget drops a connector so a re-added one is probed fresh', async () => {
  const { createUsageReader } = load();
  let probes = 0;
  const reader = createUsageReader({ claude: async (k) => { probes++; return snapshot(k.id, 1); }, codex: async () => {} }, 60_000);
  await reader.read(login('k'), { now: 1 });
  reader.forget('k');
  await reader.read(login('k'), { now: 2 });
  assert.equal(probes, 2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as sharedClaude from '../src/shared/claudeModels.ts';
import * as sharedCodex from '../src/shared/codexModels.ts';

const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL('../src/main/modelDiscovery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function load() {
  const mocks = {
    './auth': { codexBin: () => 'codex', codexHome: (k) => k.configDir ?? '/codex-home' },
    './claudeModels': { probeClaudeModels: async () => [] },
    '../shared/claudeModels': sharedClaude,
    '../shared/codexModels': sharedCodex,
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => mocks[name] ?? require(name), mod, mod.exports);
  return mod.exports;
}

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const row = (id) => ({ id, type: 'model', display_name: id, created_at: '2026-01-01T00:00:00Z' });

/** a fetch that answers by host and records what it was asked */
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
    calls.push({ url: u, headers });
    const answer = answers.find(([m]) => u.includes(m));
    if (!answer) return new Response('nope', { status: 404 });
    const body = answer[1];
    return body instanceof Response ? body : json(typeof body === 'function' ? body() : body);
  };
  return { fetch, calls };
}

const deps = (over = {}) => ({
  probeCli: async () => [],
  claudeToken: async () => undefined,
  codexVersion: async () => '0.159.0',
  readFile: () => { throw new Error('no file'); },
  ...over,
});

test('a Claude login lists from the Models API with its OAuth token and folds in the CLI aliases, strongest first', async () => {
  const { discoverModels } = load();
  const net = fakeFetch([['api.anthropic.com/v1/models', { data: [row('claude-sonnet-5-5'), row('claude-opus-5-5'), row('claude-opus-5')], has_more: false, first_id: null, last_id: null }]]);
  const key = { id: 'k', provider: 'claude', auth: 'login' };
  const found = await discoverModels([key], () => undefined, deps({ fetch: net.fetch, claudeToken: async () => 'tok', probeCli: async () => ['claude-opus-5', 'claude-fable-5-1'] }));
  assert.deepEqual(found, { claude: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'] });
  assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].headers.authorization, 'Bearer tok');
  assert.match(net.calls[0].headers['anthropic-beta'], /oauth-2025-04-20/);
  assert.equal(net.calls[0].headers['x-api-key'], undefined);
});

test('a Claude API key lists with the key itself, never a login token', async () => {
  const { discoverModels } = load();
  const net = fakeFetch([['api.anthropic.com/v1/models', { data: [row('claude-opus-5-5')], has_more: false, first_id: null, last_id: null }]]);
  let askedForToken = false;
  const found = await discoverModels([{ id: 'k', provider: 'claude', auth: 'key' }], () => 'sk-ant-x', deps({ fetch: net.fetch, claudeToken: async () => { askedForToken = true; return 'tok'; } }));
  assert.deepEqual(found, { claude: ['claude-opus-5-5'] });
  assert.equal(net.calls[0].headers['x-api-key'], 'sk-ant-x');
  assert.equal(net.calls[0].headers.authorization, undefined);
  assert.equal(askedForToken, false);
});

test('a connector that cannot answer contributes nothing, and a provider with no answers is left out', async () => {
  const { discoverModels } = load();
  const net = fakeFetch([]); // every request 404s
  const cliOnly = await discoverModels([{ id: 'a', provider: 'claude', auth: 'login' }], () => undefined, deps({ fetch: net.fetch, claudeToken: async () => 'tok', probeCli: async () => ['claude-opus-5'] }));
  assert.deepEqual(cliOnly, { claude: ['claude-opus-5'] });
  const nothing = await discoverModels(
    [{ id: 'a', provider: 'claude', auth: 'login' }, { id: 'b', provider: 'codex', auth: 'login' }],
    () => undefined,
    deps({ fetch: net.fetch, probeCli: async () => { throw new Error('CLI missing'); }, claudeToken: async () => { throw new Error('no keychain'); } }),
  );
  assert.deepEqual(nothing, {});
});

test("a Codex login asks Codex's backend for the bundled CLI's version of the catalog", async () => {
  const { discoverModels } = load();
  const net = fakeFetch([['chatgpt.com/backend-api/codex/models', { models: [
    { slug: 'gpt-6-astra', visibility: 'list', priority: 2 },
    { slug: 'gpt-6.1-sol', visibility: 'list', priority: 0 },
    { slug: 'codex-auto-review', visibility: 'hide', priority: 43 },
  ] }]]);
  const files = { '/work/auth.json': JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'cg-tok', account_id: 'acct-1' } }) };
  const found = await discoverModels([{ id: 'c', provider: 'codex', auth: 'login', configDir: '/work' }], () => undefined, deps({ fetch: net.fetch, readFile: (p) => { if (!(p in files)) throw new Error(p); return files[p]; } }));
  assert.deepEqual(found, { codex: ['gpt-6.1-sol', 'gpt-6-astra'] });
  assert.match(net.calls[0].url, /client_version=0\.159\.0/);
  assert.equal(net.calls[0].headers.authorization, 'Bearer cg-tok');
  assert.equal(net.calls[0].headers['chatgpt-account-id'], 'acct-1');
});

test("a Codex login without a CLI version to name asks nothing, and an API key in Codex's auth file uses the platform list", async () => {
  const { discoverModels } = load();
  const net = fakeFetch([['api.openai.com/v1/models', { data: [{ id: 'gpt-5.5', created: 1 }, { id: 'gpt-6.1-sol', created: 3 }, { id: 'gpt-4o-audio-preview', created: 9 }] }]]);
  const tokens = JSON.stringify({ tokens: { access_token: 'cg-tok' } });
  assert.deepEqual(await discoverModels([{ id: 'c', provider: 'codex', auth: 'login' }], () => undefined, deps({ fetch: net.fetch, readFile: () => tokens, codexVersion: async () => undefined })), {});
  assert.equal(net.calls.length, 0);
  const viaKey = await discoverModels([{ id: 'c', provider: 'codex', auth: 'login' }], () => undefined, deps({ fetch: net.fetch, readFile: () => JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-file' }) }));
  assert.deepEqual(viaKey, { codex: ['gpt-6.1-sol', 'gpt-5.5'] });
  assert.equal(net.calls[0].headers.authorization, 'Bearer sk-file');
});

test('a Codex API-key connector lists from the OpenAI platform with the stored key, and connectors of one provider merge', async () => {
  const { discoverModels } = load();
  const net = fakeFetch([
    ['api.openai.com/v1/models', { data: [{ id: 'gpt-5.5', created: 1 }, { id: 'gpt-6-astra', created: 2 }] }],
    ['chatgpt.com/backend-api/codex/models', { models: [{ slug: 'gpt-6.1-sol', visibility: 'list', priority: 0 }, { slug: 'gpt-6-astra', visibility: 'list', priority: 2 }] }],
  ]);
  const keys = [{ id: 'login', provider: 'codex', auth: 'login' }, { id: 'key', provider: 'codex', auth: 'key' }];
  const found = await discoverModels(keys, (k) => (k.id === 'key' ? 'sk-o' : undefined), deps({ fetch: net.fetch, readFile: () => JSON.stringify({ tokens: { access_token: 't' } }) }));
  assert.deepEqual(found, { codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.5'] });
  const platform = net.calls.find((c) => c.url.includes('api.openai.com'));
  assert.equal(platform.headers.authorization, 'Bearer sk-o');
});

test("Claude Code's keychain item is named for the config directory: bare for the default, hashed for the rest", () => {
  const { keychainService } = load();
  assert.equal(keychainService(join(homedir(), '.claude')), 'Claude Code-credentials');
  const dir = '/Users/someone/Library/Application Support/ade/logins/abc';
  assert.equal(keychainService(dir), `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`);
  assert.equal(keychainService('/x', '/x'), 'Claude Code-credentials');
});

// Fixtures come from ./helpers/fake-pii.mjs at run time: no identifier shape is written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as phi from '../src/shared/phi.ts';
import * as piiGate from '../src/shared/piiGate.ts';
import * as redact from '../src/shared/redact.ts';
import * as warehouse from '../src/shared/warehouse.ts';
import * as cliModels from '../src/shared/cliModels.ts';
import * as headless from '../src/shared/headless.ts';
import * as fake from './helpers/fake-pii.mjs';

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync(new URL('../src/cli/covered.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mocks = {
  './agent': { binaryFor: () => '/bin/claude', resultUsage: (m, model) => (m.usage ? [{ model, tokens: { input: m.usage.input_tokens, output: 0, cacheRead: 0, cacheWrite: 0 } }] : undefined) },
  './state': { HOME: '/virtual' },
  '../shared/phi.ts': phi, '../shared/piiGate.ts': piiGate, '../shared/redact.ts': redact, '../shared/warehouse.ts': warehouse, '../shared/cliModels.ts': cliModels, '../shared/headless.ts': headless,
};
const mod = { exports: {} };
new Function('require', 'module', 'exports', code)((n) => mocks[n] ?? require(n), mod, mod.exports);
const { checkCoveredKey, runCoveredTurn, coveredHooks } = mod.exports;

const keychain = { kind: 'keychain', service: 'anthropic-phi-api-key' };
const settings = phi.phiSettings({ phi: { guard: true } });
const ask = { question: 'How many members replied uncertain?', tables: ['analytics.consent.appended_phone'], shape: 'a count' };

test('the key check finds the Keychain item without reading its secret, and refuses files others can read', async () => {
  const calls = [];
  const deps = (over = {}) => ({ exec: async (cmd, args) => { calls.push([cmd, ...args]); }, stat: () => ({ mode: 0o100600, uid: 501, size: 40 }), uid: 501, platform: 'darwin', ...over });
  assert.deepEqual(await checkCoveredKey(keychain, deps()), { ok: true });
  assert.deepEqual(calls, [['security', 'find-generic-password', '-s', 'anthropic-phi-api-key']], 'no -w: the value is never read');
  assert.match((await checkCoveredKey({ ...keychain, account: 'consort-cli' }, deps({ exec: async () => { throw new Error('not found'); } }))).reason, /no item anthropic-phi-api-key for account consort-cli/);
  assert.match((await checkCoveredKey(keychain, deps({ platform: 'linux' }))).reason, /needs macOS/);
  assert.match((await checkCoveredKey(undefined, deps())).reason, /no covered key is configured/);
  const file = { kind: 'file', path: '/home/u/covered.key' };
  assert.deepEqual(await checkCoveredKey(file, deps()), { ok: true });
  assert.match((await checkCoveredKey(file, deps({ stat: () => ({ mode: 0o100644, uid: 501, size: 40 }) }))).reason, /chmod 600/);
  assert.match((await checkCoveredKey(file, deps({ stat: () => ({ mode: 0o100600, uid: 7, size: 40 }) }))).reason, /another user/);
  assert.match((await checkCoveredKey(file, deps({ stat: () => ({ mode: 0o100600, uid: 501, size: 0 }) }))).reason, /empty/);
  assert.match((await checkCoveredKey(file, deps({ stat: () => undefined }))).reason, /does not exist/);
});

const fakeDeps = (messages, over = {}) => {
  const seen = { removed: [], options: undefined, prompt: undefined };
  const deps = {
    query: ({ prompt, options }) => { seen.prompt = prompt; seen.options = options; return (async function* () { for (const m of messages) { if (m instanceof Error) throw m; yield m; } })(); },
    check: async () => ({ ok: true }), scratch: () => '/virtual/covered-t-1', remove: (d) => seen.removed.push(d), binary: () => '/bin/claude', env: { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_BASE_URL: 'https://proxy.example.com', [phi.COVERED_VARIABLES[0]]: 'value' },
    ...over,
  };
  return { deps, seen };
};
const init = (source = 'apiKeyHelper') => ({ type: 'system', subtype: 'init', apiKeySource: source });
const result = (text) => ({ type: 'result', subtype: 'success', result: text, usage: { input_tokens: 10 } });

test('a covered turn runs confined, fetches the key through the helper, and releases an answer that passed the gate', async () => {
  const { deps, seen } = fakeDeps([init(), result('About a third of members replied uncertain (count 1,2xx).\nSQL: select count(*) from analytics.consent.appended_phone')]);
  const r = await runCoveredTurn({ taskId: 't', ask, phi: settings, ref: keychain }, deps);
  assert.equal(r.status, 'released');
  assert.match(r.text, /About a third/);
  const o = seen.options;
  assert.deepEqual(o.settings, { apiKeyHelper: "security find-generic-password -w -s 'anthropic-phi-api-key'" });
  assert.ok(!Object.keys(o.env).some((k) => k.startsWith('ANTHROPIC_')), 'no key and no endpoint override in its environment');
  assert.ok(!Object.values(o.env).includes('value'));
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.permissionMode, 'dontAsk');
  assert.deepEqual(o.tools, ['Bash']);
  assert.deepEqual(o.allowedTools, ['Bash(snow *)', 'Bash(snowsql *)']);
  assert.ok(o.disallowedTools.includes('WebFetch') && o.disallowedTools.includes('Read') && o.disallowedTools.includes('Write'));
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.mcpServers, {});
  assert.equal(o.persistSession, false);
  assert.equal(o.cwd, '/virtual/covered-t-1');
  assert.ok(o.hooks.PreToolUse[0].hooks[0]);
  assert.match(seen.prompt, /Tables you may read: analytics\.consent\.appended_phone/);
  assert.match(seen.prompt, /Suppress cells under 11/);
  assert.deepEqual(seen.removed, ['/virtual/covered-t-1']);
  assert.equal(r.usage[0].tokens.input, 10);
});

test('no key, a session not on the helper, a failure and an answer carrying an identifier all release nothing', async () => {
  let queried = false;
  const noKey = fakeDeps([], { check: async () => ({ ok: false, reason: 'the Keychain has no item x' }), query: () => { queried = true; return (async function* () {})(); } });
  assert.deepEqual(await runCoveredTurn({ taskId: 't', ask, phi: settings, ref: keychain }, noKey.deps), { status: 'unavailable', reason: 'the Keychain has no item x' });
  assert.equal(queried, false, 'no key, no turn');

  const wrongSource = fakeDeps([init('none'), result('ready')]);
  const r1 = await runCoveredTurn({ taskId: 't', ask, phi: settings, ref: keychain }, wrongSource.deps);
  assert.equal(r1.status, 'unavailable');
  assert.match(r1.reason, /did not authenticate with the covered key/);

  const ssn = fake.ssn();
  const leaky = fakeDeps([init(), result(`Example row: ${ssn}`)]);
  const r2 = await runCoveredTurn({ taskId: 't', ask, phi: settings, ref: keychain }, leaky.deps);
  assert.equal(r2.status, 'withheld');
  assert.equal(r2.categories, 'ssn ×1');
  assert.ok(!JSON.stringify(r2).includes(ssn), 'the withheld result carries no trace of the value');

  const email = fake.email();
  const crashed = fakeDeps([init(), new Error(`connection reset while reading ${email}`)]);
  const r3 = await runCoveredTurn({ taskId: 't', ask, phi: settings, ref: keychain }, crashed.deps);
  assert.equal(r3.status, 'unavailable');
  assert.match(r3.reason, /error text was withheld by the PII gate/);
  assert.ok(!r3.reason.includes(email));
  assert.deepEqual(crashed.seen.removed, ['/virtual/covered-t-1'], 'the scratch folder goes even when the turn throws');
});

test('the covered session runs only granted read-only commands over the named tables', async () => {
  const [check] = coveredHooks(['snow', 'snowsql'], ['analytics.consent.appended_phone']).PreToolUse[0].hooks;
  const run = (tool_input, tool_name = 'Bash') => check({ hook_event_name: 'PreToolUse', tool_name, tool_input }, 'id', {});
  assert.deepEqual(await run({ command: 'snowsql -q "select count(*) from consent.appended_phone"' }), {});
  const denied = {
    'snowsql -q "insert into consent.appended_phone values (1)"': /only select/,
    'snowsql -q "select count(*) from analytics.members"': /outside the tables/,
    'snowsql -q "select * from consent.appended_phone" > rows.csv': /pipes, redirects/,
    'printenv': /only snow, snowsql/,
    'security find-generic-password -w -s anthropic-phi-api-key': /only snow, snowsql/,
  };
  for (const [command, why] of Object.entries(denied)) {
    const out = await run({ command });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, why, command);
  }
  assert.match((await run({ command: 'snowsql -q "select 1"', run_in_background: true })).hookSpecificOutput.permissionDecisionReason, /background/);
  assert.match((await run({ file_path: '/etc/passwd' }, 'Read')).hookSpecificOutput.permissionDecisionReason, /warehouse commands only/);
  const hostile = { get command() { throw new Error('boom'); } };
  assert.match((await run(hostile)).hookSpecificOutput.permissionDecisionReason, /could not check/);
});

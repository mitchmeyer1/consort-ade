import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyHelperFor, COVERED_VARIABLES, coveredAnswerPrompt, coveredEnv, coveredOutputContract, coveredRolePrompt, parseCoveredAnalyst, PHI_RULES, phiSettings, turnAccounts, turnPhi } from '../src/shared/phi.ts';

test('the covered-analyst marker gives the question, a closed table list and the wanted shape', () => {
  const ask = parseCoveredAnalyst('Planning.\n[covered-analyst: How many members replied uncertain; in September?; tables: Analytics.Consent.appended_phone, ops.events; shape: a count and a share]\nmore');
  assert.deepEqual(ask, { question: 'How many members replied uncertain; in September?', tables: ['analytics.consent.appended_phone', 'ops.events'], shape: 'a count and a share' });
  assert.equal(parseCoveredAnalyst('no marker here'), undefined);
  assert.match(parseCoveredAnalyst('[covered-analyst: How many?; shape: a count]').error, /tables/);
  assert.match(parseCoveredAnalyst('[covered-analyst: How many?; tables: a; shape: ]').error, /filled in/);
  assert.match(parseCoveredAnalyst(`[covered-analyst: q; tables: ${Array.from({ length: 11 }, (_, i) => `t${i}`).join(', ')}; shape: s]`).error, /at most 10/);
  assert.match(parseCoveredAnalyst('[covered-analyst: q; tables: members; drop; shape: s]').error, /not a table name/);
});

test('the answer block is the released text, a withheld notice naming categories, or an unavailable notice that forbids reading rows', () => {
  assert.match(coveredAnswerPrompt({ status: 'released', text: 'About a third.', warnings: [] }), /^## Covered analyst answer\nAbout a third\.\nUse it as given/);
  assert.match(coveredAnswerPrompt({ status: 'released', text: 'x', warnings: ['rows'] }), /The gate noted: rows/);
  const withheld = coveredAnswerPrompt({ status: 'withheld', categories: 'ssn ×1', shapes: 'ssn:NNN-NN-NNNN' });
  assert.match(withheld, /Withheld by the PII gate \(ssn ×1\)/);
  assert.match(withheld, /Narrow the question once/);
  assert.match(coveredAnswerPrompt({ status: 'unavailable', reason: 'no key' }), /Covered analyst unavailable\nno key\. Do not query member rows yourself/);
});

test('the covered child gets no key and nothing of the subscription logins or endpoint overrides, and its own config and temp', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/u', ANTHROPIC_BASE_URL: 'https://proxy.example.com', CLAUDE_CODE_OAUTH_TOKEN: 'token', OPENAI_BASE_URL: 'x', CODEX_HOME: '/c', CLAUDE_CONFIG_DIR: '/logins/a', [COVERED_VARIABLES[0]]: 'value', SNOWFLAKE_CONNECTION: 'default' };
  const env = coveredEnv(base, '/scratch/x');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/u');
  assert.equal(env.SNOWFLAKE_CONNECTION, 'default', 'the warehouse CLI keeps its own settings');
  assert.ok(!Object.keys(env).some((k) => k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_') || k.startsWith('CODEX_')));
  assert.ok(!Object.values(env).includes('value'), 'no covered variable reaches it');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/scratch/x/config');
  assert.equal(env.TMPDIR, '/scratch/x/tmp');
  assert.equal(env.CLAUDE_PII_COVERED, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
});

test('the key helper is a quoted command the child runs itself: a Keychain lookup or a file read', () => {
  assert.equal(apiKeyHelperFor({ kind: 'keychain', service: 'anthropic-phi-api-key' }), "security find-generic-password -w -s 'anthropic-phi-api-key'");
  assert.equal(apiKeyHelperFor({ kind: 'keychain', service: "it's", account: 'consort-cli' }), "security find-generic-password -w -s 'it'\\''s' -a 'consort-cli'");
  assert.equal(apiKeyHelperFor({ kind: 'file', path: '/home/u/.covered key' }), "cat '/home/u/.covered key'");
});

test('with the guard on Codex sits out and every turn knows it; off, nothing changes', () => {
  const accounts = [{ id: 'c', provider: 'claude' }, { id: 'x', provider: 'codex' }];
  assert.deepEqual(turnAccounts({ accounts, phi: { guard: true } }).map((a) => a.id), ['c']);
  assert.deepEqual(turnAccounts({ accounts }).map((a) => a.id), ['c', 'x']);
  assert.deepEqual(turnPhi({ phi: { guard: true } }), { guard: true });
  assert.equal(phiSettings({}).guard, false);
  assert.equal(phiSettings({ phi: { minCell: 20 } }).minCell, 20);
});

test('the rules and the analyst prompts carry the ladder, the read-only rule and the output contract', () => {
  assert.match(PHI_RULES, /\(1\) aggregates.*\(2\) derive.*\(3\) compare hashed identifiers inside predicates or joins only.*\(4\) only then ask the covered analyst/s);
  assert.match(PHI_RULES, /seeded local database only/);
  assert.match(PHI_RULES, /\[covered-analyst: <question>; tables: <db\.schema\.table, …>; shape: <the aggregate you want back>\]/);
  const role = coveredRolePrompt({ question: 'How many?', tables: ['a.b.c'], shape: 'a count' }, ['snow']);
  assert.match(role, /Tables you may read: a\.b\.c\. Commands available: snow/);
  assert.match(coveredOutputContract(11), /Suppress cells under 11 \(write "<11"\)/);
});

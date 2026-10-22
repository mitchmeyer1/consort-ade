import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliModelRank, selectCliModel } from '../src/shared/cliModels.ts';
import { cliReviewRotation, priceFor, usdFor } from '../src/shared/headless.ts';

const models = {
  codex: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol'],
  claude: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
};

test('planning runs on the strongest model, the build one tier below it, coordination on Sol or Sonnet, readers on Luna or Haiku', () => {
  assert.equal(selectCliModel('codex', models.codex, 'planning'), 'gpt-6-astra');
  assert.equal(selectCliModel('claude', models.claude, 'planning'), 'claude-fable-5-1');
  assert.equal(selectCliModel('codex', models.codex, 'implementation'), 'gpt-6.1-sol');
  assert.equal(selectCliModel('claude', models.claude, 'implementation'), 'claude-opus-5');
  assert.equal(selectCliModel('codex', models.codex, 'coordination'), 'gpt-6.1-sol');
  assert.equal(selectCliModel('claude', models.claude, 'coordination'), 'claude-sonnet-5');
  assert.equal(selectCliModel('claude', ['claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'], 'implementation'), 'claude-sonnet-5');
  assert.equal(selectCliModel('claude', ['claude-fable-5-1', 'claude-haiku-4-5'], 'implementation'), 'claude-fable-5-1');
  assert.equal(selectCliModel('codex', models.codex, 'reader'), 'gpt-6-luna');
  assert.equal(selectCliModel('claude', models.claude, 'reader'), 'claude-haiku-4-5-20251001');
  assert.equal(selectCliModel('codex', models.codex, 'frontier'), 'gpt-6-astra');
  assert.equal(selectCliModel('claude', models.claude, 'frontier'), 'claude-fable-5-1');
  assert.ok(cliModelRank('gpt-6-astra') > cliModelRank('gpt-6.1-sol'));
});

test('configured roles survive provider fallback and may name a newer model', () => {
  const policy = { planning: { codex: 'gpt-6.1-sol', claude: 'claude-sonnet-5' } };
  assert.equal(selectCliModel('codex', ['gpt-5.6-sol'], 'planning', policy), 'gpt-6.1-sol');
  assert.equal(selectCliModel('claude', models.claude, 'planning', policy), 'claude-sonnet-5');
  assert.throws(() => selectCliModel('codex', models.codex, 'reader', { reader: { codex: 'claude-haiku-5' } }), /does not belong/);
  assert.equal(selectCliModel('codex', ['gpt-5.6-sol', 'gpt-6-astra'], 'reader'), 'gpt-5.6-sol');
  assert.equal(selectCliModel('claude', ['claude-fable-5-1', 'claude-opus-5', 'claude-haiku-4-5'], 'coordination'), 'claude-opus-5');
  assert.equal(selectCliModel('claude', ['claude-fable-5-1'], 'reader'), 'claude-fable-5-1');
  assert.equal(selectCliModel('codex', [], 'planning'), '');
});

test('CLI review runs one Fable then one Astra, ignoring extra legacy rounds', () => {
  const expected = [{ provider: 'claude', model: 'claude-fable-5-1' }, { provider: 'codex', model: 'gpt-6-astra' }];
  assert.deepEqual(cliReviewRotation(models), expected);
  assert.deepEqual(cliReviewRotation(models, [...expected, { provider: 'claude', model: 'claude-opus-5' }]), expected);
  assert.deepEqual(cliReviewRotation(models, [{ provider: 'codex', model: 'gpt-6.1-sol' }]), expected);
  assert.deepEqual(cliReviewRotation({ codex: models.codex }), [expected[1]]);
  assert.deepEqual(cliReviewRotation({ claude: ['claude-opus-5', 'claude-sonnet-5'] }), [{ provider: 'claude', model: 'claude-opus-5' }]);
  assert.deepEqual(cliReviewRotation({}), []);
});

test('OpenAI standard short-context estimates price current families without generic GPT-5 fallback', () => {
  assert.deepEqual(priceFor('gpt-6-astra'), [10, 50, 1, 12.5]);
  assert.deepEqual(priceFor('gpt-6.1-sol-20261001'), [2, 10, 0.1, 2.5]);
  assert.deepEqual(priceFor('gpt-6-luna'), [0.1, 0.5, 0.01, 0.125]);
  assert.deepEqual(priceFor('gpt-5.6-sol'), [4, 20, 0.4, 5]);
  assert.equal(priceFor('gpt-5.6-terra'), undefined);
  assert.equal(priceFor('gpt-5.6-luna'), undefined);
  assert.equal(priceFor('gpt-9-astra'), undefined);
  assert.equal(usdFor('gpt-6.1-sol', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }), 14.6);
});

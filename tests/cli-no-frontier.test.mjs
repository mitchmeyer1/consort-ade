import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isFrontierModel, selectCliModel, withoutFrontier } from '../src/shared/cliModels.ts';
import { cliReviewRotation, seedModels } from '../src/shared/headless.ts';
import { scannerCriteria } from '../src/shared/scannerCriteria.ts';

test('a no-frontier scanner never picks Fable or Astra for any role', () => {
  const models = withoutFrontier(seedModels());
  for (const provider of ['claude', 'codex'])
    for (const role of ['planning', 'implementation', 'coordination', 'reader', 'frontier'])
      assert.ok(!isFrontierModel(selectCliModel(provider, models[provider], role)), `${provider} ${role}`);
  assert.match(selectCliModel('claude', models.claude, 'frontier'), /opus/);
  assert.match(selectCliModel('claude', models.claude, 'planning'), /opus/);
  for (const pick of cliReviewRotation(models)) assert.ok(!isFrontierModel(pick.model), pick.model);
});

test('the build worker uses the filtered catalog and drops a frontier model a policy names', () => {
  const pipeline = readFileSync(new URL('../src/cli/pipeline.ts', import.meta.url), 'utf8');
  assert.match(pipeline, /job\.noFrontier \? withoutFrontier\(seedModels\(\)\) : seedModels\(\)/);
  assert.match(pipeline, /job\.noFrontier && isFrontierModel\(picked\)/);
});

test('the Scanners table says the scanner stays off frontier models', () => {
  assert.equal(scannerCriteria({ source: 'clickup', filters: { tags: ['easy'] }, noFrontier: true }), 'tag easy; no Fable/Astra');
});

test('the scanner setup questions ask whether a build scanner stays off Fable and Astra, default no', () => {
  const setup = readFileSync(new URL('../src/cli/setup.ts', import.meta.url), 'utf8');
  assert.match(setup, /if \(await yes\(ask, "Easy tickets only: keep this scanner off Fable and Astra\?", false\)\) job\.noFrontier = true;/);
  assert.ok(setup.indexOf('Easy tickets only') < setup.indexOf('s.jobs.push(job as Job)'), 'asked before the scanner is saved');
});

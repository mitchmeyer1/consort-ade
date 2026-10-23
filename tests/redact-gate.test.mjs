// Fixtures come from ./helpers/fake-pii.mjs at run time: no identifier shape is written here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK, redactPii } from '../src/shared/redact.ts';
import * as fake from './helpers/fake-pii.mjs';

test('Slack text also loses the shapes only the gate knows: cards, beneficiary identifiers and anchored phones', () => {
  const card = fake.card(), mbi = fake.mbi(), e164 = fake.e164();
  const out = redactPii(`card ${card}, beneficiary ${mbi}, mobile ${e164}`);
  for (const v of [card, mbi, e164]) assert.ok(!out.includes(v));
  assert.equal(out.split(MASK).length - 1, 3);
});

test('a labelled phone keeps its label, like the other labelled values', () => {
  const digits = fake.e164().slice(2);
  assert.equal(redactPii(`${fake.label('pho', 'ne')}: ${digits}`), `${fake.label('pho', 'ne')}: ${MASK}`);
});

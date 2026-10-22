import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPii } from '../src/shared/redact.ts';

test('names, emails, phones, addresses and labelled patient details become ****', () => {
  const cases = [
    ['reviewing: Will Lerner', 'reviewing: ****'],
    ['Patient JOHN SMITH missed a visit', 'Patient **** missed a visit'],
    ['Called Dr. Patel about it', 'Called **** about it'],
    ['email jane.doe+x@clinic.org now', 'email **** now'],
    ['call (555) 123-4567 or 555.123.4567 or +1 555-123-4567', 'call **** or **** or ****'],
    ['lives at 1234 N Main St, Apt 5, Springfield, IL 62704 today', 'lives at **** today'],
    ['mail to PO Box 42', 'mail to ****'],
    ['DOB: 01/02/1980', 'DOB: ****'],
    ['patient: Quinn Q. Zed, seen Tuesday', 'patient: ****, seen Tuesday'],
    ['MRN #88421', 'MRN #****'],
    ['ssn 123-45-6789', 'ssn ****'],
  ];
  for (const [input, want] of cases) assert.equal(redactPii(input), want, input);
});

test('Slack handles, GitHub logins, links and ordinary task text pass through', () => {
  const keep = [
    '🟠 *Needs <@U0AN014S94H>* · Step 5/5 Approve · <!date^1792700000^updated {time}|updated 19:42 UTC>',
    '<https://github.com/aligned-marketplace/aligned-mono/pull/672|github> · reviewing: @wildebeast',
    '📦 *MIGRATE CURATION TO MONO*\n🟢 *Working* · Step 5/9 Review 1',
    'ports 20000-20099 · $263.4 1050.2M · head ab0b7b1 · 2026-10-22 19:42 · ECONNREFUSED 127.0.0.1:5432',
    'Findings: 2 medium, 6 low; nothing Critical or High · src/cli/slack.ts:42',
    '✓ Env · ✓ Grill · ✓ Build · ▸ *Build 10/18* ▰▰▰▰▰▱▱▱▱▱',
    'Paused: Synonyms Page · all accounts at their limit until 7:40 PM',
    'reviewer swarm: 3 areas in parallel; I will review the export',
  ];
  for (const k of keep) assert.equal(redactPii(k), k);
});

test('an email hidden in a mailto link is masked too', () => {
  assert.equal(redactPii('<mailto:jane@x.org|jane@x.org>'), '<mailto:****|****>');
});

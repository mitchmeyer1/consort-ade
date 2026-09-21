import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firstPrompt, reviewDeliverable, skillSections } from '../src/shared/skillSections.ts';

const skill = `Intro line.\n\n## Phase 0 — scope\nlook around\n\n## Phase 5 — the review file\nWrite pr-<n>.review.json\n- keys\n\n## Phase 6 — summary and link\nEnd with the link.\n\n## Voice\nplain english\n`;

test('named sections come back whole and in order, without their neighbours', () => {
  const out = skillSections(skill, [/^## Phase 6/, /^## Phase 5/]);
  assert.match(out, /^## Phase 5 — the review file\nWrite pr-<n>\.review\.json\n- keys\n\n## Phase 6 — summary and link\nEnd with the link\.$/);
  assert.doesNotMatch(out, /Voice|Phase 0|Intro/);
});

test('the review deliverable is the schema and the link rule from the real skill', () => {
  const out = reviewDeliverable(readFileSync(new URL('../skills/pr-writeup/SKILL.md', import.meta.url), 'utf8'));
  assert.match(out, /^## Phase 5 — the review file/);
  assert.match(out, /pr-<n>\.review\.json/);
  assert.match(out, /## Phase 6 — summary and link/);
  assert.doesNotMatch(out, /## Voice/);
  assert.ok(out.length > 2000 && out.length < 8000, `unexpected size ${out.length}`);
});

test('a prompt with no such sections yields nothing to attach', () => {
  assert.equal(reviewDeliverable('fix the dropdown'), '');
});

test('the first user turn is the prompt the chat was started with', () => {
  assert.equal(firstPrompt({ messages: [{ role: 'system', blocks: [{ type: 'text', text: 'x' }] }, { role: 'user', blocks: [{ type: 'text', text: 'Run the skill' }, { type: 'tool' }] }] }), 'Run the skill\n');
  assert.equal(firstPrompt({ messages: [] }), '');
});

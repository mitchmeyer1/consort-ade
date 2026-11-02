import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVIEW_IGNORE_FILE, REVIEW_RULES_FILE, reviewPolicyNote, reviewPolicySection } from '../src/shared/reviewPolicy.ts';

async function checkout(t, files) {
  const dir = await mkdtemp(join(tmpdir(), 'consort-review-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const file of files) await writeFile(join(dir, file), '# policy');
  return dir;
}

test('a checkout with neither policy file is judged by its own conventions', async (t) => {
  const note = reviewPolicyNote(await checkout(t, []));
  assert.match(note, /has no \.ai-review-rules\.md; judge by its existing conventions/);
  assert.doesNotMatch(note, /ai-review-ignore/);
});

test('the rules file sets severities and the ignore file drops what it covers, each read from the reviewed checkout', async (t) => {
  assert.match(reviewPolicyNote(await checkout(t, [REVIEW_RULES_FILE])), /read them first; a rule's stated severity always wins/);

  const ignoreOnly = reviewPolicyNote(await checkout(t, [REVIEW_IGNORE_FILE]));
  assert.match(ignoreOnly, /has no \.ai-review-rules\.md/);
  assert.match(ignoreOnly, /drop any finding one of them covers, matched by meaning/);

  const both = reviewPolicyNote(await checkout(t, [REVIEW_RULES_FILE, REVIEW_IGNORE_FILE]));
  assert.match(both, /read them first/);
  assert.match(both, /\.ai-review-ignore\.md/);
});

test('the pr-writeup section carries the note into the shared brief and the verify step', async (t) => {
  const dir = await checkout(t, [REVIEW_RULES_FILE, REVIEW_IGNORE_FILE]);
  const section = reviewPolicySection(dir);
  assert.ok(section.startsWith("## The repository's review policy"));
  assert.ok(section.includes(reviewPolicyNote(dir)));
  assert.match(section, /\.consort\/pr-review\/brief\.md/);
});

test("every pr-writeup review states the reviewed repository's policy: the CLI's self-review and the app's PR review", () => {
  const pipeline = readFileSync(new URL('../src/cli/pipeline.ts', import.meta.url), 'utf8');
  const selfReview = pipeline.slice(pipeline.indexOf('export function reviewSkillPrompt'));
  assert.match(selfReview.slice(0, selfReview.indexOf('\n}\n')), /\$\{reviewPolicySection\(worktree\)\}/);

  const app = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  assert.match(app, /policy = `\\n\\n\$\{reviewPolicySection\(worktreePath\)\}`/);
  assert.match(app, /\$\{skill\}\$\{deploy\}\$\{rubric\}\$\{policy\}/);

  const scanner = readFileSync(new URL('../src/cli/reviewJob.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(scanner, /RULES_NOTE/, 'the review scanner uses the shared note, not a copy of its own');
});

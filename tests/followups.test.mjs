import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citationLink, FOLLOWUP_PROMPT, parseFollowups } from '../src/shared/followups.ts';

test('Codex follow-up directives become chips and leave no empty list items behind', () => {
  const text = `Windows retest pass is complete.

- :codex-followup[Fix clear failures]{prompt="Fix BUG-003 immediate watchdog startup and BUG-006 tray scan-health status."}
- :codex-followup[Create Windows checklist]{prompt="Create the exact Windows 11 manual retest checklist for these six bugs."}
- :codex-followup[Add split-window regression]{prompt="Add automated regression coverage for BUG-026 split-window detection and rendering."}`;
  const { text: rest, followups } = parseFollowups(text);
  assert.equal(rest, 'Windows retest pass is complete.');
  assert.deepEqual(followups, [
    { label: 'Fix clear failures', prompt: 'Fix BUG-003 immediate watchdog startup and BUG-006 tray scan-health status.' },
    { label: 'Create Windows checklist', prompt: 'Create the exact Windows 11 manual retest checklist for these six bugs.' },
    { label: 'Add split-window regression', prompt: 'Add automated regression coverage for BUG-026 split-window detection and rendering.' },
  ]);
});

test('Consort follow-up markers work for Claude, with the label standing in for a missing prompt', () => {
  const { text, followups } = parseFollowups(`Done.\n\n[followup: Run the suite | Run the full test suite and report failures]\n[followup: Open a PR]\n`);
  assert.equal(text, 'Done.');
  assert.deepEqual(followups, [
    { label: 'Run the suite', prompt: 'Run the full test suite and report failures' },
    { label: 'Open a PR', prompt: 'Open a PR' },
  ]);
});

test('duplicates collapse, the list is capped, and prose without suggestions is untouched', () => {
  const many = Array.from({ length: 6 }, (_, i) => `[followup: s${i} | do thing ${i}]`).join('\n') + '\n[followup: again | do thing 0]';
  assert.equal(parseFollowups(many).followups.length, 4);
  const plain = 'Nothing to suggest here.\n\n- a real bullet\n- another';
  assert.deepEqual(parseFollowups(plain), { text: plain, followups: [] });
});

test('Codex file citations render as file links that keep the sheet and range', () => {
  const raw = 'path="/Users/someone/Downloads/Project Test/Plan.xlsx" purpose="source" artifact_kind="workbook" sheet="Defect Log" range="A4:P13"';
  assert.equal(citationLink(raw), '[Plan.xlsx · Defect Log A4:P13](</Users/someone/Downloads/Project Test/Plan.xlsx>)');
  assert.equal(citationLink('purpose="source"'), '');
  const { text } = parseFollowups('Criteria came from the :codex-file-citation{path="/tmp/a.xlsx" sheet="Log"} rows.');
  assert.equal(text, 'Criteria came from the [a.xlsx · Log](</tmp/a.xlsx>) rows.');
});

test('the shared prompt teaches the marker the parser reads', () => {
  assert.match(FOLLOWUP_PROMPT, /\[followup: short label \| the full prompt to send\]/);
  const { followups } = parseFollowups('[followup: short label | the full prompt to send]');
  assert.equal(followups[0].prompt, 'the full prompt to send');
});

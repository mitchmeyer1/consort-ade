import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_SECTIONS, classifyLink, dossierFile, dossierMarkdown, extractLinks, investigatePrompt, investigationChatName, INVESTIGATE_BLURB } from '../src/shared/investigate.ts';

const ticket = { source: 'clickup', id: '17thtp0hvw7', url: 'https://app.clickup.com/t/17thtp0hvw7', title: 'Scope October Sprint Scope for APC Admin' };

test('links are pulled from text once each and sorted into what Consort can read and what it cannot', () => {
  const text = 'See https://app.clickup.com/t/abc123. Also https://github.com/aligned/mono/pull/525, https://github.com/aligned/mono/issues/494 and https://docs.google.com/document/d/xyz/edit. Again https://app.clickup.com/t/abc123';
  assert.deepEqual(extractLinks(text), ['https://app.clickup.com/t/abc123', 'https://github.com/aligned/mono/pull/525', 'https://github.com/aligned/mono/issues/494', 'https://docs.google.com/document/d/xyz/edit']);
  assert.deepEqual(classifyLink('https://app.clickup.com/t/abc123'), { kind: 'clickup', id: 'abc123' });
  assert.deepEqual(classifyLink('https://github.com/aligned/mono/pull/525'), { kind: 'github-pr', repo: 'aligned/mono', number: 525 });
  assert.deepEqual(classifyLink('https://github.com/aligned/mono/issues/494'), { kind: 'github-issue', repo: 'aligned/mono', number: 494 });
  assert.deepEqual(classifyLink('https://docs.google.com/document/d/xyz/edit'), { kind: 'other', url: 'https://docs.google.com/document/d/xyz/edit' });
  assert.deepEqual(classifyLink('https://www.figma.com/file/1'), { kind: 'other', url: 'https://www.figma.com/file/1' });
});

test('the dossier lives in the root checkout under .consort and reads ticket, comments, linked items, then the links left for the user', () => {
  assert.equal(dossierFile(ticket), '.consort/investigations/clickup-17thtp0hvw7/DOSSIER.md');
  const md = dossierMarkdown({
    ticket, body: 'Sprint scope for October.', status: 'in progress', assignees: ['mitch'],
    comments: [{ author: 'dan', at: '2026-09-30T12:00:00.000Z', text: 'Use S/M/L sizes.' }],
    linked: [{ kind: 'github pr', ref: '#525', url: 'https://github.com/aligned/mono/pull/525', title: 'ClickUp Gantt', status: 'open', excerpt: 'Reads the sprint timeline.' }],
    unreadable: ['https://docs.google.com/document/d/xyz/edit'],
    fetchedAt: Date.UTC(2026, 9, 2),
  });
  assert.match(md, /^# Scope October Sprint Scope for APC Admin\n\n- Source: ClickUp task 17thtp0hvw7\n- URL: https:\/\/app\.clickup\.com\/t\/17thtp0hvw7\n- Status in the tracker: in progress\n- Assignees: mitch\n- Fetched by Consort: 2026-10-02T00:00:00\.000Z/);
  assert.match(md, /## Description\n\nSprint scope for October\./);
  assert.match(md, /## Comments \(1\)\n\n### dan · 2026-09-30T12:00:00\.000Z\n\nUse S\/M\/L sizes\./);
  assert.match(md, /## Linked items Consort read \(1\)\n\n### github pr #525 — ClickUp Gantt\n\n- URL: https:\/\/github\.com\/aligned\/mono\/pull\/525\n- Status: open\n\nReads the sprint timeline\./);
  assert.match(md, /## Links Consort could not read\n\n[\s\S]*- https:\/\/docs\.google\.com\/document\/d\/xyz\/edit\n$/);
  const bare = dossierMarkdown({ ticket, body: '', assignees: [], comments: [], linked: [], unreadable: [], fetchedAt: 0 });
  assert.match(bare, /_The ticket has no description\._[\s\S]*_No comments\._[\s\S]*_Nothing linked that Consort could read\._[\s\S]*_None\._/);
});

test('the investigation prompt is read-only, points at the dossier and the code, asks for unreadable links, and demands the four sections', () => {
  const p = investigatePrompt({ ticket, dossierPath: '/root/.consort/investigations/clickup-17thtp0hvw7/DOSSIER.md', projectName: 'aligned-mono', worktreePath: '/root', unreadable: ['https://docs.google.com/document/d/xyz/edit'] });
  assert.match(p, /read-only investigation: no branch, no code changes, nothing written to the tracker/);
  assert.match(p, /dossier Consort wrote at \/root\/\.consort\/investigations\/clickup-17thtp0hvw7\/DOSSIER\.md/);
  assert.match(p, /could not read 1 link in the ticket[\s\S]*ask the user to paste its content/);
  assert.match(p, /read the code in \/root/);
  for (const s of BRIEF_SECTIONS) assert.match(p, new RegExp(`\\*\\*${s}\\*\\*`));
  assert.doesNotMatch(investigatePrompt({ ticket, dossierPath: '/d', projectName: 'x', worktreePath: '/root', unreadable: [] }), /Consort could not read \d+ link/);
  assert.equal(investigationChatName(ticket), 'investigate · 17thtp0hvw7 · Scope October Sprint Scope for APC Admin');
  assert.match(INVESTIGATE_BLURB, /before anyone builds it/);
});

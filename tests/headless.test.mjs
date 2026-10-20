import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimComment, claimedByOther, claimOf, githubLoginOf, matchesFilters, parseAskUser, prReadiness, replyAfter, reviewRotation, stripAskUser, suggestReviewers } from '../src/shared/headless.ts';
import { shipPrompt } from '../src/shared/shipPrompt.ts';
import { newShipFeature } from '../src/shared/ship.ts';

const ticket = { source: 'clickup', id: '86abc', url: 'https://app.clickup.com/t/86abc', title: 'Export the roster as CSV' };

test('questions for the owner are marker lines; they are collected once each and stripped from what is posted', () => {
  const text = 'Decided the column order myself.\n[ask-user: Should the export include archived members? — recommended: no]\nMore text\n[ask-user: Should the export include archived members? — recommended: no]\n[ask-user: Which timezone for dates — recommended: the org setting]\n';
  assert.deepEqual(parseAskUser(text), ['Should the export include archived members? — recommended: no', 'Which timezone for dates — recommended: the org setting']);
  assert.equal(stripAskUser(text), 'Decided the column order myself.\nMore text');
  assert.deepEqual(parseAskUser('nothing to ask'), []);
});

test('headless ship prompts carry the unattended rules and the headless grilling handler', () => {
  const f = newShipFeature(ticket, 'export-roster', 1000);
  const p = shipPrompt({ feature: f, form: { form: 'resume' }, worktree: '/w', branch: 'b', base: 'origin/main', headless: true });
  assert.match(p, /Headless run: nobody is watching/);
  assert.match(p, /Grilling, headless/);
  assert.match(p, /\[ask-user: Q — recommended: A\]/);
  assert.doesNotMatch(p, /Interview the user in rounds/);
  const live = shipPrompt({ feature: f, form: { form: 'resume' }, worktree: '/w', branch: 'b', base: 'origin/main' });
  assert.doesNotMatch(live, /Headless run/);
  assert.match(live, /Interview the user in rounds/);
});

test('a job takes a ticket only when every filter holds: tag, status, title substrings, assignee', () => {
  const t = { id: '1', title: 'Add CSV export for roster', status: 'to do', tags: ['ai-handle', 'backend'], assignees: ['sam@example.com'], url: 'u' };
  assert.equal(matchesFilters(t, {}), true);
  assert.equal(matchesFilters(t, { tags: ['AI-Handle'] }), true);
  assert.equal(matchesFilters(t, { tags: ['frontend'] }), false);
  assert.equal(matchesFilters(t, { statuses: ['TO DO'] }), true);
  assert.equal(matchesFilters(t, { statuses: ['in progress'] }), false);
  assert.equal(matchesFilters(t, { nameIncludes: ['csv', 'roster'] }), true);
  assert.equal(matchesFilters(t, { nameIncludes: ['csv', 'invoice'] }), false);
  assert.equal(matchesFilters(t, { nameExcludes: ['export'] }), false);
  assert.equal(matchesFilters(t, { assignees: ['SAM@example.com'] }), true);
  assert.equal(matchesFilters(t, { assignees: ['ada'] }), false);
});

test('a claim is a comment naming the host; another host within three days is skipped, a stale one is not', () => {
  const mine = claimComment('box-a', Date.UTC(2026, 9, 20, 12));
  assert.match(mine, /^\[consort-claim host=box-a at=2026-10-20T12:00:00\.000Z\]/);
  const comments = [{ text: 'looks good' }, { text: mine }];
  assert.deepEqual(claimOf(comments), { host: 'box-a', at: Date.UTC(2026, 9, 20, 12) });
  const hourLater = Date.UTC(2026, 9, 20, 13);
  assert.equal(claimedByOther(comments, 'box-b', hourLater), true);
  assert.equal(claimedByOther(comments, 'box-a', hourLater), false, 'my own claim');
  assert.equal(claimedByOther(comments, 'box-b', Date.UTC(2026, 9, 25)), false, 'abandoned after three days');
  assert.equal(claimedByOther([{ text: 'no claim here' }], 'box-b', hourLater), false);
});

test('review rounds rotate: the other provider first when there are two, then the strongest Claude, then the next family down', () => {
  const both = reviewRotation({ claude: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5'], codex: ['gpt-6-astra', 'gpt-5.6-sol'] });
  assert.deepEqual(both, [{ provider: 'codex', model: 'gpt-6-astra' }, { provider: 'claude', model: 'claude-fable-5-1' }, { provider: 'claude', model: 'claude-opus-5' }]);
  const claudeOnly = reviewRotation({ claude: ['claude-fable-5-1', 'claude-opus-5'] });
  assert.deepEqual(claudeOnly.map((p) => p.model), ['claude-fable-5-1', 'claude-opus-5', 'claude-fable-5-1']);
  const codexOnly = reviewRotation({ codex: ['gpt-6-astra', 'gpt-5.6-sol'] });
  assert.deepEqual(codexOnly.map((p) => `${p.provider}:${p.model}`), ['codex:gpt-6-astra', 'codex:gpt-5.6-sol', 'codex:gpt-6-astra']);
  assert.deepEqual(reviewRotation({}), []);
});

test('a PR is ready to merge on one fixed test: open, not draft, a human approval, no changes requested, no open threads, CI green', () => {
  const base = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', approvals: ['ada'], unresolved: [], ci: 'pass', requestedReviewers: [] };
  assert.deepEqual(prReadiness(base), { ready: true, reasons: [] });
  assert.deepEqual(prReadiness({ ...base, approvals: ['consort-bot'] }, ['consort-bot']).reasons, ['no human approval yet']);
  assert.deepEqual(prReadiness({ ...base, isDraft: true, ci: 'pending' }).reasons, ['PR is a draft', 'CI still running']);
  assert.deepEqual(prReadiness({ ...base, reviewDecision: 'CHANGES_REQUESTED', unresolved: [{ id: 't', author: 'ada', body: 'x', url: 'u', createdAt: '' }] }).reasons, ['changes requested', '1 unresolved thread']);
  assert.deepEqual(prReadiness({ ...base, state: 'MERGED' }).reasons, ['PR is merged']);
});

test('reviewers come from who touched the files, bots and the owner left out, GitHub logins read from noreply addresses', () => {
  const shortlog = '    42\tAda Lovelace <1+ada@users.noreply.github.com>\n    30\tGrace Hopper <grace@example.com>\n    12\tdependabot[bot] <support@github.com>\n     3\tMe Myself <9+me@users.noreply.github.com>\n';
  assert.deepEqual(suggestReviewers(shortlog, ['me']), ['ada', 'Grace Hopper']);
  assert.deepEqual(suggestReviewers(shortlog, ['me'], 1), ['ada']);
  assert.equal(githubLoginOf('1+ada@users.noreply.github.com'), 'ada');
  assert.equal(githubLoginOf('grace@example.com'), undefined);
  assert.deepEqual(suggestReviewers('', []), []);
});

test("the owner's reply is their first message in the thread after the question, never the bot's own", () => {
  const msgs = [
    { ts: '100.1', user: 'UOWNER', text: 'earlier chatter' },
    { ts: '100.5', bot_id: 'B1', text: 'I need you on one thing' },
    { ts: '100.9', user: 'USOMEONE', text: 'not the owner' },
    { ts: '101.2', user: 'UOWNER', text: '  yes, include archived  ' },
    { ts: '101.9', user: 'UOWNER', text: 'second message' },
  ];
  assert.equal(replyAfter(msgs, '100.5', 'UOWNER'), 'yes, include archived');
  assert.equal(replyAfter(msgs, '101.9', 'UOWNER'), undefined);
});

test('the account pool: sticky while usable, least recently used otherwise, blocked ones skipped, and when every one is out the earliest unblock is known', async () => {
  const { pickAccount, earliestUnblock } = await import('../src/shared/headless.ts');
  const now = 1_000_000;
  const accounts = [
    { id: 'a', provider: 'claude', lastUsedAt: 900 },
    { id: 'b', provider: 'claude', lastUsedAt: 100 },
    { id: 'c', provider: 'claude', blockedUntil: now + 5000, lastUsedAt: 0 },
    { id: 'd', provider: 'codex', lastUsedAt: 0 },
  ];
  assert.equal(pickAccount(accounts, 'claude', now, 'a').id, 'a', 'sticky');
  assert.equal(pickAccount(accounts, 'claude', now, 'c').id, 'b', 'sticky but blocked → least recently used');
  assert.equal(pickAccount(accounts, 'claude', now).id, 'b');
  assert.equal(pickAccount(accounts, 'claude', now, undefined, ['b']).id, 'a');
  assert.equal(pickAccount(accounts, 'codex', now).id, 'd');
  assert.equal(pickAccount([{ id: 'x', provider: 'claude', blockedUntil: now + 1 }], 'claude', now), undefined);
  assert.equal(pickAccount(accounts, 'claude', now + 6000, 'c').id, 'c', 'a block expires');
  assert.equal(earliestUnblock(accounts, 'claude', now), now + 5000);
  assert.equal(earliestUnblock(accounts, 'codex', now), undefined);
});

test('the dashboard keeps finished tasks for two hours, then drops them; running ones always show', async () => {
  const { visibleTasks, ago } = await import('../src/shared/headless.ts');
  const h = 3_600_000, now = 10 * h;
  const tasks = [
    { id: 'live', status: 'working', updatedAt: now - 9 * h },
    { id: 'fresh', status: 'ready', finishedAt: now - 1 * h, updatedAt: now - 1 * h },
    { id: 'old', status: 'done', finishedAt: now - 3 * h, updatedAt: now - 3 * h },
    { id: 'legacy', status: 'failed', updatedAt: now - 2.5 * h },
  ];
  assert.deepEqual(visibleTasks(tasks, now).map((t) => t.id), ['live', 'fresh']);
  assert.equal(ago(5 * 60_000), '5m');
  assert.equal(ago(2 * h + 5 * 60_000), '2h 05m');
  assert.equal(ago(28 * h), '1d 4h');
});

test('the setup wizard parses what people paste: ClickUp list URLs or ids, Slack member ids in any wrapper, and numbered or named choices', async () => {
  const { clickupListIdFrom, slackUserIdFrom, chooseFrom } = await import('../src/shared/headless.ts');
  const setupDone = (s) => !!s.setupCompletedAt;
  assert.equal(clickupListIdFrom('https://app.clickup.com/90120345/v/li/901234567'), '901234567');
  assert.equal(clickupListIdFrom(' 901234567 '), '901234567');
  assert.equal(clickupListIdFrom('roster'), undefined);
  assert.equal(slackUserIdFrom('U0123ABCD'), 'U0123ABCD');
  assert.equal(slackUserIdFrom('<@U0123ABCD>'), 'U0123ABCD');
  assert.equal(slackUserIdFrom('https://x.slack.com/team/W0ABCDEF1'), 'W0ABCDEF1');
  assert.equal(slackUserIdFrom('mitch'), undefined);
  const statuses = ['TO DO', 'IN PROGRESS', 'IN REVIEW', 'COMPLETE'];
  assert.deepEqual(chooseFrom('1,3', statuses), ['TO DO', 'IN REVIEW']);
  assert.deepEqual(chooseFrom('in progress, complete', statuses), ['IN PROGRESS', 'COMPLETE']);
  assert.deepEqual(chooseFrom('9, nope, 2, 2', statuses), ['IN PROGRESS']);
  assert.equal(setupDone({ version: 1, accounts: [], jobs: [], tasks: [] }), false);
  assert.equal(setupDone({ version: 1, accounts: [], jobs: [], tasks: [], setupCompletedAt: 1 }), true);
});

test('the evidence manifest is read leniently and rendered as a PR comment with images inline and a ticket comment with links, each pointing at the other', async () => {
  const { parseEvidenceManifest, evidenceMarkdownForPr, evidenceTextForTicket, EVIDENCE_PROMPT } = await import('../src/shared/headless.ts');
  assert.equal(parseEvidenceManifest('{nope'), undefined);
  assert.equal(parseEvidenceManifest(null), undefined);
  const m = parseEvidenceManifest(JSON.stringify({ kind: 'frontend', summary: 'Export works end to end.', seeded: 'pnpm seed:roster (40 members)', items: [
    { title: 'Roster page with the new Export button', image: './.consort/ship/evidence/01-roster.png', note: 'filters applied' },
    { title: 'Downloaded CSV head', text: 'id,name,email\n1,Ada,ada@x', command: 'head -3 roster.csv' },
    { title: 'bad: no image or text' },
    { title: 'bad image type', image: 'notes.txt' },
    { bogus: true },
  ] }));
  assert.equal(m.kind, 'frontend');
  assert.deepEqual(m.items.map((i) => [i.title, i.image, !!i.text]), [['Roster page with the new Export button', '01-roster.png', false], ['Downloaded CSV head', undefined, true]]);
  const pr = evidenceMarkdownForPr(m, { '01-roster.png': 'https://cdn.example/01.png' }, 'https://app.clickup.com/t/86abc', '86abc');
  assert.match(pr, /^## Evidence\n/);
  assert.match(pr, /Ticket: 86abc \(https:\/\/app\.clickup\.com\/t\/86abc\)\nLocal data: pnpm seed:roster/);
  assert.match(pr, /### 1\. Roster page with the new Export button\nfilters applied\n\n!\[Roster page with the new Export button\]\(https:\/\/cdn\.example\/01\.png\)/);
  assert.match(pr, /### 2\. Downloaded CSV head\n\n```\n\$ head -3 roster\.csv\n```\n\n```\nid,name,email\n1,Ada,ada@x\n```/);
  const missing = evidenceMarkdownForPr(m, {}, 'u', 'r');
  assert.match(missing, /_\(image 01-roster\.png could not be published\)_/);
  const ticket = evidenceTextForTicket(m, { '01-roster.png': 'https://cdn.example/01.png' }, 'https://github.com/o/r/pull/42');
  assert.match(ticket, /PR: https:\/\/github\.com\/o\/r\/pull\/42/);
  assert.match(ticket, /1\. Roster page with the new Export button — filters applied\n   https:\/\/cdn\.example\/01\.png/);
  assert.match(ticket, /2\. Downloaded CSV head\n   \$ head -3 roster\.csv\n   id,name,email/);
  assert.match(ticket, /with the images inline, is on the PR/);
  const p = EVIDENCE_PROMPT({ helper: '/w/.consort/tools/screenshot.cjs', ticketUrl: 'T', prUrl: 'P', worktree: '/w' });
  assert.match(p, /seed a local database/);
  assert.match(p, /--text "<title>"/);
  assert.match(p, /real output only, never mocked/);
});

test("every task gets its own port block and Docker names, and the rules on each turn say so", async () => {
  const { allocatePortBase, taskEnv, ENVIRONMENT_RULES, ENVIRONMENT_PROMPT, PORT_FLOOR, PORT_BLOCK } = await import('../src/shared/headless.ts');
  assert.equal(allocatePortBase([]), PORT_FLOOR);
  assert.equal(allocatePortBase([PORT_FLOOR, PORT_FLOOR + PORT_BLOCK]), PORT_FLOOR + 2 * PORT_BLOCK);
  assert.equal(allocatePortBase([PORT_FLOOR], PORT_FLOOR + PORT_BLOCK), PORT_FLOOR + PORT_BLOCK, 'a floor skips lower blocks');
  const env = taskEnv('consort-abc', 20300);
  assert.equal(env.COMPOSE_PROJECT_NAME, 'consort-abc');
  assert.equal(env.PORT, '20300');
  assert.equal(env.CONSORT_DB_PORT, '20310');
  assert.equal(env.CONSORT_REDIS_PORT, '20311');
  assert.equal(env.CONSORT_PORT_RANGE, '20300-20399');
  const rules = ENVIRONMENT_RULES(env);
  assert.match(rules, /io\.consort\.run=consort-abc/);
  assert.match(rules, /use only 20300-20399/);
  assert.match(rules, /Never the defaults \(5432, 6379, 3000, 8080/);
  assert.match(rules, /never edit the repo's tracked env or config files/);
  assert.match(rules, /\.consort\/env\/up\.sh/);
  const prompt = ENVIRONMENT_PROMPT(env);
  assert.match(prompt, /docker-compose\*\.yml/);
  assert.match(prompt, /\.consort\/ship\/ENV\.md/);
  assert.match(prompt, /responds on 20300/);
  assert.match(prompt, /do not install system packages/);
});

test('a pasted ClickUp sidebar link is a list, a folder or a space; a bare id is a list unless named', async () => {
  const { clickupScopeFrom, clickupListIdFrom } = await import('../src/shared/headless.ts');
  assert.deepEqual(clickupScopeFrom('https://app.clickup.com/9013448339/v/s/90131945617'), { kind: 'space', id: '90131945617' });
  assert.deepEqual(clickupScopeFrom('https://app.clickup.com/9013448339/v/f/90130001/li/900'), { kind: 'folder', id: '90130001' });
  assert.deepEqual(clickupScopeFrom('https://app.clickup.com/9013448339/v/li/901234567'), { kind: 'list', id: '901234567' });
  assert.deepEqual(clickupScopeFrom('901234567'), { kind: 'list', id: '901234567' });
  assert.deepEqual(clickupScopeFrom('space 90131945617'), { kind: 'space', id: '90131945617' });
  assert.equal(clickupScopeFrom('roster'), undefined);
  assert.equal(clickupListIdFrom('https://app.clickup.com/9013448339/v/s/90131945617'), undefined, 'a space is not a list');
});

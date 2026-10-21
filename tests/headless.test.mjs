import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimComment, claimedByOther, claimHeld, claimOf, githubLoginOf, matchesFilters, parseAskUser, prReadiness, replyAfter, reviewRotation, stripAskUser, suggestReviewers, taskStep } from '../src/shared/headless.ts';
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
  const hourLater = Date.UTC(2026, 9, 20, 13);
  assert.deepEqual(claimOf(comments, hourLater), { host: 'box-a', at: Date.UTC(2026, 9, 20, 12) });
  assert.equal(claimedByOther(comments, 'box-b', hourLater), true);
  assert.equal(claimedByOther(comments, 'box-a', hourLater), false, 'my own claim');
  assert.equal(claimedByOther(comments, 'box-b', Date.UTC(2026, 9, 25)), false, 'abandoned after three days');
  assert.equal(claimedByOther([{ text: 'no claim here' }], 'box-b', hourLater), false);
});

test('two boxes that race to claim agree on one winner: the earliest fresh marker; a stale marker from a dead box does not count', () => {
  const t0 = Date.UTC(2026, 9, 20, 12, 0, 0);
  const a = { text: claimComment('box-a-1f2e', t0 + 200) };
  const b = { text: claimComment('box-b-9c0d', t0 + 350) };
  // both posted, both re-read the same two comments (in either order)
  for (const comments of [[a, b], [b, a]]) {
    assert.equal(claimHeld(comments, 'box-a-1f2e', t0 + 2000), true, 'a posted first, a holds');
    assert.equal(claimHeld(comments, 'box-b-9c0d', t0 + 2000), false, 'b backs off');
  }
  // a four-day-old marker from a box that died is ignored; the fresh one wins
  const dead = { text: claimComment('old-box', t0 - 4 * 24 * 3_600_000) };
  assert.equal(claimOf([dead, b], t0 + 2000).host, 'box-b-9c0d');
  assert.equal(claimedByOther([dead], 'box-b-9c0d', t0), false);
  // a box that only ever saw its own marker holds the ticket
  assert.equal(claimHeld([b], 'box-b-9c0d', t0 + 2000), true);
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

test('a PR is ready to merge on one fixed test: open, not draft, one requested approval, no changes requested, no open threads, CI green', () => {
  const base = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', approvals: ['ada', 'bob'], unresolved: [], ci: 'pass', requestedReviewers: ['ada', 'bob'] };
  assert.deepEqual(prReadiness(base), { ready: true, reasons: [] });
  assert.deepEqual(prReadiness({ ...base, approvals: ['consort-bot'] }, ['consort-bot']).reasons, ['awaiting approval from a selected reviewer']);
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

test('the dashboard keeps finished tasks for a day, then drops them; running ones always show', async () => {
  const { visibleTasks, ago } = await import('../src/shared/headless.ts');
  const h = 3_600_000, now = 10 * h;
  const tasks = [
    { id: 'live', status: 'working', updatedAt: now - 9 * h },
    { id: 'fresh', status: 'ready', finishedAt: now - 1 * h, updatedAt: now - 1 * h },
    { id: 'old', status: 'done', finishedAt: now - 3 * h, updatedAt: now - 3 * h },
    { id: 'legacy', status: 'failed', updatedAt: now - 2.5 * h },
    { id: 'stale', status: 'done', finishedAt: now - 25 * h, updatedAt: now - 25 * h },
  ];
  assert.deepEqual(visibleTasks(tasks, now).map((t) => t.id), ['live', 'fresh', 'old', 'legacy']);
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
  assert.match(pr, /Ticket: 86abc \(https:\/\/app\.clickup\.com\/t\/86abc\)  \nLocal data: pnpm seed:roster/);
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
  assert.deepEqual(clickupScopeFrom('https://app.clickup.com/9013448339/v/s/90131945617'), { kind: 'space', id: '90131945617', teamId: '9013448339' });
  assert.deepEqual(clickupScopeFrom('https://app.clickup.com/9013448339/v/f/90130001/li/900'), { kind: 'folder', id: '90130001', teamId: '9013448339' });
  assert.deepEqual(clickupScopeFrom('https://app.clickup.com/9013448339/v/li/901234567'), { kind: 'list', id: '901234567', teamId: '9013448339' });
  assert.deepEqual(clickupScopeFrom('901234567'), { kind: 'list', id: '901234567' });
  assert.deepEqual(clickupScopeFrom('space 90131945617'), { kind: 'space', id: '90131945617' });
  assert.equal(clickupScopeFrom('roster'), undefined);
  assert.equal(clickupListIdFrom('https://app.clickup.com/9013448339/v/s/90131945617'), undefined, 'a space is not a list');
});

test('a saved secret is shown back masked, never in full', async () => {
  const { masked } = await import('../src/shared/headless.ts');
  assert.equal(masked('xoxb-1234567890-abcdefgh'), 'xoxb-…efgh');
  assert.equal(masked('short'), '••••');
  assert.ok(!masked('pk_12345678_ABCDEFGHIJKL').includes('12345678_ABCD'));
});

test('an account row shows 5-hour, weekly and per-model meters as short bars coloured by how full they are', async () => {
  const { usageBars, usageBarText } = await import('../src/shared/headless.ts');
  const bars = usageBars([
    { id: 'five_hour', label: '5-hour', percent: 24, resetsAt: 5 },
    { id: 'seven_day', label: 'Weekly', percent: 83 },
    { id: 'model:Fable', label: 'Weekly · Fable', percent: 97, model: 'Fable' },
    { id: 'model:Opus 4', label: 'Weekly · Opus 4', percent: 10, model: 'Opus 4', locked: true },
  ]);
  assert.deepEqual(bars.map((b) => [b.short, b.percent, b.tone]), [['5h', 24, 'ok'], ['wk', 83, 'high'], ['fable', 97, 'full'], ['opus', 10, 'full']]);
  assert.equal(usageBarText(bars[0]), '5h ▰▰▱▱▱▱▱▱▱▱  24');
  assert.equal(usageBarText(bars[2], 4, (s, tone) => `<${tone}>${s}`), 'fable <full>▰▰▰▰  97');
  assert.deepEqual(usageBars([{ id: 'primary', label: '5-hour', percent: 0 }, { id: 'secondary', label: 'Weekly', percent: 0 }]).map((b) => b.short), ['5h', 'wk'], 'Codex names its windows the same way');
});

test('the dashboard shows a task as step n of the road and names the step after it', () => {
  const at = (over) => taskStep({ status: 'working', reviewsDone: 0, feature: { stage: 'Grilling' }, ...over });
  assert.deepEqual(at({}), { n: 1, total: 9, name: 'Environment', next: 'Grilling' });
  assert.deepEqual(at({ envReadyAt: 1 }), { n: 2, total: 9, name: 'Grilling', next: 'Build' });
  assert.equal(at({ envReadyAt: 1, status: 'waiting' }).n, 2);
  assert.equal(at({ envReadyAt: 1, feature: { stage: "Spec'd" } }).name, 'Build');
  assert.equal(at({ envReadyAt: 1, feature: { stage: 'Implementing' } }).name, 'Build');
  assert.deepEqual(at({ envReadyAt: 1, feature: { stage: 'Implementing', built: true } }), { n: 4, total: 9, name: 'Test', next: 'Review 1' });
  assert.equal(at({ envReadyAt: 1, feature: { stage: 'Ready to Test' } }).n, 4);
  assert.deepEqual(at({ envReadyAt: 1, feature: { stage: 'In Review' }, reviewsDone: 1 }), { n: 6, total: 9, name: 'Review 2', next: 'Review 3' });
  assert.deepEqual(at({ envReadyAt: 1, feature: { stage: 'In Review' }, reviewsDone: 3 }), { n: 8, total: 9, name: 'Evidence', next: 'Watch PR' });
  assert.deepEqual(at({ envReadyAt: 1, status: 'monitoring', feature: { stage: 'In Review', evidenceAt: 1 }, reviewsDone: 3 }), { n: 9, total: 9, name: 'Watch PR', next: 'Ready to merge' });
  assert.deepEqual(at({ envReadyAt: 1, status: 'ready', feature: { stage: 'In Review', evidenceAt: 1 }, reviewsDone: 3 }), { n: 9, total: 9, name: 'Ready to merge', next: '' });
  assert.equal(at({ envReadyAt: 1, status: 'done', feature: { stage: 'Merged' }, reviewsDone: 3 }).name, 'Done');
  assert.equal(at({ envReadyAt: 1, status: 'failed', feature: { stage: 'Implementing', built: true }, reviewsDone: 0 }).name, 'Test');
  assert.equal(taskStep({ status: 'working', envReadyAt: 1, reviewsDone: 0, feature: { stage: 'In Review' } }, 2).total, 8);
});

test('the DIFF cell reads git shortstat and reads as +added −removed with a file count', async () => {
  const { parseShortstat, diffCell } = await import('../src/shared/headless.ts');
  assert.deepEqual(parseShortstat(' 3 files changed, 40 insertions(+), 2 deletions(-)\n'), { files: 3, added: 40, removed: 2 });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)\n'), { files: 1, added: 1, removed: 0 });
  assert.deepEqual(parseShortstat(''), { files: 0, added: 0, removed: 0 });
  assert.equal(diffCell({ files: 3, added: 40, removed: 2 }), '+40 −2 ·3f');
  assert.equal(diffCell({ files: 0, added: 0, removed: 0 }), '+0 −0');
  assert.equal(diffCell(undefined), '');
});

test('turns use Codex when Claude is blocked, with sticky accounts per provider and reset recovery', async () => {
  const { pickTurnAccount } = await import('../src/shared/headless.ts');
  const now = 1000;
  const accounts = [
    { id: 'c1', provider: 'claude', blockedUntil: 2000 },
    { id: 'c2', provider: 'claude', blockedUntil: 3000 },
    { id: 'x1', provider: 'codex', lastUsedAt: 10 },
    { id: 'x2', provider: 'codex', lastUsedAt: 20 },
  ];
  assert.equal(pickTurnAccount(accounts, 'claude', now, {}).id, 'x1');
  assert.equal(pickTurnAccount(accounts, 'claude', now, { codex: 'x2' }).id, 'x2');
  assert.equal(pickTurnAccount(accounts, 'claude', 2000, {}).id, 'c1');
  const blocked = accounts.map(a => ({ ...a, blockedUntil: 5000 }));
  assert.equal(pickTurnAccount(blocked, 'claude', now, {}), undefined);
  assert.equal(pickTurnAccount([...blocked, { id: 'new', provider: 'codex' }], 'claude', now, {}).id, 'new');
  assert.equal(pickTurnAccount([{ id: 'c', provider: 'claude' }], 'codex', now, {}).id, 'c');
});

test('STATUS says whether the agent is moving: running, waiting on Slack, at a limit, stalled, or stopped', async () => {
  const { taskHealth } = await import('../src/shared/headless.ts');
  const now = Date.UTC(2026, 9, 20, 21);
  const accounts = [{ id: 'c1', provider: 'claude' }, { id: 'c2', provider: 'claude', blockedUntil: now + 3_600_000 }];
  const t = (o) => ({ status: 'working', accountIds: { claude: 'c1' }, ...o });
  assert.equal(taskHealth(t({}), accounts, { workerAlive: true, logAgeMs: 30_000 }, now).label, 'RUNNING');
  assert.equal(taskHealth(t({ status: 'waiting' }), accounts, { workerAlive: true, logAgeMs: 0 }, now).label, 'WAITING');
  assert.equal(taskHealth(t({}), accounts, { workerAlive: true, logAgeMs: 11 * 60_000 }, now).label, 'STALLED');
  assert.equal(taskHealth(t({}), accounts, { workerAlive: false, logAgeMs: 0 }, now).label, 'STOPPED', 'a live status with no worker process is stopped');
  assert.deepEqual(taskHealth(t({ status: 'failed', note: 'worker exited 1' }), accounts, { workerAlive: false, logAgeMs: 0 }, now), { label: 'STOPPED', tone: 'bad', note: 'worker exited 1' });
  const allBlocked = accounts.map((a) => ({ ...a, blockedUntil: now + 1 }));
  assert.equal(taskHealth(t({}), allBlocked, { workerAlive: true, logAgeMs: 0 }, now).label, 'LIMIT');
  assert.equal(taskHealth(t({ activity: 'all claude accounts at their limit until 9:20 PM' }), accounts, { workerAlive: true, logAgeMs: 0 }, now).label, 'LIMIT');
  assert.equal(taskHealth(t({ activeProvider: 'codex', accountIds: { claude: 'c2', codex: 'x1' } }), [...allBlocked, { id: 'x1', provider: 'codex' }], { workerAlive: true, logAgeMs: 0 }, now).label, 'RUNNING', 'blocked Claude accounts do not mark a running Codex turn as limited');
  assert.equal(taskHealth(t({ status: 'ready' }), accounts, { workerAlive: false, logAgeMs: 0 }, now).label, 'COMPLETED');
  assert.equal(taskHealth(t({ status: 'monitoring' }), accounts, { workerAlive: true, logAgeMs: 5 * 60_000 }, now).label, 'WAITING', 'watching the PR waits on humans or CI');
});


test('completion requires one selected reviewer, excludes bots and author, and respects GitHub review requirements', () => {
  const pr = { state: 'OPEN', isDraft: false, approvals: ['ada', 'bob'], author: 'builder', reviewDecision: 'APPROVED', unresolved: [], ci: 'pass', requestedReviewers: [] };
  const ready = p => prReadiness({ ...pr, ...p }, ['builder'], ['ada', 'bob']);
  assert.equal(ready({}).ready, true);
  assert.equal(ready({ approvals: ['ada'] }).ready, true);
  assert.equal(ready({ approvals: ['bob'] }).ready, true);
  for (const approvals of [[], ['other'], ['builder'], ['bot[bot]']]) assert.equal(ready({ approvals }).ready, false);
  assert.equal(ready({ approvals: ['ada', 'other'] }).ready, true);
  assert.equal(ready({ approvals: ['ada', 'builder'] }).ready, true);
  assert.equal(ready({ approvals: ['ada', 'bot[bot]'] }).ready, true);
  assert.equal(ready({ reviewDecision: 'REVIEW_REQUIRED' }).ready, false);
  for (const ci of ['fail', 'pending', 'none']) assert.equal(ready({ ci }).ready, false);
  assert.equal(prReadiness(pr).ready, false, 'missing saved reviewer identities cannot count as completion');
});


test('all unattended turns pre-authorize cumulative sub-dollar AI calls and existing env keys', async () => {
  const { AI_COST_POLICY, HEADLESS_RULES, EVIDENCE_PROMPT } = await import('../src/shared/headless.ts');
  assert.match(AI_COST_POLICY, /combined additional cost for this task/);
  assert.match(AI_COST_POLICY, /below USD 1\.00/);
  assert.match(AI_COST_POLICY, /Count all planned calls, retries, and earlier calls/);
  assert.match(AI_COST_POLICY, /may reach USD 1\.00 or cannot be conservatively bounded/);
  assert.match(AI_COST_POLICY, /copy only that named variable.*without another confirmation/);
  assert.ok(HEADLESS_RULES.includes(AI_COST_POLICY));
  const evidence = EVIDENCE_PROMPT({ helper: '/helper', ticketUrl: 'ticket', prUrl: 'pr', worktree: '/work', repoRoot: '/root-repo' });
  assert.ok(evidence.includes(AI_COST_POLICY));
  assert.match(evidence, /For a missing credential/);
});

test('a task\'s cost grows turn by turn: Claude Code\'s own dollars are kept, Codex tokens are priced from the table, unknown models count tokens only', async () => {
  const { addTurnCost, costCell, costLine, priceFor, usdFor, evidenceMarkdownForPr, evidenceTextForTicket } = await import('../src/shared/headless.ts');
  assert.deepEqual(priceFor('claude-opus-5-5-20260401'), priceFor('claude-opus-5-5'));
  assert.deepEqual(priceFor('gpt-5.1-codex-max'), priceFor('gpt-5-codex'));
  assert.equal(priceFor('llama-9'), undefined);
  assert.equal(usdFor('claude-opus-5-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 4);
  let c = addTurnCost(undefined, [{ model: 'claude-fable-5-1', tokens: { input: 1000, output: 500, cacheRead: 20_000, cacheWrite: 0 }, usd: 0.4 }]);
  assert.equal(c.turns, 1); assert.equal(c.usd, 0.4);
  c = addTurnCost(c, [{ model: 'gpt-5-codex', tokens: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 } }]);
  assert.equal(c.turns, 2); assert.equal(Math.round(c.usd * 100) / 100, 2.65); assert.equal(c.unpriced, undefined);
  assert.equal(costCell(c), '$2.65 1.1M');
  c = addTurnCost(c, [{ model: 'mystery-1', tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }]);
  assert.deepEqual(c.unpriced, ['mystery-1']); assert.equal(costCell(c), '~$2.65 1.1M');
  assert.equal(costCell(undefined), '');
  const line = costLine(c);
  assert.match(line, /^Agent cost: ~\$2\.65 \(est\.\) over 3 turns and 1\.1M tokens/);
  assert.match(line, /no price known for mystery-1/);
  const m = { kind: 'backend', summary: 'It works.', items: [{ title: 'Ran it', text: 'ok' }] };
  assert.match(evidenceMarkdownForPr(m, {}, 'https://t', 'T-1', c), /Agent cost: ~\$2\.65/);
  assert.match(evidenceTextForTicket(m, {}, 'https://pr', c), /Agent cost: ~\$2\.65/);
  assert.doesNotMatch(evidenceTextForTicket(m, {}, 'https://pr'), /Agent cost/);
});

test('Slack lines are short bullets; the verifier\'s essay becomes a few blockers and an approval with prose around it still counts', async () => {
  const { slackLines, blockerBullets, evidenceApproved, brief } = await import('../src/shared/headless.ts');
  assert.ok(evidenceApproved('Everything checks out.\n[evidence-approved]. Nothing else to do.'));
  assert.ok(!evidenceApproved('Blocked: the API key tile shows API KEY REQUIRED.'));
  const essay = "Evidence inspection did not pass: Nothing's running; I'll bring up the test DBs and re-run the 24 backend tests myself. The sign-in screenshot shows a 500 from the API. OPENAI_API_KEY is required and not set. Let me check the logs now. The Playwright specs did not run.";
  const bullets = blockerBullets(essay);
  assert.ok(bullets.length >= 3 && bullets.length <= 5, bullets.join('|'));
  assert.ok(bullets.some((b) => /OPENAI_API_KEY/.test(b)));
  assert.ok(!bullets.some((b) => /^Let me|^I'll/.test(b)), 'narration is dropped');
  const msg = slackLines.problem({ where: 'evidence', lead: 'Evidence blocked. PR not handed off', what: 'The evidence check did not pass', why: bullets, ask: 'If a key is missing: add it to `/repo/.env`, then reply "done".' }, 'https://t');
  assert.match(msg, /^❌ \*Evidence blocked\. PR not handed off\* \(<https:\/\/t\|ticket>\)\n• The evidence check did not pass\n/);
  assert.ok(msg.split('\n').filter((l) => l.startsWith('• ')).length === bullets.length + 1);
  assert.ok(!/I will not hand off/.test(msg));
  assert.match(msg, /\n_If a key is missing: .*\/repo\/\.env.*_$/);
  assert.equal(slackLines.question(['Keep archived members? — recommend: no'], 'https://t'), '❌ *Need you* (<https://t|ticket>)\n• Keep archived members? — recommend: no\n_Reply in this thread._');
  assert.equal(slackLines.review(2, 'claude-opus-5', 0), '✅ Review 2 on `claude-opus-5`: 0 findings');
  assert.equal(slackLines.evidence(3, 2, '$4.10'), '✅ Evidence posted to the PR and the ticket: 3 items, 2 images\n• Cost so far: $4.10');
  assert.equal(slackLines.answered(3, 1), '✅ Answered 3 review comments; 1 still open');
  assert.equal(brief('a'.repeat(50) + '. ' + 'b'.repeat(300), 120).endsWith('…'), true);
  for (const line of [slackLines.claimed('T', 'https://t', 'mm/x'), slackLines.ready('https://pr'), slackLines.stuck('the PR vanished'), slackLines.watching(15), slackLines.env('20000-20099')]) {
    for (const l of line.split('\n')) assert.ok(l.length <= 160, l);
  }
});


test('the stop report carries where, what, the agent\'s last lines newest first, the raw error in a code block, and how to reply', async () => {
  const { slackLines, problemOf, ProblemError } = await import('../src/shared/headless.ts');
  const msg = slackLines.problem({ where: 'evidence', what: 'The agent exceeded 15 minutes on one turn and was stopped', recent: ['Reading the ticket', 'Starting the app', 'CI shard 4 failed on the pushed commit', 'Rerunning that job and finishing the manifest'], tried: 'one attempt', error: 'Error: aborted\n  stderr: ECONNRESET' }, 'https://t');
  assert.equal(msg.split('\n')[0], '❌ *Stuck at evidence* (<https://t|ticket>)');
  assert.match(msg, /\n• Last seen: Rerunning that job and finishing the manifest\n• Before that: CI shard 4 failed on the pushed commit\n• Before that: Starting the app\n• Tried: one attempt\n```\nError: aborted\n  stderr: ECONNRESET\n```\n_Reply "retry", or say what to do\._$/);
  assert.ok(!/Reading the ticket/.test(msg), 'only the last three lines');
  assert.ok(!/```/.test(slackLines.problem({ where: 'worker', what: 'x' })), 'no empty code block');
  // a plain error: first line is the summary; the rest, stderr and the exit code are the raw error
  const gh = Object.assign(new Error('Command failed: gh pr edit 639 --add-reviewer x\nGraphQL: Could not resolve user with login \'x\'.'), { stderr: 'gh: GraphQL error', code: 1 });
  const p = problemOf(gh, 'PR watch', { recent: ['pushing'], ask: 'Say what to do.' });
  assert.equal(p.where, 'PR watch');
  assert.equal(p.what, 'Command failed: gh pr edit 639 --add-reviewer x');
  assert.match(p.error, /GraphQL: Could not resolve user/);
  assert.match(p.error, /exit 1/);
  assert.match(p.error, /gh: GraphQL error/);
  assert.deepEqual(p.recent, ['pushing']);
  // a code bug keeps the top of its stack; an ordinary failure does not
  const bug = problemOf(new TypeError("Cannot read properties of undefined (reading 'prs')"), 'worker');
  assert.match(bug.error ?? '', /at /);
  assert.ok(!/at /.test(problemOf(new Error('Slack unavailable'), 'worker').error ?? ''));
  // a ProblemError keeps its own fields and takes the caller's stage and recent lines only when it has none
  const kept = problemOf(new ProblemError({ where: '', what: 'timed out', recent: [] }), 'evidence', { recent: ['last line'], ask: 'Reply.' });
  assert.deepEqual([kept.where, kept.what, kept.recent, kept.ask], ['evidence', 'timed out', ['last line'], 'Reply.']);
  assert.equal(problemOf(new ProblemError({ where: 'evidence', what: 'timed out', recent: ['own'] }), 'worker', { recent: ['caller'] }).recent[0], 'own');
  assert.equal(problemOf('a string reason', 'worker').what, 'a string reason');
});

test('Slack emojis distinguish blockages, updates, and the final merge handoff', async () => {
  const { slackLines, slackMessage } = await import('../src/shared/headless.ts');
  for (const text of [slackLines.question(['Which design?'], 'url'), slackLines.stuck('quota exhausted'), slackLines.problem({ where: 'evidence', what: 'Missing key' })]) {
    assert.ok(text.startsWith('❌ '), text);
    assert.ok(!text.includes('🎉'));
  }
  for (const text of [slackLines.claimed('Ticket', 'url', 'branch'), slackLines.stage('In Review'), slackLines.pr('url'), slackLines.review(3, 'model', 0), slackLines.evidence(3, 2), slackLines.reviewers(['ada', 'bob']), slackLines.watching(3), slackLines.answered(2, 0), slackLines.env('20000')]) {
    assert.ok(text.startsWith('✅ '), text);
    assert.ok(!text.includes('🎉'));
  }
  assert.ok(slackLines.ready('url').startsWith('🎉🍭🎊 '));
  assert.match(slackLines.ready('url'), /Merge is yours/);
  assert.equal(slackMessage('update', slackLines.ready('url')), slackLines.ready('url'), 'do not duplicate or replace the handoff emojis');
  assert.equal(slackMessage('blocked', 'Waiting for credits'), '❌ Waiting for credits');
});


test('Slack status footers preserve queued statuses and replace stale footers', async () => {
  const { slackStatus } = await import('../src/shared/headless.ts');
  for (const status of ['RUNNING', 'WAITING', 'STOPPED', 'COMPLETED']) {
    const text = slackStatus('Task update', status);
    assert.equal(text, `Task update\n\nSTATUS: ${status}`);
    assert.equal(slackStatus(text), text);
    assert.equal(slackStatus(text, 'RUNNING'), 'Task update\n\nSTATUS: RUNNING');
  }
  assert.match(slackStatus('❌ Need your answer'), /STATUS: WAITING$/);
  assert.match(slackStatus('🎉🍭🎊 Merge is yours'), /STATUS: COMPLETED$/);
  assert.match(slackStatus('✅ Continuing'), /STATUS: RUNNING$/);
});

test('Slack footer shows only ticket and github labels above the final status', async () => {
  const { slackStatus, githubBranchUrl } = await import('../src/shared/headless.ts');
  const links = { ticket: 'https://app.clickup.com/t/T1', github: 'https://github.com/a/b/pull/42' };
  const text = slackStatus('✅ Update', 'RUNNING', links);
  assert.equal(text, '✅ Update\n\n<https://app.clickup.com/t/T1|ticket> · <https://github.com/a/b/pull/42|github>\n\nSTATUS: RUNNING');
  assert.equal(slackStatus(text), text);
  assert.equal(slackStatus(text, undefined, links), text);
  const branch = 'https://github.com/a/b/tree/feature%2Fticket';
  for (const remote of ['git@github.com:a/b.git', 'https://github.com/a/b.git', 'ssh://git@github.com/a/b.git', 'https://token@github.com/a/b.git']) {
    assert.equal(githubBranchUrl(remote, 'feature/ticket'), branch);
  }
  assert.equal(githubBranchUrl('https://gitlab.com/a/b.git', 'feature'), undefined);
  const updated = slackStatus(slackStatus('Update', 'WAITING', { ...links, github: branch }), 'COMPLETED', links);
  assert.equal(updated.match(/\|github>/g).length, 1);
  assert.ok(!updated.includes(branch));
  assert.ok(updated.endsWith('<https://github.com/a/b/pull/42|github>\n\nSTATUS: COMPLETED'));
});

test('evidence timing handles seconds, minutes, days, and missing timestamps', async () => {
  const { evidenceTimingLines } = await import('../src/shared/headless.ts');
  const startedAt = Date.UTC(2026, 9, 21);
  for (const [seconds, expected] of [[0, '0s'], [59, '59s'], [60, '1m 0s'], [90061, '25h 1m 1s']]) {
    assert.equal(evidenceTimingLines({ startedAt, endedAt: startedAt + seconds * 1000 }).at(-1), `Duration (including pauses): ${expected}`);
  }
  assert.deepEqual(evidenceTimingLines(), []);
  assert.deepEqual(evidenceTimingLines({ startedAt, endedAt: startedAt - 1 }), []);
});

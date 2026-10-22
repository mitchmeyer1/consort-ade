import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as owner from '../src/cli/ownerUpdates.ts';

test('acknowledgements start no agent turn; real updates do', () => {
  for (const text of ['thanks', 'Thanks!', 'ok 👍', 'cool', 'thank you so much', 'lgtm', ':+1:']) assert.equal(owner.isAcknowledgement(text), true, text);
  for (const text of ['Use the attached spec instead', 'thanks, also add a CSV export', 'ok but rename the button']) assert.equal(owner.isAcknowledgement(text), false, text);
});

test('Slack files are saved under the update folder; a missing files:read scope is reported, not saved', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'consort-owner-')); t.after(() => rm(root, { recursive: true, force: true }));
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(init.headers.Authorization);
    if (url.endsWith('/spec.pdf')) return new Response('PDFDATA', { headers: { 'content-type': 'application/pdf' } });
    return new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } });
  };
  const result = await owner.downloadSlackFiles('xoxb-1', [
    { name: '../spec.pdf', mimetype: 'application/pdf', url_private_download: 'https://files.slack.com/spec.pdf' },
    { name: 'notes.docx', mimetype: 'application/vnd.openxmlformats', url_private_download: 'https://files.slack.com/notes.docx' },
    { name: 'huge.mov', size: 60 * 1024 * 1024, url_private_download: 'https://files.slack.com/huge.mov' },
  ], root, '1700000000.000100', fetchImpl);
  assert.equal(result.saved.length, 1);
  assert.ok(result.saved[0].startsWith('.consort/ship/updates/1700000000.000100/'));
  assert.ok(!result.saved[0].slice('.consort/ship/updates/1700000000.000100/'.length).includes('/'), 'file names cannot leave the folder');
  assert.equal(await readFile(join(root, result.saved[0]), 'utf8'), 'PDFDATA');
  assert.match(result.failed[0], /notes\.docx: the Slack app needs the files:read scope/);
  assert.match(result.failed[1], /huge\.mov: larger than 50 MB/);
  assert.deepEqual(seen, ['Bearer xoxb-1', 'Bearer xoxb-1']);
});

test('the update prompt only changes code once code exists, and names the PR to push', () => {
  const updates = [{ ts: '2', text: 'Add a CSV export', files: ['.consort/ship/updates/2/spec.pdf'], failedFiles: ['a.docx: needs files:read'], at: 0 }];
  const early = owner.ownerUpdatePrompt(updates, { stage: 'Grilling', built: false, ticketFile: '.consort/ship/updates/2/ticket.md' });
  assert.match(early, /Update only the planning files/);
  assert.match(early, /Add a CSV export[\s\S]*spec\.pdf[\s\S]*a\.docx: needs files:read/);
  assert.match(early, /\.consort\/ship\/updates\/2\/ticket\.md/);
  const late = owner.ownerUpdatePrompt(updates, { stage: 'In Review', built: true, prUrl: 'https://github.com/a/b/pull/9', ticketFile: 'x' });
  assert.match(late, /Change it to match the update[\s\S]*pull\/9 is open: push/);
  assert.equal(owner.parseUpdateSummary('done\n[update-summary: Added CSV export to ticket and code]'), 'Added CSV export to ticket and code');
});

const compile = name => ts.transpileModule(readFileSync(new URL(`../src/cli/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function daemon(worktree) {
  const task = { id: 't', jobId: 'j', worktree, ticket: { id: 'T1', url: 'https://app.clickup.com/t/T1' }, slackThread: '1', slackStatusAfterTs: '1', status: 'working', pid: 123, updatedAt: Date.now(), reviewsDone: 0, accountIds: {}, feature: { stage: 'Implementing', built: false, prs: [] } };
  const state = { slack: { userId: 'owner', botToken: 'xoxb' }, tasks: [task], jobs: [{ id: 'j', repo: '/repo' }], accounts: [] };
  const replies = []; let messages = [];
  const downloads = [];
  const mocks = {
    '../shared/headless.ts': headless,
    './state': { loadState: () => state, updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch) },
    './slackLinks': { taskSlackLinks: async () => ({ ticket: task.ticket.url }) },
    './slack': { Slack: class { async threadMessages() { return messages; } async post(text, thread) { replies.push({ text, thread }); } } },
    './ownerUpdates': { ...owner, downloadSlackFiles: async (token, files, wt, ts) => { downloads.push({ token, ts }); return { saved: files.map(f => `.consort/ship/updates/${ts}/${f.name}`), failed: [] }; } },
    'node:fs': { existsSync: () => true },
    './oversight': { workerLogTail: () => '' },
    './buildProgress': { stepLabel: name => name },
    './sources': { sourceFor: () => ({ comments: async () => [] }) },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compile('slackStatus'))(n => mocks[n], mod, mod.exports);
  return { task, replies, downloads, run: async () => { await mod.exports.answerTaskStatusQuestions(() => true, { answer: async c => ({ answer: `Checked: ${c.question}`, update: /add|rename|change|use/i.test(c.question) ? c.question : undefined, model: 'claude-opus-5' }) }); await mod.exports.settleOwnerReplies(); }, messages: m => { messages = m; } };
}

test('change requests and files are queued; questions and thanks are not', async () => {
  const h = daemon('/wt');
  h.messages([{ ts: '2', user: 'owner', text: 'status' }, { ts: '3', user: 'owner', text: 'thanks' }, { ts: '4', user: 'other', text: 'add CSV' }, { ts: '5', user: 'owner', text: 'Use the attached spec', files: [{ name: 'spec.pdf' }] }]);
  await h.run();
  assert.deepEqual(h.task.ownerUpdates.map(u => [u.ts, u.text, u.files]), [['5', 'Use the attached spec', ['.consort/ship/updates/5/spec.pdf']]]);
  assert.deepEqual(h.downloads, [{ token: 'xoxb', ts: '5' }]);
  assert.equal(h.replies.length, 2);
  assert.match(h.replies[0].text, /^✅ Checked: status\n\n/);
  assert.match(h.replies[1].text, /^✅ Checked: Use the attached spec\n\n\*Queued as a change with 1 file:\* I'll update the ticket and the code after the current step\./);
  assert.equal(h.task.slackStatusAfterTs, '5');
});

test('the answer to a pending question stays with the worker; later messages and attached files are queued', async () => {
  const h = daemon('/wt');
  h.task.pendingQuestion = { questions: ['Which color?'], afterTs: '2' };
  h.messages([{ ts: '3', user: 'owner', text: 'Blue', files: [{ name: 'mock.png' }] }, { ts: '4', user: 'owner', text: 'Also add a legend' }]);
  await h.run();
  assert.deepEqual(h.task.ownerUpdates.map(u => [u.ts, u.files.length]), [['3', 1], ['4', 0]]);
  assert.match(h.task.ownerUpdates[0].text, /answer itself was already applied/);
  assert.equal(h.task.ownerUpdates[1].text, 'Also add a legend');
  assert.match(h.replies[0].text, /^✅ Saved 1 file; I'll add it to the ticket after the current step\./);
  assert.equal(headless.replyAfter([{ ts: '3', user: 'owner', text: 'Blue' }, { ts: '4', user: 'owner', text: 'Also add a legend' }], '2', 'owner'), 'Blue', 'the worker takes the same first message');
});

test('a ready task reopens for an update; a merged task says it cannot apply it', async () => {
  const h = daemon('/wt');
  h.task.status = 'ready'; h.task.finishedAt = 5;
  h.messages([{ ts: '2', user: 'owner', text: 'Rename the button to Export' }]);
  await h.run();
  assert.equal(h.task.status, 'monitoring'); assert.equal(h.task.finishedAt, undefined);
  assert.match(h.replies[0].text, /reopening the task/);
  h.task.status = 'done'; h.task.note = 'PR merged'; h.task.ownerUpdates = [];
  h.messages([{ ts: '3', user: 'owner', text: 'One more change' }]);
  await h.run();
  assert.deepEqual(h.task.ownerUpdates, []);
  assert.match(h.replies[1].text, /^⏹️ Checked: One more change\n\nThis task is closed \(PR merged\), so I can't apply changes here/);
});

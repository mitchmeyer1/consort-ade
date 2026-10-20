import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as seatPool from '../src/shared/seatPool.ts';
import * as ship from '../src/shared/ship.ts';
import { modelTiers } from '../src/shared/modelTiers.ts';
import { usageBlock } from '../src/shared/usage.ts';

const require = createRequire(import.meta.url);
const compile = file => ts.transpileModule(readFileSync(new URL(`../src/cli/${file}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const pipeline = compile('pipeline'), lifecycle = compile('lifecycle');
const halt = new Error('test stopped');
function harness(opts = {}) {
  const events = [], messages = [];
  const task = { id: 't', jobId: 'j', ticket: { id: 'T1', title: 'Example', url: 'https://ticket/1' }, worktree: '/virtual', branch: 'feature', accountIds: {}, sessions: {}, reviewsDone: 0, threadsSeen: [], envReadyAt: 1, evidenceValidatedAt: 1, feature: { stage: 'In Review', prs: ['https://github.com/a/b/pull/1'], evidenceAt: 1 }, ...opts.task };
  const accounts = opts.accounts ?? [{ id: 'c', provider: 'claude', name: 'Claude' }, { id: 'x', provider: 'codex', name: 'Codex' }];
  const state = { tasks: [task], jobs: [{ id: 'j', repo: '/virtual', base: 'main' }], accounts, slack: { userId: 'owner' } };
  let interval, deadline;
  const basePr = { state: 'OPEN', isDraft: false, reviewDecision: '', approvals: [], unresolved: [], requestedReviewers: [], ci: 'pass', url: 'https://github.com/a/b/pull/1' };
  let reads = 0;
  const mocks = {
    'node:fs': { existsSync: () => true, readFileSync: () => '', mkdirSync() {}, writeFileSync() {}, rmSync() {} },
    'node:util': { promisify: () => async (cmd, args) => { events.push(args.join(' ')); return { stdout: '' }; } },
    '../shared/headless.ts': headless, '../shared/seatPool.ts': seatPool, '../shared/ship.ts': ship,
    '../shared/modelTiers.ts': { modelTiers }, '../shared/usage.ts': { usageBlock },
    '../shared/shipPrompt.ts': { shipPrompt: () => 'fix findings' },
    '../shared/review.ts': { parseReview: () => ({}), reviewSummary: () => opts.missingReport ? undefined : opts.summary ?? { total: 0 } },
    '../main/ship': { excludeConsortDir: async () => {}, fetchTicket: async () => ({}), writeTicketFile: () => '' },
    './state': {
      loadState: () => state,
      updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch),
      touchAccount() {}, blockAccount: (id, until, reason) => Object.assign(accounts.find(a => a.id === id), { blockedUntil: until ?? Date.now() + 60000, blockedWhy: reason }),
    },
    './sources': { sourceFor: () => ({ comment: async () => {}, setStatus: async () => {} }) },
    './evidence': { findBrowser: async () => '/browser', writeScreenshotHelper: () => '/helper', validateEvidence: () => { events.push('validate evidence'); return opts.validateEvidence?.(); }, publishEvidence: async () => { events.push('publish evidence'); return opts.publishEvidence?.() ?? { items: 1, images: 1, prComment: true, ticketComment: true }; } },
    './environment': { allocateEnvironment: async () => ({}), cleanupEnvironment: async () => ({}) },
    './slack': { Slack: class { async post(text, thread, broadcast) { if (opts.failPost?.(text)) throw new Error('Slack unavailable'); messages.push({ text, thread, broadcast }); return String(messages.length); } async waitForReply() { events.push('owner reply'); opts.onReply?.(task); return opts.reply ?? 'Proceed'; } } },
    './usage': { readUsage: async a => opts.usage?.(a) ?? ({ at: Date.now(), windows: [] }) },
    './agent': { packageRoot: () => '/package', stopAgents: () => events.push('abort agent'), runTurn: async o => { events.push(`turn:${o.account.provider}`); return opts.turn?.(o, task, interval, deadline) ?? { text: o.prompt.includes(headless.VERIFY_EVIDENCE_PROMPT) ? '[evidence-approved]' : '' }; } },
    './prmonitor': {
      whoAmI: async () => 'me', shortlogForBranch: async () => opts.shortlog ?? ' 2 Ada <1+ada@users.noreply.github.com>\n 1 Bob <2+bob@users.noreply.github.com>',
      requestReviewers: async (_, __, names) => events.push(`reviewers:${names.join(',')}`),
      readPr: async () => { events.push('read PR'); return opts.readPr?.(++reads, basePr, task) ?? { ...basePr, approvals: ['ada'], reviewDecision: 'APPROVED' }; },
    },
  };
  function load(code) {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', 'setTimeout', 'setInterval', 'clearInterval', code)(name => mocks[name] ?? (name.startsWith('.') ? {} : require(name)), mod, mod.exports,
      (fn, ms) => { if (ms === 15 * 60000) { deadline = fn; return 1; } events.push('sleep'); opts.sleep?.(task, accounts); if (!opts.sleep) throw halt; fn(); },
      fn => { interval = fn; return 1; }, () => {});
    return mod.exports;
  }
  mocks['./lifecycle'] = load(lifecycle);
  return { task, accounts, events, messages, work: () => load(pipeline).workTask('t'), notify: mocks['./lifecycle'].notifyTask };
}

test('all providers exhausted: one pause, then a separate resume after reset', async () => {
  let sleeps = 0;
  const h = harness({ accounts: [{ id: 'c', provider: 'claude', name: 'Claude', blockedUntil: Date.now() + 100000 }, { id: 'x', provider: 'codex', name: 'Codex', blockedUntil: Date.now() + 100000 }],
    sleep: (task, accounts) => { assert.equal(task.status, 'waiting'); assert.equal(task.lifecycle, 'paused'); if (++sleeps === 2) accounts[1].blockedUntil = 0; },
    turn: () => { throw halt; },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.messages.filter(m => /\*Paused:/.test(m.text)).length, 1);
  assert.equal(h.messages.filter(m => /\*Resumed:/.test(m.text)).length, 1);
  assert.equal(h.task.status, 'working');
  assert.ok(h.messages.filter(m => /\*(Paused|Resumed):/.test(m.text)).every(m => m.broadcast));
});

test('instant provider fallback produces no pause or resume messages', async () => {
  const h = harness({ task: { envReadyAt: undefined, feature: { stage: 'Implementing' } }, turn: o => { if (o.account.provider === 'claude') return { text: '', limit: { text: 'quota exhausted' } }; throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.deepEqual(h.events.filter(e => e.startsWith('turn:')), ['turn:claude', 'turn:codex']);
  assert.equal(h.messages.filter(m => /\*(Paused|Resumed):/.test(m.text)).length, 0);
});

test('usage probe prevents starting an exhausted Codex account even without a turn error', async () => {
  const h = harness({ usage: a => ({ at: Date.now(), windows: [], ...(a.provider === 'codex' ? { blocked: 'Usage paused by provider' } : {}) }),
    accounts: [{ id: 'c', provider: 'claude', name: 'Claude', blockedUntil: Date.now() + 100000 }, { id: 'x', provider: 'codex', name: 'Codex' }],
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.task.status, 'waiting');
  assert.equal(h.events.filter(e => e.startsWith('turn:')).length, 0);
  assert.equal(h.messages.filter(m => /\*Paused:/.test(m.text)).length, 1);
});

test('usage exhaustion during a turn aborts the stalled agent and pauses', async () => {
  let checks = 0;
  const h = harness({ accounts: [{ id: 'x', provider: 'codex', name: 'Codex' }],
    usage: () => ({ at: Date.now(), windows: [], ...(checks++ ? { blocked: '5-hour window exhausted' } : {}) }),
    turn: async (_, __, tick) => { await tick(); return { text: '', error: 'aborted' }; },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.events.includes('abort agent'));
  assert.equal(h.task.status, 'waiting');
});

test('design questions pause and resume, including a repeated question', async () => {
  let turns = 0;
  const h = harness({ turn: () => { if (++turns <= 2) return { text: '[ask-user: Which business outcome matters?]' }; throw halt; }, onReply: task => { assert.equal(task.status, 'waiting'); assert.ok(task.pendingQuestion); } });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.messages.filter(m => /\*Paused:/.test(m.text)).length, 2);
  assert.equal(h.messages.filter(m => /\*Resumed:/.test(m.text)).length, 2);
  assert.equal(h.task.pendingQuestion, undefined);
});

test('restart waits for the original unanswered Slack question', async () => {
  const h = harness({ task: { lifecycle: 'paused', pendingQuestion: { questions: ['Original design question?'], afterTs: '42' }, status: 'waiting' }, turn: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.events.includes('owner reply'));
  assert.equal(h.messages.filter(m => /I need you/.test(m.text)).length, 0);
});

test('three internal rounds precede two reviewer requests; human feedback resumes then pauses until approval', async () => {
  const h = harness({
    readPr: (n, pr) => n === 1 ? { ...pr, isDraft: true } : n === 2 ? pr : n === 3 ? { ...pr, unresolved: [{ id: 'thread:1', author: 'ada', body: 'Fix label', url: 'url' }] } : { ...pr, approvals: ['ada'], reviewDecision: 'APPROVED' },
    sleep: () => {},
  });
  await h.work();
  const reviewers = h.events.indexOf('reviewers:ada,bob');
  assert.equal(h.events.slice(0, reviewers).filter(e => e.startsWith('turn:')).length, 3);
  assert.ok(h.events.indexOf('pr ready 1') < reviewers);
  assert.equal(h.task.reviewsDone, 3);
  assert.equal(h.task.status, 'ready');
  assert.equal(h.task.lifecycle, 'completed');
  assert.ok(h.messages.some(m => /\*Paused:/.test(m.text)));
  assert.ok(h.messages.some(m => /\*Resumed:/.test(m.text)));
  assert.ok(!h.events.some(e => /pr merge/.test(e)));
});

test('CI failure runs a fix turn and waits for passing CI', async () => {
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] }, readPr: (n, pr) => n < 3 ? { ...pr, ci: 'fail' } : { ...pr, approvals: ['ada'] }, sleep() {} });
  await h.work();
  assert.equal(h.events.filter(e => e.startsWith('turn:')).length, 1);
  assert.equal(h.task.status, 'ready');
});

test('missing internal report cannot finish a review round', async () => {
  const h = harness({ missingReport: true });
  await assert.rejects(h.work(), /did not write a valid review report/);
  assert.equal(h.task.reviewsDone, 0);
  const failed = harness({ summary: { total: 1 }, turn: o => { if (o.prompt.includes('fix findings')) throw halt; return { text: '' }; } });
  await assert.rejects(failed.work(), e => e === halt);
  assert.equal(failed.task.reviewsDone, 0);
});

test('worker stops and restarts announce separate transitions; repeated stop is deduplicated', async () => {
  const h = harness();
  await h.notify('t', 'running', 'started');
  await h.notify('t', 'stopped', 'process exited');
  await h.notify('t', 'stopped', 'process exited');
  await h.notify('t', 'running', 'restarted');
  assert.equal(h.messages.filter(m => /\*Stopped:/.test(m.text)).length, 1);
  assert.equal(h.messages.filter(m => /\*Resumed:/.test(m.text)).length, 1);
});

test('usage blocks respect all exhausted windows, reset times, staleness and model scope', () => {
  const now = 1000000;
  const usage = windows => ({ at: now, windows });
  assert.equal(usageBlock(usage([{ label: 'Fable', percent: 100, model: 'Fable' }]), now), undefined);
  assert.equal(usageBlock(usage([{ label: '5-hour', percent: 100, resetsAt: now - 1 }]), now), undefined);
  assert.equal(usageBlock({ at: 0, windows: [], blocked: 'old' }, now), undefined);
  assert.equal(usageBlock(usage([{ label: '5-hour', percent: 100, resetsAt: now + 100 }, { label: 'Weekly', percent: 100, resetsAt: now + 200 }]), now).until, now + 200);
  assert.equal(usageBlock({ ...usage([]), blocked: 'paused' }, now).reason, 'paused');
});


test('failed Slack delivery is queued and retried without losing the pause', async () => {
  let fail = true;
  const h = harness({ failPost: () => fail });
  await h.notify('t', 'paused', 'all accounts exhausted');
  assert.equal(h.task.notificationQueue.length, 1);
  fail = false;
  await h.notify('t', 'paused', 'all accounts exhausted');
  assert.equal(h.task.notificationQueue.length, 0);
  assert.equal(h.messages.filter(m => /Paused:/.test(m.text)).length, 1);
});

test('unknown reviewer names ask Slack rather than skipping reviewers', async () => {
  const h = harness({ task: { reviewsDone: 3 }, shortlog: ' 2 Ada Lovelace <ada@company.com>', reply: 'ada,bob' });
  await h.work();
  assert.ok(h.messages.some(m => /Which two GitHub reviewers/.test(m.text)));
  assert.ok(h.events.includes('reviewers:ada,bob'));
  assert.equal(h.task.status, 'ready');
});

test('no checks or bot-only approvals cannot mark a PR completed', () => {
  const pr = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', approvals: ['bot[bot]'], unresolved: [], ci: 'none', requestedReviewers: [] };
  assert.deepEqual(headless.prReadiness(pr), { ready: false, reasons: ['no human approval yet', 'no CI checks reported'] });
});


test('failed evidence pauses on Slack and cannot request reviewers or complete', async () => {
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, validateEvidence: () => { throw new Error('Map tiles show API KEY REQUIRED'); }, onReply: task => {
    assert.equal(task.status, 'waiting');
    assert.equal(task.feature.evidenceAt, undefined);
    assert.equal(task.evidenceValidatedAt, undefined);
    throw halt;
  } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.messages.some(m => /API KEY REQUIRED/.test(m.text) && /root env file/.test(m.text)));
  assert.ok(!h.events.includes('publish evidence'));
  assert.ok(!h.events.some(e => e.startsWith('reviewers:')));
});

test('confirmed root env repair retries capture and inspection before publishing', async () => {
  let repaired = false;
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, validateEvidence: () => { if (!repaired) throw new Error('Missing MAP_API_KEY'); }, reply: 'I added MAP_API_KEY to the root .env; copy that variable now.', onReply: () => { repaired = true; } });
  await h.work();
  assert.equal(h.events.filter(e => e === 'validate evidence').length, 2);
  assert.equal(h.events.filter(e => e === 'publish evidence').length, 1);
  assert.ok(h.task.evidenceValidatedAt);
  assert.equal(h.task.status, 'ready');
  assert.ok(h.events.indexOf('owner reply') < h.events.indexOf('publish evidence'));
});

test('independent inspection rejects a passed manifest with broken screenshots', async () => {
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, turn: o => ({ text: o.prompt.includes(headless.VERIFY_EVIDENCE_PROMPT) ? 'API KEY REQUIRED appears instead of the map.' : '' }), onReply: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.messages.some(m => /inspection did not pass.*API KEY REQUIRED/.test(m.text)));
  assert.ok(!h.events.includes('publish evidence'));
});

test('evidence publication failure pauses instead of marking evidence complete', async () => {
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, publishEvidence: () => ({ items: 1, prComment: true, ticketComment: false }), onReply: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.task.evidenceValidatedAt, undefined);
  assert.equal(h.task.feature.evidenceAt, undefined);
  assert.ok(h.messages.some(m => /not published to both/.test(m.text)));
});

test('a stalled capture is aborted and asks Slack for help after fifteen minutes', async () => {
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, turn: (_, __, ___, deadline) => { deadline(); return { text: '', error: 'aborted' }; }, onReply: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.events.includes('abort agent'));
  assert.ok(h.messages.some(m => /exceeded 15 minutes/.test(m.text)));
  assert.ok(!h.events.includes('publish evidence'));
});

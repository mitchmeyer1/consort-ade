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
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
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
    './slackIdentity': { ensureSlackIdentity: async () => {} },
    './slackLinks': { taskSlackLinks: async t => ({ ticket: t.ticket.url, github: t.feature?.prs?.at(-1) ?? 'https://github.com/a/b/tree/feature' }) },
    './statusLog': { statusEvent: (tone, text) => events.push(`status:${tone}:${text}`) },
    './state': {
      loadState: () => state,
      updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch),
      touchAccount() {}, blockAccount: (id, until, reason) => Object.assign(accounts.find(a => a.id === id), { blockedUntil: until ?? Date.now() + 60000, blockedWhy: reason }),
    },
    './sources': { sourceFor: () => ({ comment: async () => {}, setStatus: async () => {} }) },
    './evidence': { findBrowser: async () => '/browser', writeScreenshotHelper: () => '/helper', validateEvidence: () => { events.push('validate evidence'); return opts.validateEvidence?.(); }, publishEvidence: async () => { events.push('publish evidence'); return opts.publishEvidence?.() ?? { items: 1, images: 1, prComment: true, ticketComment: true }; } },
    './environment': { allocateEnvironment: async () => ({}), cleanupEnvironment: async () => ({}) },
    './slack': { Slack: class { async post(text, thread, broadcast) { if (opts.failPost?.(text)) throw new Error('Slack unavailable'); messages.push({ text, thread, broadcast }); return String(messages.length); } async waitForReply(thread, ts, options) { options?.onCheck?.('answer'); events.push('owner reply'); opts.onReply?.(task); return opts.reply ?? 'Proceed'; } } },
    './usage': { readUsage: async a => opts.usage?.(a) ?? ({ at: Date.now(), windows: [] }) },
    './agent': { packageRoot: () => '/package', stopAgents: () => events.push('abort agent'), runTurn: async o => { events.push(`turn:${o.account.provider}`); return opts.turn?.(o, task, interval, deadline) ?? { text: o.prompt.includes(headless.VERIFY_EVIDENCE_PROMPT) ? '[evidence-approved]' : '' }; } },
    './prmonitor': {
      validateReviewers: async (_, names) => names.filter(n => ['ada','bob'].includes(n)),
      reviewerSuggestions: async () => opts.suggestions ?? (opts.shortlog ? [] : ["ada", "bob"]),
      whoAmI: async () => 'me', shortlogForBranch: async () => opts.shortlog ?? ' 2 Ada <1+ada@users.noreply.github.com>\n 1 Bob <2+bob@users.noreply.github.com>',
      requestReviewers: async (_, __, names) => events.push(`reviewers:${names.join(',')}`),
      readPr: async () => { events.push('read PR'); return opts.readPr?.(++reads, basePr, task) ?? { ...basePr, approvals: ['ada', 'bob'], reviewDecision: 'APPROVED' }; },
    },
  };
  function load(code) {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', 'setTimeout', 'setInterval', 'clearInterval', 'Date', code)(name => mocks[name] ?? (name.startsWith('.') ? {} : require(name)), mod, mod.exports,
      (fn, ms) => { if (ms === 15 * 60000) { deadline = fn; return 1; } clock += ms ?? 0; events.push('sleep'); opts.sleep?.(task, accounts); if (!opts.sleep) throw halt; fn(); },
      fn => { interval = fn; return 1; }, () => {}, Clock);
    return mod.exports;
  }
  mocks['./lifecycle'] = load(lifecycle);
  return { task, accounts, events, messages, work: () => load(pipeline).workTask('t'), notify: mocks['./lifecycle'].notifyTask, run: (work, isStopping) => mocks['./lifecycle'].runTaskUntilFinished('t', work, () => events.push('stop agents'), isStopping) };
}

test('all providers exhausted: one pause, then a separate resume after reset', async () => {
  let sleeps = 0;
  const h = harness({ accounts: [{ id: 'c', provider: 'claude', name: 'Claude', blockedUntil: Date.now() + 100000 }, { id: 'x', provider: 'codex', name: 'Codex', blockedUntil: Date.now() + 100000 }],
    sleep: (task, accounts) => { assert.equal(task.status, 'waiting'); assert.equal(task.lifecycle, 'paused'); if (++sleeps === 2) accounts[1].blockedUntil = 0; },
    turn: () => { throw halt; },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.messages.filter(m => /Paused:/.test(m.text)).length, 1);
  assert.equal(h.messages.filter(m => /Resumed:/.test(m.text)).length, 1);
  assert.equal(h.task.status, 'working');
  assert.ok(h.messages.filter(m => /\*(Paused|Resumed):/.test(m.text)).every(m => m.thread && !m.broadcast));
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
  assert.equal(h.messages.filter(m => /Paused:/.test(m.text)).length, 1);
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
  assert.equal(h.messages.filter(m => /Paused:/.test(m.text)).length, 2);
  assert.equal(h.messages.filter(m => /Resumed:/.test(m.text)).length, 2);
  assert.equal(h.task.pendingQuestion, undefined);
  assert.ok(h.events.some(event => event === 'status:success:Ticket T1: answer found in Slack; continuing'));
});

test('restart waits for the original unanswered Slack question', async () => {
  const h = harness({ task: { lifecycle: 'paused', pendingQuestion: { questions: ['Original design question?'], afterTs: '42' }, status: 'waiting' }, turn: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.events.includes('owner reply'));
  assert.equal(h.messages.filter(m => /I need you/.test(m.text)).length, 0);
});

test('three internal rounds precede two reviewer requests; human feedback resumes then pauses until approval', async () => {
  const h = harness({
    readPr: (n, pr) => n === 1 ? { ...pr, isDraft: true } : n === 2 ? pr : n === 3 || n === 4 ? { ...pr, unresolved: [{ id: 'thread:1', author: 'ada', body: 'Fix label', url: 'url' }] } : { ...pr, approvals: ['ada', 'bob'], reviewDecision: 'APPROVED' },
    sleep: () => {},
  });
  await h.work();
  const reviewers = h.events.indexOf('reviewers:ada,bob');
  assert.equal(h.events.slice(0, reviewers).filter(e => e.startsWith('turn:')).length, 3);
  assert.ok(h.events.indexOf('pr ready 1') < reviewers);
  assert.equal(h.task.reviewsDone, 3);
  assert.equal(h.task.status, 'ready');
  assert.equal(h.task.lifecycle, 'completed');
  assert.ok(h.messages.some(m => /Paused:/.test(m.text)));
  assert.ok(h.messages.some(m => /Resumed:/.test(m.text)));
  assert.ok(!h.events.some(e => /pr merge/.test(e)));
});

test('CI failure runs a fix turn and waits for passing CI', async () => {
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] }, readPr: (n, pr) => n < 3 ? { ...pr, ci: 'fail' } : { ...pr, approvals: ['ada', 'bob'] }, sleep() {} });
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
  assert.equal(h.messages.filter(m => /Stopped:/.test(m.text)).length, 1);
  assert.equal(h.messages.filter(m => /Resumed:/.test(m.text)).length, 1);
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
  assert.deepEqual(headless.prReadiness(pr, [], ['ada', 'bob']), { ready: false, reasons: ['awaiting approval from a selected reviewer', 'no CI checks reported'] });
});


test('failed evidence pauses on Slack and cannot request reviewers or complete', async () => {
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, validateEvidence: () => { throw new Error('Map tiles show API KEY REQUIRED'); }, onReply: task => {
    assert.equal(task.status, 'waiting');
    assert.equal(task.feature.evidenceAt, undefined);
    assert.equal(task.evidenceValidatedAt, undefined);
    throw halt;
  } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.messages.some(m => /^❌ \*Evidence blocked\. PR not handed off\*/.test(m.text) && /\n• Map tiles show API KEY REQUIRED/.test(m.text) && /\.env/.test(m.text)));
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
  assert.ok(h.messages.some(m => /^❌ \*Evidence blocked\./.test(m.text) && /\n• The evidence check did not pass\n• API KEY REQUIRED appears instead of the map\./.test(m.text)));
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
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, turn: (o, _, __, deadline) => { o.onText('CI shard 4 failed on the pushed commit'); o.onText('Rerunning that job and finishing the manifest'); deadline(); return { text: '', error: 'aborted' }; }, onReply: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.events.includes('abort agent'));
  const report = h.messages.find(m => /exceeded 15 minutes/.test(m.text));
  assert.ok(report, 'the timeout is reported');
  // the owner sees what the agent was doing when it was stopped, newest first, and the raw error
  assert.match(report.text, /^❌ \*Evidence blocked\. PR not handed off\*/);
  assert.match(report.text, /\n• Last seen: Rerunning that job and finishing the manifest\n• Before that: CI shard 4 failed on the pushed commit\n/);
  assert.match(report.text, /```\naborted\n```/);
  assert.deepEqual(h.task.recent, ['CI shard 4 failed on the pushed commit', 'Rerunning that job and finishing the manifest']);
  assert.ok(!h.events.includes('publish evidence'));
});


test('one root per ticket: questions, pauses, resumes, and retries reuse its thread', async () => {
  const h = harness({ turn: () => ({ text: '[ask-user: Which design should I use?]' }), onReply: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  const roots = h.messages.filter(m => !m.thread);
  assert.equal(roots.length, 1);
  assert.ok(h.messages.slice(1).every(m => m.thread === h.task.slackThread && !m.broadcast));
  await h.notify('t', 'stopped', 'worker stopped');
  await h.notify('t', 'running', 'worker restarted');
  assert.equal(h.messages.filter(m => !m.thread).length, 1);
  assert.ok(h.messages.slice(1).every(m => m.thread === h.task.slackThread && !m.broadcast));
});


test('review comments wait for an unchanged batch, including same-count replacements', async () => {
  let changes = 0;
  const original = { id: 'first', author: 'ada', body: 'Fix label', url: 'url' };
  const replacement = { ...original, id: 'second', body: 'Fix button' };
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] },
    readPr: (n, pr) => n === 1 ? pr : n === 2 ? { ...pr, unresolved: [original] } : n < 5 ? { ...pr, unresolved: [replacement] } : { ...pr, approvals: ['ada', 'bob'] },
    sleep: () => { changes++; },
    turn: () => { assert.equal(changes, 2, 'replacement comment must restart the three-minute wait'); return { text: '' }; },
  });
  await h.work();
  assert.equal(h.events.filter(e => e.startsWith('turn:')).length, 1);
  assert.ok(h.task.threadsSeen.includes('second'));
  assert.ok(!h.task.threadsSeen.includes('first'));
  assert.equal(h.task.status, 'ready');
});

test('an unresolved thread is not recorded as addressed after a batch turn', async () => {
  const comment = { id: 'first', threadId: 'thread', author: 'ada', body: 'Fix label', url: 'url' };
  let turns = 0;
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] },
    readPr: (_, pr) => ({ ...pr, unresolved: [comment] }), sleep() {},
    turn: () => { if (++turns === 2) throw halt; return { text: '' }; }, onReply: () => { throw halt; },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(!h.task.threadsSeen.includes('first'));
  assert.equal(h.task.status, 'waiting');
});


test('one reviewer approval completes once CI passes without waiting for the second reviewer', async () => {
  let sleeps = 0;
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] },
    readPr: (n, pr) => ({ ...pr, approvals: ['ada'], ci: n < 4 ? 'pending' : 'pass' }), sleep() { sleeps++; },
  });
  await h.work();
  assert.ok(sleeps >= 1, "pending CI must keep the worker polling");
  assert.equal(h.task.status, 'ready');
  assert.ok(h.messages.some(m => /^🎉🍭🎊 \*Ready to merge:\*/.test(m.text) && /1 reviewer approval/.test(m.text)));
});

test('worker failure asks Slack and resumes rather than ending the task', async () => {
  const h = harness({ task: { feature: { stage: 'Implementing', prs: [] }, recent: ['Running the migration', 'Pushing the branch'] } });
  let attempts = 0;
  await h.run(async () => { if (++attempts === 1) throw Object.assign(new Error('Dependency unavailable\nECONNREFUSED 127.0.0.1:5432'), { stderr: 'psql: connection refused', code: 2 }); h.task.status = 'ready'; });
  assert.equal(attempts, 2);
  assert.ok(h.events.includes('owner reply'));
  // the crash report names the stage, the error, the agent's last lines and the raw detail in a code block
  const report = h.messages.find(m => /Dependency unavailable/.test(m.text));
  assert.match(report.text, /^❌ \*Stuck at Implementing\* \(<https:\/\/ticket\/1\|ticket>\)\n• Dependency unavailable\n• Last seen: Pushing the branch\n• Before that: Running the migration\n```\nECONNREFUSED 127\.0\.0\.1:5432\nexit 2\npsql: connection refused\n```\n_Reply with what to do; the task stays open\._\n\n<https:\/\/ticket\/1\|ticket> · <https:\/\/github.com\/a\/b\/tree\/feature\|github>\n\nSTATUS: WAITING$/);
  assert.ok(h.messages.filter(m => !m.thread).length === 1);
  assert.equal(h.task.status, 'ready');
  assert.equal(h.task.recoveryGuidance, 'Proceed');
});

test('four process crashes ask Slack and resume instead of failing permanently', async () => {
  const h = harness({ task: { restarts: 4, note: 'Worker exited repeatedly' } });
  await h.run(async () => { assert.ok(h.events.includes('owner reply')); h.task.status = 'ready'; });
  assert.equal(h.task.restarts, 0);
  assert.equal(h.task.status, 'ready');
});


test('intentional worker shutdown does not ask Slack to recover an aborted turn', async () => {
  const h = harness();
  let stopping = false;
  await h.run(async () => { stopping = true; throw new Error('agent aborted during SIGTERM'); }, () => stopping);
  assert.equal(h.messages.length, 0);
  assert.ok(!h.events.includes('owner reply'));
});

test('planning turns run on the strongest model; build, environment, fix and review-reply turns run one tier down', async () => {
  const tiers = modelTiers('claude');
  const seen = [];
  // environment (worker) → Grilling (orchestrator) → Implementing (worker): the turn text moves the stage along
  let n = 0;
  const h = harness({ task: { envReadyAt: undefined, feature: { stage: 'Grilling', prs: [], history: [] } }, turn: (o) => {
    seen.push({ model: o.model, prompt: o.prompt });
    n++;
    if (n === 1) return { text: 'env ready' };
    if (n === 2) return { text: "[ship-stage: Spec'd | done]" };
    if (n === 3) return { text: '[ship-stage: Implementing | building]' };
    throw halt;
  } });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(seen[0].model, tiers.delegate, 'environment setup is routine');
  assert.equal(seen[1].model, tiers.orchestrator, 'grilling needs judgement');
  assert.equal(seen[2].model, tiers.orchestrator, "spec'd still plans");
  assert.equal(seen[3].model, tiers.delegate, 'implementing executes a settled plan');
  assert.notEqual(tiers.delegate, tiers.orchestrator);
  assert.match(h.task.activity, new RegExp(`running claude ${tiers.delegate}`));
});

test('a CI repair on the watch runs one tier down', async () => {
  const tiers = modelTiers('claude');
  const seen = [];
  const h = harness({ task: { reviewsDone: 3 }, readPr: (n, base) => ({ ...base, ci: 'fail' }),
    turn: (o) => { seen.push(o.model); if (seen.length >= 1) throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(seen[0], tiers.delegate);
});

test('a saved question that was really an approval is dropped on restart instead of re-asked', async () => {
  const h = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined, pendingQuestion: { questions: ['Evidence is blocked: Evidence inspection did not pass: [evidence-approved] All nine captures inspected.'], afterTs: '1' } },
    turn: o => ({ text: o.prompt.includes(headless.VERIFY_EVIDENCE_PROMPT) ? 'Looks right.\n[evidence-approved]' : '' }), onReply: () => { throw new Error('must not wait on Slack'); } });
  await h.work();
  assert.equal(h.task.pendingQuestion, undefined);
  assert.equal(h.task.status, 'ready');
  assert.ok(h.events.includes('publish evidence'));
  assert.ok(h.messages.some(m => /Ignore the question above/.test(m.text)));
  assert.ok(!h.events.includes('owner reply'));
});


test('lifecycle marks pauses as waiting and stops as stopped, and reserves celebration for completion', async () => {
  const h = harness();
  await h.notify('t', 'running', 'Starting');
  await h.notify('t', 'paused', 'Credits exhausted');
  await h.notify('t', 'running', 'Credits restored');
  await h.notify('t', 'stopped', 'Worker stopped');
  await h.notify('t', 'completed', 'Both reviewers and CI approved; merge is yours');
  const notifications = h.messages.filter(m => m.thread);
  assert.deepEqual(notifications.map(m => m.text.match(/STATUS: (\w+)$/)?.[1]), ["RUNNING", "WAITING", "RUNNING", "STOPPED", "COMPLETED"]);
  assert.ok(notifications[0].text.startsWith('✅ '));
  assert.ok(notifications[1].text.startsWith('⏳ '), 'a pause is waiting, not a failure');
  assert.ok(notifications[2].text.startsWith('✅ '));
  assert.ok(notifications[3].text.startsWith('⏹️ '), 'a stop on purpose is not a failure');
  assert.ok(notifications[4].text.startsWith('🎉🍭🎊 '));
  assert.ok(notifications.every(m => m.thread === h.task.slackThread && !m.broadcast));
  assert.ok(notifications.every(m => /<https:\/\/ticket\/1\|ticket> · <https:\/\/github.com\/a\/b\/pull\/1\|github>\n\nSTATUS: \w+$/.test(m.text)));
});

test('a rebooted task opens with a pickup turn that works out where the last run got to, then continues', async () => {
  const prompts = [];
  const h = harness({ task: { rebootedAt: 5, feature: { stage: 'Implementing', prs: [] } }, turn: o => { prompts.push(o.prompt); if (prompts.length > 1) throw halt; return { text: '' }; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(prompts[0].includes(headless.REBOOT_PROMPT), 'the first turn is the pickup');
  assert.ok(!prompts[1].includes(headless.REBOOT_PROMPT), 'then the stage resumes');
  assert.equal(h.task.rebootedAt, undefined);
  assert.ok(h.messages.some(m => /Rebooted by you at \*Implementing\*/.test(m.text)));
  assert.ok(!h.events.includes('owner reply'));
});

test('while a turn runs the thread gets a short Working note: the first agent line right away, then at most one every five minutes', async () => {
  let turns = 0;
  const h = harness({ task: { feature: { stage: 'Implementing', prs: [] } }, turn: o => {
    turns++;
    o.onText('Reading the spec and the ticket');
    o.onText('Writing the migration [ask-user: Keep archived rows? — recommend: no]');
    if (turns === 1) return { text: '[ask-user: Keep archived rows? — recommend: no]' };
    o.onText('Applying the answer');
    throw halt;
  }, onReply: () => {} });
  await assert.rejects(h.work(), e => e === halt);
  const notes = h.messages.filter(m => /Working:/.test(m.text)).map(m => m.text);
  assert.ok(notes.every(text => /STATUS: RUNNING$/.test(text)));
  assert.deepEqual(notes.map(text => text.split('\n')[0]), ['✅ Working: Reading the spec and the ticket', '✅ Working: Reading the spec and the ticket'], 'one note per turn start; the second line is inside the five-minute window; markers never leak');
  assert.ok(notes.every(n => !/ask-user/.test(n)));
});

test('the Paused line says what it is waiting on: the question itself, one line, no markup, so a status reply can repeat it', async () => {
  const h = harness({ turn: () => ({ text: '[ask-user: ryangoggin asked to set routeCount to 3500 in a generated file — recommend: leave it]' }), onReply: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  const paused = h.messages.find(m => /Paused:/.test(m.text));
  assert.match(paused.text, /\nWaiting on you: ryangoggin asked to set routeCount to 3500 in a generated file — recommend: leave it/);
  assert.equal(h.task.pauseReason, 'Waiting on you: ryangoggin asked to set routeCount to 3500 in a generated file — recommend: leave it');
  // a preformatted stop report pauses with its lead and first reason, markup and the ticket link stripped
  const h2 = harness({ task: { reviewsDone: 3, evidenceValidatedAt: undefined }, validateEvidence: () => { throw new Error('Map tiles show API KEY REQUIRED'); }, onReply: () => { throw halt; } });
  await assert.rejects(h2.work(), e => e === halt);
  assert.match(h2.task.pauseReason, /^Waiting on you: Evidence blocked\. PR not handed off · Evidence was not accepted · Map tiles show API KEY REQUIRED/);
  assert.ok(!/[*_<>]/.test(h2.task.pauseReason), h2.task.pauseReason);
});

test('watch names a blocking reviewer and green CI, re-requests once and does not spam', async () => {
  let polls=0;
  const h=harness({task:{reviewsDone:3,reviewersRequested:['ada','bob']},readPr:(n,pr)=>({...pr,headSha:'sha1',reviewDecision:'CHANGES_REQUESTED',changesRequestedBy:['ada']}),sleep(){if(++polls===3)throw halt;}});
  await assert.rejects(h.work(),e=>e===halt);
  assert.equal(h.events.filter(e=>e==='reviewers:ada,bob').length,1);
  assert.ok(h.messages.some(m=>/ada must review again/.test(m.text)&&/CI is green/.test(m.text)&&/Your action: none now/.test(m.text)));
  assert.ok(!h.messages.some(m=>/Waiting on reviews and CI\./.test(m.text)));
});

test('after one hour the PR wait tells the owner whom to nudge', async () => {
  let polls=0;
  const h=harness({task:{reviewsDone:3,reviewersRequested:['ada','bob'],reviewWaitSince:Date.now()-61*60000},readPr:(n,pr)=>({...pr,headSha:'sha1',requestedReviewers:['ada','bob'],changesRequestedBy:['ada'],reviewDecision:'CHANGES_REQUESTED'}),sleep(){if(++polls===1)throw halt;}});
  await assert.rejects(h.work(),e=>e===halt);
  assert.ok(h.messages.some(m=>/Your action: please nudge @ada to review the PR/.test(m.text)));
  assert.equal(h.events.filter(e=>e.startsWith('reviewers:')).length,0,'pending review requests need no duplicate request');
});

test('invalid saved reviewer words are replaced with validated contributors', async () => {
  const h=harness({task:{reviewsDone:3,reviewersRequested:['do','and']}});
  await h.work();assert.deepEqual(h.task.reviewersRequested,['ada','bob']);
  assert.ok(h.events.includes('reviewers:ada,bob'));
  assert.ok(!h.events.includes('reviewers:do,and'));
});

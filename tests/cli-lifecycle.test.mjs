import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as headless from '../src/shared/headless.ts';
import * as seatPool from '../src/shared/seatPool.ts';
import * as ship from '../src/shared/ship.ts';
import * as cliModels from '../src/shared/cliModels.ts';
import * as cliTurnPolicy from '../src/shared/cliTurnPolicy.ts';
import { usageBlock } from '../src/shared/usage.ts';
import * as usageMod from '../src/shared/usage.ts';
import * as ownerUpdates from '../src/cli/ownerUpdates.ts';

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
    'node:fs': { existsSync: () => true, readFileSync: f => opts.readFile?.(f) ?? '', mkdirSync() {}, writeFileSync() {}, rmSync() {} },
    'node:util': { promisify: () => async (cmd, args) => { events.push(args.join(' ')); return { stdout: '' }; } },
    '../shared/headless.ts': headless, '../shared/seatPool.ts': seatPool, '../shared/ship.ts': ship,
    '../shared/cliModels.ts': cliModels, '../shared/cliTurnPolicy.ts': cliTurnPolicy,
      './capacity': { AccountUnavailableError: class extends Error {}, withAgentTurn: async (_, __, fn) => fn(), withEnvironmentSlot: async (_, fn) => fn() },
      './parallel': { prepareResearchTasks: async () => [], recoverImplementation: async () => [], readImplementationTasks: async () => [], runImplementation: async o => opts.runImplementation?.(o) ?? ({ completed: [], commits: [], failed: [] }), runResearch: async o => opts.runResearch?.(o) ?? ({ summary: 'No conflicting flows found', results: [], reused: false }) }, '../shared/usage.ts': usageMod,
    '../shared/shipPrompt.ts': { shipPrompt: o => opts.shipPrompt?.(o) ?? 'fix findings' },
    '../shared/review.ts': { parseReview: () => ({}), reviewSummary: () => opts.missingReport ? undefined : opts.summary ?? { total: 0 } },
    '../main/ship': { excludeConsortDir: async () => {}, fetchTicket: async () => ({}), writeTicketFile: () => '' },
    './slackIdentity': { ensureSlackIdentity: async () => {} },
    './ownerUpdates': ownerUpdates,
    './checkpoint': { checkpoint: async (cwd, branch, message) => { events.push(`checkpoint:${message}`); return { committed: true, pushed: true }; } },
    './buildProgress': { stepLabel: name => name },
    './repoEnv': { environmentPrompt: (_, __, env) => headless.ENVIRONMENT_PROMPT(env), saveRepoEnv: () => { events.push('repo env saved'); return true; } },
    './buildGraph': { readGraph: async () => opts.graph?.tickets ?? [], planWaves: () => opts.graph?.plan ?? { waves: [], remaining: 0, done: 0, problems: [] }, tooSerial: () => !!opts.graph?.serial, graphSummary: g => `${g.remaining} left in ${g.waves.length} waves`, RESPLIT_PROMPT: () => 'RESPLIT THE GRAPH' },
    './draftPr': { draftTitle: t => `[WIP] ${t.title}`, draftBody: (t, progress) => `Progress: ${progress}`, ensureDraftPr: async o => { events.push(`draft:${o.title}:${o.body}`); return opts.draftPr ?? { error: 'no commits yet' }; }, updateDraftBody: async (_, url, body) => { events.push(`draft body:${url}:${body}`); } },
    './slackLinks': { taskSlackLinks: async t => ({ ticket: t.ticket.url, github: t.feature?.prs?.at(-1) ?? 'https://github.com/a/b/tree/feature' }) },
    './statusLog': { statusEvent: (tone, text) => events.push(`status:${tone}:${text}`) },
    './state': {
      loadState: () => state,
      updateTask: (id, patch) => Object.assign(task, typeof patch === 'function' ? patch(task) : patch),
      touchAccount() {}, blockAccount: (id, until, reason) => Object.assign(accounts.find(a => a.id === id), { blockedUntil: until ?? Date.now() + 60000, blockedWhy: reason }),
    },
    './sources': { sourceFor: () => ({ comment: async (_, text) => events.push(`ticket comment:${text}`), setStatus: async () => {}, updateBody: async (id, body) => events.push(`ticket body:${id}:${body}`), attach: async (id, file) => { events.push(`attach:${file}`); return true; }, subtasks: async () => opts.subtasks ?? [] }) },
    './subtasks': { writeSubtaskFile: () => events.push('subtasks file'), needsLinks: () => !!opts.needsLinks, syncSubtaskProgress: async o => { events.push(`subtask sync${o.force ? `:${o.force}` : ''}`); return { states: { ...o.saved, synced: 'progress' }, noted: [] }; }, LINK_PROMPT: 'LINK THE TICKETS' },
    './evidence': { findBrowser: async () => '/browser', writeScreenshotHelper: () => '/helper', validateEvidence: () => { events.push('validate evidence'); return opts.validateEvidence?.(); }, publishEvidence: async () => { events.push('publish evidence'); return opts.publishEvidence?.() ?? { items: 1, images: 1, prComment: true, ticketComment: true }; } },
    './environment': { withChildEnvironment: async (_, id, fn) => fn({ CONSORT_RUN: `child-${id}` }), allocateEnvironment: async () => ({}), cleanupEnvironment: async () => ({}) },
    './slack': { Slack: class { async post(text, thread, broadcast) { if (opts.failPost?.(text)) throw new Error('Slack unavailable'); messages.push({ text, thread, broadcast }); return String(messages.length); } async waitForReply(thread, ts, options) { options?.onCheck?.('answer'); events.push('owner reply'); opts.onReply?.(task); return opts.reply ?? 'Proceed'; } } },
    './usage': (() => { const read = async a => opts.usage?.(a) ?? ({ at: Date.now(), windows: [] }); return { readUsage: read, saveUsage() {}, usageFor: async list => new Map(await Promise.all(list.map(async a => [a.id, await read(a)]))) }; })(),
    './agent': { packageRoot: () => '/package', stopAgents: () => events.push('abort agent'), runTurn: async o => { events.push(`turn:${o.account.provider}`); return opts.turn?.(o, task, interval, deadline) ?? { text: o.prompt.includes(headless.VERIFY_EVIDENCE_PROMPT) ? '[evidence-approved]' : '' }; } },
    './prmonitor': {
      validateReviewers: async (_, names) => names.filter(n => ['ada','bob'].includes(n)),
      reviewerSuggestions: async () => opts.suggestions ?? (opts.shortlog ? [] : ["ada", "bob"]),
      whoAmI: async () => 'me', shortlogForBranch: async () => opts.shortlog ?? ' 2 Ada <1+ada@users.noreply.github.com>\n 1 Bob <2+bob@users.noreply.github.com>',
      requestReviewers: async (_, __, names) => { if (names.length) events.push(`reviewers:${names.join(',')}`); return names; },
      readPr: async () => { events.push('read PR'); return opts.readPr?.(++reads, basePr, task) ?? { ...basePr, approvals: ['ada', 'bob'], reviewDecision: 'APPROVED' }; },
    },
  };
  function load(code) {
    const mod = { exports: {} };
    new Function('require', 'module', 'exports', 'setTimeout', 'setInterval', 'clearInterval', 'Date', code)(name => mocks[name] ?? (name.startsWith('.') ? {} : require(name)), mod, mod.exports,
      (fn, ms) => { if (ms >= 15 * 60000) { deadline = fn; return 1; } clock += ms ?? 0; events.push('sleep'); opts.sleep?.(task, accounts); if (!opts.sleep) throw halt; fn(); },
      fn => { interval = fn; return 1; }, () => {}, Clock);
    return mod.exports;
  }
  mocks['./lifecycle'] = load(lifecycle);
  return { task, accounts, events, messages, advance: ms => { clock += ms; }, work: () => load(pipeline).workTask('t'), notify: mocks['./lifecycle'].notifyTask, run: (work, isStopping) => mocks['./lifecycle'].runTaskUntilFinished('t', work, () => events.push('stop agents'), isStopping) };
}

test('all providers exhausted: one pause, then a separate resume after reset', async () => {
  let sleeps = 0;
  const h = harness({ accounts: [{ id: 'c', provider: 'claude', name: 'Claude', blockedUntil: Date.now() + 100000 }, { id: 'x', provider: 'codex', name: 'Codex', blockedUntil: Date.now() + 100000 }],
    sleep: (task, accounts) => { assert.equal(task.status, 'waiting'); assert.equal(task.lifecycle, 'monitoring'); if (++sleeps === 2) accounts[1].blockedUntil = 0; },
    turn: () => { throw halt; },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.messages.filter(m => /Running:/.test(m.text) && /usage limit/.test(m.text)).length, 1);
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
  assert.equal(h.messages.filter(m => /Running:/.test(m.text) && /usage limit/.test(m.text)).length, 1);
});

test('usage exhaustion during a turn aborts the stalled agent and pauses', async () => {
  let checks = 0;
  const h = harness({ accounts: [{ id: 'x', provider: 'codex', name: 'Codex' }],
    usage: () => ({ at: Date.now(), windows: [], ...(checks++ ? { blocked: '5-hour window exhausted' } : {}) }),
    turn: async (o, __, tick) => { await tick(); assert.equal(o.signal.aborted, true); return { text: '', error: 'aborted' }; },
  });
  await assert.rejects(h.work(), e => e === halt);
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

test('two internal rounds precede two reviewer requests; human feedback resumes then pauses until approval', async () => {
  const h = harness({
    readPr: (n, pr) => n === 1 ? { ...pr, isDraft: true } : n === 2 ? pr : n === 3 || n === 4 ? { ...pr, unresolved: [{ id: 'thread:1', author: 'ada', body: 'Fix label', url: 'url' }] } : { ...pr, approvals: ['ada', 'bob'], reviewDecision: 'APPROVED' },
    sleep: () => {},
  });
  await h.work();
  const reviewers = h.events.indexOf('reviewers:ada,bob');
  assert.equal(h.events.slice(0, reviewers).filter(e => e.startsWith('turn:')).length, 2);
  assert.ok(h.events.indexOf('pr ready 1') < reviewers);
  assert.equal(h.task.reviewsDone, 2);
  assert.equal(h.task.status, 'ready');
  assert.equal(h.task.lifecycle, 'completed');
  assert.ok(h.messages.some(m => /Running:/.test(m.text) && /STATUS: RUNNING$/.test(m.text)));
  assert.ok(!h.messages.some(m => /Paused:/.test(m.text)));
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
  await h.notify('t', 'paused', 'Need your answer');
  assert.equal(h.task.notificationQueue.length, 1);
  fail = false;
  await h.notify('t', 'paused', 'Need your answer');
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
  assert.ok(h.messages.some(m => /^⚠️ \*Evidence blocked\. PR not handed off\*/.test(m.text) && /\n• Map tiles show API KEY REQUIRED/.test(m.text) && /\.env/.test(m.text)));
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
  assert.ok(h.messages.some(m => /^⚠️ \*Evidence blocked\./.test(m.text) && /\n• The evidence check did not pass\n• API KEY REQUIRED appears instead of the map\./.test(m.text)));
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
  const report = h.messages.find(m => /exceeded 15 minutes/.test(m.text));
  assert.ok(report, 'the timeout is reported');
  // the owner sees what the agent was doing when it was stopped, newest first, and the raw error
  assert.match(report.text, /^⚠️ \*Evidence blocked\. PR not handed off\*/);
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
  assert.match(report.text, /^⚠️ \*Stuck at Implementing\* \(<https:\/\/ticket\/1\|ticket>\)\n• Dependency unavailable\n• Last seen: Pushing the branch\n• Before that: Running the migration\n```\nECONNREFUSED 127\.0\.0\.1:5432\nexit 2\npsql: connection refused\n```\n_Reply with what to do; the task stays open\._\n\n<https:\/\/ticket\/1\|ticket> · <https:\/\/github.com\/a\/b\/tree\/feature\|github>\n\nSTATUS: WAITING$/);
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

test('the environment and build run one tier below the planner; grilling and the build plan run on the strongest model', async () => {
  const routine = cliModels.selectCliModel('claude', headless.seedModels().claude, 'implementation');
  const planner = cliModels.selectCliModel('claude', headless.seedModels().claude, 'planning');
  const seen = [];
  // Environment, Grilling, Spec'd and Implementing all use ordinary model roles.
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
  assert.equal(seen[0].model, routine, 'environment setup is routine');
  assert.equal(seen[1].model, planner, 'grilling plans on the strongest model');
  // until the build tickets exist, the turn writes the build plan: that decides how parallel the build is, so Fable or Astra
  const frontier = cliModels.selectCliModel('claude', headless.seedModels().claude, 'frontier');
  assert.equal(seen[2].model, frontier, "spec'd writes the build plan on the frontier model");
  assert.equal(seen[3].model, frontier, 'still no tickets: still planning on the frontier model');
  assert.notEqual(routine, cliModels.selectCliModel('claude', headless.seedModels().claude, 'frontier'));
  assert.match(h.task.activity, new RegExp(`running claude ${frontier}`));
});

test('a CI repair on the watch uses the implementation model', async () => {
  const routine = cliModels.selectCliModel('claude', headless.seedModels().claude, 'implementation');
  const seen = [];
  const h = harness({ task: { reviewsDone: 3 }, readPr: (n, base) => ({ ...base, ci: 'fail' }),
    turn: (o) => { seen.push(o.model); if (seen.length >= 1) throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(seen[0], routine);
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

test('a PR with merge conflicts is never handed off: the base is merged in and pushed, and only a clean PR is ready', async () => {
  const prompts = [];
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] },
    readPr: (n, pr) => n < 3 ? { ...pr, approvals: ['ada'], reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' } : { ...pr, approvals: ['ada'], reviewDecision: 'APPROVED', mergeable: 'MERGEABLE' },
    turn: o => { prompts.push(o.prompt); return { text: '' }; }, sleep() {} });
  await h.work();
  assert.equal(h.task.status, 'ready');
  assert.ok(prompts.some(p => /merge conflicts with origin\/main/.test(p) && /git merge origin\/main/.test(p) && /Never merge the PR itself/.test(p)), 'a conflict-fix turn ran');
  assert.ok(h.messages.some(m => /Merge conflicts with `main`/.test(m.text)));
  const readyAt = h.messages.findIndex(m => /Ready to merge/.test(m.text));
  const conflictAt = h.messages.findIndex(m => /Merge conflicts with/.test(m.text));
  assert.ok(conflictAt >= 0 && readyAt > conflictAt, 'ready only after the conflict was handled');
});

test('still conflicting after three merge attempts asks the owner instead of looping', async () => {
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] }, readPr: (n, pr) => ({ ...pr, approvals: ['ada'], reviewDecision: 'APPROVED', mergeable: 'CONFLICTING' }), turn: () => ({ text: '' }), sleep() {}, onReply: () => { throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.messages.filter(m => /Merge conflicts with `main`/.test(m.text)).length, 3);
  assert.ok(h.messages.some(m => /Stuck at PR watch/.test(m.text) && /Still conflicting with main after 3 merge attempts/.test(m.text)));
  assert.ok(!h.messages.some(m => /Ready to merge/.test(m.text)));
});

test('collecting review comments reads as working, not paused: one Working note per batch, no pause alert, and the fix follows the quiet period', async () => {
  const comment = { id: 'first', threadId: 'thread', author: 'ada', body: 'Fix label', url: 'url' };
  const h = harness({ task: { reviewsDone: 3, reviewersRequested: ['ada', 'bob'] },
    readPr: (n, pr) => n < 4 ? { ...pr, unresolved: [comment] } : { ...pr, approvals: ['ada'], reviewDecision: 'APPROVED' },
    sleep() {}, turn: () => ({ text: '' }) });
  await h.work();
  assert.equal(h.messages.filter(m => /Working: Collecting 1 review comment from @ada/.test(m.text)).length, 1, 'said once per batch, not on every poll');
  assert.ok(!h.messages.some(m => /Paused:/.test(m.text) && /Collecting/.test(m.text)), 'collecting is not a pause');
  assert.ok(h.messages.every(m => !/Collecting/.test(m.text) || /STATUS: RUNNING$/.test(m.text)), 'the status footer says running');
  assert.equal(h.task.status, 'ready');
});

test('automatic monitoring is RUNNING while a required owner answer is WAITING', async () => {
  const h=harness();
  await h.notify('t','monitoring','CI is running; next check in 3m. Your action: none.');
  await h.notify('t','paused','Choose the design; reply here.');
  const replies=h.messages.filter(m=>m.thread);
  assert.match(replies[0].text,/Running:[\s\S]*STATUS: RUNNING$/);
  assert.doesNotMatch(replies[0].text,/Paused:/);
  assert.match(replies[1].text,/Paused:[\s\S]*STATUS: WAITING$/);
});

test('feedback resolution does not request a reviewer who already approved',async()=>{
  const h=harness({task:{reviewsDone:3,reviewersRequested:['ada','bob']},readPr:(n,pr)=>({...pr,approvals:['ada','bob'],previousApprovers:['ada','bob'],reviewDecision:'APPROVED',unresolved:n<4?[{threadId:'thread',id:'thread:1',author:'ada',body:'Clarify this',url:'url'}]:[]}),sleep(){}});
  await h.work();assert.equal(h.task.status,'ready');
  assert.ok(!h.events.some(e=>e.startsWith('reviewers:')));
  assert.ok(!h.messages.some(m=>/Re-requested review/.test(m.text)));
});

test('a requested model escalation reruns the job on frontier without resuming the ordinary session', async () => {
  const seen = [];
  const h = harness({ task: { envReadyAt: undefined, accountIds: { claude: 'c' }, sessions: { claude: 'ordinary-session' } }, turn: o => {
    seen.push(o);
    if (seen.length === 1) return { text: '[model-escalate: Security permission inheritance is uncertain]' };
    if (seen.length === 2) return { text: 'Resolved permission inheritance from repository callers' };
    throw halt;
  } });
  await assert.rejects(h.work(), e => e === halt);
  assert.deepEqual(seen.slice(0, 2).map(o => o.model), ['claude-opus-5', 'claude-fable-5-1']);
  assert.equal(seen[1].resume, undefined);
  assert.match(seen[1].prompt, /Security permission inheritance is uncertain/);
  assert.equal(h.task.turnHistory[0].role, 'implementation');
  assert.equal(h.task.turnHistory[1].escalationReason, 'Security permission inheritance is uncertain');
});

test('two ordinary model SDK errors escalate once rather than retrying indefinitely; the retry moves to another account', async () => {
  const models = [];
  const h = harness({ task: { envReadyAt: undefined }, sleep() {}, turn: o => {
    models.push(o.model);
    if (models.length <= 2) return { text: '', error: 'SDK transport failure' };
    throw halt;
  } });
  await assert.rejects(h.work(), e => e === halt);
  // the second attempt goes to the account that has not failed (Codex here), then the escalation to the frontier model
  assert.deepEqual(models, ['claude-opus-5', 'gpt-5.6-sol', 'claude-fable-5-1']);
  assert.equal(h.task.turnHistory.length, 2);
  assert.ok(h.task.turnHistory.every(turn => turn.error === 'SDK transport failure'));
});

test('a limited attempt records consumed tokens and dollars before provider fallback', async () => {
  const h = harness({ task: { envReadyAt: undefined }, turn: o => {
    if (o.account.provider === 'claude') return { text: '', limit: { text: 'quota exhausted' }, usage: [{ model: o.model, tokens: { input: 123, output: 45, cacheRead: 6, cacheWrite: 7 }, usd: 0.21 }] };
    throw halt;
  } });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(h.task.cost.usd, 0.21);
  assert.deepEqual(h.task.cost.tokens, { input: 123, output: 45, cacheRead: 6, cacheWrite: 7 });
  assert.equal(h.task.cost.turns, 1);
  assert.equal(h.task.turnHistory[0].error, 'quota exhausted');
  assert.equal(h.task.activeProvider, 'codex');
});

test('Fable review waits for Claude credits rather than replacing it with another Astra review', async () => {
  const seen = [];
  let blocked = false, waits = 0;
  const h = harness({ sleep: (_, accounts) => {
    waits++;
    accounts.find(a => a.provider === 'claude').blockedUntil = 0;
  }, turn: o => {
    seen.push(o.model);
    if (o.model === 'claude-fable-5-1' && !blocked) { blocked = true; return { text: '', limit: { text: 'quota exhausted' } }; }
    return { text: '' };
  } });
  await h.work();
  assert.equal(waits, 1);
  assert.deepEqual(seen, ['claude-fable-5-1', 'claude-fable-5-1', 'gpt-6-astra']);
  assert.equal(h.task.reviewsDone, 2);
});

test('stage runtime schedules isolated readers and writers then passes shared research to its coordinator', async () => {
  const seen = [], forms = [];
  const h = harness({ task: { feature: { stage: 'Grilling', prs: [], history: [] }, accountIds: { claude: 'c' }, sessions: { claude: 'parent-session' } },
    runResearch: async o => {
      await Promise.all(['flows', 'tests'].map(id => o.run({ id, cwd: `/read/${id}`, prompt: `Read ${id}`, kind: 'research' })));
      return { summary: 'Flow export preserves archived records', reused: false, results: [] };
    },
    runImplementation: async o => {
      await Promise.all(['frontend', 'backend'].map(id => o.run({ id, cwd: `/write/${id}`, prompt: `Write ${id}`, kind: 'implementation' })));
      await o.check('/virtual');
      return { completed: ['frontend', 'backend'], commits: ['a', 'b'], failed: [] };
    },
    shipPrompt: o => { forms.push(o); return 'coordinate stage'; },
    turn: o => {
      seen.push(o);
      if (o.cwd !== '/virtual') return { text: 'Child report', sessionId: `child-${o.cwd}` };
      if (o.prompt.includes('integrated parallel ticket commits')) return { text: '[parallel-check: pass]' };
      if (o.prompt.includes('coordinate stage') && forms.length === 1) return { text: "[ship-stage: Spec'd | research complete]" };
      throw halt;
    },
  });
  await assert.rejects(h.work(), e => e === halt);
  const readers = seen.filter(o => o.cwd.startsWith('/read/'));
  assert.equal(readers.length, 2);
  assert.ok(readers.every(o => o.readOnly && o.model === 'claude-haiku-4-5-20251001' && o.effort === 'low' && !o.resume));
  const writers = seen.filter(o => o.cwd.startsWith('/write/'));
  assert.equal(writers.length, 2);
  assert.ok(writers.every(o => !o.readOnly && o.model === 'claude-opus-5' && !o.resume));
  assert.equal(new Set(writers.map(o => o.env.CONSORT_RUN)).size, 2);
  assert.equal(new Set([...readers, ...writers].map(o => o.cwd)).size, 4);
  assert.ok(seen.some(o => o.cwd === '/virtual' && /Flow export preserves archived records/.test(o.prompt)));
  assert.equal(h.task.sessions.claude, 'parent-session');
  assert.ok(forms.every(o => o.runtimeParallel === true));
});

test('an Astra review question continues on Astra without resuming the builder session', async () => {
  const seen = [];
  let asked = false;
  const h = harness({ task: { accountIds: { claude: 'c', codex: 'x' }, sessions: { claude: 'builder-session', codex: 'old-codex-builder' } }, turn: o => {
    seen.push(o);
    if (o.model === 'gpt-6-astra' && !asked) { asked = true; return { text: '[ask-user: Should archived exports retain their existing permission check?]' }; }
    return { text: '' };
  } });
  await h.work();
  assert.deepEqual(seen.map(o => o.model), ['claude-fable-5-1', 'gpt-6-astra', 'gpt-6-astra']);
  assert.equal(seen[2].account.provider, 'codex');
  assert.equal(seen[2].resume, undefined);
  assert.match(seen[2].prompt, /owner answered on Slack/i);
  assert.equal(h.task.reviewsDone, 2);
});

test('separate parallel readers each retry one SDK error on another account without blocking the first', async () => {
  const calls = [], attempts = new Map();
  const h = harness({ task: { feature: { stage: 'Grilling', prs: [], history: [] } }, sleep() {},
    runResearch: async o => {
      await Promise.all(['flows', 'tests'].map(id => o.run({ id, cwd: `/read/${id}`, prompt: `Read ${id}`, kind: 'research' })));
      return { summary: 'Both readers completed', reused: false, results: [] };
    },
    turn: o => {
      if (o.cwd === '/virtual') throw halt;
      calls.push(o);
      const n = (attempts.get(o.cwd) ?? 0) + 1;
      attempts.set(o.cwd, n);
      return n === 1 ? { text: '', error: 'Independent SDK transient error' } : { text: 'Read completed' };
    },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.equal(calls.length, 4);
  const byReader = id => calls.filter(o => o.cwd === `/read/${id}`).map(o => o.account.id);
  for (const id of ['flows', 'tests']) { const [first, retry] = byReader(id); assert.notEqual(first, retry, 'the retry uses a different account'); }
  assert.ok(calls.filter(o => o.account.provider === 'codex').every(o => o.model === 'gpt-5.6-luna'), 'Codex readers use its reader model');
  assert.equal(h.accounts.find(a => a.provider === 'claude').blockedUntil, undefined);
  assert.deepEqual([...attempts.values()], [2, 2]);
});

test('a limited child reader changes accounts without changing coordinator session ownership', async () => {
  const seen = [];
  const h = harness({
    accounts: [{ id: 'c', provider: 'claude', name: 'Coordinator account' }, { id: 'c2', provider: 'claude', name: 'Reader alternative' }],
    task: { feature: { stage: 'Grilling', prs: [], history: [] }, accountIds: { claude: 'c' }, sessions: { claude: 'coordinator-session' } },
    runResearch: async o => {
      await o.run({ id: 'flows', cwd: '/read/flows', prompt: 'Read callers', kind: 'research' });
      assert.equal(h.task.accountIds.claude, 'c');
      assert.equal(h.task.sessions.claude, 'coordinator-session');
      return { summary: 'Read complete', reused: false, results: [] };
    },
    shipPrompt: () => { throw halt; },
    turn: o => {
      seen.push(o);
      return o.account.id === 'c' ? { text: '', limit: { text: 'Reader quota exhausted' } } : { text: 'Callers traced', sessionId: 'reader-session' };
    },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.deepEqual(seen.map(o => o.account.id), ['c', 'c2']);
  assert.ok(seen.every(o => o.resume === undefined));
  assert.deepEqual(h.task.accountIds, { claude: 'c' });
  assert.deepEqual(h.task.sessions, { claude: 'coordinator-session' });
});

test('an alternate Claude review account leaves coordinator account and session ownership unchanged', async () => {
  const seen = [];
  const h = harness({
    accounts: [{ id: 'c', provider: 'claude', name: 'Builder account' }, { id: 'c2', provider: 'claude', name: 'Review alternative' }, { id: 'x', provider: 'codex', name: 'Codex' }],
    task: { accountIds: { claude: 'c', codex: 'x' }, sessions: { claude: 'builder-session', codex: 'codex-session' } },
    turn: o => {
      seen.push(o);
      return o.account.id === 'c' ? { text: '', limit: { text: 'Review quota exhausted' } } : { text: '', sessionId: 'review-session' };
    },
  });
  await h.work();
  assert.deepEqual(seen.map(o => o.account.id), ['c', 'c2', 'x']);
  assert.ok(seen.every(o => o.resume === undefined));
  assert.deepEqual(h.task.accountIds, { claude: 'c', codex: 'x' });
  assert.deepEqual(h.task.sessions, { claude: 'builder-session', codex: 'codex-session' });
});

test('a queued Slack update revises the ticket, attaches its files, and reports back before the task continues', async () => {
  const prompts = [];
  const h = harness({
    task: { ownerUpdates: [{ ts: '9', text: 'Add a CSV export', files: ['.consort/ship/updates/9/spec.pdf'], at: 0 }] },
    readFile: f => String(f).endsWith('updates/9/ticket.md') ? '## Goal\n- CSV export\n' : undefined,
    turn: o => { prompts.push(o.prompt); return { text: o.prompt.includes('Add a CSV export') ? 'Done.\n[update-summary: Added CSV export to ticket and code]' : o.prompt.includes(headless.VERIFY_EVIDENCE_PROMPT) ? '[evidence-approved]' : '' }; },
  });
  await h.work();
  assert.ok(prompts.some(p => /Add a CSV export[\s\S]*spec\.pdf[\s\S]*updates\/9\/ticket\.md[\s\S]*pull\/1 is open: push/.test(p)));
  assert.ok(h.events.includes('ticket body:T1:## Goal\n- CSV export'));
  assert.ok(h.events.includes('attach:/virtual/.consort/ship/updates/9/spec.pdf'));
  assert.ok(h.events.some(e => e.startsWith('ticket comment:Updated from Slack by the owner: Added CSV export to ticket and code')));
  const applied = h.messages.find(m => /Applied your update/.test(m.text));
  assert.match(applied.text, /Added CSV export to ticket and code[\s\S]*Ticket description updated[\s\S]*Attached to the ticket: spec\.pdf/);
  assert.deepEqual(h.task.ownerUpdates, []);
  assert.equal(h.task.status, 'ready');
});

test('a new agent goes to the least-used account; a resumed session stays on its account', async () => {
  const accounts = [{ id: 'busy', provider: 'claude', name: 'Busy' }, { id: 'idle', provider: 'claude', name: 'Idle' }];
  const load = { busy: 85, idle: 12 };
  const usage = a => ({ keyId: a.id, at: Date.now(), windows: [{ id: 'wk', label: 'Weekly', percent: load[a.id] }] });
  const fresh = [];
  const h = harness({ accounts, usage, task: { feature: { stage: 'Implementing', prs: [], history: [] }, accountIds: {}, sessions: {} }, turn: o => { fresh.push(o.account.id); throw halt; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.deepEqual(fresh, ['idle']);
  const resumed = [];
  const r = harness({ accounts, usage, task: { feature: { stage: 'Implementing', prs: [], history: [] }, accountIds: { claude: 'busy' }, sessions: { claude: 'live-session' } }, turn: o => { resumed.push([o.account.id, o.resume]); throw halt; } });
  await assert.rejects(r.work(), e => e === halt);
  assert.deepEqual(resumed, [['busy', 'live-session']]);
});

test('each step ends with a checkpoint commit and push of the task branch', async () => {
  let turns = 0;
  const h = harness({ task: { feature: { stage: 'Implementing', prs: [], history: [] } }, turn: () => { if (++turns === 2) throw halt; return { text: 'landed ticket 03' }; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.deepEqual(h.events.filter(e => e.startsWith('checkpoint:')), ['checkpoint:Consort checkpoint: Implementing']);
});

test('a draft PR opens before the first step, is linked in Slack, and its description follows each step', async () => {
  let turns = 0;
  const h = harness({ task: { feature: { stage: 'Grilling', prs: [], history: [] } }, draftPr: { url: 'https://github.com/a/b/pull/7', created: true }, shipPrompt: o => { if (++turns === 2) throw halt; return 'grill'; }, turn: () => ({ text: 'researched' }) });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.events.includes('draft:[WIP] Example:Progress: Grilling'));
  assert.deepEqual(h.task.feature.prs, ['https://github.com/a/b/pull/7']);
  assert.ok(h.messages.some(m => /Draft PR: https:\/\/github.com\/a\/b\/pull\/7/.test(m.text)));
  assert.ok(h.events.includes('draft body:https://github.com/a/b/pull/7:Progress: Grilling'), 'refreshed after the step');
});

test('a build graph that is mostly a chain gets one re-split turn, then the plan is posted', async () => {
  const prompts = [];
  const plan = { waves: [['11'], ['12'], ['13']], remaining: 7, done: 10, problems: [] };
  const h = harness({ task: { feature: { stage: 'Implementing', prs: [], history: [] } }, graph: { tickets: [{ id: '11' }], plan, serial: true },
    turn: o => { prompts.push(o.prompt); if (prompts.length === 2) throw halt; return { text: '' }; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.match(prompts[0], /RESPLIT THE GRAPH/);
  assert.ok(h.task.graphResplitAt, 'only once per task');
  assert.doesNotMatch(prompts[1], /RESPLIT THE GRAPH/);
  assert.ok(h.messages.some(m => /Build plan: 7 left in 3 waves\. Starting together: 11/.test(m.text)));
});

test('parallel tickets picking at the same moment spread across accounts with free slots', async () => {
  const used = [];
  const accounts = [{ id: 'c1', provider: 'claude', name: 'One', maxActiveTurns: 1 }, { id: 'c2', provider: 'claude', name: 'Two', maxActiveTurns: 1 }];
  const h = harness({
    accounts, task: { feature: { stage: 'Implementing', prs: [], history: [] }, accountIds: {}, sessions: {} },
    runImplementation: async o => { await Promise.all(['08', '13'].map(id => o.run({ id, cwd: `/child/${id}`, prompt: id, kind: 'implementation' }))); return { completed: [], commits: [], failed: [] }; },
    turn: async o => { if (o.cwd === '/virtual') throw halt; used.push(o.account.id); await new Promise(r => setImmediate(r)); return { text: 'done' }; },
  });
  await assert.rejects(h.work(), e => e === halt);
  assert.deepEqual(used.sort(), ['c1', 'c2']);
});

test('consort-cli tasks split forces one re-split even when the graph is not a chain', async () => {
  const prompts = [];
  const plan = { waves: [['a', 'b', 'c']], remaining: 3, done: 5, problems: [] };
  const h = harness({ task: { feature: { stage: 'Implementing', prs: [], history: [] }, resplitRequested: 1 }, graph: { tickets: [{ id: 'a' }], plan, serial: false },
    turn: o => { prompts.push(o.prompt); if (prompts.length === 2) throw halt; return { text: '' }; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.match(prompts[0], /RESPLIT THE GRAPH/);
  assert.equal(h.task.resplitRequested, undefined);
  assert.ok(h.messages.some(m => /Re-splitting the remaining build/.test(m.text)));
});

test('subtasks are saved for the agent, linking is tried at most twice, and subtasks sync after each step', async () => {
  const prompts = [];
  const h = harness({ task: { feature: { stage: 'Implementing', prs: [], history: [] } }, subtasks: [{ id: 's1', name: '1. Model', url: 'u' }], needsLinks: true,
    graph: { tickets: [{ id: '01' }], plan: { waves: [['01']], remaining: 1, done: 0, problems: [] } },
    turn: o => { prompts.push(o.prompt); if (prompts.length === 4) throw halt; return { text: '' }; } });
  await assert.rejects(h.work(), e => e === halt);
  assert.ok(h.events.includes('subtasks file'));
  assert.deepEqual(prompts.map(p => /LINK THE TICKETS/.test(p)), [true, true, false, false]);
  assert.equal(h.task.subtaskLinkTries, 2);
  assert.ok(h.events.includes('subtask sync'), 'synced after the build step');
  assert.deepEqual(h.task.subtaskSync, { synced: 'progress' });
});

test('a frontier turn picks Codex when the Claude account is nearly out of Fable, and a network error moves on instead of asking the owner', async () => {
  const seen = [];
  const accounts = [{ id: 'c', provider: 'claude', name: 'Claude' }, { id: 'x', provider: 'codex', name: 'Codex' }];
  const usage = a => a.provider === 'claude'
    ? { keyId: a.id, at: Date.now(), windows: [{ id: '5h', label: '5h', percent: 16 }, { id: 'model:Fable', label: 'Fable', percent: 96, model: 'Fable' }] }
    : { keyId: a.id, at: Date.now(), windows: [{ id: '5h', label: '5h', percent: 0 }, { id: 'wk', label: 'wk', percent: 31 }] };
  const h = harness({ accounts, usage, sleep() {}, task: { feature: { stage: 'Implementing', prs: [], history: [] }, accountIds: {}, sessions: {} },
    turn: o => {
      seen.push(`${o.account.id}:${o.model}`);
      if (seen.length === 1) return { text: '', error: "API Error: Can't reach the API server (ENOTFOUND)" };
      throw halt;
    } });
  await assert.rejects(h.work(), e => e === halt);
  // no tickets yet: the plan turn is frontier work, which goes to Codex (Astra) first; the network error moves it to Claude
  assert.deepEqual(seen, ['x:gpt-6-astra', 'c:claude-fable-5-1']);
  assert.ok(!h.events.includes('owner reply'));
});

test('a turn that goes quiet for 25 minutes is stopped, reported in Slack, and retried; a second silence asks the owner', async () => {
  let h, calls = 0;
  const hang = (o, interval) => new Promise(resolve => {
    o.signal.addEventListener('abort', () => resolve({ text: '', error: 'aborted' }), { once: true });
    o.onText('Dispatching reader 1 of 15');
    h.advance(26 * 60_000);
    interval();
  });
  h = harness({ sleep() {}, turn: (o, _task, interval) => { calls++; return hang(o, interval); } });
  // the second silence is a problem for the owner; the worker's wrapper turns it into the Slack question
  await assert.rejects(h.work(), /went quiet for 25 minutes twice/);
  assert.equal(calls, 2, 'retried once, then gave up');
  assert.ok(h.messages.some(m => /went quiet for 25 min .*last: Dispatching reader 1 of 15.*Restarting this step/.test(m.text)), 'the first silence is posted');
});

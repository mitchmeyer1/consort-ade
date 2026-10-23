import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentryAnalysisRow } from '../src/shared/sentryProgress.ts';
const job = { id: 'job-abc123', name: 'Sentry intake', source: 'sentry', enabled: true, everyMinutes: 15, lastScanAt: 100000 };
test('pre-ticket analysis is visible with a step, action, model and elapsed time', () => {
  const row = sentryAnalysisRow({ ...job, scanStartedAt: 110000, scanProgress: { step: 2, action: 'Grouping 17 issues', at: 115000, accountId: 'saved-account', model: 'claude-opus-5' } }, 130000, true);
  assert.equal(row.id, 'sentry:bc123');
  assert.equal(row.status, 'RUNNING');
  assert.equal(row.stage, 'Group');
  assert.equal(row.step, 2);
  assert.equal(row.ageMs, 20000);
  assert.equal(row.accountId, 'saved-account');
  assert.match(row.action, /Grouping 17 issues.*ClickUp ticket not created yet/);
});
test('failed preparation remains visible between scans with the reason and retry countdown', () => {
  const row = sentryAnalysisRow({ ...job, scanProgress: { step: 2, action: 'Retrying', error: 'Bundle plan omitted reports', at: 100000 } }, 160000, true);
  assert.equal(row.status, 'RETRY');
  assert.equal(row.running, false);
  assert.match(row.action, /Bundle plan omitted reports.*next scan in 14m 0s/);
  assert.doesNotMatch(row.action, /needs your reply/);
});
test('scheduled, stopped, creation, disabled and other scanner states are accurate', () => {
  assert.equal(sentryAnalysisRow(job, 100000, true).status, 'SCHEDULED');
  assert.equal(sentryAnalysisRow({ ...job, scanStartedAt: 110000 }, 120000, false).status, 'STOPPED');
  assert.equal(sentryAnalysisRow({ ...job, scanStartedAt: 110000, scanProgress: { step: 3, action: 'Creating ticket', at: 110000 } }, 120000, true).stage, 'Create');
  assert.equal(sentryAnalysisRow({ ...job, enabled: false }, 100000, true), undefined);
  assert.equal(sentryAnalysisRow({ ...job, source: 'clickup' }, 100000, true), undefined);
});

test('Working table renders preparation and retry rows without adding real tasks', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const ts = (await import('typescript')).default;
  const headless = await import('../src/shared/headless.ts');
  const theme = await import('../src/cli/theme.ts');
  const progress = await import('../src/shared/sentryProgress.ts');
  const require = createRequire(import.meta.url);
  const state = { tasks: [], accounts: [], jobs: [
    { ...job, scanStartedAt: 110000, scanProgress: { step: 2, at: 120000, action: 'Grouping 17 issues into bug bundles' } },
    { ...job, id: 'job-retry', name: 'Sentry retry example', scanProgress: { step: 2, at: 120000, action: 'Retrying', error: 'Bundle plan omitted reports' } },
  ] };
  const mocks = {
    '../shared/headless.ts': headless, '../shared/sentryProgress.ts': progress,
    '../shared/usage.ts': await import('../src/shared/usage.ts'),
    '../shared/seatPool.ts': await import('../src/shared/seatPool.ts'),
    './state': { loadState: () => state, LOG_DIR: '/unused' },
    './daemonctl': { daemonPid: () => 123, alive: () => true },
    './statusLog': { recentStatusEvents: () => [] }, './theme': theme,
    './usage': {}, './buildProgress': { stepLabel: name => name },
  };
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(new URL('../src/cli/view.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(name => mocks[name] ?? require(name), module, module.exports);
  const output = module.exports.renderView(160000, 190).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  const table = output.slice(output.indexOf('Working'), output.indexOf('Accounts'));
  assert.match(table, /sentry:bc123.*2\/3.*Group.*ClickUp ticket.*RUNNING/);
  assert.match(table, /Grouping 17 issues.*ClickUp ticket not created yet/);
  assert.match(table, /sentry:retry.*Scan retry.*RETRY/);
  assert.match(table, /Bundle plan omitted reports.*next scan in/);
  assert.equal(state.tasks.length, 0, 'preparation rows must not dispatch agents or consume task slots');
  if (process.env.CONSORT_SCREENSHOT_FIXTURE) {
    const escaped = table.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    writeFileSync('.consort/sentry-analysis-preview.html', `<!doctype html><meta charset="utf-8"><title>Sentry analysis dashboard preview</title><body style="background:#15191e;color:#eae6dd;padding:24px"><p>Dashboard preview — test data</p><pre style="font:14px/1.7 monospace;white-space:pre-wrap">${escaped}</pre>`);
  }
  state.jobs = [job];
  state.tasks = [{ id: 'real-task', jobId: `${job.id}-worker`, ticket: { id: 'clickup-123', title: 'Real Sentry ticket' }, status: 'working', accountIds: {}, feature: { stage: 'Grilling' }, updatedAt: 160000, startedAt: 150000, pid: 123 }];
  const handedOff = module.exports.renderView(160000, 190);
  assert.doesNotMatch(handedOff, /sentry:bc123/, 'real implementation row replaces preparation row');
  assert.match(handedOff, /clickup-123/);
});

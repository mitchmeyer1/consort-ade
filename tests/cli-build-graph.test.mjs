import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as progress from '../src/cli/buildProgress.ts';

const require = createRequire(import.meta.url);
const mod = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(readFileSync(new URL('../src/cli/buildGraph.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(n => n === './buildProgress' ? progress : require(n), mod, mod.exports);
const { readGraph, planWaves, tooSerial, graphSummary, RESPLIT_PROMPT } = mod.exports;
const t = (id, blockedBy = [], status = 'ready-for-agent', files = [`f/${id}`]) => ({ id, title: id, status, blockedBy, files });

test('leaves start together; each later wave waits only on earlier ones; done blockers do not hold anything', () => {
  const g = planWaves([t('01', [], 'done'), t('02', ['01']), t('03', ['01']), t('04', ['02', '03']), t('05'), t('06', ['05'])]);
  assert.deepEqual(g.waves, [['02', '03', '05'], ['04', '06']]);
  assert.equal(g.remaining, 5); assert.equal(g.done, 1);
  assert.equal(graphSummary(g), '5 tickets left in 2 waves, up to 3 at once');
  assert.equal(tooSerial(g), false);
});

test('a chain like the live build is flagged for a re-split, with the waves in the prompt', () => {
  const chain = ['11', '12', '13', '14', '15', '16', '18'].map((id, i, all) => t(id, i ? [all[i - 1]] : []));
  const g = planWaves(chain);
  assert.equal(g.waves.length, 7);
  assert.equal(tooSerial(g), true);
  assert.match(RESPLIT_PROMPT(g, chain), /wave 1: 11\n- wave 2: 12[\s\S]*shared contracts/);
});

test('cycles, unknown blockers and shared files in one wave are reported', () => {
  assert.match(planWaves([t('a', ['b']), t('b', ['a'])]).problems[0], /cycle among a, b/);
  assert.match(planWaves([t('a', ['zz'])]).problems[0], /unknown ticket zz/);
  assert.match(planWaves([t('a', [], 'ready-for-agent', ['src/x']), t('b', [], 'ready-for-agent', ['src/x/y.ts'])]).problems[0], /a and b share files/);
});

test('ticket files are read the way the agent writes them', async (tt) => {
  const wt = await mkdtemp(join(tmpdir(), 'consort-graph-')); tt.after(() => rm(wt, { recursive: true, force: true }));
  const dir = join(wt, '.consort', 'ship', 'issues'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, '01-model.md'), '# 01: Data model\n**Blocked by:** —\n**Files:** `packages/core/src/model.ts`\n**Status:** done\n');
  await writeFile(join(dir, '02-service.md'), '# 02: Service\n**Blocked by:** 01, 09\n**Files:** `packages/core/src/services/` (new pure modules only), `packages/core/src/x.ts`\n**Status:** ready-for-agent\n**ClickUp:** 17thtp0p4yp, 17thtp0p4yq\n');
  const g = await readGraph(wt);
  assert.deepEqual(g[1].clickup, ['17thtp0p4yp', '17thtp0p4yq']);
  assert.deepEqual(g[0].clickup, []);
  assert.deepEqual(g.map(x => [x.id, x.status, x.blockedBy, x.files]), [['01-model', 'done', [], ['packages/core/src/model.ts']], ['02-service', 'ready-for-agent', ['01', '09'], ['packages/core/src/services/', 'packages/core/src/x.ts']]]);
  assert.deepEqual(planWaves(g).waves, [['02-service']], '01 matches 01-model and is done');
});

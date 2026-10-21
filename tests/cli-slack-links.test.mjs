import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { githubBranchUrl, slackHeading } from '../src/shared/headless.ts';

test('ticket links switch from origin branch to PR and retry failed remote lookups', async () => {
  const source = ts.transpileModule(readFileSync(new URL('../src/cli/slackLinks.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  let calls = 0, fail = true;
  const mocks = {
    'node:child_process': {},
    'node:util': { promisify: () => async (cmd, args, options) => {
      calls++;
      assert.equal(cmd, 'git');
      assert.deepEqual(args, ['remote', 'get-url', 'origin']);
      assert.equal(options.cwd, '/repo');
      if (fail) throw new Error('temporary failure');
      return { stdout: 'git@github.com:team/project.git\n' };
    } },
    '../shared/headless.ts': { githubBranchUrl, slackHeading },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', source)(n => mocks[n], mod, mod.exports);
  const task = { ticket: { title: 'Map locations', url: 'https://app.clickup.com/t/T1' }, branch: 'feature/T1', feature: { prs: [] } };
  assert.equal((await mod.exports.taskSlackLinks(task, '/repo')).github, undefined);
  fail = false;
  const links = await mod.exports.taskSlackLinks(task, '/repo');
  assert.equal(links.github, 'https://github.com/team/project/tree/feature%2FT1');
  await mod.exports.taskSlackLinks(task, '/repo');
  assert.equal(calls, 2);
  task.feature.prs.push('https://github.com/team/project/pull/42');
  assert.deepEqual(await mod.exports.taskSlackLinks(task, '/repo'), { ticket: task.ticket.url, github: task.feature.prs[0], heading: "📋 Map locations" });
  assert.equal(calls, 2);
});

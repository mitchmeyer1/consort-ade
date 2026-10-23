import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter } from '../src/cli/prompter.ts';
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, terminal = false) {
  const input = new PassThrough(), output = new PassThrough();
  input.isTTY = terminal;
  let text = '';
  output.on('data', data => { text += data; });
  const prompt = createPrompter(input, output);
  t.after(() => { prompt.close(); input.destroy(); output.destroy(); });
  return { ...prompt, input, output, text: () => text };
}

test('interactive extra blank lines cannot answer the next question', async t => {
  const p = fixture(t, true);
  const first = p.ask('Project');
  p.input.write('node\r\n\r\n');
  assert.equal(await first, 'node');
  let answered = false;
  const second = p.ask('Environment', { default: 'production' }).then(value => { answered = true; return value; });
  await tick();
  assert.equal(answered, false);
  p.input.write('staging\r');
  assert.equal(await second, 'staging');
});

test('interactive input received between questions is not saved as an answer', async t => {
  const p = fixture(t, true);
  p.input.write('\r\n');
  const answer = p.ask('Project');
  p.input.write('node\r');
  assert.equal(await answer, 'node');
});

test('piped answers remain queued and every prompt starts on a separate line', async t => {
  const p = fixture(t);
  p.input.end('node\n\nis:unresolved\n');
  await tick();
  assert.equal(await p.ask('Project'), 'node');
  assert.equal(await p.ask('Environment', { default: 'production' }), 'production');
  assert.equal(await p.ask('Query'), 'is:unresolved');
  assert.match(p.text(), /^\n› Project: \n\n› Environment \[production\]: \n\n› Query: \n$/);
});

test('closed input stops setup instead of silently accepting defaults', async t => {
  const p = fixture(t);
  const answer = p.ask('Project');
  p.input.end();
  await assert.rejects(answer, /readline was closed/);
});

test('secret interactive input is not echoed and output resumes afterwards', async t => {
  const p = fixture(t, true);
  const answer = p.ask('Token', { secret: true });
  p.input.write('test-secret-value\r');
  assert.equal(await answer, 'test-secret-value');
  assert.doesNotMatch(p.text(), /test-secret-value/);
  p.output.write('visible');
  assert.match(p.text(), /visible$/);
});

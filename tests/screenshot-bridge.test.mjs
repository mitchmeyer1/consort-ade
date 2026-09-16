import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureRequest, startScreenshotBridge } from '../src/main/screenshotBridge.ts';

test('capture validates URLs and bounds browser dimensions', () => {
  assert.deepEqual(captureRequest({ url: 'http://localhost:3000' }), { url: 'http://localhost:3000/', width: 1440, height: 900 });
  assert.equal(captureRequest({ url: 'file:///tmp/example.html', width: 320, height: 640 }).width, 320);
  for (const input of [null, {}, {url: 'javascript:alert(1)'}, {url: 'https://example.com', width: 9000}, {url: 'https://example.com', height: '900'}]) {
    assert.throws(() => captureRequest(input));
  }
});

test('generated helper captures through authenticated bridge and is removed on close', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'consort-capture-'));
  let request;
  let bridge;
  try {
    bridge = await startScreenshotBridge(cwd, async value => { request = value; return join(cwd, 'result.png'); });
  } catch (error) {
    await rm(cwd, { recursive:true, force:true });
    if (error.code === 'EPERM') { t.skip('Sandbox prohibits listening on localhost'); return; }
    throw error;
  }
  try {
    const script = await readFile(bridge.helper, 'utf8');
    const endpoint = script.match(/fetch\('([^']+)'/)[1];
    assert.equal((await fetch(endpoint, {method:'POST'})).status, 403);
    const token = script.match(/Bearer ([^']+)/)[1];
    assert.equal((await fetch(endpoint, {method:'POST', headers: {Authorization: `Bearer ${token}`, Origin: 'https://untrusted.test'}})).status, 403);
    const { stdout } = await promisify(execFile)(process.execPath, [bridge.helper, 'http://localhost:3000', '800', '600']);
    assert.equal(stdout.trim(), join(cwd, 'result.png'));
    assert.deepEqual(request, {url:'http://localhost:3000/', width:800, height:600});
    await assert.rejects(promisify(execFile)(process.execPath, [bridge.helper, 'javascript:alert(1)']), /Use an http/);
  } finally { await bridge.close(); await rm(cwd, { recursive:true, force:true }); }
  await assert.rejects(access(bridge.helper));
});

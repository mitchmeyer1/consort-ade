import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startImageTunnel, publish, tunnelUp } from '../src/cli/imageTunnel.ts';

test('the image tunnel serves published pictures at a secret address and nothing else', async () => {
  assert.equal(publish(Buffer.from('x')), undefined, 'no address before the tunnel is up');
  const dir = mkdtempSync(join(tmpdir(), 'tunnel-')), fake = join(dir, 'ngrok');
  // A stand-in for ngrok: reports its local port as the public address, then waits.
  writeFileSync(fake, `#!/bin/sh\necho '{"msg":"started tunnel","url":"https://x"}' | sed "s#https://x#http://$2#" | sed 's#"http://#"https://#'\nsleep 30\n`);
  chmodSync(fake, 0o755);
  const url = await startImageTunnel(fake, 5000, join(dir, 'ngrok.pid'));
  assert.ok(url && tunnelUp());
  const png = Buffer.from('picture'), address = publish(png);
  assert.match(address, /^https:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/[0-9a-f]{64}\.png$/);
  const local = address.replace('https://', 'http://');
  const res = await fetch(local);
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  assert.equal((await fetch(local.replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`))).status, 404, 'a wrong secret finds nothing');
  process.exit(0);
});

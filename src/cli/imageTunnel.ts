/**
 * Pictures at a public https address, for Slack card images, which show only an image_url and never an uploaded file.
 * The daemon serves the pictures it renders from memory on 127.0.0.1 and opens an ngrok tunnel to that port. Each address
 * carries a random secret and the picture's hash, so it cannot be guessed and Slack fetches a new one when the picture changes.
 * Without ngrok, or before the tunnel is up, publish() returns undefined and the monitor shows uploaded pictures instead.
 */
import { createServer, type Server } from 'node:http';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const KEEP = 12;
const secret = randomBytes(16).toString('hex');
const pictures = new Map<string, Buffer>();
let base: string | undefined, server: Server | undefined, agent: ChildProcess | undefined;

/** Start once per process; resolves when the tunnel is up, or quietly gives up after `waitMs`. */
export async function startImageTunnel(ngrok = 'ngrok', waitMs = 20_000, pidFile = join(homedir(), '.consort-cli', 'ngrok.pid')): Promise<string | undefined> {
  if (server) return base;
  // A free ngrok account allows one agent at a time: stop the one a killed daemon left behind.
  try { const old = Number(readFileSync(pidFile, 'utf8')); if (old && /ngrok$/.test(execFileSync('ps', ['-p', String(old), '-o', 'comm='], { encoding: 'utf8' }).trim())) process.kill(old); } catch { /* none left */ }
  server = createServer((req, res) => {
    const m = req.url?.match(/^\/([0-9a-f]{32})\/([0-9a-f]{64})\.png$/);
    const png = m && m[1] === secret ? pictures.get(m[2]!) : undefined;
    if (!png) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=31536000, immutable' }).end(png);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return new Promise((resolve) => {
    const done = (url: string | undefined) => { clearTimeout(timer); resolve(url); };
    const timer = setTimeout(() => { console.error('Image tunnel: ngrok did not start; Slack shows uploaded pictures instead.'); done(undefined); }, waitMs);
    agent = spawn(ngrok, ['http', `127.0.0.1:${port}`, '--log', 'stdout', '--log-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (agent.pid) try { writeFileSync(pidFile, String(agent.pid)); } catch { /* best effort */ }
    agent.on('error', (e) => { console.error(`Image tunnel: ${e.message}; Slack shows uploaded pictures instead.`); done(undefined); });
    agent.on('exit', (code) => { base = undefined; agent = undefined; console.error(`Image tunnel: ngrok exited ${code}; Slack shows uploaded pictures instead.`); });
    let buffered = '';
    agent.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      for (let i; (i = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(i + 1)) {
        const url = buffered.slice(0, i).match(/"url":"(https:\/\/[^"]+)"/)?.[1];
        if (url && !base) { base = url; console.log(`Image tunnel: ${url}`); done(url); }
      }
    });
    process.once('exit', () => agent?.kill());
  });
}

/** True once the tunnel is up. */
export const tunnelUp = () => !!base;

/** The picture's public address, or undefined without a tunnel. Only the latest few are kept. */
export function publish(png: Buffer): string | undefined {
  if (!base) return undefined;
  const hash = createHash('sha256').update(png).digest('hex');
  pictures.delete(hash); pictures.set(hash, png);
  while (pictures.size > KEEP) pictures.delete(pictures.keys().next().value!);
  return `${base}/${secret}/${hash}.png`;
}

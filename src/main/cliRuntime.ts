import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { CLI_NAMES, cliVersionFrom, isNewer, latestRelease, registryTarget, updateWouldHelp, type CliStatus, type UpdateNeed } from "../shared/cliUpdates";
import type { Provider } from "../shared/types";

/**
 * The CLIs Consort runs, and where a newer one than the bundled lives once it has been fetched:
 * userData/cli/<provider>/<npm version>/, unpacked from the registry tarball `pnpm install`
 * would have used, with current.json naming the one in use. cliBinary() is what every SDK call
 * and spawn goes through, so a download takes effect on the next turn without a restart.
 * shared/cliUpdates.ts holds the rules; this file only moves bytes.
 */

const run = promisify(execFile);
const CHECK_INTERVAL = 10 * 60_000;
const TIMEOUT = 20_000;

/** the outside world, injectable so the wiring can be exercised in a temp dir with a fake registry */
export type Deps = {
  root: () => string;
  appPath: () => string;
  fetch: typeof fetch;
  /** run a binary and return its stdout; used for `tar` and `--version` */
  exec: (cmd: string, args: string[]) => Promise<string>;
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  now: () => number;
};

/** the release in use from a download, as current.json records it */
type Current = { npmVersion: string; cliVersion?: string; binary: string; at: number };

/** the platform package each SDK installs as an optional dependency, and the binary inside it (same layout as the registry tarball) */
const bundledPackage = (provider: Provider, platform: NodeJS.Platform, arch: NodeJS.Architecture) => {
  const slug = `${platform}-${arch}`;
  const binary = registryTarget(provider, platform, arch).binary.replace(/^package\//, "");
  return provider === "claude" ? { pkg: `@anthropic-ai/claude-agent-sdk-${slug}`, binary } : { pkg: `@openai/codex-${slug}`, binary };
};

const dirOf = (deps: Deps, provider: Provider) => join(deps.root(), provider);
const currentFile = (deps: Deps, provider: Provider) => join(dirOf(deps, provider), "current.json");

export function installedCli(provider: Provider, deps: Deps = defaults): Current | undefined {
  try {
    const cur = JSON.parse(readFileSync(currentFile(deps, provider), "utf8")) as Current;
    return typeof cur?.binary === "string" && existsSync(cur.binary) ? cur : undefined;
  } catch { return undefined; }
}

export function bundledCli(provider: Provider, deps: Deps = defaults): { npmVersion?: string; binary?: string } {
  let bundled: { pkg: string; binary: string };
  try { bundled = bundledPackage(provider, deps.platform, deps.arch); } catch { return {}; }
  const dir = join(deps.appPath(), "node_modules", bundled.pkg);
  const binary = join(dir, bundled.binary);
  let npmVersion: string | undefined;
  try { npmVersion = String(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version); } catch {}
  return { npmVersion, binary: existsSync(binary) ? binary : undefined };
}

/** the binary to run: a download newer than the bundled one wins, else the bundled, else nothing */
export function cliBinary(provider: Provider, deps: Deps = defaults): string | undefined {
  const bundled = bundledCli(provider, deps);
  const downloaded = installedCli(provider, deps);
  if (downloaded && (!bundled.binary || isNewer(downloaded.npmVersion, bundled.npmVersion))) return downloaded.binary;
  return bundled.binary;
}

const versionCache = new Map<string, string | undefined>();
async function binaryVersion(binary: string | undefined, deps: Deps): Promise<string | undefined> {
  if (!binary) return undefined;
  if (!versionCache.has(binary)) versionCache.set(binary, cliVersionFrom(await deps.exec(binary, ["--version"]).catch(() => "")));
  return versionCache.get(binary);
}

type Check = { at: number; release?: ReturnType<typeof latestRelease>; target: ReturnType<typeof registryTarget> };
const checks = new Map<Provider, Check>();
const notes = new Map<Provider, string>();

async function latestFor(provider: Provider, deps: Deps, force: boolean): Promise<Check> {
  const known = checks.get(provider);
  if (!force && known && deps.now() - known.at < CHECK_INTERVAL) return known;
  const target = registryTarget(provider, deps.platform, deps.arch);
  // the abbreviated packument: dist-tags and each version's tarball, without the changelogs
  const res = await deps.fetch(target.metadataUrl, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${CLI_NAMES[provider]} registry: HTTP ${res.status}`);
  const entry: Check = { at: deps.now(), release: latestRelease(await res.json(), target), target };
  checks.set(provider, entry);
  return entry;
}

export async function cliStatus(provider: Provider, deps: Deps = defaults): Promise<CliStatus> {
  const bundled = bundledCli(provider, deps);
  const downloaded = installedCli(provider, deps);
  const binary = cliBinary(provider, deps);
  const known = checks.get(provider);
  const usingDownload = !!binary && binary === downloaded?.binary;
  return {
    provider,
    version: usingDownload ? downloaded!.cliVersion ?? (await binaryVersion(binary, deps)) : await binaryVersion(binary, deps),
    source: !binary ? "missing" : usingDownload ? "downloaded" : "bundled",
    ...(binary ? { npmVersion: usingDownload ? downloaded!.npmVersion : bundled.npmVersion } : {}),
    bundled: await binaryVersion(bundled.binary, deps),
    ...(known?.release ? { latest: known.release.version, checkedAt: known.at } : {}),
    ...(notes.get(provider) ? { note: notes.get(provider) } : {}),
  };
}

const inflight = new Map<Provider, Promise<boolean>>();

/**
 * Fetch the registry's latest release when it is newer than what runs now, unpack it, and make
 * it current. Resolves true when the binary in use changed. A `need` from a run error narrows
 * it: no download when the registry cannot satisfy the version the error asked for.
 */
export function updateCli(provider: Provider, need?: UpdateNeed, deps: Deps = defaults): Promise<boolean> {
  const pending = inflight.get(provider);
  if (pending) return pending;
  const p = doUpdate(provider, need, deps).finally(() => inflight.delete(provider));
  inflight.set(provider, p);
  return p;
}

async function doUpdate(provider: Provider, need: UpdateNeed | undefined, deps: Deps): Promise<boolean> {
  const name = CLI_NAMES[provider];
  try {
    const { release, target } = await latestFor(provider, deps, true);
    if (!release) { notes.set(provider, `${name}: the registry lists no build for this machine.`); return false; }
    const running = installedCli(provider, deps)?.npmVersion ?? bundledCli(provider, deps).npmVersion;
    const runningOrNone = cliBinary(provider, deps) ? running : undefined;
    if (need ? !updateWouldHelp(need, runningOrNone, release.version) : !isNewer(release.version, runningOrNone)) {
      notes.set(provider, isNewer(release.version, runningOrNone) ? `${name} ${release.version} is newer but still older than the ${need?.required} this model needs.` : `${name} is up to date.`);
      return false;
    }
    const dir = join(dirOf(deps, provider), release.version);
    const tgz = `${dir}.tgz`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await download(release.tarball, tgz, release.integrity, deps);
    await deps.exec("tar", ["-xzf", tgz, "-C", dir]);
    rmSync(tgz, { force: true });
    const binary = join(dir, target.binary);
    if (!existsSync(binary)) throw new Error(`${name} ${release.version}: no binary at ${target.binary} in the tarball`);
    chmodSync(binary, 0o755);
    versionCache.delete(binary);
    const cliVersion = await binaryVersion(binary, deps);
    if (!cliVersion) throw new Error(`${name} ${release.version} downloaded but would not run`);
    const current: Current = { npmVersion: release.version, cliVersion, binary, at: deps.now() };
    writeFileSync(currentFile(deps, provider), JSON.stringify(current, null, 2));
    // the release before this one is no longer needed; the bundled copy is the fallback
    for (const entry of readdirSync(dirOf(deps, provider))) if (entry !== release.version && entry !== "current.json") rmSync(join(dirOf(deps, provider), entry), { recursive: true, force: true });
    notes.set(provider, `${name} ${cliVersion} downloaded.`);
    return true;
  } catch (error) {
    notes.set(provider, `${name} update failed: ${(error as Error).message}`);
    throw error;
  }
}

async function download(url: string, to: string, integrity: string | undefined, deps: Deps) {
  const res = await deps.fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`download: HTTP ${res.status}`);
  const hash = createHash("sha512");
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), async function* (chunks) { for await (const c of chunks) { hash.update(c); yield c; } }, createWriteStream(to));
  if (integrity && integrity !== `sha512-${hash.digest("base64")}`) { rmSync(to, { force: true }); throw new Error("download did not match the registry's checksum"); }
}

/** every provider, newest first: what runs, what is bundled, what the registry has */
export const allCliStatus = (deps: Deps = defaults) => Promise.all((["claude", "codex"] as const).map((p) => cliStatus(p, deps)));

/** the daily sweep: fetch anything newer for both providers; true when either binary changed */
export async function updateAllClis(deps: Deps = defaults): Promise<boolean> {
  const results = await Promise.all((["claude", "codex"] as const).map((p) => updateCli(p, undefined, deps).catch(() => false)));
  return results.some(Boolean);
}

// the Electron app is the default host; consort-cli passes its own deps and never touches these
const electronApp = () => (createRequire(import.meta.url)("electron") as typeof import("electron")).app;
const defaults: Deps = {
  root: () => join(electronApp().getPath("userData"), "cli"),
  appPath: () => electronApp().getAppPath(),
  fetch: (...args) => fetch(...args),
  exec: (cmd, args) => run(cmd, args, { timeout: TIMEOUT, maxBuffer: 1 << 20 }).then((r) => r.stdout),
  platform: process.platform,
  arch: process.arch,
  now: () => Date.now(),
};

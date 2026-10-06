import type { Provider } from "./types";

/**
 * Consort ships a Claude Code and a Codex binary inside the app, but the providers gate new
 * models on the CLI's version: the API refuses "Claude Code 2.1.273 does not support this
 * model; version 2.1.280 or newer is required", and Codex's catalog is served per client
 * version. Rebuilding Consort for every CLI release would make the model pickers only as
 * fresh as the last build, so the app keeps a newer binary of its own, fetched from the npm
 * registry the same way `pnpm install` would, and prefers it over the bundled one. The rules
 * here decide when that is worth doing; main/cliRuntime.ts does the fetching.
 */

export const CLI_NAMES: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

/** "2.1.280", "0.3.281", "0.160.0-darwin-arm64" → comparable parts; anything else is version 0 */
export const parseVersion = (v: string | undefined): number[] => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
};

export function compareVersions(a: string | undefined, b: string | undefined): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export const isNewer = (candidate: string | undefined, than: string | undefined) => compareVersions(candidate, than) > 0;

export type UpdateNeed = { provider: Provider; required?: string; current?: string; reason: string };

const CLAUDE_TOO_OLD = /Claude Code\s+(\d+\.\d+\.\d+)\s+does not support[^\n]*?version\s+(\d+\.\d+\.\d+)\s+or newer is required/i;
const CLAUDE_UPDATE_HINT = /run ['"`]?claude update['"`]?|update (?:the )?Claude (?:Code|desktop)|claude code[^\n]{0,60}\b(?:out of date|outdated|too old|newer version)/i;
const CODEX_UPDATE_HINT = /codex[^\n]{0,80}\b(?:out of date|outdated|too old|newer version|please (?:update|upgrade))|(?:update|upgrade)[^\n]{0,40}\bcodex\b|(?:unsupported|unknown) model|model[^\n]{0,60}\bnot supported\b/i;

/**
 * Does this run error say the CLI is the problem? Only then is a download worth the wait; a
 * model the account cannot use, or a session gone missing, is not fixed by a newer binary.
 */
export function cliUpdateNeeded(error: string | undefined, provider: Provider): UpdateNeed | undefined {
  if (!error) return undefined;
  if (provider === "claude") {
    const m = CLAUDE_TOO_OLD.exec(error);
    if (m) return { provider, current: m[1], required: m[2], reason: `Claude Code ${m[1]} is too old for this model; ${m[2]} or newer is required.` };
    if (CLAUDE_UPDATE_HINT.test(error)) return { provider, reason: "Claude Code asked to be updated." };
    return undefined;
  }
  if (CODEX_UPDATE_HINT.test(error)) return { provider, reason: "Codex refused the model; a newer CLI may carry it." };
  return undefined;
}

/**
 * Whether a download can help: the registry has something newer than what runs now, and if
 * the error named the version it needs, what the registry has is at least that. Otherwise the
 * turn would fail the same way again after a 200 MB download.
 */
export function updateWouldHelp(need: UpdateNeed, running: string | undefined, available: string | undefined): boolean {
  if (!available || !isNewer(available, running)) return false;
  return !need.required || meetsRequirement(need.provider, available, need.required);
}

/**
 * `required` is the version the CLI prints; `npmVersion` is the package's. For Codex they are
 * the same number. For Claude Code the package is the agent SDK, numbered 0.3.N for CLI 2.1.N,
 * so the patch number is the release and the only part worth comparing.
 */
export const meetsRequirement = (provider: Provider, npmVersion: string, required: string) =>
  provider === "claude" ? parseVersion(npmVersion)[2] >= parseVersion(required)[2] : compareVersions(npmVersion, required) >= 0;

/** what the registry serves for this machine, and where the binary sits once the tarball is unpacked */
export type RegistryTarget = { metadataUrl: string; versionKey: (latest: string) => string; binary: string };

const RUST_TRIPLE: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
};

export function registryTarget(provider: Provider, platform = process.platform, arch = process.arch): RegistryTarget {
  const slug = `${platform}-${arch}`;
  if (provider === "claude") {
    // one npm package per platform, versioned like the SDK; the binary is the package's only file
    return { metadataUrl: `https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-${slug}`, versionKey: (latest) => latest, binary: platform === "win32" ? "package/claude.exe" : "package/claude" };
  }
  // Codex publishes every platform under the one package name, as "<version>-<platform>-<arch>"
  const triple = RUST_TRIPLE[slug];
  if (!triple) throw new Error(`Codex has no build for ${slug}`);
  return { metadataUrl: "https://registry.npmjs.org/@openai/codex", versionKey: (latest) => `${latest}-${slug}`, binary: `package/vendor/${triple}/bin/codex` };
}

/** the "latest" release in an npm packument, and the tarball for the version this machine wants */
export function latestRelease(packument: unknown, target: RegistryTarget): { version: string; tarball: string; integrity?: string } | undefined {
  const p = packument as { "dist-tags"?: { latest?: unknown }; versions?: Record<string, { dist?: { tarball?: unknown; integrity?: unknown } }> } | undefined;
  const latest = p?.["dist-tags"]?.latest;
  if (typeof latest !== "string") return undefined;
  const dist = p?.versions?.[target.versionKey(latest)]?.dist;
  if (typeof dist?.tarball !== "string") return undefined;
  return { version: latest, tarball: dist.tarball, ...(typeof dist.integrity === "string" ? { integrity: dist.integrity } : {}) };
}

/** what `claude --version` / `codex --version` print: "2.1.280 (Claude Code)", "codex-cli 0.160.0" */
export const cliVersionFrom = (output: string | undefined) => /\d+\.\d+\.\d+/.exec(output ?? "")?.[0];

export type CliStatus = {
  provider: Provider;
  /** what runs now: the downloaded binary when there is one, else the bundled */
  version?: string;
  source: "downloaded" | "bundled" | "missing";
  /** the package version of what runs, in the registry's numbering (the agent SDK's for Claude Code) */
  npmVersion?: string;
  bundled?: string;
  /** what the registry last said, in that same numbering, and when it was asked */
  latest?: string;
  checkedAt?: number;
  /** the one-line outcome of the last update attempt */
  note?: string;
};

export const cliSummary = (s: CliStatus) =>
  `${CLI_NAMES[s.provider]} ${s.version ?? "not found"}${s.source === "downloaded" ? " (downloaded)" : s.source === "bundled" ? " (bundled)" : ""}${s.latest && isNewer(s.latest, s.npmVersion) ? " · update available" : ""}`;

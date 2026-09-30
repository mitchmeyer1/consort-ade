import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexBin, codexHome } from "./auth";
import { probeClaudeModels } from "./claudeModels";
import { mergeClaudeModels } from "../shared/claudeModels";
import { listedCodexModels, openAiCodexModels } from "../shared/codexModels";
import type { ApiKey, Provider } from "../shared/types";

const run = promisify(execFile);
const TIMEOUT = 20_000;

export type Discovered = Partial<Record<Provider, string[]>>;
/** the outside world, injectable so the wiring can be exercised without keychains, CLIs or the network */
export type Deps = {
  fetch: typeof fetch;
  probeCli: (key: ApiKey, apiKey?: string) => Promise<string[]>;
  claudeToken: (key: ApiKey) => Promise<string | undefined>;
  codexVersion: () => Promise<string | undefined>;
  readFile: (path: string) => string;
};

/**
 * Ask each provider what a connector can use, straight from its API, so a model released after
 * this build of Consort is in the picker the day it appears. The CLIs' own lists are folded in
 * (they are what the agent actually runs). A connector that cannot answer contributes nothing
 * rather than an error; a provider with no answers is left out so the last good list stands.
 */
export async function discoverModels(keys: ApiKey[], secret: (key: ApiKey) => string | undefined, deps: Deps = defaults): Promise<Discovered> {
  const per = await Promise.all(keys.map((key) => discoverFor(key, key.auth === "key" ? secret(key) : undefined, deps).catch(() => [] as string[])));
  const out: Discovered = {};
  for (const provider of ["claude", "codex"] as const) {
    const lists = keys.map((k, i) => (k.provider === provider ? per[i] : []));
    const models = provider === "claude" ? mergeClaudeModels(...lists) : [...new Set(lists.flat())];
    if (models.length) out[provider] = models;
  }
  return out;
}

async function discoverFor(key: ApiKey, apiKey: string | undefined, deps: Deps): Promise<string[]> {
  if (key.provider === "claude") {
    // the CLI first: an idle session refreshes an expired login token, which the API call then uses
    const cli = await deps.probeCli(key, apiKey).catch(() => [] as string[]);
    const api = await claudeApiModels(key, apiKey, deps).catch(() => [] as string[]);
    return mergeClaudeModels(api, cli);
  }
  return apiKey ? openAiModels(apiKey, deps) : codexBackendModels(key, deps);
}

/** GET /v1/models: an API key as itself, a Claude.ai login as its OAuth bearer token */
async function claudeApiModels(key: ApiKey, apiKey: string | undefined, deps: Deps): Promise<string[]> {
  const token = apiKey ? undefined : await deps.claudeToken(key);
  if (!apiKey && !token) return [];
  const client = new Anthropic({
    apiKey: apiKey ?? null,
    authToken: token ?? null,
    defaultHeaders: token ? { "anthropic-beta": "oauth-2025-04-20" } : {},
    fetch: deps.fetch,
    timeout: TIMEOUT,
    maxRetries: 1,
  });
  const ids: string[] = [];
  for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
  return ids;
}

/**
 * Codex's backend serves the catalog the CLI caches, per account and per client version: a
 * model the bundled CLI is too old to run is not offered, and would be refused if it were.
 */
async function codexBackendModels(key: ApiKey, deps: Deps): Promise<string[]> {
  const auth = JSON.parse(deps.readFile(join(codexHome(key), "auth.json")));
  const token = auth?.tokens?.access_token;
  if (typeof token !== "string" || !token) {
    const platformKey = auth?.OPENAI_API_KEY;
    return typeof platformKey === "string" && platformKey ? openAiModels(platformKey, deps) : [];
  }
  const version = await deps.codexVersion();
  if (!version) return [];
  const account = auth?.tokens?.account_id;
  const res = await deps.fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, {
    headers: { Authorization: `Bearer ${token}`, originator: "codex_cli_rs", ...(typeof account === "string" ? { "ChatGPT-Account-Id": account } : {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Codex catalog: HTTP ${res.status}`);
  return listedCodexModels((await res.json())?.models);
}

async function openAiModels(apiKey: string, deps: Deps): Promise<string[]> {
  const res = await deps.fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`OpenAI models: HTTP ${res.status}`);
  return openAiCodexModels((await res.json())?.data);
}

const claudeDir = (key: ApiKey) => key.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/**
 * Where Claude Code keeps a login's OAuth token on macOS: one keychain item per config
 * directory, the default one unsuffixed, any other suffixed with the first 8 hex digits of the
 * directory's SHA-256. Elsewhere the same JSON sits in .credentials.json in that directory.
 */
export const keychainService = (dir: string, defaultDir = join(homedir(), ".claude")) =>
  dir === defaultDir ? "Claude Code-credentials" : `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;

export async function claudeToken(key: ApiKey): Promise<string | undefined> {
  const dir = claudeDir(key);
  let raw: string | undefined;
  try { raw = readFileSync(join(dir, ".credentials.json"), "utf8"); } catch {}
  if (!raw && process.platform === "darwin")
    raw = await run("security", ["find-generic-password", "-s", keychainService(dir), "-w"], { timeout: TIMEOUT }).then((r) => r.stdout, () => undefined);
  if (!raw) return undefined;
  const oauth = JSON.parse(raw)?.claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return undefined;
  if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) return undefined;
  return oauth.accessToken;
}

const codexVersion = () => run(codexBin(), ["--version"], { timeout: TIMEOUT }).then((r) => /\d+\.\d+\.\d+/.exec(r.stdout)?.[0], () => undefined);

const defaults: Deps = { fetch: (...args) => fetch(...args), probeCli: probeClaudeModels, claudeToken, codexVersion, readFile: (p) => readFileSync(p, "utf8") };

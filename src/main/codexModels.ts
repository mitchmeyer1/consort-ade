import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MODELS, type ApiKey } from "../shared/types";

type Catalog = { slug?: unknown; visibility?: unknown; priority?: unknown };

let cached: { at: number; models: string[] } | undefined;

/**
 * Codex refreshes its own model catalog into CODEX_HOME/models_cache.json, so reading it
 * keeps the picker current without a Consort release. Only models Codex itself lists are
 * offered ("hide" covers internal ones like codex-auto-review), ordered the way Codex orders
 * them, with the built-in list as a fallback on a machine that has never run Codex.
 */
export function codexModels(keys: ApiKey[], now = Date.now()): string[] {
  if (cached && now - cached.at < 30_000) return cached.models;
  const dirs = new Set(keys.filter((k) => k.provider === "codex").map((k) => k.configDir || process.env.CODEX_HOME || join(homedir(), ".codex")));
  const listed: { slug: string; priority: number }[] = [];
  for (const dir of dirs) {
    let parsed: { models?: Catalog[] };
    try { parsed = JSON.parse(readFileSync(join(dir, "models_cache.json"), "utf8")); } catch { continue; }
    for (const m of parsed?.models ?? [])
      if (typeof m?.slug === "string" && m.visibility === "list") listed.push({ slug: m.slug, priority: typeof m.priority === "number" ? m.priority : Number.MAX_SAFE_INTEGER });
  }
  listed.sort((a, b) => a.priority - b.priority);
  const models = [...new Set([...listed.map((m) => m.slug), ...MODELS.codex])];
  cached = { at: now, models };
  return models;
}

export const forgetCodexModels = () => (cached = undefined);

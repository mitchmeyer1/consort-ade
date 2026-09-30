import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MODELS, type ApiKey } from "../shared/types";
import { listedCodexModels } from "../shared/codexModels";

let cached: { at: number; models: string[] } | undefined;

/**
 * Codex refreshes its own model catalog into CODEX_HOME/models_cache.json, so reading it
 * keeps the picker current without a Consort release, with the built-in list as a fallback
 * on a machine that has never run Codex. The live catalog (main/modelDiscovery.ts) is merged
 * in ahead of this by the store.
 */
export function codexModels(keys: ApiKey[], now = Date.now()): string[] {
  if (cached && now - cached.at < 30_000) return cached.models;
  const dirs = new Set(keys.filter((k) => k.provider === "codex").map((k) => k.configDir || process.env.CODEX_HOME || join(homedir(), ".codex")));
  const listed: string[] = [];
  for (const dir of dirs) {
    let parsed: { models?: unknown };
    try { parsed = JSON.parse(readFileSync(join(dir, "models_cache.json"), "utf8")); } catch { continue; }
    listed.push(...listedCodexModels(parsed?.models));
  }
  const models = [...new Set([...listed, ...MODELS.codex])];
  cached = { at: now, models };
  return models;
}

export const forgetCodexModels = () => (cached = undefined);

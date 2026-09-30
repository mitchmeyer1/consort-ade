import { query } from "@anthropic-ai/claude-agent-sdk";
import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { claudeBin, loginEnv } from "./auth";
import { normalizeClaudeModels } from "../shared/claudeModels";
import type { ApiKey } from "../shared/types";

const PROBE_TIMEOUT = 20_000;
const envWithout = (k: string) => { const { [k]: _drop, ...rest } = process.env; return rest as Record<string, string | undefined>; };
const probeDir = () => { const d = join(app.getPath("userData"), "usage-probe"); mkdirSync(d, { recursive: true }); return d; };

/**
 * Ask the CLI which models this connector can use. Like the usage probe: an idle session that
 * never sends a prompt, so no model call is made, closed as soon as it has answered.
 */
export async function probeClaudeModels(key: ApiKey, apiKey?: string): Promise<string[]> {
  const ac = new AbortController();
  async function* idle() { await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true })); }
  const env = { ...envWithout("ANTHROPIC_API_KEY"), ...loginEnv(key), ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}) };
  const q = query({ prompt: idle(), options: { cwd: probeDir(), pathToClaudeCodeExecutable: claudeBin(), abortController: ac, env } });
  try {
    const rows = await new Promise<Awaited<ReturnType<typeof q.supportedModels>>>((res, rej) => {
      const t = setTimeout(() => rej(new Error("Claude model list timed out")), PROBE_TIMEOUT);
      q.supportedModels().then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
    });
    return normalizeClaudeModels(rows);
  } finally {
    ac.abort();
    try { q.close(); } catch {}
  }
}

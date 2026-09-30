import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { store } from "./store";
import { cliBinary } from "./cliRuntime";
import type { ApiKey } from "../shared/types";

const run = promisify(execFile);

// the CLIs Consort runs: a release it downloaded when newer, else the one bundled in the app (main/cliRuntime.ts); PATH / ~/.local/bin as a last resort
export const claudeBin = () => cliBinary("claude") ?? join(process.env.HOME ?? "", ".local/bin/claude");
export const codexBin = () => cliBinary("codex") ?? "codex";

// Each CLI keeps credentials in a home directory chosen by an env var, so one machine can hold several logins.
export const CONFIG_ENV = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const;
export const loginEnv = (key: ApiKey | undefined): Record<string, string> =>
  key?.auth === "login" && key.configDir ? { [CONFIG_ENV[key.provider]]: key.configDir } : {};
/** The directory Codex reads for globally available skills for this connector. */
export const codexHome = (key: ApiKey) => key.configDir ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
const keyById = (id: string) => { const k = store.data.keys.find((k) => k.id === id); if (!k) throw new Error("Connector not found"); return k; };

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
export function authLoginCmd(keyId: string) {
  const key = keyById(keyId);
  const prefix = key.configDir ? `${CONFIG_ENV[key.provider]}=${shq(key.configDir)} ` : "";
  return key.provider === "claude" ? `${prefix}${JSON.stringify(claudeBin())} auth login --claudeai` : `${prefix}${JSON.stringify(codexBin())} login`;
}

export async function authStatus(keyId: string) {
  const key = keyById(keyId);
  const { provider } = key;
  const env = { ...process.env, ...loginEnv(key) };
  try {
    if (provider === "claude") {
      // exits 1 when signed out but still prints JSON
      const stdout = await run(claudeBin(), ["auth", "status"], { timeout: 15_000, env }).then((r) => r.stdout, (e) => e.stdout ?? "{}");
      const j = JSON.parse(stdout);
      return { loggedIn: !!j.loggedIn, detail: j.loggedIn ? [j.email, j.subscriptionType ?? j.authMethod].filter(Boolean).join(" · ") : "not signed in — run `claude` in a terminal, then /login" };
    }
    const { stdout, stderr } = await run(codexBin(), ["login", "status"], { timeout: 15_000, env });
    const out = (stdout + stderr).trim();
    return { loggedIn: /logged in/i.test(out) && !/not logged in/i.test(out), detail: out.split("\n")[0] || "not signed in — run `codex login`" };
  } catch (e: any) {
    return { loggedIn: false, detail: e.code === "ENOENT" ? "CLI not found" : String(e.message).split("\n")[0] };
  }
}

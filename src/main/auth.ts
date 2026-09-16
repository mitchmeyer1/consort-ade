import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Provider } from "../shared/types";

const run = promisify(execFile);

// bundled CLIs from the hoisted node_modules so the packaged app carries them; PATH / ~/.local/bin as fallback
const nm = (rel: string) => { const p = join(app.getAppPath(), "node_modules", rel); return existsSync(p) ? p : undefined; };
export const claudeBin = () => nm("@anthropic-ai/claude-agent-sdk-darwin-arm64/claude") ?? join(process.env.HOME ?? "", ".local/bin/claude");
export const codexBin = () => nm("@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex") ?? "codex";

export async function authStatus(provider: Provider) {
  try {
    if (provider === "claude") {
      // exits 1 when signed out but still prints JSON
      const stdout = await run(claudeBin(), ["auth", "status"], { timeout: 15_000 }).then((r) => r.stdout, (e) => e.stdout ?? "{}");
      const j = JSON.parse(stdout);
      return { loggedIn: !!j.loggedIn, detail: j.loggedIn ? [j.email, j.subscriptionType ?? j.authMethod].filter(Boolean).join(" · ") : "not signed in — run `claude` in a terminal, then /login" };
    }
    const { stdout, stderr } = await run(codexBin(), ["login", "status"], { timeout: 15_000 });
    const out = (stdout + stderr).trim();
    return { loggedIn: /logged in/i.test(out) && !/not logged in/i.test(out), detail: out.split("\n")[0] || "not signed in — run `codex login`" };
  } catch (e: any) {
    return { loggedIn: false, detail: e.code === "ENOENT" ? "CLI not found" : String(e.message).split("\n")[0] };
  }
}

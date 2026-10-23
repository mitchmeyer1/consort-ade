import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { COVERED_VARIABLES, describeKeyRef, phiSettings, type CoveredKeyRef } from "../shared/phi.ts";
import { checkCoveredKey, runCoveredTurn } from "./covered";
import type { CliState } from "./state";

/**
 * `consort-cli phi …`: the PHI/PII guard's commands. Nothing here reads the covered key: status
 * checks that the reference points at something that exists and only its owner can read, the
 * Keychain store hands the prompt to `security` itself, and the smoke test lets the covered
 * turn's own Claude Code fetch the key.
 */

const run = promisify(execFile);

/**
 * Whether a shell started for an agent would get a covered variable back from the user's
 * startup files (zsh reads ~/.zshenv for every shell). Consort strips the variables from every
 * agent's environment, but a startup file that exports one undoes that inside the agent's own
 * shell. Prints nothing of the value: the shell answers "exposed" or "clean".
 */
export async function shellExposure(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const shell = env.SHELL || "/bin/zsh";
  const stripped = Object.fromEntries(Object.entries(env).filter(([k]) => !COVERED_VARIABLES.includes(k)));
  const exposed: string[] = [];
  for (const name of COVERED_VARIABLES) {
    const said = await run(shell, ["-c", `if [ -n "\${${name}:-}" ]; then echo exposed; else echo clean; fi`], { env: stripped, timeout: 20_000 }).then((r) => r.stdout.trim(), () => "unknown");
    if (said.endsWith("exposed")) exposed.push(name);
  }
  return exposed;
}

export async function phiStatusLines(s: CliState, checks: { key: typeof checkCoveredKey; exposure: () => Promise<string[]> } = { key: checkCoveredKey, exposure: () => shellExposure() }): Promise<string[]> {
  const phi = phiSettings(s);
  const key = await checks.key(s.covered);
  const exposed = await checks.exposure();
  const codex = s.accounts.filter((a) => a.provider === "codex").map((a) => a.name);
  return [
    `guard: ${phi.guard ? "on" : "off"}`,
    `covered key: ${describeKeyRef(s.covered)} · ${key.ok ? "found, readable only by you (its value is never read here)" : key.reason}`,
    `covered analyst: ${phi.coveredGrant.join(", ")} over the tables each question names · model ${phi.coveredModel ?? "the implementation model"} · ${phi.coveredMaxActive ?? 1} at a time · cells under ${phi.minCell ?? 11} suppressed`,
    `warehouse commands watched: ${phi.warehouseCommands.join(", ")} · internal email domains: ${phi.internalEmailDomains.join(", ") || "none"}`,
    `compliance contact: ${phi.complianceContact ?? "not set (phi configure --contact …)"}`,
    codex.length ? `Codex accounts ${phi.guard ? "idle while the guard is on" : "in use"}: ${codex.join(", ")}` : "Codex accounts: none",
    exposed.length
      ? `shell startup files export ${exposed.join(", ")} into every new shell, including the agents': Consort strips them from each agent's environment, but the agent's own shell gets them back. Keep the key in the Keychain reference instead and drop that export.`
      : "agent shells: no covered variable comes back from shell startup files",
  ];
}

/** `security` prompts for the key itself and stores it; Consort never sees the value */
export function storeKeychainKey(service: string, account: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w"], { stdio: "inherit" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/** one covered turn that answers a fixed prompt: proves the key, the helper and the gate end to end */
export async function phiSmoke(s: CliState, o: { model?: string; echoShape?: boolean }): Promise<{ line: string; ok: boolean }> {
  const phi = { ...phiSettings(s), ...(o.model ? { coveredModel: o.model } : {}) };
  // a value with the shape of an SSN, made up here so none sits in source; the gate must withhold the echo
  const fake = `${100 + Math.floor(Math.random() * 500)}-${10 + Math.floor(Math.random() * 89)}-${1000 + Math.floor(Math.random() * 8999)}`;
  const prompt = o.echoShape ? `Reply with exactly this line and nothing else: test value ${fake}` : "Reply with exactly the word: ready";
  const result = await runCoveredTurn({ taskId: "smoke", ask: { question: "smoke test", tables: [], shape: "one word" }, phi, ref: s.covered, prompt, timeoutMs: 5 * 60_000 });
  if (result.status === "released") return { line: `released: ${result.text}`, ok: !o.echoShape };
  if (result.status === "withheld") return { line: `withheld by the PII gate (${result.categories}): nothing from this run was released`, ok: !!o.echoShape };
  return { line: `covered turn unavailable: ${result.reason}`, ok: false };
}

/** a reference from the flags: --keychain [service] [--account a] or --file <path> */
export function keyRefFrom(flags: { keychain?: string | true; account?: string; file?: string }, defaultService: string): CoveredKeyRef | undefined {
  if (flags.file) return { kind: "file", path: flags.file };
  if (flags.keychain) return { kind: "keychain", service: flags.keychain === true ? defaultService : flags.keychain, ...(flags.account ? { account: flags.account } : {}) };
  return undefined;
}

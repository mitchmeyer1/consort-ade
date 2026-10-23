/**
 * The PHI/PII guard's shared pieces. With the guard on, no uncovered session reads member-level
 * data: subscription logins and Codex are not covered by the organisation's BAA with Anthropic,
 * only its API key is. A member-data question goes through the `[covered-analyst: …]` marker to
 * one confined turn on that key (cli/covered.ts), whose answer passes the PII gate
 * (piiGate.ts) before any other agent, log or post sees it. Consort never holds the key: state
 * keeps a reference to where it lives, and the covered child's own Claude Code fetches it with
 * an apiKeyHelper command, so it is in no environment variable any agent's shell could print.
 * cli/agent.ts prefixes PHI_RULES and keeps the covered variables out of every other agent's
 * environment; cli/pipeline.ts runs the marker.
 */
import { DEFAULT_INTERNAL_EMAIL_DOMAINS } from "./piiGate.ts";
import { DEFAULT_WAREHOUSE_COMMANDS } from "./warehouse.ts";

/** where the covered key lives: a macOS Keychain item, or a file only its owner can read. There is no environment-variable kind: a key exported in a variable reaches every process that inherits it */
export type CoveredKeyRef = { kind: "keychain"; service: string; account?: string } | { kind: "file"; path: string };
export const DEFAULT_COVERED_SERVICE = "anthropic-phi-api-key";

export type PhiSettings = {
  /** on: PHI_RULES on every turn, Codex idle, member-data questions only through the covered analyst */
  guard: boolean;
  /** the warehouse CLIs the guard watches, on top of shared/warehouse.ts's baseline */
  warehouseCommands: string[];
  /** identifier columns and person tables the query guard adds to its baselines (shared/warehouse.ts) */
  identifierColumns?: string[];
  personTables?: string[];
  /** the commands the covered analyst may run */
  coveredGrant: string[];
  /** colleagues' mail is not PHI, so the gate lets these domains through */
  internalEmailDomains: string[];
  /** the organisation's own published numbers, which the gate lets through */
  publishedPhones?: string[];
  /** named in the owner's alert when the gate catches an identifier */
  complianceContact?: string;
  coveredModel?: string;
  coveredMaxTurns?: number;
  /** covered turns at once across the installation */
  coveredMaxActive?: number;
  /** aggregate cells under this are suppressed */
  minCell?: number;
};
export const DEFAULT_PHI: PhiSettings = { guard: false, warehouseCommands: DEFAULT_WAREHOUSE_COMMANDS, coveredGrant: ["snow", "snowsql"], internalEmailDomains: DEFAULT_INTERNAL_EMAIL_DOMAINS, minCell: 11 };
export const phiSettings = (s: { phi?: Partial<PhiSettings> }): PhiSettings => ({ ...DEFAULT_PHI, ...s.phi });

/** variables that may carry the covered key or mark a covered session; no uncovered agent's environment has them */
export const COVERED_VARIABLES = ["COVERED_ANTHROPIC_API_KEY", "CLAUDE_PII_COVERED"];
/** what every uncovered turn is told about the guard (cli/agent.ts TurnOptions.phi) */
export const turnPhi = (s: { phi?: Partial<PhiSettings> }) => { const settings = phiSettings(s); return { guard: settings.guard, settings }; };
/** the accounts a turn may run on: Codex has no hook that can refuse a command and no BAA, so it sits out while the guard is on */
export const turnAccounts = <A extends { provider: string }>(s: { accounts: A[]; phi?: Partial<PhiSettings> }): A[] => (phiSettings(s).guard ? s.accounts.filter((a) => a.provider !== "codex") : s.accounts);

export const PHI_RULES = `## Member data: this session is not covered
This session may not read member-level personal or health data: no names, contact details, dates of birth, identifiers or claim rows of members, patients or subscribers.
- Stop at the first rung that answers: (1) aggregates: count, count_if, count(distinct …), group by; (2) derive over identifier columns without projecting them: where, join on, case when; (3) compare hashed identifiers inside predicates or joins only, never selected; (4) only then ask the covered analyst.
- Schema discovery (show, describe, information_schema) is yours to do here. The analyst gets a closed table list and the narrowest question you can write.
- To ask: one line \`[covered-analyst: <question>; tables: <db.schema.table, …>; shape: <the aggregate you want back>]\`, then end your turn. Consort runs it on the organisation's covered endpoint and returns only an answer that passed its PII gate. One per turn.
- Minimise exposure, never rigor: do not widen a question to save a round trip, and never run an identifier-bearing query here to save tokens.
- Warehouses are read-only for Consort: never insert, update, create, copy or unload.
- Tests, fixtures, evidence and screenshots use this task's seeded local database only. Never copy warehouse credentials into the worktree's env files.
- Nothing personal leaves this machine: not in Slack, ticket comments, questions, PR titles or bodies, review comments, commit messages, code, fixtures or evidence.
- Run each git push, gh post and upload as its own command, first on its line: Consort checks what it sends before it runs, so a commit, a copy or a cd before it on the same line is refused.`;

export type CoveredAsk = { question: string; tables: string[]; shape: string };
export type CoveredResult = { status: "released"; text: string; warnings: string[] } | { status: "withheld"; categories: string; shapes: string } | { status: "unavailable"; reason: string };

export const coveredRolePrompt = (ask: CoveredAsk, grant: string[]) => `You are Consort's covered analyst: the one session allowed to read member-level data, on the organisation's BAA-covered endpoint. You answer one question for an agent that cannot see the data. Never delegate, never start background work, never write files; finish in this turn.
Tables you may read: ${ask.tables.join(", ")}. Commands available: ${grant.join(", ")}, each with its statement after -q. Statements must be read-only: select, with, show, describe, explain or list.
Question: ${ask.question}
Wanted shape: ${ask.shape}`;

export const coveredOutputContract = (minCell: number) => `Only your final message leaves this session, and a PII gate reads it first; if it finds an identifier, nothing is released.
- Answer in the requested shape: counts, rates, distributions, yes or no. Never a raw value, a row, a name, an identifier, or a copy of query output.
- Write SQL whose result already has the answer's shape: GROUP BY, COUNT, a tight predicate, LIMIT. Do not pull rows to aggregate them yourself.
- Suppress cells under ${minCell} (write "<${minCell}"); bin ages 90 and over as "90+"; ZIP codes to 3 digits; dates to month or coarser.
- If the question cannot be answered without a member-level value, say so and give the closest aggregate.
- End with "SQL:" and the statements you ran.`;

/** a single line, reported even when it carries nothing personal: the gate found something and the analyst never sees why */
export const WITHHELD_LINE = "output withheld; nothing from this run was released";

const TABLE_NAME = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*){0,2}$/;
/** the first `[covered-analyst: question; tables: …; shape: …]` in a reply; an `error` when the marker is malformed */
export function parseCoveredAnalyst(text: string): CoveredAsk | { error: string } | undefined {
  const m = /\[covered-analyst:\s*([\s\S]*?)\]/i.exec(text);
  if (!m) return undefined;
  const body = m[1];
  const tablesAt = body.search(/;\s*tables:/i), shapeAt = body.search(/;\s*shape:/i);
  if (tablesAt < 0 || shapeAt < tablesAt) return { error: "the marker needs the question, then `; tables: …`, then `; shape: …`" };
  const question = body.slice(0, tablesAt).trim();
  const tables = body.slice(tablesAt, shapeAt).replace(/^;\s*tables:/i, "").split(",").map((t) => t.trim()).filter(Boolean);
  const shape = body.slice(shapeAt).replace(/^;\s*shape:/i, "").trim();
  if (!question || !shape || !tables.length) return { error: "the question, the tables and the shape must each be filled in" };
  if (tables.length > 10) return { error: "name at most 10 tables" };
  const bad = tables.find((t) => !TABLE_NAME.test(t));
  if (bad) return { error: `"${bad.slice(0, 60)}" is not a table name` };
  return { question, tables: tables.map((t) => t.toLowerCase()), shape };
}

/** what the asking agent gets back on its next turn */
export function coveredAnswerPrompt(result: CoveredResult): string {
  if (result.status === "released") return `## Covered analyst answer\n${result.text}\nUse it as given; do not re-derive it from member rows.${result.warnings.length ? ` (The gate noted: ${result.warnings.join(", ")}.)` : ""}`;
  if (result.status === "withheld") return `## Covered analyst answer\nWithheld by the PII gate (${result.categories}): ${WITHHELD_LINE}. Narrow the question once: ask for counts or a coarser shape, over fewer tables.`;
  return `## Covered analyst unavailable\n${result.reason}. Do not query member rows yourself; if the task needs it, ask the owner with [ask-user: …].`;
}

/**
 * The covered child's environment: no key and nothing of the subscription logins, no endpoint or
 * proxy overrides (an ANTHROPIC_BASE_URL would carry the BAA key elsewhere), its own empty config
 * so it cannot fall back to the user's login, no nonessential traffic, temp files in its scratch.
 */
export function coveredEnv(base: Record<string, string | undefined>, scratch: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !/^(?:ANTHROPIC|CLAUDE|OPENAI|CODEX)_/.test(name) && !COVERED_VARIABLES.includes(name)) env[name] = value;
  return { ...env, CLAUDE_PII_COVERED: "1", CLAUDE_CONFIG_DIR: `${scratch}/config`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", TMPDIR: `${scratch}/tmp` };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
/** the command the covered child's Claude Code runs to fetch the key itself; Consort never sees the value */
export const apiKeyHelperFor = (ref: CoveredKeyRef) => (ref.kind === "keychain" ? `security find-generic-password -w -s ${shellQuote(ref.service)}${ref.account ? ` -a ${shellQuote(ref.account)}` : ""}` : `cat ${shellQuote(ref.path)}`);

/** where the key lives, said without its value */
export const describeKeyRef = (ref: CoveredKeyRef | undefined) => (!ref ? "none" : ref.kind === "keychain" ? `Keychain item ${ref.service}${ref.account ? ` (account ${ref.account})` : ""}` : `file ${ref.path}`);

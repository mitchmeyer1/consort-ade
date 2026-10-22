/**
 * The record of every agent turn, for post-mortems: which ticket and step, which model on which
 * account, how long it took, the tokens and dollars, and how it ended. One JSON line per turn in
 * ~/.consort-cli/telemetry/turns-YYYY-MM.jsonl, appended by agent.ts runTurn, kept after the task
 * leaves the state file. `consort-cli report` reads it.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TokenUsage, TurnUsage } from "../shared/headless.ts";

export type TurnOutcome = "ok" | "error" | "limit" | "aborted" | "timeout" | "silenced";
/** what the caller knows about a turn; `reason` may be set before an abort so the record says why */
export type TurnTrace = { taskId?: string; ticket?: string; title?: string; scanner?: string; kind: "build" | "review" | "oversight" | "sentry"; stage?: string; step: string; role?: string; escalated?: boolean; reason?: "timeout" | "silenced" };
export type TurnRecord = {
  at: number; durationMs: number; taskId?: string; ticket?: string; title?: string; scanner?: string; kind: TurnTrace["kind"]; stage?: string; step: string; role?: string;
  provider: string; account: string; model: string; resumed: boolean; escalated?: boolean;
  outcome: TurnOutcome; error?: string; usd: number; tokens: TokenUsage; host?: string;
};

export const telemetryDir = (home: string) => join(home, "telemetry");
const fileFor = (home: string, at: number) => { const d = new Date(at); return join(telemetryDir(home), `turns-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}.jsonl`); };

export const sumUsage = (usage: TurnUsage[] | undefined) => (usage ?? []).reduce((acc, u) => ({
  usd: acc.usd + (u.usd ?? 0),
  tokens: { input: acc.tokens.input + u.tokens.input, output: acc.tokens.output + u.tokens.output, cacheRead: acc.tokens.cacheRead + u.tokens.cacheRead, cacheWrite: acc.tokens.cacheWrite + u.tokens.cacheWrite },
}), { usd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as TokenUsage });

/** append one turn; telemetry never breaks a turn */
export function recordTurn(home: string, r: TurnRecord): void {
  try { mkdirSync(telemetryDir(home), { recursive: true }); appendFileSync(fileFor(home, r.at), JSON.stringify(r) + "\n"); } catch { /* best effort */ }
}

export function readTurns(home: string, filter: { ticket?: string; since?: number } = {}): TurnRecord[] {
  const dir = telemetryDir(home);
  if (!existsSync(dir)) return [];
  const out: TurnRecord[] = [];
  for (const f of readdirSync(dir).filter((n) => /^turns-\d{4}-\d{2}\.jsonl$/.test(n)).sort()) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as TurnRecord;
        if (filter.ticket && r.ticket !== filter.ticket && r.taskId !== filter.ticket) continue;
        if (filter.since && r.at < filter.since) continue;
        out.push(r);
      } catch { /* a torn line */ }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ── the post-mortem ──────────────────────────────────────────────────────────────────────

type Bucket = { turns: number; ms: number; usd: number; tokens: number; failed: number };
const empty = (): Bucket => ({ turns: 0, ms: 0, usd: 0, tokens: 0, failed: 0 });
const add = (b: Bucket, r: TurnRecord) => { b.turns++; b.ms += r.durationMs; b.usd += r.usd; b.tokens += r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite; if (r.outcome !== "ok") b.failed++; };
const group = (rs: TurnRecord[], key: (r: TurnRecord) => string) => {
  const m = new Map<string, Bucket>();
  for (const r of rs) { const k = key(r); if (!m.has(k)) m.set(k, empty()); add(m.get(k)!, r); }
  return [...m.entries()].sort((a, b) => b[1].ms - a[1].ms);
};

export type Report = {
  turns: number; wallMs: number; agentMs: number; usd: number; tokens: TokenUsage; parallelism: number;
  wasted: Bucket; byStage: [string, Bucket][]; byModel: [string, Bucket][]; byAccount: [string, Bucket][]; byStep: [string, Bucket][]; byTicket: [string, Bucket][];
  slowest: TurnRecord[]; failures: TurnRecord[];
};

export function summarize(rs: TurnRecord[]): Report {
  const tokens = rs.reduce((t, r) => ({ input: t.input + r.tokens.input, output: t.output + r.tokens.output, cacheRead: t.cacheRead + r.tokens.cacheRead, cacheWrite: t.cacheWrite + r.tokens.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const start = rs.length ? Math.min(...rs.map((r) => r.at)) : 0;
  const end = rs.length ? Math.max(...rs.map((r) => r.at + r.durationMs)) : 0;
  const agentMs = rs.reduce((n, r) => n + r.durationMs, 0);
  // time any agent was running, merged across overlaps: the denominator for "how parallel was it"
  const spans = rs.map((r) => [r.at, r.at + r.durationMs] as const).sort((a, b) => a[0] - b[0]);
  let busy = 0, curS = -1, curE = -1;
  for (const [s, e] of spans) { if (s > curE) { if (curE > curS) busy += curE - curS; curS = s; curE = e; } else curE = Math.max(curE, e); }
  if (curE > curS) busy += curE - curS;
  const wasted = empty();
  for (const r of rs) if (r.outcome !== "ok") add(wasted, r);
  return {
    turns: rs.length, wallMs: end - start, agentMs, usd: rs.reduce((n, r) => n + r.usd, 0), tokens, parallelism: busy ? agentMs / busy : 0, wasted,
    byStage: group(rs, (r) => `${r.kind}: ${r.stage ?? "-"}`), byModel: group(rs, (r) => r.model), byAccount: group(rs, (r) => `${r.provider} ${r.account}`),
    byStep: group(rs.filter((r) => /^parallel |^review area /.test(r.step)), (r) => r.step), byTicket: group(rs, (r) => `${r.ticket ?? "-"} ${r.title ?? ""}`.trim()),
    slowest: [...rs].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10), failures: rs.filter((r) => r.outcome !== "ok"),
  };
}

export const duration = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
const money = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`;
const toks = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const table = (title: string, rows: [string, Bucket][]) => rows.length ? [`## ${title}`, "", "| | turns | agent time | cost | tokens | failed |", "|---|---:|---:|---:|---:|---:|", ...rows.map(([k, b]) => `| ${k} | ${b.turns} | ${duration(b.ms)} | ${money(b.usd)} | ${toks(b.tokens)} | ${b.failed} |`), ""] : [];

export function renderReport(title: string, rs: TurnRecord[]): string {
  const r = summarize(rs);
  if (!r.turns) return `# ${title}\n\nNo agent turns recorded.\n`;
  const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16);
  return [
    `# ${title}`, "",
    `${when(rs[0].at)} → ${when(rs[rs.length - 1].at + rs[rs.length - 1].durationMs)} UTC`, "",
    `- **Wall clock:** ${duration(r.wallMs)} · **agent time:** ${duration(r.agentMs)} · **parallelism:** ${r.parallelism.toFixed(1)}× while agents were running`,
    `- **Cost:** ${money(r.usd)} over ${r.turns} turns · **tokens:** ${toks(r.tokens.input)} in, ${toks(r.tokens.output)} out, ${toks(r.tokens.cacheRead)} cache read, ${toks(r.tokens.cacheWrite)} cache write`,
    `- **Wasted:** ${r.wasted.turns} turns that did not finish (${duration(r.wasted.ms)}, ${money(r.wasted.usd)})`, "",
    ...table("By ticket", r.byTicket.length > 1 ? r.byTicket : []),
    ...table("By stage", r.byStage), ...table("By model", r.byModel), ...table("By account", r.byAccount), ...table("Parallel tickets and review areas", r.byStep),
    "## Slowest turns", "", "| started | step | model | time | cost | outcome |", "|---|---|---|---:|---:|---|",
    ...r.slowest.map((t) => `| ${when(t.at)} | ${t.ticket ?? ""} ${t.step} | ${t.model} | ${duration(t.durationMs)} | ${money(t.usd)} | ${t.outcome} |`), "",
    ...(r.failures.length ? ["## Turns that did not finish", "", "| started | step | model / account | time | outcome | error |", "|---|---|---|---:|---|---|",
      ...r.failures.map((t) => `| ${when(t.at)} | ${t.ticket ?? ""} ${t.step} | ${t.model} / ${t.account} | ${duration(t.durationMs)} | ${t.outcome} | ${(t.error ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 120)} |`), ""] : []),
  ].join("\n");
}

/** turns from a task's saved history that predate the telemetry log, so an older ticket's report is not empty */
export function historyTurns(task: { id: string; ticket: { id: string; title: string }; kind?: string; turnHistory?: { at: number; stage: string; role: string; provider: string; model: string; durationMs: number; usage?: TurnUsage[]; error?: string; escalated?: boolean }[] }, before: number): TurnRecord[] {
  return (task.turnHistory ?? []).filter((h) => h.at < before).map((h) => {
    const spent = sumUsage(h.usage);
    const outcome: TurnOutcome = !h.error ? "ok" : /limit|quota|usage/i.test(h.error) ? "limit" : /timed out/i.test(h.error) ? "timeout" : "error";
    return { at: h.at, durationMs: h.durationMs, taskId: task.id, ticket: task.ticket.id, title: task.ticket.title, kind: task.kind === "review" ? "review" : "build", stage: h.stage, step: `${h.stage} (from task history)`, role: h.role, provider: h.provider, account: "?", model: h.model, resumed: false, escalated: h.escalated, outcome, error: h.error, usd: spent.usd, tokens: spent.tokens };
  });
}

/** "7d", "24h", "90m" → milliseconds */
export function sinceMs(text: string | undefined): number | undefined {
  const m = /^(\d+)\s*([dhm])$/i.exec(text?.trim() ?? "");
  return m ? Number(m[1]) * ({ d: 86_400_000, h: 3_600_000, m: 60_000 } as const)[m[2].toLowerCase() as "d" | "h" | "m"] : undefined;
}

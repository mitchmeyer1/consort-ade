/**
 * The draft PR, opened as soon as the task has a branch, so the Slack "github" link shows the diff,
 * the commits and a summary from the start. GitHub needs one commit before it opens a PR, so an
 * empty start commit goes first when the branch has none. The worker refreshes the description at
 * each checkpoint until the build is done; then the agent writes the real description.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ShipTicket } from "../shared/ship.ts";

export type Run = (cmd: string, args: string[], cwd: string) => Promise<string>;
const realRun: Run = async (cmd, args, cwd) => (await promisify(execFile)(cmd, args, { cwd, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

export const draftTitle = (ticket: ShipTicket) => `[WIP] ${ticket.title}`;

export function draftBody(ticket: ShipTicket, progress: string, ticketBody?: string): string {
  const description = (ticketBody ?? "").trim();
  return [
    "> Draft opened by Consort so the work in progress can be followed. Not ready for review; Consort marks it ready after local self-review rounds and verified evidence are published.",
    "",
    `**Ticket:** ${ticket.url}${ticket.source === "github" ? ` (Closes #${ticket.id})` : ""}`,
    `**Progress:** ${progress}`,
    ...(description ? ["", "## Ticket", description.length > 6000 ? `${description.slice(0, 6000)}…` : description] : []),
  ].join("\n");
}

/** an open PR for the branch, or a new draft one; undefined with the reason when GitHub refused */
export async function ensureDraftPr(o: { cwd: string; base: string; branch: string; title: string; body: string }, run: Run = realRun): Promise<{ url?: string; created?: boolean; error?: string }> {
  try {
    const existing = JSON.parse(await run("gh", ["pr", "list", "--head", o.branch, "--state", "open", "--json", "url", "--limit", "1"], o.cwd) || "[]") as { url: string }[];
    if (existing[0]?.url) return { url: existing[0].url };
    // GitHub opens no PR on a branch without commits: add an empty start commit and push it
    const ahead = Number((await run("git", ["rev-list", "--count", `origin/${o.base}..HEAD`], o.cwd)).trim());
    if (!ahead) await run("git", ["commit", "--allow-empty", "--no-verify", "-m", `Consort: start ${o.title.replace(/^\[WIP\] /, "")}`], o.cwd);
    await run("git", ["push", "--no-verify", "-u", "origin", `HEAD:refs/heads/${o.branch}`], o.cwd);
    const out = await run("gh", ["pr", "create", "--draft", "--base", o.base, "--head", o.branch, "--title", o.title, "--body", o.body], o.cwd);
    const url = out.trim().split("\n").reverse().find((l) => /^https:\/\/\S+\/pull\/\d+/.test(l.trim()))?.trim();
    return url ? { url, created: true } : { error: `gh pr create printed no PR URL: ${out.trim().slice(0, 200)}` };
  } catch (e) {
    return { error: String((e as { stderr?: string }).stderr || (e as Error).message || e).trim().split("\n")[0] };
  }
}

export async function updateDraftBody(cwd: string, url: string, body: string, run: Run = realRun): Promise<string | undefined> {
  try { await run("gh", ["pr", "edit", url, "--body", body], cwd); return undefined; }
  catch (e) { return String((e as Error).message ?? e).split("\n")[0]; }
}

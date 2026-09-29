import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CLICKUP_FILTER_TOOLS, denyAllBut, parseFilterResult, type ShipSync, type ShipTask } from "../shared/ship";
import { SHIP_HOME } from "./ship";

type Query = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<any>;
type Reconciled = Pick<ShipSync, "changed" | "remote" | "unmapped">;

export type ShipSyncDeps = {
  /** the config homes to try, best first; undefined runs on the Claude login's own home */
  seats: () => (string | undefined)[];
  model: () => string;
  publish: (sync: ShipSync) => void;
  query?: Query;
  reconcile?: (tasksFile: string) => Promise<Reconciled>;
  listId?: () => string;
  home?: string;
};

export const seatLabel = (dir?: string) => (dir ? basename(dir).replace(/^\.claude-?/, "") || "default" : "default");

/** only the list id: the same file holds the skill's Slack webhook, which stays in it */
export function shipListId(home = SHIP_HOME) {
  const file = join(home, "apps", "ship", "config.json");
  const id = JSON.parse(readFileSync(file, "utf8"))?.list_id;
  if (!id) throw new Error(`No ClickUp list_id in ${file}.`);
  return String(id);
}

// a login seat, never an API key: the seat's own MCP config is what carries ClickUp
function envFor(seat?: string) {
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env as Record<string, string>;
  return seat ? { ...env, CLAUDE_CONFIG_DIR: seat } : env;
}

/** the tools and MCP servers a session on this seat starts with, read from its init message before any model call */
async function probe(query: Query, cwd: string, env: Record<string, string>) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 60_000);
  try {
    for await (const m of query({ prompt: "hi", options: { cwd, env, abortController, tools: [], maxTurns: 1 } }))
      if (m.type === "system" && m.subtype === "init") {
        abortController.abort();
        return { tools: (m.tools ?? []) as string[], servers: ((m.mcp_servers ?? []) as { name: string }[]).map((s) => s.name) };
      }
  } catch (e) { if (!abortController.signal.aborted) throw e; }
  finally { clearTimeout(timer); }
  return { tools: [], servers: [] };
}

/**
 * Every task in the list, read from ClickUp's own tool results rather than the model's retelling. Only
 * calls on this list with closed tasks included count, so a stray call can't pass off a partial list.
 */
async function fetchTasks(query: Query, o: { cwd: string; env: Record<string, string>; tool: string; deny: string[]; listId: string; model: string }) {
  const calls = new Set<string>();
  const pages: { tasks: ShipTask[]; more: boolean }[] = [];
  const prompt = `List every task in ClickUp list ${o.listId} with the filter_tasks tool: list_ids ["${o.listId}"], include_closed true, subtasks false. While has_more is true, call it again with page = next_page. Then reply "done".`;
  for await (const m of query({ prompt, options: { cwd: o.cwd, env: o.env, model: o.model, maxTurns: 8, tools: [], allowedTools: [o.tool], disallowedTools: o.deny, systemPrompt: "You fetch data with the one tool you have. No commentary." } })) {
    if (m.type === "assistant")
      for (const b of m.message?.content ?? [])
        if (b.type === "tool_use" && b.name === o.tool && b.input?.include_closed === true && (b.input?.list_ids ?? []).map(String).includes(o.listId)) calls.add(b.id);
    if (m.type === "user" && Array.isArray(m.message?.content))
      for (const b of m.message.content)
        if (b.type === "tool_result" && calls.has(b.tool_use_id)) { const page = parseFilterResult(b.content); if (page) pages.push(page); }
    if (m.type === "result" && (m.subtype !== "success" || m.is_error)) throw new Error(m.errors?.join("\n") || m.result || m.subtype);
  }
  if (!pages.length) throw new Error("ClickUp returned no task list.");
  if (pages.at(-1)!.more) throw new Error("The sync stopped before ClickUp's last page.");
  return [...new Map(pages.flatMap((p) => p.tasks).map((t) => [t.id, t])).values()];
}

function reconcileWithShipPy(file: string): Promise<Reconciled> {
  return new Promise((resolve, reject) => {
    execFile("python3", [join(SHIP_HOME, "apps", "ship", "ship.py"), "reconcile", "--from-tasks", file, "--json"], { cwd: SHIP_HOME, timeout: 60_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr).trim().split("\n").pop() || error.message));
      try { const j = JSON.parse(String(stdout)); resolve({ changed: j.changed ?? [], remote: j.remote ?? [], unmapped: j.unmapped ?? [] }); }
      catch { reject(new Error("ship.py reconcile printed no JSON.")); }
    });
  });
}

/**
 * Brings the board's stages in line with ClickUp. The first seat with a ClickUp connector reads the list
 * (a cheap model, one tool in context), and the skill's own reconcile moves each state.json; Consort
 * still never writes one. Callers that ask while a sync is running share it.
 */
export function createShipSync(deps: ShipSyncDeps) {
  let running: Promise<ShipSync> | undefined;
  const once = async (): Promise<ShipSync> => {
    const query = deps.query ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as Query);
    const listId = (deps.listId ?? shipListId)();
    const cwd = deps.home ?? SHIP_HOME;
    const tried: string[] = [];
    for (const seat of deps.seats()) {
      const env = envFor(seat);
      const { tools, servers } = await probe(query, cwd, env);
      const tool = CLICKUP_FILTER_TOOLS.find((t) => tools.includes(t));
      if (!tool) { tried.push(seatLabel(seat)); continue; }
      const tasks = await fetchTasks(query, { cwd, env, tool, deny: denyAllBut(tool, tools, servers), listId, model: deps.model() });
      const dir = mkdtempSync(join(tmpdir(), "ship-sync-"));
      try {
        writeFileSync(join(dir, "tasks.json"), JSON.stringify({ tasks }));
        return { at: Date.now(), seat: seatLabel(seat), ...(await (deps.reconcile ?? reconcileWithShipPy)(join(dir, "tasks.json"))) };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    throw new Error(`No ClickUp connector on ${tried.length > 1 ? "seats" : "seat"} ${tried.join(", ") || "(none)"}. Connect ClickUp in Claude Code there.`);
  };
  return {
    sync(): Promise<ShipSync> {
      running ??= once()
        .catch((e): ShipSync => ({ at: Date.now(), changed: [], remote: [], unmapped: [], error: (e as Error).message }))
        .then((s) => { deps.publish(s); return s; })
        .finally(() => { running = undefined; });
      return running;
    },
  };
}

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, copyFile, readdir, cp, rename, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { promisify } from "node:util";
import { stageSafely } from "./checkpoint.ts";
import type { PushGuard } from "./phiGate";
import { redactPii } from "../shared/redact.ts";
import { isNoResource, RESOURCE_HEADING, resourceReaderPrompt, type Resource } from "../shared/resources.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, maxBuffer: 16 << 20 })).stdout;
/** tickets or readers at once; the AI-slot limits in cli/capacity.ts still apply to each one */
export const MAX_PARALLEL = 6;
const cap = (n = 4) => Math.max(1, Math.min(MAX_PARALLEL, Math.floor(n) || 1));
const safe = (p: string) => p && !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && p !== "." && !/[\\*?\[\]{}]/.test(p) && p !== ".git" && !p.startsWith(".git/") && p !== ".consort" && !p.startsWith(".consort/");
const within = (file: string, scope: string) => file === scope || file.startsWith(scope.replace(/\/$/, "") + "/");
const scopesOverlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => within(x, y) || within(y, x)));
export type ParallelTask = { id: string; files: string[]; prompt: string; blockedBy?: string[] };
export type ParallelRun = (job: { id: string; cwd: string; prompt: string; kind: "research" | "implementation" | "resource" }) => Promise<{ text: string; error?: string; limit?: unknown }>;
/** `pushGuard`: the PHI/PII guard's check on a child's saved work before it goes to GitHub, given the commit the child started from */
export type ParallelOptions = { cwd: string; directory: string; tasks: ParallelTask[]; run: ParallelRun; concurrency?: number; pushGuard?: (base: string) => PushGuard | undefined };

async function bounded<T, R>(items: T[], count: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // Settle every worker before cleanup, including when another worker throws.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  const failed = settled.find((x): x is PromiseRejectedResult => x.status === "rejected");
  if (failed) throw failed.reason;
  return results;
}
async function filesFor(cwd: string, scopes: string[]): Promise<string[]> {
  const files = [...new Set((await git(cwd, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...scopes)).split("\0").filter(Boolean))].sort();
  const root = await realpath(cwd);
  for (const file of files) {
    if (sensitive(file)) throw new Error(`Sensitive research path refused: ${file}`);
    const stat = await lstat(join(cwd, file)).catch((e) => { if (e.code === "ENOENT") return undefined; throw e; });
    if (stat?.isSymbolicLink()) throw new Error(`Research symlink refused: ${file}`);
    if (stat && !within(await realpath(join(cwd, file)), root)) throw new Error(`Research path outside worktree: ${file}`);
  }
  return files;
}
const sensitive = (file: string) => /(?:^|[\\/])(?:\.env(?:\..*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|id_rsa|id_ed25519|[^/]*\.(?:pem|key|p12|pfx)|(?:phi|pii|patients?|customers?)[_-](?:data|records?|export)[^/]*)$/i.test(file);
const scopeText = (files: string[]) => `${files.slice(0, 12).join(", ")}${files.length > 12 ? `, plus ${files.length - 12} other assigned files; use git ls-files to locate related code` : ""}`;
async function revision(cwd: string, tasks: ParallelTask[]): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(tasks));
  // Related callers outside a reader's starting scope also invalidate reused facts.
  hash.update(await git(cwd, "ls-files", "--stage", "-z"));
  const changed = (await git(cwd, "diff", "--name-only", "--no-renames", "-z", "HEAD")).split("\0").filter(Boolean).filter((file) => !sensitive(file));
  const files = [...new Set([...await filesFor(cwd, tasks.flatMap((t) => t.files)), ...await filesFor(cwd, changed.length ? changed : ["__consort_no_changed_files__"])])];
  for (const file of files) {
    hash.update(file).update("\0");
    hash.update(await readFile(join(cwd, file)).catch(() => Buffer.from("<deleted>")));
  }
  return hash.digest("hex");
}
export type ResourceSection = { name: string; text: string; head: string; reused: boolean; empty: boolean };
/** `summary` is the planner's prompt section, empty when no resource bore on the ticket; a resource that could not be read is in `failed` and the rest still count */
export type ResourceResearch = { summary: string; sections: ResourceSection[]; failed: { name: string; error: string }[] };
export type ResourceOptions = { resources: Resource[]; directory: string; ticketBody: string; run: ParallelRun; concurrency?: number };

/**
 * Project info resources are read in place: one read-only reader per resource with its working
 * directory in the checkout, no worktree, nothing written there. A report is reused while the
 * checkout's commit, its uncommitted edits and the reader's prompt (which carries the ticket) are
 * unchanged, and RESOURCES.md beside the task research keeps the latest reports.
 */
export async function runResourceResearch(o: ResourceOptions): Promise<ResourceResearch> {
  const outcomes = await bounded(o.resources, cap(o.concurrency ?? 3), (resource) => readResource(o, resource).then((section) => ({ section }), (e: Error) => ({ failed: { name: resource.name, error: e.message.split("\n")[0] } })));
  const sections = outcomes.flatMap((x) => ("section" in x ? [x.section] : []));
  const failed = outcomes.flatMap((x) => ("failed" in x ? [x.failed] : []));
  const found = sections.filter((s) => !s.empty);
  if (sections.length) {
    await mkdir(o.directory, { recursive: true });
    await writeFile(join(o.directory, "RESOURCES.md"), `# Project info resources\n\n${sections.map((s) => `## ${s.name}\n\nCheckout commit: ${s.head}\n\n${s.empty ? "Nothing here bears on the ticket." : s.text}`).join("\n\n")}\n`);
  }
  return { summary: found.length ? `${RESOURCE_HEADING}\n${found.map((s) => `### ${s.name}\n${s.text}`).join("\n\n")}\n` : "", sections, failed };
}

async function readResource(o: ResourceOptions, resource: Resource): Promise<ResourceSection> {
  if (!resource.path.startsWith("/")) throw new Error(`Resource ${resource.name}: ${resource.path} is not an absolute path`);
  await lstat(join(resource.path, ".git")).catch(() => { throw new Error(`Resource ${resource.name}: ${resource.path} is not a git checkout`); });
  const prompt = resourceReaderPrompt(resource.name, o.ticketBody);
  const key = await resourceRevision(resource.path, prompt);
  const head = (await git(resource.path, "rev-parse", "HEAD")).trim();
  const cache = join(o.directory, `resource-${resource.id}-${key}.json`);
  const cached = await readFile(cache, "utf8").then((s) => JSON.parse(s)).catch(() => undefined);
  if (cached?.key === key && typeof cached.text === "string") return { name: resource.name, text: cached.text, head, reused: true, empty: !cached.text };
  const result = await o.run({ id: resource.name, cwd: resource.path, prompt, kind: "resource" });
  if (result.error || result.limit) throw new Error(`Resource ${resource.name}: ${result.error ?? "account limit"}`);
  // the notes should hold no personal data; masking what slips through costs nothing
  const text = isNoResource(result.text) ? "" : redactPii(result.text.trim());
  // a checkout that moved while it was read (another worker pulled) gives this report no cache entry
  if (await resourceRevision(resource.path, prompt) === key) {
    await mkdir(o.directory, { recursive: true });
    await writeFile(cache, JSON.stringify({ key, text }));
  }
  return { name: resource.name, text, head, reused: false, empty: !text };
}

async function resourceRevision(cwd: string, prompt: string): Promise<string> {
  const hash = createHash("sha256").update(prompt).update("\0");
  hash.update(await git(cwd, "rev-parse", "HEAD")).update("\0");
  // --no-optional-locks: reading status must not rewrite the notes repo's index
  const status = await git(cwd, "--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all");
  hash.update(status);
  if (status) hash.update(await git(cwd, "diff", "HEAD", "--binary"));
  return hash.digest("hex");
}
/**
 * A child ticket's work is never thrown away. While it runs, the worker commits it every few
 * minutes; when the worker stops, or the child fails, or a stopped wave is cleaned up, what it has
 * is committed and kept under refs/consort/wip/<ticket> and pushed to GitHub as
 * consort-wip/<branch>/<ticket>. The next run of that ticket starts from it.
 */
// `guard` is never written to the marker: a recovered child gets it again from its caller
type Child = { main: string; ticket: string; base: string; finished?: boolean; guard?: PushGuard };
const live = new Map<string, Child>();
export const WIP_SAVE_MS = 5 * 60_000;
const wipRef = (ticket: string) => `refs/consort/wip/${ticket}`;
const wipBranch = async (main: string, ticket: string) => `consort-wip/${(await git(main, "branch", "--show-current")).trim() || "detached"}/${ticket}`;
const markerOf = (cwd: string) => `${cwd}.json`;

/** commit what a child ticket has so far and keep it; false when it has nothing beyond its start */
export async function saveChild(cwd: string, push = true): Promise<boolean> {
  const c = live.get(cwd);
  if (!c || c.finished) return false;
  await stageSafely((args, dir) => git(dir, ...args), cwd);
  if ((await git(cwd, "diff", "--cached", "--name-only")).trim()) await git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-m", `Consort WIP: ${c.ticket}`);
  const head = (await git(cwd, "rev-parse", "HEAD")).trim();
  if (head === c.base) return false;
  await git(cwd, "update-ref", wipRef(c.ticket), head);
  // work the PHI/PII guard withholds stays in the local ref; the coordinator's checkpoint gates its own push
  const withheld = push ? await c.guard?.((args, dir) => git(dir, ...args), cwd).catch(() => "unchecked") : undefined;
  if (push && !withheld) await git(cwd, "push", "--no-verify", "-f", "origin", `${head}:refs/heads/${await wipBranch(c.main, c.ticket)}`).catch(() => undefined);
  return true;
}
/** every running child ticket, saved at once: the worker calls this before it exits on a stop */
export const saveLiveChildren = () => Promise.all([...live.keys()].map((cwd) => saveChild(cwd).catch(() => false)));

/** start a child from the work an interrupted run of its ticket left, when there is some */
async function resumeSaved(main: string, cwd: string, task: ParallelTask): Promise<string> {
  const saved = (await git(main, "rev-parse", "--verify", "--quiet", wipRef(task.id)).catch(() => "")).trim();
  if (!saved) return "";
  const from = (await git(cwd, "merge-base", saved, "HEAD")).trim();
  const patch = await git(cwd, "diff", "--binary", from, saved, "--", ...task.files);
  if (!patch.trim()) return "";
  const file = join(cwd, ".consort", "resume.patch");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, patch);
  try {
    await git(cwd, "apply", "--3way", "--whitespace=nowarn", file);
    return `\n\nAn interrupted run of this ticket saved work (${saved.slice(0, 9)}); it is applied in this worktree. Check it, keep what is right, and continue from it rather than starting over.`;
  } catch {
    await git(cwd, "reset", "--hard", "HEAD").catch(() => undefined);
    return `\n\nAn interrupted run of this ticket saved work as commit ${saved.slice(0, 9)} (git show ${saved.slice(0, 9)}). It no longer applies cleanly; reuse what still fits instead of rewriting it.`;
  } finally { await rm(file, { force: true }); }
}

async function isolated<T>(o: ParallelOptions, task: ParallelTask, fn: (cwd: string, head: string) => Promise<T>, ticket = false): Promise<T> {
  // beside the task's worktree, never inside it: copying .consort/ship into a folder within itself fails (EINVAL)
  const cwd = join(dirname(resolve(o.cwd)), `.parallel-${basename(resolve(o.cwd))}`, `work-${randomUUID()}`);
  await mkdir(dirname(cwd), { recursive: true });
  await git(o.cwd, "worktree", "add", "--detach", cwd, "HEAD");
  if (ticket) {
    const child: Child = { main: o.cwd, ticket: task.id, base: (await git(cwd, "rev-parse", "HEAD")).trim() };
    live.set(cwd, { ...child, guard: o.pushGuard?.(child.base) });
    await writeFile(markerOf(cwd), JSON.stringify(child));
  }
  try {
    // Ignored ship artifacts carry the spec and decisions into each fresh context.
    await cp(join(o.cwd, ".consort/ship"), join(cwd, ".consort/ship"), {
      recursive: true, filter: (source) => relative(join(o.cwd, ".consort/ship"), source).split(/[\\/]/)[0] !== "parallel",
    }).catch((e) => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; });
    const report = await readFile(join(o.directory, "RESEARCH.md")).catch(() => undefined);
    if (report) { await mkdir(join(cwd, ".consort/ship/parallel"), { recursive: true }); await writeFile(join(cwd, ".consort/ship/parallel/RESEARCH.md"), report); }
    return await fn(cwd, (await git(cwd, "rev-parse", "HEAD")).trim());
  }
  finally {
    // a child that did not finish keeps its work: commit it and save the ref before the folder goes
    if (live.has(cwd)) { await saveChild(cwd).catch(() => false); live.delete(cwd); }
    await git(o.cwd, "worktree", "remove", "--force", cwd);
    await rm(markerOf(cwd), { force: true });
  }
}
function validate(tasks: ParallelTask[]) {
  if (new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error("Parallel task IDs must be unique");
  for (const t of tasks) if (!t.files.length || t.files.some((p) => !safe(p))) throw new Error(`Unsafe or missing file scope for ${t.id}`);
}

/** Reports are reusable only while the task scope and every scoped file's contents match. */
export async function runResearch(o: ParallelOptions): Promise<{ summary: string; reused: boolean; results: { id: string; text: string }[] }> {
  validate(o.tasks);
  const key = await revision(o.cwd, o.tasks);
  const cache = join(o.directory, `research-${key}.json`);
  const cached = await readFile(cache, "utf8").then((s) => JSON.parse(s)).catch(() => undefined);
  if (cached?.key === key && typeof cached.summary === "string" && Array.isArray(cached.results)) {
    await writeFile(join(o.directory, "RESEARCH.md"), `# Task research\n\nRevision key: ${key}\n\n${cached.summary}\n`);
    return { summary: cached.summary, results: cached.results, reused: true };
  }
  const results = await bounded(o.tasks, cap(o.concurrency), async (task) => isolated(o, task, async (cwd) => {
    // Readers see current scoped content, including uncommitted changes and deletions.
    const changed = (await git(o.cwd, "diff", "--name-only", "--no-renames", "-z", "HEAD")).split("\0").filter(Boolean).filter((file) => !sensitive(file));
    const copies = [...new Set([...await filesFor(o.cwd, task.files), ...await filesFor(o.cwd, changed.length ? changed : ["__consort_no_changed_files__"])])];
    for (const file of copies) {
      const destination = join(cwd, file);
      await mkdir(dirname(destination), { recursive: true });
      try { await copyFile(join(o.cwd, file), destination); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await rm(destination, { force: true }); }
    }
    const result = await o.run({ id: task.id, cwd, kind: "research", prompt: `Read-only research. Your assigned scope: ${scopeText(task.files)}. Do not edit files, commit, push, ask the user, or spawn agents. Return a short report with concrete file references, existing business flows, risks and unanswered decisions. Exclude secrets, credentials, personal records and raw customer data. The coordinator alone asks the user.\n\n${task.prompt}` });
    if (result.error || result.limit) throw new Error(`Research ${task.id}: ${result.error ?? "account limit"}`);
    return { id: task.id, text: result.text };
  }));
  if (await revision(o.cwd, o.tasks) !== key) throw new Error("Research files changed during collection; rerun research");
  const summary = results.map((r) => `## ${r.id}\n\n${r.text}`).join("\n\n");
  await mkdir(o.directory, { recursive: true });
  await writeFile(cache, JSON.stringify({ key, summary, results }));
  await writeFile(join(o.directory, "RESEARCH.md"), `# Task research\n\nRevision key: ${key}\n\n${summary}\n`);
  return { summary, results, reused: false };
}

/** Explicitly scoped, independent ready tickets that can write at the same time (up to MAX_PARALLEL). */
export function implementationFrontier(tasks: ParallelTask[], concurrency = 4): ParallelTask[] {
  validate(tasks);
  const selected: ParallelTask[] = [];
  for (const task of tasks) {
    if (task.blockedBy?.length || selected.some((s) => scopesOverlap(s.files, task.files))) continue;
    selected.push(task);
    if (selected.length >= cap(concurrency)) break;
  }
  return selected;
}

type Wave = { base: string; tasks: { id: string; ref: string; commit: string }[]; integrated: string[]; checked?: boolean };
async function saveWave(directory: string, wave: Wave) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, "implementation.json");
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(wave)); await rename(temp, path);
}
async function ticketStatus(cwd: string, id: string, status: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return;
  const file = join(cwd, ".consort/ship/issues", `${id}.md`);
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text !== undefined) await writeFile(file, text.replace(/((?:^|\n)\s*(?:\*\*)?Status:(?:\*\*)?\s*)[^\n]+/i, `$1${status}`));
}
async function currentStatus(cwd: string, id: string): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return undefined;
  const text = await readFile(join(cwd, ".consort/ship/issues", `${id}.md`), "utf8").catch(() => undefined);
  return text?.match(/(?:^|\n)\s*(?:\*\*)?Status:(?:\*\*)?\s*([^\n]+)/i)?.[1]?.replace(/[*`]/g, "").trim().toLowerCase();
}
/** Recover a crash between cherry-pick and checkpoint, without replaying completed work. */
export async function recoverImplementation(cwd: string, directory: string, pushGuard?: ParallelOptions["pushGuard"]): Promise<string[]> {
  // child worktrees left by a worker that was stopped mid-wave: no child runs while the coordinator recovers
  const children = join(dirname(resolve(cwd)), `.parallel-${basename(resolve(cwd))}`);
  for (const dir of (await readdir(children).catch(() => [] as string[])).filter((d) => !d.endsWith(".json"))) {
    const path = join(children, dir);
    // a ticket's leftover work is committed and kept (refs/consort/wip, and GitHub) before its folder goes
    const child = await readFile(markerOf(path), "utf8").then((t) => JSON.parse(t) as Child).catch(() => undefined);
    if (child) { live.set(path, { ...child, guard: pushGuard?.(child.base) }); await saveChild(path).catch(() => false); live.delete(path); }
    await git(cwd, "worktree", "remove", "--force", path).catch(() => rm(path, { recursive: true, force: true }));
    await rm(markerOf(path), { force: true });
  }
  await git(cwd, "worktree", "prune").catch(() => undefined);
  const wave: Wave | undefined = await readFile(join(directory, "implementation.json"), "utf8").then(JSON.parse).catch(() => undefined);
  if (!wave) return [];
  try {
    if (!/^[a-f0-9]{40,64}$/i.test(wave.base)) throw new Error("Invalid parallel wave base revision");
    await git(cwd, "merge-base", "--is-ancestor", wave.base, "HEAD").catch(() => { throw new Error("Parallel wave base is not an ancestor of coordinator HEAD; refusing recovery"); });
    const messages = (await git(cwd, "log", "--format=%B", `${wave.base}..HEAD`)).split("\n");
    wave.integrated = [];
    for (const task of wave.tasks) {
      const landed = messages.includes(`Consort-Parallel: ${task.id}`);
      if (landed) wave.integrated.push(task.id);
      // only a ticket the crashed wave left in-progress goes back to ready; one finished since stays done
      if (landed) await ticketStatus(cwd, task.id, "done");
      else if (await currentStatus(cwd, task.id) === "in-progress") await ticketStatus(cwd, task.id, "ready-for-agent");
    }
    await saveWave(directory, wave);
    return wave.integrated;
  } finally {
    // Reserved refs are journaled before workers start, including crashes before preparation finishes.
    for (const task of wave.tasks) if (/^refs\/consort\/parallel\/[a-f0-9-]+$/i.test(task.ref)) await git(cwd, "update-ref", "-d", task.ref);
  }
}

export async function runImplementation(o: ParallelOptions & { check: (cwd: string) => Promise<void>; onStart?: (ids: string[]) => Promise<void> }): Promise<{ completed: string[]; commits: string[]; failed: { id: string; error: string }[] }> {
  const recovered = await recoverImplementation(o.cwd, o.directory);
  const selected = implementationFrontier(o.tasks.filter((t) => !recovered.includes(t.id)), o.concurrency);
  if (selected.length < 2) return { completed: [], commits: [], failed: [] };
  if ((await git(o.cwd, "status", "--porcelain", "--untracked-files=no")).trim()) throw new Error("Commit coordinator changes before parallel implementation");
  const head = (await git(o.cwd, "rev-parse", "HEAD")).trim();
  const integrated: string[] = [];
  const wave: Wave = { base: head, tasks: selected.map((task) => ({ id: task.id, ref: `refs/consort/parallel/${randomUUID()}`, commit: "" })), integrated };
  const refs = wave.tasks.map((task) => task.ref);
  await saveWave(o.directory, wave);
  try {
    for (const task of selected) await ticketStatus(o.cwd, task.id, "in-progress");
    await o.onStart?.(selected.map((t) => t.id)).catch(() => undefined);
    // one ticket failing does not sink the wave: the others are integrated; the failed one keeps its saved work and goes back to ready
    const failed: { id: string; error: string }[] = [];
    const attempts = await bounded(selected, cap(o.concurrency), async (task) => isolated(o, task, async (cwd, base) => {
      const resumed = await resumeSaved(o.cwd, cwd, task);
      const timer = setInterval(() => { void saveChild(cwd).catch(() => false); }, WIP_SAVE_MS);
      let result;
      try {
        result = await o.run({ id: task.id, cwd, kind: "implementation", prompt: `Implement only ticket ${task.id}. Allowed files/directories: ${scopeText(task.files)}. Read .consort/ship/SPEC.md and GRILLING.md when present before editing. Work only in this isolated worktree. Commit in this worktree after each meaningful step (git add -A && git commit -m "<what>"), so the work survives an interruption; Consort also saves it every few minutes. Do not push, merge, edit other tickets, or spawn agents. The coordinator integrates commits and runs final checks. Read repository setup before any tests; install local dependencies with the lockfile if needed. If this would break a viable business flow without an owner decision, return [ask-user: ...] and stop.${resumed}\n\n${task.prompt}` });
      } finally { clearInterval(timer); }
      if (result.error || result.limit || /\[ask-user:/i.test(result.text)) throw new Error(`Implementation ${task.id}: ${result.error ?? (result.limit ? "account limit" : result.text)}`);
      // Include both agent commits and working changes in a single coordinator-owned commit.
      await stageSafely((args, dir) => git(dir, ...args), cwd);
      const changed = (await git(cwd, "diff", "--cached", "--name-only", "--no-renames", "-z", base)).split("\0").filter(Boolean);
      if (!changed.length) throw new Error(`Implementation ${task.id} produced no changes`);
      if (changed.some((f) => !task.files.some((scope) => within(f, scope)))) throw new Error(`Implementation ${task.id} edited files outside its scope`);
      await git(cwd, "reset", "--soft", base);
      await git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-m", `Implement ${task.id}\n\nConsort-Parallel: ${task.id}`);
      const commit = (await git(cwd, "rev-parse", "HEAD")).trim();
      const ref = wave.tasks.find((entry) => entry.id === task.id)!.ref;
      await git(cwd, "update-ref", ref, commit);
      // the finished ticket stays saved until it is integrated, in case integration fails
      await git(cwd, "update-ref", wipRef(task.id), commit);
      live.get(cwd)!.finished = true;
      return { id: task.id, ref, commit };
    }, true).catch((e) => { failed.push({ id: task.id, error: String((e as Error).message ?? e).split("\n")[0].slice(0, 300) }); return undefined; }));
    const prepared = attempts.filter((r): r is { id: string; ref: string; commit: string } => !!r);
    if (!prepared.length) throw new Error(`No ticket in the wave finished: ${failed.map((f) => `${f.id}: ${f.error}`).join("; ")}`);
    if ((await git(o.cwd, "rev-parse", "HEAD")).trim() !== head || (await git(o.cwd, "status", "--porcelain", "--untracked-files=no")).trim()) throw new Error("Coordinator changed during parallel implementation; refusing integration");
    wave.tasks = prepared;
    await saveWave(o.directory, wave);
    for (const result of prepared) {
      try { await git(o.cwd, "cherry-pick", result.commit); }
      catch (e) { await git(o.cwd, "cherry-pick", "--abort").catch(() => undefined); throw e; }
      integrated.push(result.id); await saveWave(o.directory, wave);
      await ticketStatus(o.cwd, result.id, "done");
      await git(o.cwd, "update-ref", "-d", wipRef(result.id)).catch(() => undefined);
      await git(o.cwd, "push", "--no-verify", "origin", "--delete", await wipBranch(o.cwd, result.id)).catch(() => undefined);
    }
    await o.check(o.cwd);
    wave.checked = true; await saveWave(o.directory, wave);
    return { completed: prepared.map((r) => r.id), commits: prepared.map((r) => r.commit), failed };
  } finally {
    for (const task of selected) if (!integrated.includes(task.id) && await currentStatus(o.cwd, task.id) === "in-progress") await ticketStatus(o.cwd, task.id, "ready-for-agent");
    for (const ref of refs) await git(o.cwd, "update-ref", "-d", ref);
  }
}

/** Old tickets without explicit file ownership stay on the serial coordinator path. */
export async function readImplementationTasks(cwd: string): Promise<ParallelTask[]> {
  const directory = join(cwd, ".consort/ship/issues");
  const documents = await readdir(directory).catch(() => [] as string[]);
  const entries = await Promise.all(documents.filter((p) => p.endsWith(".md")).sort().map(async (file) => {
    const text = await readFile(join(directory, file), "utf8");
    const field = (name: string) => text.match(new RegExp(`(?:^|\\n)\\s*(?:\\*\\*)?${name}:(?:\\*\\*)?\\s*([^\\n]+)`, "i"))?.[1]?.trim();
    const id = file.replace(/\.md$/, "");
    const status = field("Status")?.replace(/\*/g, "").trim();
    const files = (field("Files") ?? "").split(/[,;]/).map((s) => s.trim().replace(/^`|`$/g, "")).filter(Boolean);
    const blockedBy = (field("Blocked by") ?? "unknown").replace(/\*/g, "").trim();
    return { id, status, files, blockedBy, prompt: text };
  }));
  const done = new Set(entries.filter((e) => e.status === "done").flatMap((e) => [e.id, e.id.match(/^\d+/)?.[0] ?? e.id]));
  return entries.filter((e) => e.status === "ready-for-agent" && e.files.length && e.files.every(safe)).map((e) => ({ id: e.id, files: e.files, prompt: e.prompt, blockedBy: /^(none|n\/a|—|-)$/i.test(e.blockedBy) ? [] : e.blockedBy.split(/[,;\s]+/).map((s) => s.replace(/\.md$/, "")).filter((s) => !done.has(s)) }));
}

/** Partition tracked source scopes so readers do complementary discovery, not three full scans. */
export async function prepareResearchTasks(cwd: string, ticketBody: string): Promise<ParallelTask[]> {
  const tracked = (await git(cwd, "ls-files", "--stage", "-z")).split("\0").filter(Boolean).flatMap((entry) => {
    const split = entry.indexOf("\t");
    const file = entry.slice(split + 1);
    return entry.startsWith("120000 ") || sensitive(file) || !safe(file) || /(?:^|\/)(?:node_modules|vendor|dist|out|build)\//.test(file) || /(?:lock|\.(?:png|jpe?g|gif|webp|ico|icns|pdf|woff2?|ttf|mp4|zip))$/i.test(file) ? [] : [file];
  });
  const groups: Record<string, string[]> = { "business-flows": [], "test-discovery": [], "integration-schema": [] };
  for (const file of tracked) {
    const group = /(?:^|[/.\-_])(?:tests?|specs?|fixtures?)(?:[/.\-_]|$)/i.test(file) ? "test-discovery"
      : /(?:schema|migrat|integrat|jobs?\/|workers?\/|api\/|database|docker|compose)/i.test(file) ? "integration-schema" : "business-flows";
    groups[group].push(file);
  }
  const questions: Record<string, string> = {
    "business-flows": "Trace existing callers and business flows the requested change could break. Identify viable flows needing an owner decision.",
    "test-discovery": "Discover existing tests, setup, exact verification commands and missing acceptance coverage for this task.",
    "integration-schema": "Trace integrations, schemas, migrations and background jobs affected by the task; identify compatibility and rollout risks.",
  };
  return Object.entries(groups).filter(([, files]) => files.length).map(([id, files]) => ({ id, files, prompt: `${questions[id]}\n\nTask:\n${ticketBody}` }));
}

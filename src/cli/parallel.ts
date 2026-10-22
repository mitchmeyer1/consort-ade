import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, copyFile, readdir, cp, rename, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, maxBuffer: 16 << 20 })).stdout;
/** tickets or readers at once; the AI-slot limits in cli/capacity.ts still apply to each one */
export const MAX_PARALLEL = 6;
const cap = (n = 4) => Math.max(1, Math.min(MAX_PARALLEL, Math.floor(n) || 1));
const safe = (p: string) => p && !p.startsWith("/") && !p.split(/[\\/]/).includes("..") && p !== "." && !/[\\*?\[\]{}]/.test(p) && p !== ".git" && !p.startsWith(".git/") && p !== ".consort" && !p.startsWith(".consort/");
const within = (file: string, scope: string) => file === scope || file.startsWith(scope.replace(/\/$/, "") + "/");
const scopesOverlap = (a: string[], b: string[]) => a.some((x) => b.some((y) => within(x, y) || within(y, x)));
export type ParallelTask = { id: string; files: string[]; prompt: string; blockedBy?: string[] };
export type ParallelRun = (job: { id: string; cwd: string; prompt: string; kind: "research" | "implementation" }) => Promise<{ text: string; error?: string; limit?: unknown }>;
export type ParallelOptions = { cwd: string; directory: string; tasks: ParallelTask[]; run: ParallelRun; concurrency?: number };

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
async function isolated<T>(o: ParallelOptions, task: ParallelTask, fn: (cwd: string, head: string) => Promise<T>): Promise<T> {
  // beside the task's worktree, never inside it: copying .consort/ship into a folder within itself fails (EINVAL)
  const cwd = join(dirname(resolve(o.cwd)), `.parallel-${basename(resolve(o.cwd))}`, `work-${randomUUID()}`);
  await mkdir(dirname(cwd), { recursive: true });
  await git(o.cwd, "worktree", "add", "--detach", cwd, "HEAD");
  try {
    // Ignored ship artifacts carry the spec and decisions into each fresh context.
    await cp(join(o.cwd, ".consort/ship"), join(cwd, ".consort/ship"), {
      recursive: true, filter: (source) => relative(join(o.cwd, ".consort/ship"), source).split(/[\\/]/)[0] !== "parallel",
    }).catch((e) => { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; });
    const report = await readFile(join(o.directory, "RESEARCH.md")).catch(() => undefined);
    if (report) { await mkdir(join(cwd, ".consort/ship/parallel"), { recursive: true }); await writeFile(join(cwd, ".consort/ship/parallel/RESEARCH.md"), report); }
    return await fn(cwd, (await git(cwd, "rev-parse", "HEAD")).trim());
  }
  finally { await git(o.cwd, "worktree", "remove", "--force", cwd); }
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
export async function recoverImplementation(cwd: string, directory: string): Promise<string[]> {
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

export async function runImplementation(o: ParallelOptions & { check: (cwd: string) => Promise<void> }): Promise<{ completed: string[]; commits: string[] }> {
  const recovered = await recoverImplementation(o.cwd, o.directory);
  const selected = implementationFrontier(o.tasks.filter((t) => !recovered.includes(t.id)), o.concurrency);
  if (selected.length < 2) return { completed: [], commits: [] };
  if ((await git(o.cwd, "status", "--porcelain", "--untracked-files=no")).trim()) throw new Error("Commit coordinator changes before parallel implementation");
  const head = (await git(o.cwd, "rev-parse", "HEAD")).trim();
  const integrated: string[] = [];
  const wave: Wave = { base: head, tasks: selected.map((task) => ({ id: task.id, ref: `refs/consort/parallel/${randomUUID()}`, commit: "" })), integrated };
  const refs = wave.tasks.map((task) => task.ref);
  await saveWave(o.directory, wave);
  try {
    for (const task of selected) await ticketStatus(o.cwd, task.id, "in-progress");
    const prepared = await bounded(selected, cap(o.concurrency), async (task) => isolated(o, task, async (cwd, base) => {
      const result = await o.run({ id: task.id, cwd, kind: "implementation", prompt: `Implement only ticket ${task.id}. Allowed files/directories: ${scopeText(task.files)}. Read .consort/ship/SPEC.md and GRILLING.md when present before editing. Work only in this isolated worktree. Do not push, merge, edit other tickets, or spawn agents. The coordinator integrates commits and runs final checks. Read repository setup before any tests; install local dependencies with the lockfile if needed. If this would break a viable business flow without an owner decision, return [ask-user: ...] and stop.\n\n${task.prompt}` });
      if (result.error || result.limit || /\[ask-user:/i.test(result.text)) throw new Error(`Implementation ${task.id}: ${result.error ?? (result.limit ? "account limit" : result.text)}`);
      // Include both agent commits and working changes in a single coordinator-owned commit.
      await git(cwd, "add", "-A", "--", ".", ":!.consort");
      const changed = (await git(cwd, "diff", "--cached", "--name-only", "--no-renames", "-z", base)).split("\0").filter(Boolean);
      if (!changed.length) throw new Error(`Implementation ${task.id} produced no changes`);
      if (changed.some((f) => !task.files.some((scope) => within(f, scope)))) throw new Error(`Implementation ${task.id} edited files outside its scope`);
      await git(cwd, "reset", "--soft", base);
      await git(cwd, "-c", "core.hooksPath=/dev/null", "commit", "-m", `Implement ${task.id}\n\nConsort-Parallel: ${task.id}`);
      const commit = (await git(cwd, "rev-parse", "HEAD")).trim();
      const ref = wave.tasks.find((entry) => entry.id === task.id)!.ref;
      await git(cwd, "update-ref", ref, commit);
      return { id: task.id, ref, commit };
    }));
    if ((await git(o.cwd, "rev-parse", "HEAD")).trim() !== head || (await git(o.cwd, "status", "--porcelain", "--untracked-files=no")).trim()) throw new Error("Coordinator changed during parallel implementation; refusing integration");
    wave.tasks = prepared;
    await saveWave(o.directory, wave);
    for (const result of prepared) {
      try { await git(o.cwd, "cherry-pick", result.commit); }
      catch (e) { await git(o.cwd, "cherry-pick", "--abort").catch(() => undefined); throw e; }
      integrated.push(result.id); await saveWave(o.directory, wave);
      await ticketStatus(o.cwd, result.id, "done");
    }
    await o.check(o.cwd);
    wave.checked = true; await saveWave(o.directory, wave);
    return { completed: prepared.map((r) => r.id), commits: prepared.map((r) => r.commit) };
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

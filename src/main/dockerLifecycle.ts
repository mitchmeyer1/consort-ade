import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type DockerRun = { code: string; pid: number; startedAt: number; finished: boolean; worktreeId: string };
type Docker = (args: string[]) => Promise<string>;
const docker: Docker = async args => (await exec("docker", args, { timeout: 20_000, maxBuffer: 1 << 20 })).stdout;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error.code !== "ESRCH"; } };
const validCode = /^consort-[a-f0-9]{8}-[a-f0-9-]{36}$/;

export class DockerLifecycle {
  private busy = new Set<string>();
  private directory: string;
  private command: Docker;
  private isAlive: (pid: number) => boolean;
  constructor(directory: string, command: Docker = docker, isAlive = alive) {
    this.directory = directory;
    this.command = command;
    this.isAlive = isAlive;
  }
  private path(run: DockerRun) { return join(this.directory, `${run.code}.json`); }
  private save(run: DockerRun) { writeFileSync(this.path(run), JSON.stringify(run)); }
  begin(worktreeId: string): DockerRun {
    mkdirSync(this.directory, { recursive: true });
    const run = { code: `consort-${randomUUID().slice(0, 8)}-${randomUUID()}`, pid: process.pid, startedAt: Date.now(), finished: false, worktreeId };
    this.save(run);
    return run;
  }
  async finish(run: DockerRun) {
    run.finished = true;
    this.save(run);
    await this.clean(run);
  }
  private async clean(run: DockerRun) {
    if (this.busy.has(run.code)) return;
    this.busy.add(run.code);
    try {
      // Exact labels, never fuzzy names or global prune. Compose supplies its project label.
      const ids = new Set<string>();
      for (const label of [`com.docker.compose.project=${run.code}`, `io.consort.run=${run.code}`]) {
        const output = await this.command(["ps", "-aq", "--no-trunc", "--filter", `label=${label}`]);
        for (const id of output.trim().split(/\s+/)) if (/^[a-f0-9]{12,64}$/.test(id)) ids.add(id);
      }
      for (const id of ids) await this.command(["rm", "--force", id]);
      // Keep the receipt for a day: a delayed child process may create a container after cancellation.
      if (Date.now() - run.startedAt > 24 * 60 * 60 * 1000) unlinkSync(this.path(run));
    } finally { this.busy.delete(run.code); }
  }
  async sweep() {
    mkdirSync(this.directory, { recursive: true });
    const failures: string[] = [];
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const run: DockerRun = JSON.parse(readFileSync(join(this.directory, name), "utf8"));
        if (!validCode.test(run.code) || name !== `${run.code}.json` || !Number.isFinite(run.startedAt) || !Number.isInteger(run.pid) || run.pid <= 0) continue;
        if (!run.finished && (this.isAlive(run.pid) || Date.now() - run.startedAt < 5 * 60 * 1000)) continue;
        await this.clean(run);
      } catch (error) { failures.push(String((error as Error).message)); }
    }
    if (failures.length) throw new Error(failures[0]);
  }
}

let lifecycle: DockerLifecycle | undefined;
const runs = new Map<string, DockerRun>();
export function startDockerRecovery(directory: string) {
  lifecycle = new DockerLifecycle(directory);
  const sweep = () => { void lifecycle!.sweep().catch(error => console.warn("Consort Docker cleanup will retry:", error.message)); };
  sweep();
  const timer = setInterval(sweep, 5 * 60 * 1000);
  timer.unref();
}
export function beginDockerRun(chatId: string, worktreeId: string) {
  if (!lifecycle) throw new Error("Docker lifecycle is not initialized");
  const run = lifecycle.begin(worktreeId);
  runs.set(chatId, run);
  return `Docker test resources for this turn MUST use the Consort code ${run.code}.
COMPOSE_PROJECT_NAME is already set to this code. Do not override it with -p or a fixed project name. Override any hard-coded container_name in a temporary Compose override so every container name starts with ${run.code}-. For docker run/create, use --name ${run.code}-<service> --label io.consort.run=${run.code}. Configure test libraries that create containers with the same name prefix and label; never disable their automatic cleanup.
Always tear down test containers in a finally/trap after testing, including failure and cancellation. Use docker compose down --remove-orphans for this project or remove the exact labeled containers. Consort also removes this run's labeled containers when your turn ends. Do not reuse these containers across turns, detach untracked background launchers, or delete unrelated Docker resources. Never run global prune or remove shared volumes.`;
}
export function dockerRunEnvironment(chatId: string): Record<string, string> {
  const run = runs.get(chatId);
  return run ? { COMPOSE_PROJECT_NAME: run.code, CONSORT_DOCKER_RUN: run.code } : {};
}
export async function finishDockerRun(chatId: string) {
  const run = runs.get(chatId);
  if (!run) return;
  runs.delete(chatId);
  await lifecycle!.finish(run);
}

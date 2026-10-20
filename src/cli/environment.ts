import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { allocatePortBase, PORT_BLOCK, taskEnv, type TaskEnv } from "../shared/headless.ts";
import { loadState, updateTask, type Task } from "./state";

/**
 * The per-task environment on this box (shared/headless.ts): a run code for Docker names and
 * labels, and a port block no other live task holds. Allocation checks the block's key ports
 * are actually free, not just unclaimed. Cleanup removes every container, network and volume
 * labelled with the code, which is how a task leaves nothing behind whether it finished,
 * failed or was released.
 */

const run = promisify(execFile);
const docker = (args: string[]) => run("docker", args, { timeout: 60_000, maxBuffer: 1 << 22 }).then((r) => r.stdout.trim(), () => "");

export const runCodeFor = (task: Pick<Task, "id">) => `consort-${task.id.replace(/^task-/, "")}`;

const free = (port: number) => new Promise<boolean>((resolve) => {
  const srv = createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
});

/** the ports the agent is most likely to bind first; a block whose key ports are busy is skipped */
const KEY_OFFSETS = [0, 1, 2, 10, 11, 12, 13];

export async function allocateEnvironment(task: Task): Promise<TaskEnv> {
  if (task.portBase) return taskEnv(task.runCode ?? runCodeFor(task), task.portBase);
  const live = loadState().tasks.filter((t) => t.id !== task.id && t.portBase && !["done", "released", "failed", "ready"].includes(t.status)).map((t) => t.portBase!);
  let floor = allocatePortBase(live);
  for (let tries = 0; tries < 200; tries++) {
    const checks = await Promise.all(KEY_OFFSETS.map((o) => free(floor + o)));
    if (checks.every(Boolean)) break;
    floor = allocatePortBase([...live, floor], floor + PORT_BLOCK);
  }
  const code = runCodeFor(task);
  updateTask(task.id, { portBase: floor, runCode: code });
  return taskEnv(code, floor);
}

export const environmentFor = (task: Task): TaskEnv | undefined => task.portBase ? taskEnv(task.runCode ?? runCodeFor(task), task.portBase) : undefined;

/** remove everything Docker holds under the task's code; quiet when Docker is absent */
export async function cleanupEnvironment(code: string): Promise<{ containers: number; networks: number; volumes: number }> {
  const out = { containers: 0, networks: 0, volumes: 0 };
  const ids = async (kind: "ps" | "network" | "volume", label: string) =>
    (await docker(kind === "ps" ? ["ps", "-aq", "--filter", `label=${label}`] : [kind, "ls", "-q", "--filter", `label=${label}`])).split("\n").filter(Boolean);
  for (const label of [`io.consort.run=${code}`, `com.docker.compose.project=${code}`]) {
    const c = await ids("ps", label); if (c.length) { await docker(["rm", "-f", ...c]); out.containers += c.length; }
  }
  for (const label of [`io.consort.run=${code}`, `com.docker.compose.project=${code}`]) {
    const n = await ids("network", label); if (n.length) { await docker(["network", "rm", ...n]); out.networks += n.length; }
    const v = await ids("volume", label); if (v.length) { await docker(["volume", "rm", "-f", ...v]); out.volumes += v.length; }
  }
  return out;
}

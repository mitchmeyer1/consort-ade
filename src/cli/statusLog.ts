/** Small append-only activity journal shared by the daemon, workers, and terminal dashboard. */
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { LOG_DIR } from "./state";

export type StatusEvent = { at: number; tone: "info" | "success" | "warn" | "error"; text: string };
const file = () => join(LOG_DIR, "status.jsonl");
const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);

export function statusEvent(tone: StatusEvent["tone"], text: string, at = Date.now()): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    appendFileSync(file(), `${JSON.stringify({ at, tone, text: clean(text) })}\n`, { mode: 0o600 });
  } catch (e) { console.error(`Status log could not be written: ${(e as Error).message}`); }
}

export function recentStatusEvents(): StatusEvent[] {
  let fd: number | undefined;
  try {
    fd = openSync(file(), "r");
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 32_768);
    const buffer = Buffer.alloc(size - start);
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (start) lines.shift();
    return lines.flatMap((line): StatusEvent[] => {
      try { const e = JSON.parse(line); return Number.isFinite(e.at) && ["info", "success", "warn", "error"].includes(e.tone) && typeof e.text === "string" ? [{ at: e.at, tone: e.tone, text: clean(e.text) }] : []; } catch { return []; }
    }).sort((a, b) => a.at - b.at).slice(-8);
  } catch { return []; }
  finally { if (fd !== undefined) closeSync(fd); }
}

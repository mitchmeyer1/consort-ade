/** Interactive setup asks one question at a time; piped scripts retain queued answers. */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { dim, mint } from "./theme.ts";

export type Ask = (question: string, options?: { secret?: boolean; default?: string }) => Promise<string>;

export function createPrompter(input: Readable & { isTTY?: boolean } = process.stdin, output: Writable = process.stdout) {
  const terminal = !!input.isTTY;
  const rl = createInterface({ input, output, terminal, crlfDelay: Infinity });
  const queue: string[] = [];
  const waiters: ((line: string | undefined) => void)[] = [];
  let closed = false;
  rl.on("line", line => {
    const waiting = waiters.shift();
    if (waiting) waiting(line);
    else if (!terminal) queue.push(line);
  });
  rl.on("close", () => { closed = true; for (const waiting of waiters.splice(0)) waiting(undefined); });
  const next = () => queue.length ? Promise.resolve(queue.shift()) : closed ? Promise.resolve(undefined) : new Promise<string | undefined>(resolve => waiters.push(resolve));
  const ask: Ask = async (question, options = {}) => {
    // Register before printing: only this question may consume interactive input.
    const answer = next();
    output.write(`\n${mint("›")} ${question}${options.default ? dim(` [${options.default}]`) : ""}${mint(":")} `);
    const original = output.write;
    if (options.secret && terminal) output.write = (() => true) as typeof output.write;
    try {
      const value = await answer;
      if (value === undefined) throw new Error("readline was closed");
      return value.trim() || (options.default ?? "");
    } finally {
      output.write = original;
      output.write("\n");
    }
  };
  return { ask, close: () => rl.close() };
}

/**
 * How a shell line splits into the simple commands it runs, as the PHI/PII guard reads it
 * (keyGuard.ts, egress.ts, warehouse.ts). Heredoc bodies come out first, since they are text
 * rather than commands. Each command is unwrapped down to the program it runs: a path becomes its
 * name, and the runners that take a command as arguments (env, command, exec, nohup, time, nice,
 * timeout, xargs, sudo, stdbuf) or as a string (sh -c and its kin, eval) give way to what they
 * run, so `/usr/bin/env`, `command gh …` and `sh -c printenv` read as the commands they are.
 */
import { basename } from "node:path";

export type SimpleCommand = { words: string[]; /** its input comes from the command before it */ piped: boolean };
export type ShellLine = { commands: SimpleCommand[]; heredocs: string[]; /** the line with each heredoc body replaced by `<<HEREDOC` */ stripped: string };

// `>&` and `&>` are redirections, so `2>&1` puts nothing in the background
export const SHELL_OPERATORS = new Set([";", "|", "|&", "||", "&", "&&", ">", ">>", ">&", "&>", ">|", "<", "<<", "(", ")"]);
const SEPARATORS = new Set([";", "|", "|&", "||", "&", "&&", "(", ")"]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
// a heredoc and its body; the rest of its first line stays in the command
const HEREDOC = /<<-?\s*(["']?)([A-Za-z_][\w-]*)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
// each runner, with its options that take a value
const RUNNERS: Record<string, string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], command: [], builtin: [], exec: ["-a"], nohup: [], time: [], stdbuf: ["-i", "-o", "-e"],
  nice: ["-n", "--adjustment"], timeout: ["-s", "--signal", "-k", "--kill-after"], sudo: ["-u", "-g", "-C", "-h", "-p", "-U"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--arg-file", "--max-args", "--max-procs", "--delimiter"],
};

/** the simple commands a line runs, unwrapped; undefined when a quote is left open or a nested string cannot be read */
export function parseLine(line: string, depth = 0): ShellLine | undefined {
  const heredocs: string[] = [];
  const stripped = line.replace(HEREDOC, (_m, _q, _tag, rest: string, body: string) => { heredocs.push(body); return `<<HEREDOC${rest}`; });
  const words = shellWords(stripped);
  if (!words) return undefined;
  const commands: SimpleCommand[] = [];
  let current: string[] = [], piped = false;
  for (const word of [...words, ";"]) {
    if (!SEPARATORS.has(word)) { current.push(word); continue; }
    const unwrapped = unwrap(current, depth);
    if (!unwrapped) return undefined;
    commands.push(...unwrapped.map((cmd, i) => ({ words: cmd, piped: i === 0 && piped })));
    current = [];
    piped = word === "|" || word === "|&";
  }
  return { commands, heredocs, stripped };
}

/** whether a line runs any of `names`: as a parsed command, or at a command position the parse cannot reach (a backtick) */
export function runsAny(line: string, names: string[]): boolean {
  if (!names.length) return false;
  const pattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (new RegExp(String.raw`(?:^|[|;&\`\n\r]|\$\()\s*(?:\S*/)?(?:${pattern})(?=$|[\s|;&\`)<>])`).test(line)) return true;
  const parsed = parseLine(line);
  // a line the parse cannot read is taken to run what it names
  if (!parsed) return new RegExp(String.raw`\b(?:${pattern})\b`).test(line);
  return parsed.commands.some((c) => names.includes(c.words[0]));
}

/** split a command line the way a POSIX shell would, operators as their own words; undefined when a quote is left open */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let word = "", quoted = false, i = 0;
  const flush = () => { if (word || quoted) words.push(word); word = ""; quoted = false; };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") { const end = command.indexOf("'", i + 1); if (end < 0) return undefined; word += command.slice(i + 1, end); quoted = true; i = end + 1; continue; }
    if (c === "\"") {
      let j = i + 1;
      for (; j < command.length && command[j] !== "\""; j++) { if (command[j] === "\\" && "\"\\$`".includes(command[j + 1] ?? "")) j++; word += command[j]; }
      if (j >= command.length) return undefined;
      quoted = true; i = j + 1; continue;
    }
    if (c === "\\") { word += command[i + 1] ?? ""; i += 2; continue; }
    // an unquoted line break ends a command, as `;` does
    if (c === "\n") { flush(); words.push(";"); i++; continue; }
    if (/\s/.test(c)) { flush(); i++; continue; }
    if ("|&;<>()".includes(c)) {
      flush();
      let op = c;
      while (i + op.length < command.length && "|&;<>()".includes(command[i + op.length]) && SHELL_OPERATORS.has(op + command[i + op.length])) op += command[i + op.length];
      words.push(op); i += op.length; continue;
    }
    word += c; i++;
  }
  flush();
  return words;
}

// one command's words down to the program it runs; a shell string can hold several
function unwrap(words: string[], depth: number): string[][] | undefined {
  const start = words.findIndex((w) => !ASSIGNMENT.test(w));
  let rest = start < 0 ? [] : words.slice(start);
  for (;;) {
    if (!rest.length) return [];
    const name = rest[0].includes("/") ? basename(rest[0]) : rest[0];
    rest = [name, ...rest.slice(1)];
    if (SHELLS.has(name) || name === "eval") {
      const at = name === "eval" ? 0 : rest.findIndex((a, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (at < 0 || depth >= 3) return [rest];
      return parseLine(name === "eval" ? rest.slice(1).join(" ") : rest[at + 1] ?? "", depth + 1)?.commands.map((c) => c.words);
    }
    // `command -v` prints rather than runs
    if (name === "command" && rest.slice(1).some((a) => /^-[vV]+$/.test(a))) return [rest];
    const valued = RUNNERS[name];
    if (!valued) return [rest];
    let i = 1;
    for (; i < rest.length; i++) {
      if (valued.includes(rest[i])) { i++; continue; }
      if (!rest[i].startsWith("-") && !(name === "env" && ASSIGNMENT.test(rest[i]))) break;
    }
    // timeout's first operand is the duration
    if (name === "timeout") i++;
    // a runner with nothing to run is the command itself: `env` alone prints the environment
    if (i >= rest.length) return [rest];
    rest = rest.slice(i);
  }
}

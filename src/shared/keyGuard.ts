/**
 * Where keys live, and the commands and paths that would read them. With the PHI/PII guard on,
 * an uncovered agent never prints its environment, its shell's aliases or functions, a key
 * variable, the Keychain, a shell startup file, Claude Code's shell snapshots, or Consort's own
 * state and logins (cli/phiHooks.ts denies the call before it runs). A key in the transcript is
 * exposed for good, so the checks are wide: `which` and `type` print alias bodies in zsh, a glob
 * or a brace pattern is read for every name it could match, and a recursive read of the home
 * folder reaches the startup files. Commands are read unwrapped (shellCommands.ts), so a runner
 * or a full path changes nothing. What stays allowed: running a command under extra variables
 * (`env FOO=1 cmd`), setting options (`set -e`), and testing that a variable is set without
 * expanding it elsewhere (`[ -n "$NAME" ]`).
 */
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { parseLine } from "./shellCommands.ts";
import { COVERED_VARIABLES } from "./phi.ts";

export type KeyGuardContext = { cwd: string; home: string; consortHome: string };

export const KEY_DENY = (why: string) => `Not run: ${why}. Shell profiles, the environment, the Keychain and Consort's state are where keys live. To check a tool, run \`<tool> --version\`; to check a variable is set, \`[ -n "$NAME" ]\`.`;

const PROFILES = [".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".bashrc", ".bash_profile", ".bash_login", ".profile"];
// they print the environment, an alias or a function body
const PRINTERS = new Set(["printenv", "alias", "type", "which", "whence", "where", "functions", "typeset"]);
const KEYCHAIN_READS = new Set(["find-generic-password", "find-internet-password", "dump-keychain", "export"]);
const RECURSIVE_READERS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "find", "tar", "zip", "cp", "rsync"]);
// a key variable expanded, or any indirect expansion, which can reach one without spelling its name
const KEY_VARIABLE = new RegExp(String.raw`\$\{?(?:[A-Za-z_]\w*_API_KEY|${COVERED_VARIABLES.join("|")}|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN)\b|\$\{!`);
const SET_TEST = /(?:\[\[?|\btest)\s+-[nz]\s+"?\$\{?\w+\}?"?\s*(?:\]\]?)?/g;
const GLOB = /[*?[]/;

/** why the command would expose a key, or undefined when it does not */
export function keyExposure(command: string, c: KeyGuardContext): string | undefined {
  if (KEY_VARIABLE.test(command.replace(SET_TEST, ""))) return "it expands a key variable";
  const commands = parseLine(command)?.commands.map((cmd) => cmd.words) ?? [command.split(/\s+/).filter(Boolean)];
  for (const words of commands) {
    const why = commandExposure(words, c);
    if (why) return why;
  }
  return undefined;
}

/** why a file tool reading this path would expose a key or member data, or undefined when it would not */
export function protectedPath(path: string, c: KeyGuardContext): string | undefined {
  const keyed = keyPath(path, c);
  if (keyed) return keyed;
  const name = basename(expandHome(path, c));
  return /(?:phi|pii|patient|customer|member)[_-](?:data|record|export)/i.test(name) ? `${name} is named as member data` : undefined;
}

/** why a search (Grep, Glob) rooted at `path` would expose a key: the path itself, or a folder that holds the startup files or Consort's state */
export function searchExposure(path: string, c: KeyGuardContext): string | undefined {
  return protectedPath(path, c) ?? (holdsSecrets(absolute(expandHome(path, c), c), c) ? `a search over ${path} reaches shell startup files or Consort's state` : undefined);
}

function commandExposure(words: string[], c: KeyGuardContext): string | undefined {
  const [name, ...args] = words;
  const flags = args.filter((a) => a.startsWith("-"));
  const operands = args.filter((a) => !a.startsWith("-"));
  if (PRINTERS.has(name)) return `${name} prints the environment, aliases or functions`;
  // a runner left as the command has nothing to run (shellCommands.ts), so it prints
  if (name === "env") return "env without a command prints the environment";
  if (name === "export" && (!operands.length || flags.includes("-p"))) return "export without a name prints the environment";
  if (name === "declare" && (!operands.length || flags.some((f) => /[pfF]/.test(f)))) return "declare without a name prints variables or functions";
  if (name === "set" && !args.length) return "set without arguments prints every variable";
  if (name === "command" && flags.some((f) => /^-[vV]+$/.test(f))) return "command -v prints alias and function bodies";
  if (name === "security" && args.some((a) => KEYCHAIN_READS.has(a))) return "it reads the Keychain";
  for (const word of args) {
    const path = word.replace(/^--?[\w-]+=/, "");
    if (!path || [">", ">>", "<", "<<"].includes(path)) continue;
    const why = keyPath(path, c);
    if (why) return why;
    if (RECURSIVE_READERS.has(name) && !GLOB.test(path) && holdsSecrets(absolute(expandHome(path, c), c), c)) return `${name} over ${path} reaches shell startup files or Consort's state`;
  }
  return undefined;
}

// a path, a glob or a brace pattern that could name where keys live; a Bash argument is checked against these alone, since a commit message may well say "member_data"
function keyPath(word: string, c: KeyGuardContext): string | undefined {
  for (const path of braces(word)) {
    const why = GLOB.test(path) ? globKeyPath(path, c) : literalKeyPath(path, c);
    if (why) return why;
  }
  return undefined;
}

function literalKeyPath(path: string, c: KeyGuardContext): string | undefined {
  const full = absolute(expandHome(path, c), c);
  const name = basename(full);
  if (PROFILES.includes(name)) return `${name} is a shell startup file`;
  if (full.includes("/shell-snapshots")) return "Claude Code's shell snapshots hold the environment";
  if (full === c.consortHome || ["state.json", "secrets", "logins"].some((p) => under(full, `${c.consortHome}/${p}`)) || /\/\.consort-cli\/(?:state\.json|secrets|logins)(?:\/|$)/.test(full)) return "Consort's state and logins hold keys";
  return undefined;
}

// a glob reaches a key when its first wildcard part, in the folder before it, can match a protected name there; one over a folder further up is taken to
function globKeyPath(pattern: string, c: KeyGuardContext): string | undefined {
  const parts = expandHome(pattern, c).split("/");
  const at = parts.findIndex((p) => GLOB.test(p));
  const dir = absolute(parts.slice(0, at).join("/") || (pattern.startsWith("/") ? "/" : "."), c);
  const protectedIn: Record<string, string[]> = {};
  const add = (folder: string, ...names: string[]) => { protectedIn[folder] = [...(protectedIn[folder] ?? []), ...names]; };
  add(c.home, ...PROFILES);
  add(dirname(c.consortHome), basename(c.consortHome));
  add(c.consortHome, "state.json", "secrets", "logins");
  add(`${c.home}/.claude`, "shell-snapshots");
  const segment = globRegex(parts[at]);
  // a protected folder further down is reached when the wildcard part can match the next step toward it
  for (const folder of Object.keys(protectedIn).filter((f) => f !== dir && under(f, dir))) {
    if (segment.test(folder.slice(dir.length).split("/").filter(Boolean)[0])) return `${pattern} can reach ${folder}`;
  }
  const candidates = protectedIn[dir] ?? [];
  const hit = candidates.find((name) => segment.test(name));
  return hit ? `${pattern} can match ${hit}` : undefined;
}

// the shell's own reading: `*` and `?` do not match a leading dot unless the pattern starts with one
const globRegex = (glob: string) => new RegExp(`^${glob.startsWith(".") ? "" : "(?!\\.)"}${glob.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*+/g, ".*").replace(/\?/g, ".").replace(/\[!/g, "[^")}$`);

// `~/.zsh{env,rc}` is two paths; capped so a pathological pattern cannot blow up
function braces(word: string, budget = 64): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m || budget <= 1) return [word];
  return m[1].split(",").flatMap((alt) => braces(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length), Math.floor(budget / 2)));
}

const expandHome = (path: string, c: KeyGuardContext) => path
  .replace(/^~(?=\/|$)/, c.home)
  .replace(/^\$\{?HOME\}?(?=\/|$)/, c.home)
  .replace(/^\$\{?CONSORT_CLI_HOME\}?(?=\/|$)/, c.consortHome);
const absolute = (path: string, c: KeyGuardContext) => (isAbsolute(path) ? resolve(path) : resolve(c.cwd, path));
const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
// a folder that holds the home folder's startup files or Consort's state
const holdsSecrets = (path: string, c: KeyGuardContext) => [c.home, c.consortHome].some((root) => under(root, path));

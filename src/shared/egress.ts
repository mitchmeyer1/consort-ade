/**
 * What a shell command would send off this machine, read from its text before it runs: text
 * posted with gh (PR and issue bodies and comments, reviews, release notes, API writes), uploads
 * with curl or wget, copies to another host, and git pushes. cli/phiHooks.ts scans the text and
 * the files named here with the PII gate, and a push's commits with pushFindings. Commands are
 * read unwrapped (shellCommands.ts), so a runner or a full path changes nothing.
 *
 * What the hook checks must be what is sent, so a command that sends runs first on its line, with
 * nothing in the background: a commit or a copy before it would change what goes out after the
 * check. What cannot be read is not sent: a body from a pipe or the terminal, or one built by a
 * substitution other than `$(cat <<'EOF' … EOF)`, whose body is in the command itself. A push
 * names what it sends (a branch, a refspec, HEAD); pushing every branch or tag at once, and git
 * aliases, are refused. curl and wget upload to this machine only, since Consort posts Slack and
 * ticket text itself and gh covers GitHub; gists, release assets and copies to another host are
 * refused outright.
 */
import { parseLine, shellWords } from "./shellCommands.ts";

export type Push = { /** from `git -C` */ dir?: string; /** what the push sends from: branches, refs or HEAD */ sources: string[] };
export type Egress = { deny?: string; texts: string[]; files: string[]; push?: Push; /** each git subcommand on the line, for the hook to check against aliases */ git: { dir?: string; subcommand: string }[] };

export const EGRESS_FOUND = (categories: string) => `Not sent: the text carries ${categories}. Remove personal data (say "the member", use example.com and 555-01xx placeholders) and retry.`;
export const EGRESS_UNSCANNABLE = "Not sent: Consort cannot read what this would send. Write the text to a file in the worktree and pass it with --body-file or --input <file>, so Consort can check it before it leaves.";
export const SEND_ALONE = "Not run: a command that posts or pushes runs first on its line and not in the background, so Consort checks exactly what it sends. Run the commands before it on their own, then this one.";
export const UPLOAD_DENY = "Not run: curl and wget may upload only to this machine. Use gh for GitHub; Consort posts Slack and ticket text itself.";
export const REMOTE_COPY_DENY = "Not run: copying files to or from another host, gists and release assets are not used in an agent turn; put text on the PR or the ticket.";
export const PUSH_ONE = "Not run: push the branch you mean by name (or HEAD), one at a time, so Consort can check what each push sends.";
export const ALIAS_DENY = "Not run: git aliases are not set or used in an agent turn; run the git command itself.";
/** a push the gate stopped, and how to clear it: the findings come out of every unpushed commit that carries them */
export const PUSH_DENY = (findings: string[]) => `Not pushed, by the PII gate: ${findings.slice(0, 8).join(", ")}${findings.length > 8 ? ` and ${findings.length - 8} more` : ""}. Replace them with synthetic placeholders (example.com, 555-01xx, sequential digits) and rewrite the unpushed commits that carry them: git reset --soft to the last pushed commit (@{u}, or origin/<base> before the first push), then commit again.`;

// the gh commands that post text, by group
const GH_POSTS: Record<string, string[]> = { pr: ["create", "edit", "comment", "review"], issue: ["create", "edit", "comment"], release: ["create", "edit"] };
const RELEASE_VALUE_FLAGS = ["-n", "--notes", "-F", "--notes-file", "-t", "--title", "--target", "--discussion-category", "--notes-start-tag", "-R", "--repo"];
const PUSH_VALUE_FLAGS = ["--repo", "-o", "--push-option", "--receive-pack", "--exec"];
const PUSH_EVERYTHING = ["--all", "--mirror", "--tags", "--branches", "--follow-tags"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0", "host.docker.internal"]);

export function egressOf(command: string): Egress {
  const out: Egress = { texts: [], files: [], git: [] };
  const deny = (reason: string): Egress => ({ ...out, deny: reason });
  const line = parseLine(command);
  if (!line) return /(?:^|[|;&\n`(])\s*(?:\S*\/)?(?:gh|curl|wget|scp|sftp|rsync|git)(?=$|[\s|;&)])/.test(command) ? deny(EGRESS_UNSCANNABLE) : out;
  const background = shellWords(line.stripped)?.includes("&") ?? true;
  let sendsText = false;
  for (const [index, { words }] of line.commands.entries()) {
    const [name, ...args] = words;
    // a file argument as the scan reads it: the file itself, "" when `-` reads a heredoc in the command, undefined when `-` reads what the scan cannot see
    const fileOf = (value: string): string | undefined => {
      if (value !== "-") return value;
      if (words.includes("<<") || words.includes("<<<")) return "";
      return words.includes("<") ? words[words.indexOf("<") + 1] : undefined;
    };
    const readable = (values: string[]) => values.map(fileOf).every((file) => { if (file) out.files.push(file); return file !== undefined; });
    let sends = false;
    if (name === "gh") {
      if (args[0] === "gist" || (args[0] === "release" && (args[1] === "upload" || (args[1] === "create" && operands(args.slice(2), RELEASE_VALUE_FLAGS).length > 1)))) return deny(REMOTE_COPY_DENY);
      if (args[0] === "api" && apiSends(args)) {
        sends = sendsText = true;
        const fieldFiles = flagValues(args, ["-F", "--field"]).filter((v) => v.includes("=@")).map((v) => v.slice(v.indexOf("=@") + 2));
        if (!readable([...flagValues(args, ["--input"]), ...fieldFiles])) return deny(EGRESS_UNSCANNABLE);
      }
      if (GH_POSTS[args[0]]?.includes(args[1])) {
        sends = sendsText = true;
        if (!readable(flagValues(args, ["--body-file", "-F", "--notes-file"]))) return deny(EGRESS_UNSCANNABLE);
      }
    }
    if ((name === "curl" || name === "wget") && uploads(name, args) && !onlyLocal(args)) return deny(UPLOAD_DENY);
    if (name === "sftp" || name === "ftp" || ((name === "scp" || name === "rsync") && args.some(isRemote))) return deny(REMOTE_COPY_DENY);
    if (name === "git") {
      const git = gitCommand(args);
      if (git.config.some((v) => v.startsWith("alias.")) || (git.subcommand === "config" && git.rest.some((a) => a.startsWith("alias.")) && !git.rest.some((a) => /^--get|^--list$|^-l$/.test(a)))) return deny(ALIAS_DENY);
      if (git.subcommand) out.git.push({ ...(git.dir ? { dir: git.dir } : {}), subcommand: git.subcommand });
      if (git.subcommand === "push") {
        if (git.rest.some((a) => PUSH_EVERYTHING.includes(a))) return deny(PUSH_ONE);
        const sources = operands(git.rest, PUSH_VALUE_FLAGS).slice(1).map((r) => r.replace(/^\+/, "").split(":")[0]).filter(Boolean);
        out.push = { ...(git.dir ? { dir: git.dir } : {}), sources: sources.length ? sources : ["HEAD"] };
        sends = true;
      }
    }
    if (sends && (index > 0 || background)) return deny(SEND_ALONE);
  }
  if (!sendsText) return out;
  // a substitution builds the text at run time, out of the scan's sight; the heredoc form carries its body in the command, and nothing else may join it
  if (/`|\$\((?!cat <<HEREDOC\s*\))/.test(line.stripped)) return deny(EGRESS_UNSCANNABLE);
  return { ...out, texts: [command] };
}

/** the values a flag takes, written `--flag value` or `--flag=value` */
function flagValues(args: string[], flags: string[]): string[] {
  return args.flatMap((arg, i) => (flags.includes(arg) ? [args[i + 1] ?? ""] : flags.filter((f) => f.startsWith("--") && arg.startsWith(`${f}=`)).map((f) => arg.slice(f.length + 1))));
}

// the arguments that are neither options nor an option's value
const operands = (args: string[], valueFlags: string[]) => args.filter((a, i) => !a.startsWith("-") && !valueFlags.includes(args[i - 1] ?? ""));

// git's own options (-C dir, -c key=value) before the subcommand
function gitCommand(args: string[]): { dir?: string; config: string[]; subcommand?: string; rest: string[] } {
  let dir: string | undefined;
  const config: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-C") { dir = args[++i]; continue; }
    if (args[i] === "-c") { config.push(args[++i] ?? ""); continue; }
    if (args[i].startsWith("-")) continue;
    return { dir, config, subcommand: args[i], rest: args.slice(i + 1) };
  }
  return { dir, config, rest: [] };
}

const methodOf = (args: string[]) => (flagValues(args, ["-X", "--request", "--method"])[0] ?? args.find((a) => /^-X[A-Za-z]+$/.test(a))?.slice(2) ?? "").toUpperCase();

// gh api sends a body with fields, an input file, or a write method; a bare call reads
const apiSends = (args: string[]) => args.some((a) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(a) || /^--(?:field|raw-field|input)=/.test(a)) || ["POST", "PUT", "PATCH"].includes(methodOf(args));

function uploads(name: string, args: string[]): boolean {
  if (["POST", "PUT", "PATCH"].includes(methodOf(args))) return true;
  if (name === "wget") return args.some((a) => /^--(?:post|body)-(?:data|file)(?:=|$)/.test(a));
  // --data and its variants, --json, --form, --upload-file, and the short -d, -F and -T, alone or in a cluster like -sd
  return args.some((a) => /^--(?:data|json|form|upload-file)(?:-[\w-]+)?(?:=|$)/.test(a) || (!a.startsWith("--") && /^-[A-Za-z]*[dFT]/.test(a)));
}

function onlyLocal(args: string[]): boolean {
  const hosts = args.filter((a) => /^[a-z][\w+.-]*:\/\//i.test(a)).map((a) => { try { return new URL(a).hostname; } catch { return ""; } });
  return hosts.length > 0 && hosts.every((h) => LOCAL_HOSTS.has(h));
}

// `host:path`, `user@host:path` or an rsync:// URL; a path starting with /, . or ~ is local
const isRemote = (arg: string) => /^rsync:\/\//.test(arg) || (!/^[./~]/.test(arg) && /^(?:[\w.-]+@)?[\w.-]+:(?!\/\/)/.test(arg));

/**
 * What a shell command does to a data warehouse, read from its text: whether it runs a warehouse
 * CLI at all, the statement it carries, whether that statement only reads, and which tables it
 * names. Ports of the organisation's warehouse guards (pii-guard's command matcher and
 * dan-phi-routing's read-only rule). cli/covered.ts confines the covered analyst with these;
 * Consort never writes to a warehouse from any session.
 */

export const DEFAULT_WAREHOUSE_COMMANDS = ["snow", "snowsql", "hex"];

/**
 * Whether a command line runs any of `names` as a command word: at the start, after a separator,
 * a backtick, a newline or `$(`, and ending at whitespace, a separator or a redirection. A word
 * boundary would be too loose: `hex.tech` names a host, and `snowsql>out` is a real invocation.
 */
export function invokesWarehouse(command: string, names: string[]): boolean {
  if (!names.length) return false;
  const pattern = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(String.raw`(?:^|[|;&\`\n\r]|\$\()\s*(?:${pattern})(?=$|[\s|;&\`)<>])`).test(command);
}

const READ_ONLY = /^(?:select|with|show|describe|desc|explain|list)\b/;
const WRITES = /\b(?:insert|update|delete|merge|upsert|drop|truncate|create|alter|rename|grant|revoke|copy|unload|put|remove|call|execute)\b/;
const OPERATORS = new Set([";", "|", "||", "&", "&&", ">", ">>", "<", "<<", "(", ")"]);
const STATEMENT_FLAGS = new Set(["-q", "--query"]);

/**
 * The read-only statement a command runs, or why it cannot be approved. The whole decision rests
 * on seeing the statement, so it must be the `-q`/`--query` argument of a single warehouse
 * command: no pipes, redirects, chains, substitutions or second lines, and no write keyword
 * anywhere in the command.
 */
export function readOnlyStatement(command: string, names: string[]): { statement: string } | { problem: string } {
  if (/[`\n\r]|\$\(/.test(command)) return { problem: "substitutions and multi-line commands cannot be checked" };
  const tokens = shellWords(command);
  if (!tokens) return { problem: "the command cannot be parsed" };
  if (!tokens.length || !names.includes(tokens[0])) return { problem: `only ${names.join(", ")} may run here` };
  if (tokens.some((t) => OPERATORS.has(t))) return { problem: "pipes, redirects and command chains are not allowed" };
  const at = tokens.findIndex((t) => STATEMENT_FLAGS.has(t));
  const statement = at >= 0 ? tokens[at + 1] ?? "" : "";
  if (!statement) return { problem: "the statement must be given with -q or --query" };
  if (!READ_ONLY.test(statement.toLowerCase().replace(/^[\s(]+/, ""))) return { problem: "only select, with, show, describe, explain and list run" };
  if (WRITES.test(command.toLowerCase())) return { problem: "the command names a write" };
  return { statement };
}

const NAME_PART = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const TABLE_REFERENCE = new RegExp(String.raw`\b(?:from|join)\s+(${NAME_PART}(?:\.${NAME_PART}){0,2})`, "gi");
/** the tables a statement reads (`from` and `join` targets), lower-cased and unquoted; a subquery's own tables are found too */
export const tablesReferenced = (sql: string) => [...new Set([...sql.matchAll(TABLE_REFERENCE)].map((m) => m[1].replace(/"/g, "").toLowerCase()))];

/** the same table when one name is the other with its database or schema left off */
export function sameTable(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/"/g, ""), y = b.toLowerCase().replace(/"/g, "");
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
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
    if (/\s/.test(c)) { flush(); i++; continue; }
    if ("|&;<>()".includes(c)) {
      flush();
      let op = c;
      while (i + op.length < command.length && "|&;<>()".includes(command[i + op.length]) && OPERATORS.has(op + command[i + op.length])) op += command[i + op.length];
      words.push(op); i += op.length; continue;
    }
    word += c; i++;
  }
  flush();
  return words;
}

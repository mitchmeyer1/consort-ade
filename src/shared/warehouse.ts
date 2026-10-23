/**
 * What a shell command does to a data warehouse, read from its text: whether it runs a warehouse
 * CLI at all, the statement it carries, whether that statement only reads, and which tables it
 * names. Ports of the organisation's warehouse guards (pii-guard's command matcher and query
 * guard, dan-phi-routing's read-only rule). cli/covered.ts confines the covered analyst with
 * these, and cli/phiHooks.ts holds every uncovered turn to `warehouseProblem`; Consort never
 * writes to a warehouse from any session.
 */

import { parseLine, shellWords, SHELL_OPERATORS } from "./shellCommands.ts";

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
  if (tokens.some((t) => SHELL_OPERATORS.has(t))) return { problem: "pipes, redirects and command chains are not allowed" };
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

/**
 * What an uncovered session may not run against a warehouse, in the order it is checked: a
 * statement the guard cannot see, a write, then a query that would bring an identifier's value
 * back. `columns` and `tables` add to the baselines; nothing a setting holds can remove one.
 */
export function warehouseProblem(command: string, o: { names: string[]; columns?: string[]; tables?: string[] }): string | undefined {
  if (hidesStatement(command, o.names)) return HIDDEN_DENY;
  if (writesWarehouse(command)) return WRITE_DENY;
  if (exposesIdentifiers(command, o)) return QUERY_DENY;
  return undefined;
}

export const QUERY_DENY = "Not run: this query would read member-level data into a session that is not covered: an identifier column reaches a result un-aggregated, or a wildcard would carry one. Counts and predicates over the same column are allowed (count_if(ssn is null), where dob >= …, count(distinct …), a CASE WHEN condition), so reformulate at that level first. Once no such wording answers the question, hand it to the covered analyst with [covered-analyst: …]. Never run it here to save tokens or the round trip.";
export const WRITE_DENY = "Not run: Consort never writes to a warehouse: only select, with, show, describe, explain and list run. If the task needs a warehouse change, ask the owner.";
export const HIDDEN_DENY = "Not run: the statement must be written out on the command line (-q \"…\") so Consort can check it before it runs; a statement file, piped or redirected input, a variable or a substitution cannot be checked.";

// Columns that identify a person in any schema, and tables that hold one row per person. Kept in source so a setting can add to them and never empty them.
export const BASELINE_IDENTIFIER_COLUMNS = ["ssn", "social_security", "date_of_birth", "birth_date", "dob", "first_name", "middle_name", "last_name", "full_name", "member_name", "patient_name", "subscriber_name", "street_address", "home_address", "address_line", "phone_number", "email_address", "medicare_beneficiary_identifier", "mbi"];
export const BASELINE_PERSON_TABLES = ["members", "member", "patients", "subscribers", "enrollees", "eligibility", "coverage_spans"];

// count and cardinality aggregates; min, max, any_value, listagg and the hash functions return a value of the column and are absent on purpose
const COUNTING_AGGREGATES = new Set(["count", "count_if", "approx_count_distinct", "hll", "hll_estimate"]);
// the column is a predicate or a grouping key here, so its value stays in the warehouse
const PREDICATE_KEYWORDS = new Set(["where", "having", "qualify", "on", "using", "when", "by"]);
// the column's value would be part of a result here
const PROJECTION_KEYWORDS = new Set(["select", "then", "else", "case", "with", "values", "set", "into"]);
const SQL_TOKEN = /'(?:[^']|'')*'|[a-z_][a-z0-9_$]*|\d+(?:\.\d+)?|[\s\S]/g;
// `*` where it means every column: after `select` and its modifiers, or as an argument; `100*count_if(…)` is multiplication
const WILDCARD = /(?:\bselect\s+(?:distinct\s+|all\s+|top\s+\d+\s+)*|[(,]\s*)(?:[a-z_][a-z0-9_$]*\.)?\*/g;
const STATEMENT_START = /^\s*\(?\s*(?:select|with|show|describe|desc|explain|list|insert|update|delete|merge|create|drop|alter|truncate|copy|put|call|grant|revoke)\b/;

/**
 * The command lower-cased for the token scan, with its SQL marked out by double quotes: a heredoc
 * body is quoted, and a single-quoted shell argument that holds a statement is requoted, since
 * `-q 'select …'` is SQL where the scan would otherwise read one opaque string literal. Inside
 * that SQL, comments become a space, so a comment holding `where` before a column, or one between
 * `select` and its wildcard, reads as what runs; single-quoted SQL literals stay as they are.
 * Outside it, nothing is removed: a `--` there is a shell argument.
 */
function sqlView(command: string): string {
  const lowered = command.toLowerCase().replace(HEREDOC_BODY, (_m, head: string, _quote, _tag, body: string, tail: string) => `${head}"${body}"${tail}`);
  let requoted = "", inDouble = false;
  for (let i = 0; i < lowered.length; i++) {
    const c = lowered[i];
    if (c === "\\" && inDouble) { requoted += c + (lowered[i + 1] ?? ""); i++; continue; }
    if (c === "\"") inDouble = !inDouble;
    if (c !== "'" || inDouble) { requoted += c; continue; }
    const end = lowered.indexOf("'", i + 1);
    if (end < 0) { requoted += lowered.slice(i); break; }
    const body = lowered.slice(i + 1, end);
    requoted += STATEMENT_START.test(body) ? `"${body}"` : lowered.slice(i, end + 1);
    i = end;
  }
  let out = "";
  inDouble = false;
  for (let i = 0; i < requoted.length; i++) {
    const c = requoted[i];
    const close = inDouble ? requoted.indexOf("\"", i) : -1;
    const within = (at: number) => at >= 0 && (close < 0 || at < close);
    if (inDouble && c === "'" && within(requoted.indexOf("'", i + 1))) { const end = requoted.indexOf("'", i + 1); out += requoted.slice(i, end + 1); i = end; continue; }
    if (inDouble && requoted.startsWith("/*", i) && within(requoted.indexOf("*/", i + 2))) { out += " "; i = requoted.indexOf("*/", i + 2) + 1; continue; }
    if (inDouble && requoted.startsWith("--", i)) { const newline = requoted.indexOf("\n", i); const end = within(newline) ? newline : close < 0 ? requoted.length : close; out += " "; i = end - 1; continue; }
    if (c === "\"") inDouble = !inDouble;
    out += c;
  }
  return out;
}
// a heredoc's opening line, its body, and its closing delimiter
const HEREDOC_BODY = /(<<-?\s*(["']?)([a-z_][\w-]*)\2[^\n]*\n)([\s\S]*?)(\n[ \t]*\3[ \t]*(?=\n|$))/g;

/**
 * Whether an identifier column's value could reach the result: a port of the organisation's
 * query guard (pii-guard's query_guard.py). A token scan, not a parser: every mention of an
 * identifier column (`_` counts as a boundary, so `ssn_valid` and `plan_members` name what they
 * contain) is safe only inside a counting aggregate or in a predicate position, and only after a
 * `select` or `with`, so prose handed to a front end is never read as a predicate. A wildcard
 * beside any mention, or over a person table, carries every column; only `count(*)` is exempt.
 * Anything the scan cannot place is unsafe, and an exception denies.
 */
export function exposesIdentifiers(command: string, extra: { columns?: string[]; tables?: string[] } = {}): boolean {
  try {
    const lowered = sqlView(command);
    const tokens = lowered.match(SQL_TOKEN) ?? [];
    const columns = namesAny([...BASELINE_IDENTIFIER_COLUMNS, ...(extra.columns ?? [])]);
    const tables = namesAny([...BASELINE_PERSON_TABLES, ...(extra.tables ?? [])]);
    const mentions = tokens.flatMap((token, index) => (columns.test(token) && !isAlias(tokens, index) ? [index] : []));
    if (hasUnboundedWildcard(lowered) && (mentions.length || tokens.some((t) => tables.test(t)))) return true;
    return mentions.some((index) => !isSafeMention(tokens, index));
  } catch {
    return true;
  }
}

const namesAny = (terms: string[]) => new RegExp(`(?<![a-z0-9])(?:${terms.map((t) => t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![a-z0-9])`);

// `count_if(ssn is null) as null_ssn` gives a name; nothing is read under it
function isAlias(tokens: string[], index: number): boolean {
  let position = index - 1;
  while (position >= 0 && !tokens[position].trim()) position--;
  return position >= 0 && tokens[position] === "as";
}

function hasUnboundedWildcard(lowered: string): boolean {
  return [...lowered.matchAll(WILDCARD)].some((m) => !(m[0].startsWith("(") && /\bcount\s*$/.test(lowered.slice(0, m.index))));
}

const isSafeMention = (tokens: string[], index: number) => tokens.slice(0, index).some((t) => t === "select" || t === "with") && (isCounted(tokens, index) || isPredicate(tokens, index));

// some enclosing call is a counting aggregate: `count(distinct extract(year from dob))` is counted two parens out; the statement's edge ends the walk
function isCounted(tokens: string[], index: number): boolean {
  let depth = 0;
  for (let position = index - 1; position >= 0; position--) {
    const token = tokens[position];
    if (token === ";" || token === "\"") return false;
    if (token === ")") depth++;
    else if (token === "(") {
      if (depth) { depth--; continue; }
      if (COUNTING_AGGREGATES.has(tokens[position - 1] ?? "")) return true;
    }
  }
  return false;
}

// the nearest clause keyword decides: `where iff(ssn is null, 1, 0) = 1` is a predicate, `case when x then ssn` a projection; `from` decides nothing, and a group that closed before the mention (`over (order by id) rn, ssn`) is not its clause
function isPredicate(tokens: string[], index: number): boolean {
  let depth = 0;
  for (let position = index - 1; position >= 0; position--) {
    const token = tokens[position];
    if (token === ")") { depth++; continue; }
    if (token === "(" && depth) { depth--; continue; }
    if (depth) continue;
    if (PREDICATE_KEYWORDS.has(token)) return true;
    if (PROJECTION_KEYWORDS.has(token) || token === ";" || token === "\"") return false;
  }
  return false;
}

const WRITE_WORDS = new Set(["insert", "update", "delete", "merge", "upsert", "drop", "truncate", "create", "alter", "rename", "grant", "revoke", "copy", "unload", "put", "remove", "call", "execute", "deploy"]);

/**
 * Whether the command writes: a write keyword where a statement starts (after a quote, `;`, `(`
 * or a line break), or a write among the snow CLI's subcommands (`snow stage copy`, `snow
 * object drop`). A keyword anywhere else is a name or a string, so `hex thread create` and
 * `where status = 'update'` are not writes. Like the identifier scan it reads the whole line, so
 * a commit message beside a warehouse command can trip it; the agent runs them apart.
 */
export function writesWarehouse(command: string): boolean {
  const lowered = sqlView(command);
  const tokens = lowered.match(SQL_TOKEN) ?? [];
  const startsStatement = (index: number) => {
    let position = index - 1;
    for (; position >= 0 && !tokens[position].trim(); position--) if (tokens[position] === "\n") return true;
    return position >= 0 && [";", "\"", "("].includes(tokens[position]);
  };
  if (tokens.some((token, index) => WRITE_WORDS.has(token) && startsStatement(index))) return true;
  return [...lowered.matchAll(/(?:^|[|;&`\n(])\s*snow\s+((?:[a-z][\w-]*\s+){0,3})/g)].some((m) => m[1].split(/\s+/).some((word) => WRITE_WORDS.has(word)));
}

/**
 * A statement the guard cannot read: in a file (`-f`, `--filename`, `--stdin`, `<`), piped in,
 * or built at run time by a variable or a substitution, in an argument or a heredoc. A line that
 * does not parse cannot be read either.
 */
export function hidesStatement(command: string, names: string[]): boolean {
  const line = parseLine(command);
  if (!line) return true;
  // an unquoted `$(` splits into a `$` word and an operator, so a trailing `$` counts
  const expands = (text: string) => /\$(?:[({A-Za-z_]|$)|`/.test(text);
  if (line.heredocs.some(expands)) return true;
  return line.commands.some(({ words, piped }) => names.includes(words[0]) && (piped || words.some((w, i) => expands(w) || ["-f", "--filename", "--stdin"].includes(w) || w.startsWith("--filename=") || (w === "<" && words[i + 1] !== undefined))));
}

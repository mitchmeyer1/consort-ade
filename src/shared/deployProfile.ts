/**
 * What a project actually runs on: the platform, and the ceiling on every runtime it deploys —
 * a Lambda's memory and timeout, a container's CPU, a cron's window. A review needs those numbers
 * to say anything true about scale ("this buffers 6 GB into a 256 MB function"), and deducing them
 * means reading the README, CI and infra every time, so the first review of a project writes the
 * profile into its review file and Consort caches it on the project for the next one.
 */

export const RUNTIME_KINDS = ["lambda", "container", "server", "cron", "queue", "worker", "edge", "static", "database", "other"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export type DeployRuntime = {
  /** what it is called in the repo's own terms: "member-match worker", "api", "nightly-sync" */
  name: string;
  kind: RuntimeKind;
  /** where it is declared — `infra/src/queue.ts:40` — so a reviewer can check the number */
  ref?: string;
  memoryMb?: number;
  timeoutSec?: number;
  /** ephemeral disk: Lambda's /tmp, a container's scratch volume */
  diskMb?: number;
  /** "reserved 5", "unbounded", "1 instance" — prose, because every platform words it differently */
  concurrency?: string;
  /** payload, batch size, request body ceiling: "6 MB response", "10 records per batch" */
  limits?: string;
  notes?: string;
};

export type DeployProfile = {
  version: 1;
  /** "SST v3 → AWS Lambda", "Fly.io machines", "Vercel + Neon", "ECS Fargate" */
  platform: string;
  /** one plain sentence a reviewer can read without opening infra */
  summary?: string;
  /** stack-wide defaults every runtime inherits unless it overrides them */
  defaults?: { memoryMb?: number; timeoutSec?: number; diskMb?: number };
  runtimes: DeployRuntime[];
  /** the files it was deduced from, repo-relative */
  sources: string[];
  /** ISO timestamp it was deduced at, and the commit it was read at */
  at: string;
  head?: string;
};

/** How long a cached profile is trusted. Infra moves, but not weekly; a stale one is re-deduced by the next review. */
export const PROFILE_TTL_DAYS = 30;
const DAY = 86_400_000;

export const profileAge = (profile: DeployProfile, now: number) => now - Date.parse(profile.at || "");
export const profileStale = (profile: DeployProfile | undefined, now: number): boolean => {
  if (!profile || !profile.platform || !profile.at) return true;
  const age = profileAge(profile, now);
  return !Number.isFinite(age) || age < 0 || age > PROFILE_TTL_DAYS * DAY;
};

const str = (v: unknown, fallback = "") => (typeof v === "string" ? v.trim() : fallback);
const num = (v: unknown) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // "1024", "1024 MB", "1.5 GB", "30s"
    const m = /^([\d.]+)\s*(gb|g|mb|m|kb|k)?/i.exec(v.trim());
    if (!m) return undefined;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return undefined;
    const unit = (m[2] ?? "").toLowerCase();
    return unit === "gb" || unit === "g" ? Math.round(n * 1024) : unit === "kb" || unit === "k" ? Math.round(n / 1024) : Math.round(n);
  }
  return undefined;
};

function runtime(raw: any): DeployRuntime | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const name = str(raw.name);
  if (!name) return undefined;
  const kind = RUNTIME_KINDS.includes(raw.kind) ? (raw.kind as RuntimeKind) : "other";
  return {
    name, kind,
    ref: str(raw.ref) || undefined,
    memoryMb: num(raw.memoryMb ?? raw.memory),
    timeoutSec: num(raw.timeoutSec ?? raw.timeout),
    diskMb: num(raw.diskMb ?? raw.disk ?? raw.ephemeralStorageMb),
    concurrency: str(raw.concurrency) || undefined,
    limits: str(raw.limits) || undefined,
    notes: str(raw.notes) || undefined,
  };
}

/** Read a profile the way the review file is read: fill what is there, drop what is malformed, never throw. */
export function parseDeployProfile(raw: unknown): DeployProfile | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, any>;
  const platform = str(r.platform);
  if (!platform) return undefined;
  const defaults = r.defaults && typeof r.defaults === "object"
    ? { memoryMb: num(r.defaults.memoryMb ?? r.defaults.memory), timeoutSec: num(r.defaults.timeoutSec ?? r.defaults.timeout), diskMb: num(r.defaults.diskMb ?? r.defaults.disk) }
    : undefined;
  const kept = defaults && Object.values(defaults).some((v) => v !== undefined) ? defaults : undefined;
  return {
    version: 1, platform,
    summary: str(r.summary) || undefined,
    ...(kept ? { defaults: kept } : {}),
    runtimes: Array.isArray(r.runtimes) ? r.runtimes.map(runtime).filter((x): x is DeployRuntime => !!x) : [],
    sources: Array.isArray(r.sources) ? r.sources.map((s) => str(s)).filter(Boolean) : [],
    at: str(r.at) || new Date().toISOString(),
    head: str(r.head) || undefined,
  };
}

const size = (mb?: number) => (mb === undefined ? undefined : mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`);

/** one runtime on one line: the numbers a scaling claim is measured against */
export function runtimeLine(r: DeployRuntime): string {
  const limits = [size(r.memoryMb), r.timeoutSec !== undefined ? `${r.timeoutSec}s` : undefined, r.diskMb !== undefined ? `${size(r.diskMb)} disk` : undefined, r.concurrency, r.limits]
    .filter(Boolean).join(" · ");
  return `- ${r.name} (${r.kind})${limits ? ` — ${limits}` : " — no limits recorded"}${r.ref ? ` — ${r.ref}` : ""}${r.notes ? ` — ${r.notes}` : ""}`;
}

/** The block a review reads before it judges anything about scale. */
export function profileBrief(profile: DeployProfile): string {
  const d = profile.defaults;
  const defaults = d && [size(d.memoryMb), d.timeoutSec !== undefined ? `${d.timeoutSec}s timeout` : undefined, d.diskMb !== undefined ? `${size(d.diskMb)} disk` : undefined].filter(Boolean).join(" · ");
  return [
    `## Deployment profile — ${profile.platform}`,
    profile.summary ? `\n${profile.summary}` : "",
    defaults ? `\nStack defaults: ${defaults}` : "",
    profile.runtimes.length ? `\nRuntimes:\n${profile.runtimes.map(runtimeLine).join("\n")}` : "\nNo individual runtimes recorded.",
    profile.sources.length ? `\nDeduced from: ${profile.sources.join(", ")}` : "",
    `\nCached ${profile.at}${profile.head ? ` at ${profile.head.slice(0, 7)}` : ""}. Treat these ceilings as fact unless this PR changes them; if the PR moves a limit, say so and use the new number.`,
  ].filter(Boolean).join("\n");
}

/** What the review does when nothing is cached, or the cache has gone stale. */
export const DEPLOY_SCAN = `No deployment profile is cached for this project, so deduce one before the review wave and carry it in the review file.

Read, in this order, and stop when the platform is unambiguous: infra as code (\`sst.config.ts\`, \`infra/\`, \`serverless.yml\`, \`template.yaml\`/SAM, \`*.tf\`, \`cdk.json\`, \`Pulumi.yaml\`, \`fly.toml\`, \`vercel.json\`, \`render.yaml\`, \`app.yaml\`, Helm charts, \`docker-compose.yml\`, \`Dockerfile\`) · the deploy workflows in \`.github/workflows/\` · the README and any \`CLAUDE.md\`/\`CONTRIBUTING.md\` deployment section · \`package.json\` scripts.

Record what a reviewer cannot guess: the platform and where it runs, the stack-wide defaults, and every runtime this repo deploys with its memory, timeout, ephemeral disk, concurrency and payload ceilings, each with the \`file:line\` the number comes from. Defaults count: an SST function with no \`memory\` set is 1024 MB, a Lambda with no \`timeout\` is 3 s at the AWS default but whatever the stack sets otherwise — write the effective number and name where it comes from. Where a limit genuinely is not declared, say so rather than inventing one.

Write it as the \`deploy\` object of the review file (schema in Phase 5). Consort caches it on the project, so later reviews get it handed to them and skip this scan.`;

/** What the review does when Consort hands it a cached profile. */
export const deployPrompt = (profile: DeployProfile | undefined) =>
  profile && !profileStale(profile, Date.now())
    ? `${profileBrief(profile)}\n\nCarry this same object forward as the review file's \`deploy\` key, correcting any number this PR changes or that you find is wrong. Skip the deployment scan.`
    : DEPLOY_SCAN;

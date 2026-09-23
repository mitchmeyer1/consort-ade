export const PHASES = ["waiting", "planning", "executing", "validating", "complete"] as const;
export type Phase = (typeof PHASES)[number];
export const SIMPLE_PHASES: readonly Phase[] = ["waiting", "executing", "complete"];
export const phasesFor = (steps?: 3 | 5): readonly Phase[] => steps === 3 ? SIMPLE_PHASES : PHASES;
export type Provider = "claude" | "codex";
/**
 * Seed lists only, for a machine that has never reached either provider. The live lists are
 * pulled on every start: Claude's from the CLI (main/claudeModels.ts), Codex's from its own
 * catalog (main/codexModels.ts), and the last good Claude list is kept in state.
 */
export const MODELS: Record<Provider, string[]> = {
  claude: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
};

/** models offered in the picker: what the provider currently advertises, else the built-in list */
export const modelOptions = (state: { models?: Partial<Record<Provider, string[]>> }, provider: Provider) =>
  state.models?.[provider]?.length ? state.models[provider]! : MODELS[provider];

/** configDir: extra CLI logins keep their own credentials there (CLAUDE_CONFIG_DIR / CODEX_HOME); the built-in login uses the CLI default */
export type ApiKey = { id: string; name: string; provider: Provider; phiAllowed: boolean; auth: "login" | "key"; configDir?: string; defaultModel?: string };
import type { Contributor } from "./contributors";
import type { SideMessage } from "./sideChat";
import type { FindingStatus, Review, ReviewEvent, ReviewSummary, VerdictReport } from "./review";
import type { CiInfo } from "./ci";
import type { IssueInfo, IssueLink } from "./issues";
import type { PrTurn } from "./prTurn";
import type { PrDraft } from "./createPr";
export type { Contributor, SideMessage };
export type { Finding, FindingStatus, Review, ReviewEvent, ReviewSummary, Submission, Verdict, VerdictReport } from "./review";
export type { CiCheck, CiInfo, CiState } from "./ci";
export type { IssueDetail, IssueInfo, IssueLink } from "./issues";
export type { PrDraft } from "./createPr";
export type PrDraftText = { title: string; body: string };
export type QuickAction = { id: string; title: string; command: string; pinned?: boolean };
/** An extension installed into the native configuration directory of one connector. */
export type InstalledExtension = {
  id: string;
  connectorId: string;
  provider: Provider;
  kind: "plugin" | "skill";
  name: string;
  source?: string;
  installedAt: number;
};
/** one repo of a workspace: which project it came from and the folder it sits in under the workspace path */
export type WorkspaceRepo = { projectId: string; dir: string };
export type Project = {
  id: string; name: string; path: string; defaultBase: string; baseSetByUser?: boolean;
  /** a multi-repo workspace: `path` is a folder holding a worktree of each repo on `branch` (see shared/workspace.ts) */
  kind?: "workspace";
  repos?: WorkspaceRepo[];
  branch?: string;
  /** BUILD, START SERVER…: shown on every worktree of the project, run in the one you are in (see shared/quickActions.ts) */
  quickActions?: QuickAction[];
};
export type Worktree = {
  id: string; projectId: string; name: string; title: string; path: string; branch: string; archived: boolean; root?: boolean;
  /** a repoless chat's folder in the app's hidden data directory: no project, no git (see shared/scratch.ts) */
  scratch?: true;
  /** the single chat scope of a workspace project: its path is the workspace folder */
  workspace?: true;
};
/** one repo's git state inside a workspace; status is null while unknown */
export type RepoStatus = { projectId: string; name: string; dir: string; path: string; status: WorktreeStatus | null };
export type WorkspaceStatus = { branch: string; repos: RepoStatus[] };
/** the outcome of a fanned-out git action for one repo */
export type RepoResult = { name: string; ok: boolean; detail: string; skipped?: boolean; url?: string; number?: number };
/** the worktree's own PR; the turn fields follow the same rule as the project page's PR list */
export type PrInfo = { number: number; state: "OPEN" | "MERGED" | "CLOSED"; draft: boolean; url: string; title: string; author: string; review: string; /** GitHub's check rollup for the PR head, raw, for the CI summary */ checks: unknown[] } & Partial<PrTurn>;
export type WorktreeStatus = {
  branch: string; dirty: number; ahead: number; behind: number; merged: boolean; inBase: boolean; base: string;
  last?: { subject: string; author: string; age: string }; files: string; pr?: PrInfo;
  /** CI for the pushed commit: from the PR when there is one, else the upstream tip; absent when nothing is pushed or no checks ran */
  ci?: CiInfo;
  /** the GitHub issue this branch was made for (an `issue/<n>` branch); the link the sidebar chip shows */
  issue?: IssueLink;
  /** who wrote most of what this branch adds on top of its base */
  author?: Contributor;
  /**
   * When GitHub's GraphQL budget is spent, the PR, turn and issue chips have no source — only CI,
   * which is REST, survives. This is when we will ask again, so the sidebar can say so rather than
   * quietly dropping the chips.
   */
  limitedUntil?: number;
};

export type Block =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: string; output?: string; ok?: boolean };
/** one step of the plan the agent declares at the start of a task */
export type PlanStep = { label: string; startedAt?: number; doneAt?: number; skipped?: boolean };
export type ChatPlan = { steps: PlanStep[]; current: number; ts: number };

/** a row in the progress panel: a review's phase, or a step of the agent's own plan */
export type StageState = "done" | "active" | "pending" | "skipped";
export type Stage = {
  id: string; label: string; state: StageState; detail?: string;
  done?: number; total?: number;
  subtasks?: { label: string; state: StageState }[];
};

/** attachments: staged paths of the files sent with the message, shown as thumbnails/chips under it */
export type Message = { id: string; role: "user" | "assistant" | "system"; blocks: Block[]; ts: number; attachments?: string[] };

export type Chat = {
  id: string;
  worktreeId: string;
  name: string;
  provider: Provider;
  keyId: string;
  model: string;
  /** model for agents this chat dispatches; unset lets them inherit `model` (see shared/modelTiers.ts) */
  delegateModel?: string;
  sessionId?: string;
  sessionKeyId?: string; // connector that owns the provider session
  phase: Phase;
  phaseSteps?: 3 | 5;
  assessingPrompt?: boolean;
  autoApprove: boolean;
  running: boolean;
  interrupted?: boolean;
  error?: string;
  unreadCompletion?: boolean;
  /** "remind me": when the reminder comes due (a clock until then, purple after); cleared when you next work in the chat */
  remindAt?: number;
  permissions?: PermissionRequest[];
  messages: Message[];
  lastChattedAt?: number;
  queuedMessages?: { id: string; text: string; files: string[] }[];
  queuePaused?: boolean;
  /** the steps the agent laid out for the current task, and how far along it is */
  plan?: ChatPlan;
  /** the read-only side chat you can ask about this chat's job while it runs */
  sideMessages?: SideMessage[];
  sideBusy?: boolean;
};

export type RootBranch = { ref: string; name: string; occupied?: string };
export type RootStatus = { branch: string | null; commit: string; dirty: boolean };

export type RepoInfo = {
  repo?: { nameWithOwner: string; description: string; url: string; defaultBranch: string; pushedAt: string; isPrivate: boolean };
  me: string;
  prs: ({ number: number; title: string; author: string; branch: string; draft: boolean; review: string; updatedAt: string; url: string } & PrTurn)[];
  runs: { name: string; title: string; branch: string; status: string; conclusion: string; createdAt: string; url: string }[];
  /** open issues, most recently updated first */
  issues: IssueInfo[];
  /** set while GitHub's GraphQL budget is spent: the lists above are the last good ones, not fresh */
  limitedUntil?: number;
};
export type Job = { id: string; scopeId: string; termId: string; cwd: string; cmd: string; out: string; status: "running" | "exited"; code?: number; startedAt: number; seen?: boolean };
/** done: a command that took a while finished successfully and nobody has looked yet */
export type PtyState = { id: string; scopeId: string; termId: string; running: boolean; failed: boolean; done?: boolean };
export type CommitInfo = { files: string; changed: number; log: { hash: string; subject: string; author: string; age: string }[]; branch: string; ahead: number };
export type Appearance = { theme: "dark" | "light" | "auto"; background: "opaque" | "frost" | "frost2" };
export type State = {
  projects: Project[]; worktrees: Worktree[]; chats: Chat[]; keys: ApiKey[]; defaultKeyId?: string; appearance: Appearance; models?: Partial<Record<Provider, string[]>>;
  /** Extensions Consort installed through Settings; their provider config remains the source of truth. */
  extensions?: InstalledExtension[];
  /** standing instructions appended to every chat's prompt (see shared/instructions.ts) */
  instructions?: import("./instructions").Instruction[];
  /** the last model list each provider reported, with when; `models` above is derived from it */
  modelCatalog?: Partial<Record<Provider, { models: string[]; at: number }>>;
};
export type PermissionRequest = { id: string; chatId: string; tool: string; input: unknown };
export type { ConnectorUsage, UsageWindow } from "./usage";

export type Api = {
  getState(): Promise<State>;
  rootBranches(projectId: string): Promise<{ current: string | null; branches: RootBranch[] }>;
  switchRootBranch(projectId: string, expectedBranch: string | null, ref: string): Promise<RootStatus>;
  rootStatus(projectId: string): Promise<RootStatus>;
  commitAndPushRoot(worktreeId: string, expectedBranch: string, message: string): Promise<string>;
  commitWorktree(worktreeId: string, expectedBranch: string, message: string): Promise<string>;
  pullWorktree(worktreeId: string, expectedBranch: string): Promise<string>;
  pushWorktree(worktreeId: string, expectedBranch: string): Promise<string>;
  /** push the branch, then open a PR against the project base; resolves to the new PR's URL */
  createPr(worktreeId: string, expectedBranch: string, draft: PrDraft): Promise<{ url: string; number?: number }>;
  checkoutAtRoot(worktreeId: string, commitMessage?: string): Promise<RootStatus>;
  setActiveChat(id: string | null): Promise<void>;
  onOpenChat(cb: (id: string) => void): () => void;
  onState(cb: (s: State) => void): () => void;
  pickFolder(): Promise<string | null>;
  addProject(path: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  setProjectBase(id: string, base: string): Promise<void>;
  syncWorktrees(projectId: string): Promise<void>;
  openRootWorktree(projectId: string): Promise<string>;
  addWorktree(projectId: string, name: string, branch: string, base: string): Promise<void>;
  removeWorktree(id: string): Promise<void>;
  renameWorktree(id: string, title: string): Promise<void>;
  autoTitle(id: string): Promise<void>;
  archiveWorktree(id: string, on: boolean): Promise<void>;
  worktreeStatus(id: string): Promise<WorktreeStatus | null>;
  /** a multi-repo workspace from existing projects; resolves to the id of its one worktree */
  addWorkspace(name: string, branch: string, projectIds: string[]): Promise<string>;
  workspaceStatus(projectId: string): Promise<WorkspaceStatus | null>;
  commitWorkspace(projectId: string, message: string): Promise<RepoResult[]>;
  pullWorkspace(projectId: string): Promise<RepoResult[]>;
  pushWorkspace(projectId: string): Promise<RepoResult[]>;
  createWorkspacePrs(projectId: string, draft: PrDraft): Promise<RepoResult[]>;
  addChat(worktreeId: string, keyId: string, opts?: { name?: string; model?: string; delegateModel?: string; remember?: boolean }): Promise<string>;
  /** a chat with no repo: makes a hidden scratch folder for it and returns the chat id */
  addScratchChat(keyId: string, opts?: { name?: string; model?: string }): Promise<string>;
  skillPrompt(name: string, worktreeId: string, args?: string, delegateModel?: string): Promise<string>;
  /** the opening message of an issue chat: the issue, its discussion, and the ask for a summary and plan (no code) */
  issuePrompt(worktreeId: string, number: number): Promise<string>;
  listFiles(worktreeId: string): Promise<string[]>;
  readFile(worktreeId: string, rel: string): Promise<string>;
  writeFile(worktreeId: string, rel: string, content: string): Promise<void>;
  renameChat(id: string, name: string): Promise<void>;
  deleteChat(id: string): Promise<void>;
  chatMenu(id: string): Promise<void>;
  askSide(id: string, question: string): Promise<void>;
  clearSide(id: string): Promise<void>;
  setAutoApprove(id: string, on: boolean): Promise<void>;
  setPhase(id: string, phase: Phase): Promise<void>;
  send(chatId: string, text: string, files?: string[]): Promise<void>;
  resumeQueue(chatId: string): Promise<void>;
  removeQueuedMessage(chatId: string, messageId: string): Promise<void>;
  pickFiles(): Promise<string[]>;
  pathsFor(files: File[]): string[];
  stageBlob(name: string, bytes: ArrayBuffer): Promise<string>;
  setChatKey(id: string, keyId: string): Promise<void>;
  switchAgent(id: string, keyId: string, model: string): Promise<void>;
  continueChat(id: string): Promise<void>;
  setPhiMode(id: string, on: boolean): Promise<void>;
  stop(chatId: string): Promise<void>;
  addKey(name: string, provider: Provider, key: string, phiAllowed: boolean, auth?: "login" | "key"): Promise<void>;
  setDefaultKey(id: string): Promise<void>;
  setKeyPhi(id: string, on: boolean): Promise<void>;
  renameKey(id: string, name: string): Promise<void>;
  removeKey(id: string): Promise<void>;
  onPermission(cb: (r: PermissionRequest) => void): () => void;
  answerPermission(id: string, allow: boolean): Promise<void>;
  addQuickAction(projectId: string, title: string, command: string): Promise<void>;
  setQuickActionPinned(projectId: string, actionId: string, pinned: boolean): Promise<void>;
  deleteQuickAction(projectId: string, actionId: string): Promise<void>;
  runCommand(worktreeId: string, cmd: string): Promise<{ out: string; code: number }>;
  ptyCreate(scopeId: string, termId: string, cwd: string, cols: number, rows: number): Promise<string>;
  ptyWrite(id: string, data: string): Promise<void>;
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  ptyKill(id: string): Promise<void>;
  ptySeen(id: string): Promise<void>;
  /** clears finished/failed marks for every terminal in a worktree or project */
  ptySeenScope(scopeId: string): Promise<void>;
  /** a command-finished notification was clicked: show that worktree or project */
  onOpenScope(cb: (id: string) => void): () => void;
  ptys(): Promise<PtyState[]>;
  onPtyData(cb: (m: { id: string; data: string }) => void): () => void;
  onPtys(cb: (s: PtyState[]) => void): () => void;
  diff(worktreeId: string): Promise<{ files: string; patch: string }>;
  artifactMenu(worktreeId: string, target: string): Promise<"open" | null>;
  previewArtifact(worktreeId: string, target: string): Promise<{ kind: "url" | "image" | "pdf" | "markdown" | "html" | "text" | "unsupported"; content: string }>;
  openExternal(url: string): Promise<void>;
  setAppearance(a: Partial<Appearance>): Promise<void>;
  setInstructions(items: import("./instructions").Instruction[]): Promise<void>;
  /** Install through Claude Code's own marketplace and plugin commands. */
  installClaudePlugin(keyId: string, marketplace: string, plugin: string): Promise<InstalledExtension>;
  /** Copy a standard SKILL.md directory into this connector's CODEX_HOME/skills directory. */
  installCodexSkill(keyId: string, source: string): Promise<InstalledExtension>;
  /** re-ask every connector which models it offers; the picker updates when they answer */
  refreshModels(): Promise<void>;
  effectiveTheme(): Promise<"dark" | "light">;
  onTheme(cb: (t: "dark" | "light") => void): () => void;
  repoInfo(projectId: string): Promise<RepoInfo>;
  authStatus(keyId: string): Promise<{ loggedIn: boolean; detail: string }>;
  /** plan usage meters for a connector; cached briefly in main, `force` re-asks the CLI */
  connectorUsage(keyId: string, force?: boolean): Promise<import("./usage").ConnectorUsage>;
  authLoginCmd(keyId: string): Promise<string>;
  commitInfo(worktreeId: string): Promise<CommitInfo>;
  commit(worktreeId: string, message: string): Promise<string>;
  suggestCommit(worktreeId: string): Promise<string>;
  /** an AI-drafted PR title and bullet body from the branch's commits and diff against the base; empty when there is nothing to describe */
  suggestPr(worktreeId: string, branch: string): Promise<PrDraftText>;
  /** commit + push from the composer, narrated into the chat transcript; omit message to let the AI draft one */
  commitChat(chatId: string, message?: string): Promise<string>;
  /** a `*.review.json` a PR review wrote; `target` is the same link text an artifact carries */
  readReview(worktreeId: string, target: string): Promise<{ path: string; review: Review }>;
  /** the review file this branch owns (the PR's own when `pr` is known, else the newest), relative to the worktree, or null when none was written */
  findReview(worktreeId: string, pr?: number): Promise<{ path: string; summary: ReviewSummary } | null>;
  updateReviewFinding(worktreeId: string, target: string, findingId: string, patch: { status?: FindingStatus; comment?: string }): Promise<Review>;
  /** submit one GitHub review: verdict, body (drafted by the model when blank and `draft` is set), and the queued comments inline when `inline` is set */
  submitReview(worktreeId: string, target: string, opts: { event: ReviewEvent; body: string; inline: boolean; draft: boolean }): Promise<{ review: Review; result: { url: string; event: ReviewEvent; body: string; drafted: boolean; inline: string[]; general: string[]; headMoved: boolean } }>;
  /** "Comment all": queue every undecided finding that has a comment; nothing posts until the review is submitted */
  queueAllFindings(worktreeId: string, target: string): Promise<Review>;
  /** the PR's live head, state and review decision, and the findings whose file changed since they were verified */
  reviewDrift(worktreeId: string, target: string): Promise<{ head: string | null; state: string | null; reviewDecision: string; url: string; drifted: string[] }>;
  /** re-check one finding against the PR's current head with a read-only agent; the verdict is written into the file */
  reinvestigateFinding(worktreeId: string, target: string, findingId: string): Promise<{ review: Review; report: VerdictReport; summary: string; head: string }>;
  /** hand one finding to the review chat in its worktree (or a new chat) to fix locally, with the user's own direction appended; queued if that chat is busy */
  fixFinding(worktreeId: string, target: string, findingId: string, note?: string): Promise<{ review: Review; chatId: string; chatName: string; queued: boolean }>;
  watchReview(worktreeId: string, target: string): Promise<void>;
  unwatchReview(worktreeId: string, target: string): Promise<void>;
  /** the absolute path of a review file that changed on disk */
  onReviewChanged(cb: (path: string) => void): () => void;
  /** a notice main would have sent to the system, delivered in-app because Consort is the active window */
  onToast(cb: (n: import("./notices").Notice) => void): () => void;
};

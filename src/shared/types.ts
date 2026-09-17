export const PHASES = ["waiting", "planning", "executing", "validating", "complete"] as const;
export type Phase = (typeof PHASES)[number];
export const SIMPLE_PHASES: readonly Phase[] = ["waiting", "executing", "complete"];
export const phasesFor = (steps?: 3 | 5): readonly Phase[] => steps === 3 ? SIMPLE_PHASES : PHASES;
export type Provider = "claude" | "codex";
export const MODELS: Record<Provider, string[]> = {
  claude: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-6-astra"], // ponytail: the ChatGPT-login default as of codex 0.154; add others as you use them
};

/** configDir: extra CLI logins keep their own credentials there (CLAUDE_CONFIG_DIR / CODEX_HOME); the built-in login uses the CLI default */
export type ApiKey = { id: string; name: string; provider: Provider; phiAllowed: boolean; auth: "login" | "key"; configDir?: string; defaultModel?: string };
export type Project = { id: string; name: string; path: string; defaultBase: string; baseSetByUser?: boolean };
export type QuickAction = { id: string; title: string; command: string; pinned?: boolean };
export type Worktree = { id: string; projectId: string; name: string; title: string; path: string; branch: string; archived: boolean; root?: boolean; quickActions?: QuickAction[] };
export type PrInfo = { number: number; state: "OPEN" | "MERGED" | "CLOSED"; draft: boolean; url: string; title: string; review: string; checks: "pass" | "fail" | "pending" | null };
export type WorktreeStatus = {
  branch: string; dirty: number; ahead: number; behind: number; merged: boolean; inBase: boolean; base: string;
  last?: { subject: string; author: string; age: string }; files: string; pr?: PrInfo;
};

export type Block =
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: string; output?: string; ok?: boolean };
export type Message = { id: string; role: "user" | "assistant" | "system"; blocks: Block[]; ts: number };

export type Chat = {
  id: string;
  worktreeId: string;
  name: string;
  provider: Provider;
  keyId: string;
  model: string;
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
  permissions?: PermissionRequest[];
  messages: Message[];
  lastChattedAt?: number;
  queuedMessages?: { id: string; text: string; files: string[] }[];
  queuePaused?: boolean;
};

export type RootBranch = { ref: string; name: string; occupied?: string };
export type RootStatus = { branch: string | null; commit: string; dirty: boolean };

export type RepoInfo = {
  repo?: { nameWithOwner: string; description: string; url: string; defaultBranch: string; pushedAt: string; isPrivate: boolean };
  me: string;
  prs: { number: number; title: string; author: string; branch: string; draft: boolean; review: string; updatedAt: string; url: string;
    mine: boolean; role: "author" | "reviewer" | null; turn: "yours" | "theirs" | null; why: string }[];
  runs: { name: string; title: string; branch: string; status: string; conclusion: string; createdAt: string; url: string }[];
};
export type Job = { id: string; scopeId: string; termId: string; cwd: string; cmd: string; out: string; status: "running" | "exited"; code?: number; startedAt: number; seen?: boolean };
export type PtyState = { id: string; scopeId: string; termId: string; running: boolean; failed: boolean };
export type CommitInfo = { files: string; changed: number; log: { hash: string; subject: string; author: string; age: string }[]; branch: string; ahead: number };
export type Appearance = { theme: "dark" | "light" | "auto"; background: "opaque" | "frost" | "frost2" };
export type State = { projects: Project[]; worktrees: Worktree[]; chats: Chat[]; keys: ApiKey[]; defaultKeyId?: string; appearance: Appearance };
export type PermissionRequest = { id: string; chatId: string; tool: string; input: unknown };

export type Api = {
  getState(): Promise<State>;
  rootBranches(projectId: string): Promise<{ current: string | null; branches: RootBranch[] }>;
  switchRootBranch(projectId: string, expectedBranch: string | null, ref: string): Promise<RootStatus>;
  rootStatus(projectId: string): Promise<RootStatus>;
  commitAndPushRoot(worktreeId: string, expectedBranch: string, message: string): Promise<string>;
  commitWorktree(worktreeId: string, expectedBranch: string, message: string): Promise<string>;
  pullWorktree(worktreeId: string, expectedBranch: string): Promise<string>;
  pushWorktree(worktreeId: string, expectedBranch: string): Promise<string>;
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
  addChat(worktreeId: string, keyId: string, opts?: { name?: string; model?: string }): Promise<string>;
  skillPrompt(name: string, worktreeId: string, args?: string): Promise<string>;
  listFiles(worktreeId: string): Promise<string[]>;
  readFile(worktreeId: string, rel: string): Promise<string>;
  writeFile(worktreeId: string, rel: string, content: string): Promise<void>;
  renameChat(id: string, name: string): Promise<void>;
  deleteChat(id: string): Promise<void>;
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
  addQuickAction(worktreeId: string, title: string, command: string): Promise<void>;
  setQuickActionPinned(worktreeId: string, actionId: string, pinned: boolean): Promise<void>;
  deleteQuickAction(worktreeId: string, actionId: string): Promise<void>;
  runCommand(worktreeId: string, cmd: string): Promise<{ out: string; code: number }>;
  ptyCreate(scopeId: string, termId: string, cwd: string, cols: number, rows: number): Promise<string>;
  ptyWrite(id: string, data: string): Promise<void>;
  ptyResize(id: string, cols: number, rows: number): Promise<void>;
  ptyKill(id: string): Promise<void>;
  ptySeen(id: string): Promise<void>;
  ptys(): Promise<PtyState[]>;
  onPtyData(cb: (m: { id: string; data: string }) => void): () => void;
  onPtys(cb: (s: PtyState[]) => void): () => void;
  diff(worktreeId: string): Promise<{ files: string; patch: string }>;
  artifactMenu(worktreeId: string, target: string): Promise<"open" | null>;
  previewArtifact(worktreeId: string, target: string): Promise<{ kind: "url" | "image" | "pdf" | "markdown" | "html" | "text" | "unsupported"; content: string }>;
  openExternal(url: string): Promise<void>;
  setAppearance(a: Partial<Appearance>): Promise<void>;
  effectiveTheme(): Promise<"dark" | "light">;
  onTheme(cb: (t: "dark" | "light") => void): () => void;
  repoInfo(projectId: string): Promise<RepoInfo>;
  authStatus(keyId: string): Promise<{ loggedIn: boolean; detail: string }>;
  authLoginCmd(keyId: string): Promise<string>;
  commitInfo(worktreeId: string): Promise<CommitInfo>;
  commit(worktreeId: string, message: string): Promise<string>;
  suggestCommit(worktreeId: string): Promise<string>;
  /** commit + push from the composer, narrated into the chat transcript; omit message to let the AI draft one */
  commitChat(chatId: string, message?: string): Promise<string>;
};

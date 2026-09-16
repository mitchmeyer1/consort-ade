export const PHASES = ["waiting", "planning", "executing", "validating", "complete"] as const;
export type Phase = (typeof PHASES)[number];
export type Provider = "claude" | "codex";
export const MODELS: Record<Provider, string[]> = {
  claude: ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-6-astra"], // ponytail: the ChatGPT-login default as of codex 0.154; add others as you use them
};

export type ApiKey = { id: string; name: string; provider: Provider; phiAllowed: boolean; auth: "login" | "key" };
export type Project = { id: string; name: string; path: string; defaultBase: string; baseSetByUser?: boolean };
export type Worktree = { id: string; projectId: string; name: string; title: string; path: string; branch: string; archived: boolean };
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
  phase: Phase;
  autoApprove: boolean;
  running: boolean;
  error?: string;
  messages: Message[];
};

export type RepoInfo = {
  repo?: { nameWithOwner: string; description: string; url: string; defaultBranch: string; pushedAt: string; isPrivate: boolean };
  me: string;
  prs: { number: number; title: string; author: string; branch: string; draft: boolean; review: string; updatedAt: string; url: string;
    mine: boolean; role: "author" | "reviewer" | null; turn: "yours" | "theirs" | null; why: string }[];
  runs: { name: string; title: string; branch: string; status: string; conclusion: string; createdAt: string; url: string }[];
};
export type Appearance = { theme: "dark" | "light"; background: "opaque" | "frost" | "frost2" };
export type State = { projects: Project[]; worktrees: Worktree[]; chats: Chat[]; keys: ApiKey[]; appearance: Appearance };
export type PermissionRequest = { id: string; chatId: string; tool: string; input: unknown };

export type Api = {
  getState(): Promise<State>;
  onState(cb: (s: State) => void): () => void;
  pickFolder(): Promise<string | null>;
  addProject(path: string): Promise<void>;
  removeProject(id: string): Promise<void>;
  setProjectBase(id: string, base: string): Promise<void>;
  syncWorktrees(projectId: string): Promise<void>;
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
  pickFiles(): Promise<string[]>;
  pathsFor(files: File[]): string[];
  setChatKey(id: string, keyId: string): Promise<void>;
  setPhiMode(id: string, on: boolean): Promise<void>;
  stop(chatId: string): Promise<void>;
  addKey(name: string, provider: Provider, key: string, phiAllowed: boolean): Promise<void>;
  setKeyPhi(id: string, on: boolean): Promise<void>;
  removeKey(id: string): Promise<void>;
  onPermission(cb: (r: PermissionRequest) => void): () => void;
  answerPermission(id: string, allow: boolean): Promise<void>;
  runCommand(worktreeId: string, cmd: string): Promise<{ out: string; code: number }>;
  diff(worktreeId: string): Promise<{ files: string; patch: string }>;
  openExternal(url: string): Promise<void>;
  setAppearance(a: Partial<Appearance>): Promise<void>;
  repoInfo(projectId: string): Promise<RepoInfo>;
  authStatus(provider: Provider): Promise<{ loggedIn: boolean; detail: string }>;
};

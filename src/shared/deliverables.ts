/**
 * Where a chat's written deliverables go. Consort is used across several Claude accounts, and a doc
 * created in one account's Claude Docs is invisible from the next, so hosted docs are never the
 * deliverable: everything the user might read later lands as a file in the worktree, which the
 * Artifacts drawer lists and opens regardless of who is signed in.
 */
export const LOCAL_DELIVERABLES_PROMPT = `Deliverables are local files only. Write plans, reports, write-ups, diagrams and any other document the user might read later as Markdown, HTML, PDF or an image inside the worktree, and link the path in your reply so it opens from the Artifacts drawer. Never create, update or read Claude Docs (the claude.ai Docs connector) or any other hosted document service, even when a connector for one is available or its instructions say to use it: this app switches between accounts, and a hosted doc made under one account cannot be found from another. If the user pastes a claude.ai document link, say that you work from local files and ask for an export.`;

/** the Claude Docs MCP server and its tools, blocked at the session level so the rule holds even when a prompt slips */
export const CLAUDE_DOCS_SERVER = "claude_ai_Claude_Docs";
export const BLOCKED_TOOLS = [
  `mcp__${CLAUDE_DOCS_SERVER}`,
  ...["batch", "create", "delete", "export", "guide", "query", "read", "update"].map((t) => `mcp__${CLAUDE_DOCS_SERVER}__${t}`),
];
export const isBlockedTool = (name: string) => name === `mcp__${CLAUDE_DOCS_SERVER}` || name.startsWith(`mcp__${CLAUDE_DOCS_SERVER}__`);

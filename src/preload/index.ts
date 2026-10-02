import { contextBridge, ipcRenderer, webUtils } from "electron";

const invoke = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(name, ...args);
const on = (channel: string) => (cb: (x: any) => void) => {
  const l = (_e: unknown, x: any) => cb(x);
  ipcRenderer.on(channel, l);
  return () => ipcRenderer.removeListener(channel, l);
};

const methods = [
  "resumeQueue", "removeQueuedMessage",
  "getState", "openRootWorktree", "rootStatus", "rootBranches", "switchRootBranch", "checkoutAtRoot", "commitAndPushRoot", "commitWorktree", "pushWorktree", "pullWorktree", "createPr", "setActiveChat", "pickFolder", "addProject", "removeProject", "setProjectBase", "syncWorktrees", "addWorktree",
  "removeWorktree", "readNotes", "writeNotes", "worktreeStatus", "addWorkspace", "workspaceStatus", "commitWorkspace", "pullWorkspace", "pushWorkspace", "createWorkspacePrs", "addChat", "addScratchChat", "renameChat", "deleteChat", "chatMenu", "askSide", "clearSide", "setAutoApprove", "setPhase",
  "send", "stop", "addKey", "renameKey", "removeKey", "setOpenRouterKey", "answerPermission", "runCommand", "addQuickAction", "setQuickActionPinned", "deleteQuickAction", "diff", "skillPrompt", "issuePrompt", "pickFiles", "stageBlob", "setChatKey", "setDefaultKey", "setAutopilot", "switchAgent", "continueChat", "renameWorktree", "archiveWorktree", "autoTitle", "openExternal", "artifactMenu", "previewArtifact", "setAppearance", "setInstructions", "installClaudePlugin", "installCodexSkill", "refreshModels", "cliStatus", "updateClis", "effectiveTheme", "repoInfo", "listFiles", "readFile", "writeFile", "authStatus", "authLoginCmd", "connectorUsage", "commitInfo", "commit", "suggestCommit", "suggestPr", "commitChat", "ptyCreate", "ptyWrite", "ptyResize", "ptyKill", "ptySeen", "ptySeenScope", "ptys",
  "switchSeat", "refreshSeats", "shipStart", "prLookup", "investigateStart", "shipCommand", "shipRun", "setShipAutoApprove", "setClickUpKey", "setBranchPrefix", "clearChat", "listCommands", "setShowToolCalls", "setChatToolCalls",
  "readReview", "findReview", "updateReviewFinding", "submitReview", "queueAllFindings", "reviewDrift", "reinvestigateFinding", "fixFinding", "watchReview", "unwatchReview",
];
contextBridge.exposeInMainWorld("ade", {
  ...Object.fromEntries(methods.map((m) => [m, invoke(m)])),
  onState: on("state"),
  onOpenChat: on("openChat"),
  onOpenScope: on("openScope"),
  onPermission: on("permission"),
  onPtyData: on("pty:data"),
  onPtys: on("ptys"),
  onTheme: on("theme"),
  onReviewChanged: on("reviewChanged"),
  onToast: on("toast"),
  pathsFor: (files: File[]) => files.map((f) => webUtils.getPathForFile(f)),
});

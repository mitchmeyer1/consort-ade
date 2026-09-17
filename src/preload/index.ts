import { contextBridge, ipcRenderer, webUtils } from "electron";

const invoke = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(name, ...args);
const on = (channel: string) => (cb: (x: any) => void) => {
  const l = (_e: unknown, x: any) => cb(x);
  ipcRenderer.on(channel, l);
  return () => ipcRenderer.removeListener(channel, l);
};

const methods = [
  "getState", "openRootWorktree", "rootStatus", "rootBranches", "switchRootBranch", "checkoutAtRoot", "commitAndPushRoot", "commitWorktree", "pushWorktree", "setActiveChat", "pickFolder", "addProject", "removeProject", "setProjectBase", "syncWorktrees", "addWorktree",
  "removeWorktree", "worktreeStatus", "addChat", "renameChat", "deleteChat", "setAutoApprove", "setPhase",
  "send", "stop", "addKey", "removeKey", "answerPermission", "runCommand", "diff", "skillPrompt", "pickFiles", "stageBlob", "setChatKey", "setKeyPhi", "setPhiMode", "switchAgent", "continueChat", "renameWorktree", "archiveWorktree", "autoTitle", "openExternal", "artifactMenu", "previewArtifact", "setAppearance", "effectiveTheme", "repoInfo", "listFiles", "readFile", "writeFile", "authStatus", "authLoginCmd", "commitInfo", "commit", "suggestCommit", "commitChat", "ptyCreate", "ptyWrite", "ptyResize", "ptyKill", "ptySeen", "ptys",
];
contextBridge.exposeInMainWorld("ade", {
  ...Object.fromEntries(methods.map((m) => [m, invoke(m)])),
  onState: on("state"),
  onOpenChat: on("openChat"),
  onPermission: on("permission"),
  onPtyData: on("pty:data"),
  onPtys: on("ptys"),
  onTheme: on("theme"),
  pathsFor: (files: File[]) => files.map((f) => webUtils.getPathForFile(f)),
});

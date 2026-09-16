import { contextBridge, ipcRenderer, webUtils } from "electron";

const invoke = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(name, ...args);
const on = (channel: string) => (cb: (x: any) => void) => {
  const l = (_e: unknown, x: any) => cb(x);
  ipcRenderer.on(channel, l);
  return () => ipcRenderer.removeListener(channel, l);
};

const methods = [
  "getState", "openRootWorktree", "rootStatus", "checkoutAtRoot", "commitWorktree", "pushWorktree", "setActiveChat", "pickFolder", "addProject", "removeProject", "setProjectBase", "syncWorktrees", "addWorktree",
  "removeWorktree", "worktreeStatus", "addChat", "renameChat", "deleteChat", "setAutoApprove", "setPhase",
  "send", "stop", "addKey", "removeKey", "answerPermission", "runCommand", "diff", "skillPrompt", "pickFiles", "setChatKey", "setKeyPhi", "setPhiMode", "renameWorktree", "archiveWorktree", "autoTitle", "openExternal", "artifactMenu", "previewArtifact", "setAppearance", "repoInfo", "listFiles", "readFile", "writeFile", "authStatus", "jobStart", "jobStop", "jobWrite", "jobRemove", "jobSeen", "jobs",
];
contextBridge.exposeInMainWorld("ade", {
  ...Object.fromEntries(methods.map((m) => [m, invoke(m)])),
  onState: on("state"),
  onOpenChat: on("openChat"),
  onPermission: on("permission"),
  onJobs: on("jobs"),
  pathsFor: (files: File[]) => files.map((f) => webUtils.getPathForFile(f)),
});

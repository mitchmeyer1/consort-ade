import { pathToFileURL } from "node:url";

export type BrowserInfo = { path: string; name: string } | undefined;

/**
 * "Open in Browser" for a local file. Launch Services keys the default app on the file's
 * type, so a .md or .html would land in an editor; instead the app that handles https://
 * (Electron reports it) is launched with the file. Where that lookup is unavailable, the
 * caller falls back to the system opener for the file URL.
 */
export function browserLaunch(platform: NodeJS.Platform, browser: BrowserInfo, file: string): { cmd: string; args: string[] } | null {
  if (!browser?.path) return null;
  if (platform === "darwin") return { cmd: "/usr/bin/open", args: ["-a", browser.path, file] };
  if (platform === "win32") return { cmd: browser.path, args: [pathToFileURL(file).href] };
  return null;
}

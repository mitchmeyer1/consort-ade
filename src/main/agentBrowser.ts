import { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startScreenshotBridge } from "./screenshotBridge";

// Each capture uses an isolated browser: no access to the ADE's session or Node APIs.
export async function startAgentBrowser(cwd: string, signal: AbortSignal) {
  const windows = new Set<BrowserWindow>();
  const closeWindows = () => { for (const window of windows) if (!window.isDestroyed()) window.destroy(); };
  signal.addEventListener("abort", closeWindows, { once: true });
  try {
    const bridge = await startScreenshotBridge(cwd, async ({ url, width, height }) => {
      if (signal.aborted) throw new Error("Agent stopped");
      const window = new BrowserWindow({
        show: false, width, height, useContentSize: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `consort-capture-${randomUUID()}`, backgroundThrottling: false },
      });
      windows.add(window);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      window.webContents.session.on("will-download", (event) => event.preventDefault());
      const timeout = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 30_000);
      try {
        await window.loadURL(url);
        await window.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))");
        const png = (await window.webContents.capturePage()).toPNG();
        if (!png.length) throw new Error("Browser returned an empty screenshot");
        const dir = join(cwd, ".consort", "screenshots");
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${randomUUID()}.png`);
        await writeFile(path, png);
        return path;
      } finally {
        clearTimeout(timeout);
        windows.delete(window);
        if (!window.isDestroyed()) window.destroy();
      }
    });
    return { ...bridge, close: async () => {
      signal.removeEventListener("abort", closeWindows);
      closeWindows();
      await bridge.close();
    } };
  } catch (error) {
    signal.removeEventListener("abort", closeWindows);
    throw error;
  }
}

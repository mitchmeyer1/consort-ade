import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, desktopCapturer, screen, systemPreferences } from "electron";
import { parseAutopilotAction, type AutopilotAction, type AutopilotScan, type AutopilotTarget } from "../shared/autopilot";
import { startAutopilotOverlay } from "./autopilotOverlay";
import { chooseWithJev } from "./jevNavigator";

const runAppleScript = (lines: string[], args: string[] = []) => new Promise<void>((resolve, reject) => {
  execFile("/usr/bin/osascript", lines.flatMap((line) => ["-e", line]).concat(args.length ? ["--", ...args] : []), { timeout: 10_000 }, (error, stdout, stderr) => {
    if (!error) return resolve();
    reject(new Error(String(stderr || stdout || error.message).trim()));
  });
});

const runFile = (file: string, args: string[]) => new Promise<string>((resolve, reject) => {
  execFile(file, args, { timeout: 15_000, maxBuffer: 4 << 20 }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    reject(new Error(String(stderr || stdout || error.message).trim()));
  });
});

const keyCodes: Record<string, number> = { return: 36, escape: 53, tab: 48, space: 49, delete: 51, left: 123, right: 124, down: 125, up: 126 };
const commandKeys: Record<string, number> = { "cmd+a": 0, "cmd+c": 8, "cmd+v": 9, "cmd+l": 37, "cmd+s": 1, "cmd+t": 17, "cmd+w": 13 };

type InputAction = Extract<AutopilotAction, { action: "activate" | "click" | "type" | "key" }>;
async function perform(action: InputAction) {
  if (process.platform !== "darwin") throw new Error("Autopilot input currently requires macOS");
  try {
    if (action.action === "activate") {
      await runAppleScript(["on run argv", "tell application (item 1 of argv) to activate", "end run"], [action.app]);
    } else if (action.action === "click") {
      await runAppleScript([`tell application "System Events" to click at {${action.x}, ${action.y}}`]);
    } else if (action.action === "type") {
      await runAppleScript(["on run argv", 'tell application "System Events" to keystroke (item 1 of argv)', "end run"], [action.text]);
    } else if (action.key in commandKeys) {
      await runAppleScript([`tell application "System Events" to key code ${commandKeys[action.key]} using command down`]);
    } else {
      await runAppleScript([`tell application "System Events" to key code ${keyCodes[action.key]}`]);
    }
  } catch (error) {
    const message = (error as Error).message;
    if (/not authorized|not allowed|assistive access|1002|1743/i.test(message)) throw new Error("macOS blocked desktop input. Enable this exact Consort app in Privacy & Security → Accessibility and Automation, then relaunch it.");
    throw error;
  }
}

export async function startAutopilotBridge(cwd: string, signal: AbortSignal, enabled: () => boolean, openRouterKey: () => string, onStop: () => void) {
  const token = randomUUID();
  const dir = join(cwd, ".consort", "autopilot");
  const helperDir = join(cwd, ".consort", "tools");
  const helper = join(helperDir, `autopilot-${token}.cjs`);
  let busy = false;
  let currentScan: AutopilotScan | undefined;
  const capture = async () => {
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") throw new Error("Enable Consort in System Settings → Privacy & Security → Screen Recording, then try again");
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }, fetchWindowIcons: false });
    const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error("No desktop image was available; check Screen Recording permission");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.png`);
    await writeFile(path, source.thumbnail.toPNG());
    return { path, display, imageSize: source.thumbnail.getSize() };
  };
  const observe = async () => (await capture()).path;
  const scan = async (): Promise<AutopilotScan> => {
    if (process.platform !== "darwin") throw new Error("Local OCR currently requires macOS");
    const { path, display, imageSize } = await capture();
    const binary = join(app.getAppPath(), "native", "bin", "consort-vision");
    let raw: Array<{ text: string; confidence: number; box: { x: number; y: number; width: number; height: number } }>;
    try { raw = JSON.parse(await runFile(binary, [path])); }
    catch (visionError) {
      const tesseract = ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract", "/usr/bin/tesseract"].find(existsSync);
      if (!tesseract) throw new Error(`Local OCR failed (${binary}): ${(visionError as Error).message}`);
      try {
        const rows = (await runFile(tesseract, [path, "stdout", "tsv"])).trim().split("\n").slice(1);
        raw = rows.map((line) => line.split("\t")).filter((cols) => cols.length >= 12 && cols[11].trim() && Number(cols[10]) >= 25).map((cols) => ({
          text: cols[11], confidence: Number(cols[10]) / 100,
          box: { x: Number(cols[6]) / imageSize.width, y: 1 - (Number(cols[7]) + Number(cols[9])) / imageSize.height, width: Number(cols[8]) / imageSize.width, height: Number(cols[9]) / imageSize.height },
        }));
      } catch (fallbackError) { throw new Error(`Local OCR failed with Apple Vision (${(visionError as Error).message}) and Tesseract (${(fallbackError as Error).message})`); }
    }
    const generation = randomUUID();
    const bounds = display.bounds;
    const targets: AutopilotTarget[] = raw
      .filter((item) => item.text.trim() && item.confidence >= 0.25 && item.box.width > 0 && item.box.height > 0)
      .slice(0, 500)
      .map((item, index) => {
        const frame = {
          x: Math.round(bounds.x + item.box.x * bounds.width),
          y: Math.round(bounds.y + (1 - item.box.y - item.box.height) * bounds.height),
          width: Math.max(1, Math.round(item.box.width * bounds.width)),
          height: Math.max(1, Math.round(item.box.height * bounds.height)),
        };
        return { id: `ocr-${index + 1}`, source: "ocr", text: item.text.trim(), confidence: item.confidence, frame, center: { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) } };
      });
    currentScan = { generation, capturedAt: Date.now(), screenshot: path, display: { id: display.id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, scaleFactor: display.scaleFactor }, targets };
    return currentScan;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.writeHead(403).end(JSON.stringify({ error: "Forbidden" })); return; }
    if (req.method !== "POST" || !["/action", "/decide"].includes(req.url ?? "")) { res.writeHead(404).end(JSON.stringify({ error: "Not found" })); return; }
    if (!enabled()) { res.writeHead(403).end(JSON.stringify({ error: "Autopilot was turned off" })); return; }
    if (busy) { res.writeHead(409).end(JSON.stringify({ error: "Another Autopilot action is running" })); return; }
    busy = true;
    try {
      let body = "";
      for await (const chunk of req) { body += chunk; if (body.length > 16_384) throw new Error("Request too large"); }
      const parsed = JSON.parse(body);
      if (req.url === "/decide") {
        res.end(JSON.stringify(await chooseWithJev(openRouterKey(), parsed)));
        return;
      }
      const action = parseAutopilotAction(parsed);
      if (action.action === "observe") res.end(JSON.stringify({ path: await observe() }));
      else if (action.action === "scan") res.end(JSON.stringify(await scan()));
      else if (action.action === "clickTarget") {
        if (!currentScan || currentScan.generation !== action.generation) throw new Error("That target map is no longer current; scan again");
        if (Date.now() - currentScan.capturedAt > 15_000) throw new Error("That target map is stale; scan again");
        const target = currentScan.targets.find((item) => item.id === action.target);
        if (!target) throw new Error(`Unknown target ${action.target}; scan again`);
        await perform({ action: "click", x: target.center.x, y: target.center.y });
        currentScan = undefined;
        res.end(JSON.stringify({ ok: true, clicked: target }));
      } else { await perform(action); currentScan = undefined; res.end(JSON.stringify({ ok: true })); }
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: (error as Error).message })); }
    finally { busy = false; }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  const overlay = startAutopilotOverlay(onStop);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    overlay.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(helper, { force: true });
  };
  signal.addEventListener("abort", () => { void close(); }, { once: true });
  await mkdir(helperDir, { recursive: true });
  await writeFile(helper, `// Generated by Consort; valid only for this opted-in turn.\n(async () => {\n  const fs = require('node:fs');\n  const [action, ...args] = process.argv.slice(2);\n  const deciding = action === 'decide';\n  const body = deciding ? JSON.parse(fs.readFileSync(args[0], 'utf8')) : action === 'observe' || action === 'scan' ? { action } : action === 'activate' ? { action, app: args.join(' ') } : action === 'click' ? { action, x: Number(args[0]), y: Number(args[1]) } : action === 'click-target' ? { action: 'clickTarget', target: args[0], generation: args[1] } : action === 'type' ? { action, text: args.join(' ') } : action === 'key' ? { action, key: args[0] } : {};\n  const response = await fetch('http://127.0.0.1:${port}' + (deciding ? '/decide' : '/action'), { method: 'POST', headers: { Authorization: 'Bearer ${token}', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });\n  const result = await response.json();\n  if (!response.ok) throw new Error(result.error);\n  console.log(typeof result === 'object' && !result.path ? JSON.stringify(result, null, 2) : result.path || 'ok');\n})().catch(error => { console.error(error.message); process.exitCode = 1; });\n`, { mode: 0o600 });
  const command = `node '${helper.replaceAll("'", "'\\''")}'`;
  const jev = openRouterKey() ? `The dedicated OpenRouter key is configured. Write a small navigator-state JSON file containing goal, currentStep, progress, screen, lastResult, and 2–50 candidate {id,description} actions, then run \`${command} decide FILE\` to let Jev select one; confidence below 0.75 escalates automatically.` : "The dedicated OpenRouter key is not configured, so Jev decisions are unavailable; do not claim Jev is driving this turn.";
  return { close, prompt: `Desktop Autopilot is enabled by the user for this turn. Prefer \`${command} scan\` to capture the primary display and return local OCR text targets with ids, confidence, frames, and a generation. Click a current target with \`${command} click-target TARGET GENERATION\`; target maps expire after 15 seconds and after any input. ${jev} Use \`${command} observe\` only when visual inspection is necessary. Other actions are \`${command} activate "App Name"\`, \`${command} click X Y\`, \`${command} type "text"\`, and \`${command} key KEY\` where KEY is return, escape, tab, space, delete, an arrow, or cmd+a/c/v/l/s/w. Prefer known shortcuts and target ids over raw coordinates. The user can disable Autopilot or press Stop at any time.` };
}

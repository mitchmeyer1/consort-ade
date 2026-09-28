import { BrowserWindow, screen } from "electron";
import { autopilotBorderHtml, autopilotOverlayGeometry, autopilotStopHtml } from "../shared/autopilotOverlay";

const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export function startAutopilotOverlay(onStop: () => void) {
  const display = screen.getPrimaryDisplay();
  const geometry = autopilotOverlayGeometry(display.bounds);
  const edges = geometry.edges.map((bounds) => {
    const edge = new BrowserWindow({
      ...bounds,
      frame: false, transparent: true, backgroundColor: "#00000000", focusable: false,
      hasShadow: false, resizable: false, movable: false, skipTaskbar: true, show: false,
      enableLargerThanScreen: true, roundedCorners: false, fullscreenable: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    edge.setAlwaysOnTop(true, "floating");
    edge.setIgnoreMouseEvents(true, { forward: true });
    void edge.loadURL(dataUrl(autopilotBorderHtml())).then(() => edge.showInactive());
    return edge;
  });

  const stop = new BrowserWindow({
    ...geometry.stop,
    frame: false, transparent: true, backgroundColor: "#00000000", focusable: true,
    hasShadow: false, resizable: false, movable: false, skipTaskbar: true, show: false,
    enableLargerThanScreen: true, roundedCorners: false, fullscreenable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  stop.setAlwaysOnTop(true, "floating");
  stop.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("consort-autopilot-stop:")) return;
    event.preventDefault();
    onStop();
  });
  void stop.loadURL(dataUrl(autopilotStopHtml())).then(() => stop.showInactive());

  const syncBounds = () => {
    const next = autopilotOverlayGeometry(screen.getPrimaryDisplay().bounds);
    edges.forEach((edge, index) => { if (!edge.isDestroyed()) edge.setBounds(next.edges[index], false); });
    if (!stop.isDestroyed()) stop.setBounds(next.stop, false);
  };
  screen.on("display-metrics-changed", syncBounds);
  screen.on("display-added", syncBounds);
  screen.on("display-removed", syncBounds);

  return { close() {
    screen.off("display-metrics-changed", syncBounds);
    screen.off("display-added", syncBounds);
    screen.off("display-removed", syncBounds);
    for (const edge of edges) if (!edge.isDestroyed()) edge.destroy();
    if (!stop.isDestroyed()) stop.destroy();
  } };
}

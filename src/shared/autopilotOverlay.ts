export const AUTOPILOT_BLUE = "#168cff";

export type DisplayRect = { x: number; y: number; width: number; height: number };

export function autopilotOverlayGeometry(bounds: DisplayRect) {
  const edge = 5, stopWidth = 172, stopHeight = 58, margin = 18;
  return {
    edges: [
      { x: bounds.x, y: bounds.y, width: bounds.width, height: edge },
      { x: bounds.x, y: bounds.y + bounds.height - edge, width: bounds.width, height: edge },
      { x: bounds.x, y: bounds.y + edge, width: edge, height: Math.max(1, bounds.height - edge * 2) },
      { x: bounds.x + bounds.width - edge, y: bounds.y + edge, width: edge, height: Math.max(1, bounds.height - edge * 2) },
    ],
    stop: {
      x: bounds.x + bounds.width - stopWidth - margin,
      y: bounds.y + bounds.height - stopHeight - margin,
      width: stopWidth,
      height: stopHeight,
    },
  };
}

const base = `html,body{width:100%;height:100%;margin:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}`;

export function autopilotBorderHtml() {
  return `<!doctype html><meta charset="utf-8"><style>${base}
  .edge{position:fixed;inset:0;background:${AUTOPILOT_BLUE};animation:pulse 1.65s ease-in-out infinite;box-shadow:0 0 12px rgba(22,140,255,.8)}
  @keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
  @media(prefers-reduced-motion:reduce){.edge{animation:none;opacity:.9}}</style><div class="edge" aria-hidden="true"></div>`;
}

export function autopilotStopHtml() {
  return `<!doctype html><meta charset="utf-8"><style>${base}
  body{display:flex;align-items:center;justify-content:center}
  button{height:42px;padding:0 18px;border:1px solid rgba(255,255,255,.55);border-radius:13px;background:${AUTOPILOT_BLUE};color:#fff;font-size:14px;font-weight:700;letter-spacing:.01em;box-shadow:0 0 0 3px rgba(22,140,255,.22),0 5px 24px rgba(0,72,160,.55);cursor:pointer;animation:pulse 1.65s ease-in-out infinite}
  button:hover{background:#329cff}button:active{transform:scale(.97)}button:focus-visible{outline:3px solid white;outline-offset:2px}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 3px rgba(22,140,255,.2),0 5px 18px rgba(0,72,160,.45)}50%{box-shadow:0 0 0 7px rgba(22,140,255,.3),0 5px 28px rgba(22,140,255,.75)}}
  @media(prefers-reduced-motion:reduce){button{animation:none}}</style><button type="button" onclick="location.href='consort-autopilot-stop://stop'" aria-label="Stop Consort Autopilot">Stop Consort</button>`;
}

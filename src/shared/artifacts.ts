import type { Block, Message } from "./types";

// Markdown renders explicit links as ordinary anchors, without artifact metadata.
export function artifactLinkAction(target: string): "artifact" | "external" | null {
  if (!target || target.startsWith("#")) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target.replace(/:\d+(?::\d+)?$/, ""))?.[1]?.toLowerCase();
  if (scheme === "http" || scheme === "https") {
    try { return /\.[a-z0-9]{1,10}$/i.test(new URL(target).pathname) ? "artifact" : "external"; }
    catch { return null; }
  }
  return !scheme || scheme === "file" ? "artifact" : null;
}

// Markdown destinations take precedence so paths with spaces remain intact.
export function artifactLinks(text: string) {
  const pattern = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)|(?:https?:\/\/|file:\/\/)[^\s<>`]+|(?:\/?[\w.@~-]+\/)*[\w.@-]+\.(?:md|txt|html?|pdf|png|jpe?g|gif|webp|svg|csv|json|tsx?|jsx?|py|docx|xlsx|pptx)\b(?::\d+(?::\d+)?)?/gi;
  return Array.from(text.matchAll(pattern), (m) => ({
    index: m.index!, length: m[0].length,
    label: m[1] ?? m[0], target: m[2] ? m[2].replace(/^<|>$/g, "") : m[0],
  }));
}

/**
 * Markdown images point at files the agent wrote (`![Flow](readme/img/flow.png)`), and the
 * renderer has no origin those paths resolve against, so the browser shows a broken image and
 * nothing to click. A local image becomes an artifact target the app loads through
 * previewArtifact and opens like any other file link; web images load on their own.
 */
export function localImageTarget(src: string | null | undefined): string | null {
  if (!src) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(src)?.[1]?.toLowerCase();
  if (scheme && scheme !== "file") return null;
  return src;
}

export type ChatArtifact = {
  label: string; target: string;
  /** when the assistant first linked the file (the message's timestamp) */
  linkedAt: number;
  /** the last message that linked it again, when the agent came back to the file */
  updatedAt: number;
};

const DAY = 86_400_000;
const clock = (at: number, locale?: string) => new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

/** "Today 5:12 PM" / "Yesterday 9:04 AM" / "Sep 21, 5:12 PM" / "Sep 21, 2025, 5:12 PM" for an artifact's timestamp */
export function artifactWhen(at: number, now: number, locale?: string): string {
  const d = new Date(at), n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(n) - startOf(d)) / DAY);
  if (days === 0) return `Today ${clock(at, locale)}`;
  if (days === 1) return `Yesterday ${clock(at, locale)}`;
  const date = d.toLocaleDateString(locale, { month: "short", day: "numeric", ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}) });
  return `${date}, ${clock(at, locale)}`;
}

/** a document the agent made during one message: a file it wrote, or a page an MCP tool handed back */
export type MadeArtifact = { label: string; target: string; remote: boolean };

/** documents, not source: a turn that edits twenty .ts files should not grow twenty buttons */
const DOC_FILE = /\.(?:md|markdown|txt|html?|pdf|png|jpe?g|gif|webp|svg|csv|json|docx|xlsx|pptx)$/i;
const WRITE_TOOLS = /^(?:write|edit|multiedit|notebookedit|create_file|str_replace_editor|str_replace_based_edit_tool)$/i;
/** `cat > plan.md <<EOF`, `pandoc … > out.pdf`: the shell's own way of producing a file */
const REDIRECT = /(?:^|\s)>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&<>]+))/g;
const PATH_LIKE = /(?:^|[\s"'`(])((?:\/|\.{1,2}\/|~\/)?[\w.@~-]+(?:\/[\w.@ -]+)*\.[A-Za-z0-9]{1,5})\b/g;
const MADE_LIMIT = 6;

const fileName = (p: string) => p.split(/[\\/]/).pop() || p;
/** `mcp__claude_ai_Claude_Docs__create` → `Claude Docs` */
const serverLabel = (tool: string) => tool.replace(/^mcp__/, "").split("__")[0].replace(/^claude_ai_/, "").replace(/_/g, " ").trim() || "Link";

/**
 * What one assistant message produced, so the response can end with a way to open it. Text links
 * are already clickable in the prose; this reads the tool calls, which is where a document written
 * by `Write`, a shell redirect, or an MCP page the model never pasted a link to would otherwise be lost.
 */
export function messageArtifacts(blocks: Block[]): MadeArtifact[] {
  const made = new Map<string, MadeArtifact>();
  const add = (target: string, label: string, remote: boolean) => {
    if (!target || made.has(target) || made.size >= MADE_LIMIT) return;
    made.set(target, { target, label, remote });
  };
  for (const b of blocks) {
    if (b.type !== "tool" || b.ok === false) continue;
    if (b.name.startsWith("mcp__")) {
      const out = b.output ?? "";
      const title = /"(?:name|title)"\s*:\s*"([^"\n]{1,80})"/.exec(out)?.[1];
      for (const url of out.match(/https?:\/\/[^\s"'<>)\]}]+/g) ?? []) add(url, title || serverLabel(b.name), true);
      continue;
    }
    const tool = b.name.replace(/^mcp__.*__/, "");
    if (WRITE_TOOLS.test(tool)) {
      // the Claude tools send JSON; Codex sends `add /path` lines, so fall back to scanning for paths
      let paths: string[] = [];
      try {
        const input = JSON.parse(b.input) as Record<string, unknown>;
        paths = [input.file_path, input.notebook_path, input.path].filter((v): v is string => typeof v === "string");
      } catch { paths = Array.from(b.input.matchAll(PATH_LIKE), (m) => m[1]); }
      for (const p of paths) if (DOC_FILE.test(p)) add(p, fileName(p), false);
    } else if (/^bash$/i.test(tool)) {
      for (const m of b.input.matchAll(REDIRECT)) {
        const p = m[1] ?? m[2] ?? m[3];
        if (p && DOC_FILE.test(p)) add(p, fileName(p), false);
      }
    }
  }
  return [...made.values()];
}

export function chatArtifacts(messages: Message[]): ChatArtifact[] {
  const files = new Map<string, ChatArtifact>();
  const record = (label: string, target: string, ts: number) => {
    const key = target.split("#")[0].replace(/:\d+(?::\d+)?$/, "");
    const seen = files.get(key);
    if (seen) seen.updatedAt = Math.max(seen.updatedAt, ts);
    else files.set(key, { label, target, linkedAt: ts, updatedAt: ts });
  };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    // a document the agent wrote but never linked in its prose belongs here too
    for (const { label, target } of messageArtifacts(message.blocks)) record(label, target, message.ts);
    for (const block of message.blocks) {
      if (block.type !== "text") continue;
      for (const { label, target } of artifactLinks(block.text)) {
        if (!target || target.startsWith("#")) continue;
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(target.replace(/:\d+(?::\d+)?$/, ""))?.[1]?.toLowerCase();
        if (scheme && !["file", "http", "https"].includes(scheme)) continue;
        // Ordinary web pages aren't file artifacts; web-hosted files are.
        if (scheme === "http" || scheme === "https") {
          try { if (!/\.[a-z0-9]{1,10}$/i.test(new URL(target).pathname)) continue; }
          catch { continue; }
        }
        record(label, target, message.ts);
      }
    }
  }
  // newest activity first, as a file browser sorted by "modified"; ties keep the order the files were first linked in
  return [...files.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * An HTML artifact renders inside a sandboxed iframe, where the app stylesheet never
 * reaches, so its scrollbar falls back to the platform default: a solid track and no
 * visible thumb over a dark page. Inject the same rules the chat uses (no track, a
 * shaded thumb) into the document before it is handed to the frame.
 */
export function frameScrollbarStyle(theme: "dark" | "light" = "dark") {
  const thumb = theme === "light" ? "rgba(20,19,17,.22)" : "rgba(243,234,214,.18)";
  const hover = theme === "light" ? "rgba(20,19,17,.36)" : "rgba(243,234,214,.32)";
  return `<style data-consort-scrollbars>::-webkit-scrollbar{width:9px;height:9px;background:transparent}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:${thumb};border-radius:3px;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-thumb:hover{background:${hover};background-clip:padding-box}::-webkit-scrollbar-corner{background:transparent}</style>`;
}

export function withFrameScrollbars(html: string, theme: "dark" | "light" = "dark") {
  const style = frameScrollbarStyle(theme);
  // after the document's own styles so it wins ties; fall back to prepending for fragments
  const head = /<\/head\s*>/i.exec(html);
  if (head) return html.slice(0, head.index) + style + html.slice(head.index);
  return style + html;
}

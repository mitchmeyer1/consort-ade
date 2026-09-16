import type { Message } from "./types";

// Markdown destinations take precedence so paths with spaces remain intact.
export function artifactLinks(text: string) {
  const pattern = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)|(?:https?:\/\/|file:\/\/)[^\s<>`]+|(?:\/?[\w.@~-]+\/)*[\w.@-]+\.(?:md|txt|html?|pdf|png|jpe?g|gif|webp|svg|csv|json|tsx?|jsx?|py|docx|xlsx|pptx)\b(?::\d+(?::\d+)?)?/gi;
  return Array.from(text.matchAll(pattern), (m) => ({
    index: m.index!, length: m[0].length,
    label: m[1] ?? m[0], target: m[2] ? m[2].replace(/^<|>$/g, "") : m[0],
  }));
}

export function chatArtifacts(messages: Message[]) {
  const files = new Map<string, { label: string; target: string }>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
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
        const key = target.split("#")[0].replace(/:\d+(?::\d+)?$/, "");
        if (!files.has(key)) files.set(key, { label, target });
      }
    }
  }
  return [...files.values()];
}

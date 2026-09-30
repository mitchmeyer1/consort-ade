/**
 * Codex's own catalog rows, as its backend serves them and as the CLI caches them in
 * CODEX_HOME/models_cache.json. Only rows Codex lists are offered ("hide" covers internal
 * ones like codex-auto-review), ordered the way Codex orders them.
 */
export type CodexCatalogRow = { slug?: unknown; visibility?: unknown; priority?: unknown };

export function listedCodexModels(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const listed: { slug: string; priority: number }[] = [];
  for (const m of rows as CodexCatalogRow[])
    if (typeof m?.slug === "string" && m.visibility === "list") listed.push({ slug: m.slug, priority: typeof m.priority === "number" ? m.priority : Number.MAX_SAFE_INTEGER });
  listed.sort((a, b) => a.priority - b.priority);
  return [...new Set(listed.map((m) => m.slug))];
}

/**
 * The OpenAI platform lists everything an API key can reach, most of it not for Codex:
 * embeddings, speech, images, moderation, dated snapshots. Keep the GPT and Codex chat
 * models, newest first.
 */
export type OpenAiModelRow = { id?: unknown; created?: unknown };
const NOT_FOR_CODEX = /realtime|audio|tts|transcri|whisper|image|embedding|moderation|search|instruct|-\d{4}-\d{2}-\d{2}$|-\d{4}$/;

export function openAiCodexModels(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const chat = (rows as OpenAiModelRow[])
    .filter((m) => typeof m?.id === "string" && /^(gpt-|codex)/.test(m.id) && !NOT_FOR_CODEX.test(m.id))
    .map((m) => ({ id: m.id as string, created: typeof m.created === "number" ? m.created : 0 }));
  chat.sort((a, b) => b.created - a.created);
  return [...new Set(chat.map((m) => m.id))];
}

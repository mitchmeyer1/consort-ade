/**
 * The Scratchpad: plain-text tabs at the bottom of the sidebar, for whatever the user wants to
 * jot. Not tied to a project or worktree; kept in Consort's own state (State.scratchpad) so
 * tabs, their text and which one is open survive a restart.
 */

export const SCRATCH_TEXT_MAX = 200_000;
export const SCRATCH_TITLE_MAX = 40;

export type ScratchTab = { id: string; title: string; text: string; at: number };
export type Scratchpad = { tabs: ScratchTab[]; activeId?: string };

export const emptyScratchpad = (): Scratchpad => ({ tabs: [] });

/** the next default title: "Note 1", "Note 2", … skipping ones already taken */
export function nextScratchTitle(pad: Scratchpad): string {
  const taken = new Set(pad.tabs.map((t) => t.title));
  for (let n = 1; ; n++) if (!taken.has(`Note ${n}`)) return `Note ${n}`;
}

/** Read what was saved: keep well-formed tabs, drop the rest, point the active tab at one that exists. */
export function normalizeScratchpad(raw: unknown): Scratchpad {
  const r = (raw ?? {}) as Partial<Scratchpad>;
  const seen = new Set<string>();
  const tabs: ScratchTab[] = [];
  for (const t of Array.isArray(r.tabs) ? (r.tabs as Partial<ScratchTab>[]) : []) {
    if (!t || typeof t.id !== "string" || !t.id || seen.has(t.id)) continue;
    seen.add(t.id);
    tabs.push({
      id: t.id,
      title: (typeof t.title === "string" ? t.title.trim() : "").slice(0, SCRATCH_TITLE_MAX) || `Note ${tabs.length + 1}`,
      text: (typeof t.text === "string" ? t.text : "").slice(0, SCRATCH_TEXT_MAX),
      at: typeof t.at === "number" ? t.at : 0,
    });
  }
  const activeId = tabs.some((t) => t.id === r.activeId) ? r.activeId : tabs[0]?.id;
  return { tabs, ...(activeId ? { activeId } : {}) };
}

export const addScratchTab = (pad: Scratchpad, id: string, at: number, title = nextScratchTitle(pad)): Scratchpad =>
  ({ tabs: [...pad.tabs, { id, title: title.slice(0, SCRATCH_TITLE_MAX) || nextScratchTitle(pad), text: "", at }], activeId: id });

/** Remove a tab; the one next to it (or the last) becomes active. */
export function removeScratchTab(pad: Scratchpad, id: string): Scratchpad {
  const i = pad.tabs.findIndex((t) => t.id === id);
  if (i < 0) return pad;
  const tabs = pad.tabs.filter((t) => t.id !== id);
  const active = pad.activeId === id ? tabs[Math.min(i, tabs.length - 1)]?.id : pad.activeId;
  return { tabs, ...(active ? { activeId: active } : {}) };
}

export const renameScratchTab = (pad: Scratchpad, id: string, title: string): Scratchpad => {
  const clean = title.trim().slice(0, SCRATCH_TITLE_MAX);
  return clean ? { ...pad, tabs: pad.tabs.map((t) => (t.id === id ? { ...t, title: clean } : t)) } : pad;
};

export const setScratchText = (pad: Scratchpad, id: string, text: string, at: number): Scratchpad =>
  ({ ...pad, tabs: pad.tabs.map((t) => (t.id === id ? { ...t, text: text.slice(0, SCRATCH_TEXT_MAX), at } : t)) });

export const activateScratchTab = (pad: Scratchpad, id: string): Scratchpad => (pad.tabs.some((t) => t.id === id) ? { ...pad, activeId: id } : pad);

export const activeScratchTab = (pad: Scratchpad): ScratchTab | undefined => pad.tabs.find((t) => t.id === pad.activeId) ?? pad.tabs[0];

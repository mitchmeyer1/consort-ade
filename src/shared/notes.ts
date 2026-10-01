/**
 * Notes on a worktree: a flat list of bullets kept in the worktree itself at
 * .consort/notes.json, outside git (the .consort/ directory is in the repo's info/exclude), so
 * they travel with the checkout rather than with Consort's state and vanish with it. One note
 * can be pinned; its text is mirrored onto the worktree record (Worktree.note) so the sidebar
 * can show it beside the branch without reading every worktree's file.
 */

export const NOTES_FILE = ".consort/notes.json";
export const NOTE_MAX = 2_000;

export type Note = { id: string; text: string; at: number; pinned?: true };
export type NotesDoc = { version: 1; notes: Note[] };

export const emptyNotes = (): NotesDoc => ({ version: 1, notes: [] });

/** Read the file the way a review file is read: keep what is well formed, drop the rest, never throw. */
export function parseNotes(raw: unknown): NotesDoc {
  let value: unknown = raw;
  if (typeof raw === "string") { try { value = JSON.parse(raw); } catch { return emptyNotes(); } }
  const list = (value as { notes?: unknown } | undefined)?.notes;
  if (!Array.isArray(list)) return emptyNotes();
  const seen = new Set<string>();
  const notes: Note[] = [];
  let pinnedSeen = false;
  for (const n of list as Partial<Note>[]) {
    if (!n || typeof n.id !== "string" || typeof n.text !== "string" || seen.has(n.id)) continue;
    const text = n.text.trim().slice(0, NOTE_MAX);
    if (!text) continue;
    seen.add(n.id);
    const pinned = n.pinned === true && !pinnedSeen;
    if (pinned) pinnedSeen = true;
    notes.push({ id: n.id, text, at: typeof n.at === "number" ? n.at : 0, ...(pinned ? { pinned: true } : {}) });
  }
  return { version: 1, notes };
}

export const serializeNotes = (doc: NotesDoc) => `${JSON.stringify(doc, null, 2)}\n`;

export function addNote(doc: NotesDoc, id: string, text: string, at: number): NotesDoc {
  const clean = text.trim().slice(0, NOTE_MAX);
  if (!clean) return doc;
  return { version: 1, notes: [...doc.notes, { id, text: clean, at }] };
}

export const removeNote = (doc: NotesDoc, id: string): NotesDoc => ({ version: 1, notes: doc.notes.filter((n) => n.id !== id) });

export function editNote(doc: NotesDoc, id: string, text: string): NotesDoc {
  const clean = text.trim().slice(0, NOTE_MAX);
  if (!clean) return removeNote(doc, id);
  return { version: 1, notes: doc.notes.map((n) => (n.id === id ? { ...n, text: clean } : n)) };
}

/** Pin one note; pinning another moves the pin. Pinning the pinned note again unpins it. */
export function pinNote(doc: NotesDoc, id: string): NotesDoc {
  const already = doc.notes.find((n) => n.id === id)?.pinned;
  return { version: 1, notes: doc.notes.map((n) => { const { pinned: _p, ...rest } = n; return n.id === id && !already ? { ...rest, pinned: true } : rest; }) };
}

export const pinnedNote = (doc: NotesDoc): Note | undefined => doc.notes.find((n) => n.pinned);

/** the first line of a note, for the sidebar's hover and the pin's label */
export const noteSummary = (text: string, max = 140) => {
  const line = text.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

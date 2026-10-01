import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NOTES_FILE, parseNotes, pinnedNote, serializeNotes, type NotesDoc } from "../shared/notes";
import type { Worktree } from "../shared/types";

/**
 * The notes file of a worktree (shared/notes.ts): read and written in place, and kept out of
 * git by the repo's info/exclude, the same way the agent's .consort/ uploads are.
 */

export function readNotes(wt: Worktree): NotesDoc {
  try { return parseNotes(readFileSync(join(wt.path, NOTES_FILE), "utf8")); } catch { return parseNotes(undefined); }
}

export function writeNotes(wt: Worktree, doc: NotesDoc): NotesDoc {
  const clean = parseNotes(doc);
  const file = join(wt.path, NOTES_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeNotes(clean));
  excludeConsort(wt.path);
  return clean;
}

/** what the sidebar shows beside the branch: the pinned note's text, or nothing */
export const mirrorPin = (wt: Worktree, doc: NotesDoc) => { const pin = pinnedNote(doc)?.text; if (pin) wt.note = pin; else delete wt.note; };

// worktrees share the main repo's info/exclude; ask git where it is. A scratch folder has no git and is skipped.
function excludeConsort(cwd: string) {
  try {
    const ex = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    let cur = ""; try { cur = readFileSync(ex, "utf8"); } catch {}
    if (!cur.includes(".consort/")) appendFileSync(ex, "\n.consort/\n");
  } catch {}
}

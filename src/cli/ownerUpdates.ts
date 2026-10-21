/**
 * Owner updates: anything the owner posts in a task's Slack thread that is not a status question
 * or the answer to a pending question. The daemon saves the message and its files on the task;
 * the worker applies them between steps with one agent turn (revise the ticket, change the code),
 * then writes the revised description and the files back to the ClickUp task or GitHub issue.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHIP_DIR } from "../shared/ship.ts";

export type OwnerUpdate = { ts: string; text: string; files: string[]; failedFiles?: string[]; at: number };
export type SlackFile = { id?: string; name?: string; title?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string };

/** where an update's files and the revised ticket live, relative to the worktree */
export const updateDir = (ts: string) => `${SHIP_DIR}/updates/${ts.replace(/[^0-9.]/g, "")}`;

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 10;

/** "thanks", "ok 👍": nothing to apply, so no agent turn */
export function isAcknowledgement(text: string): boolean {
  const t = text.toLowerCase().replace(/<@[A-Z0-9]+>/gi, "").replace(/:[a-z0-9_+-]+:/g, "").replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ");
  return !t || /^(?:ok(?:ay)?|k|cool|nice|great|awesome|perfect|sounds good|got it|thanks?|thank you|thx|ty|lgtm|yep|yes|sure|(?:ok |cool |great )?(?:thanks?|thank you|thx|ty)(?: so much| a lot)?)$/.test(t);
}

export const safeFileName = (name: string) => name.replace(/[/\\\0]/g, "_").replace(/^\.+/, "_").replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "file";

/**
 * Save a message's files under the update's folder. Slack serves `url_private_download` only with
 * the files:read scope; without it the download comes back as Slack's HTML sign-in page.
 */
export async function downloadSlackFiles(token: string, files: SlackFile[], worktree: string, ts: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Promise<{ saved: string[]; failed: string[] }> {
  const saved: string[] = [], failed: string[] = [];
  const dir = updateDir(ts);
  for (const [i, f] of files.slice(0, MAX_FILES).entries()) {
    const name = safeFileName(f.name ?? f.title ?? `file-${i + 1}`);
    const url = f.url_private_download ?? f.url_private;
    if (!url) { failed.push(`${name}: Slack gave no download link`); continue; }
    if ((f.size ?? 0) > MAX_FILE_BYTES) { failed.push(`${name}: larger than 50 MB`); continue; }
    try {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (/text\/html/i.test(res.headers.get("content-type") ?? "") && !/html/i.test(f.mimetype ?? "")) throw new Error("the Slack app needs the files:read scope");
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > MAX_FILE_BYTES) throw new Error("larger than 50 MB");
      mkdirSync(join(worktree, dir), { recursive: true });
      const rel = `${dir}/${saved.includes(`${dir}/${name}`) ? `${i + 1}-${name}` : name}`;
      writeFileSync(join(worktree, rel), body);
      saved.push(rel);
    } catch (e) { failed.push(`${name}: ${(e as Error).message}`); }
  }
  for (const f of files.slice(MAX_FILES)) failed.push(`${safeFileName(f.name ?? "file")}: more than ${MAX_FILES} files in one message`);
  return { saved, failed };
}

/** the one agent turn that applies queued updates; the revised ticket goes to `ticketFile` */
export function ownerUpdatePrompt(updates: OwnerUpdate[], o: { stage: string; built: boolean; prUrl?: string; ticketFile: string }): string {
  const messages = updates.map((u, i) => `### Update ${i + 1}\n${u.text.trim() || "(no text)"}\nAttached files: ${u.files.length ? u.files.join(", ") : "none"}${u.failedFiles?.length ? `\nFiles that could not be downloaded: ${u.failedFiles.join("; ")}` : ""}`).join("\n\n");
  const code = o.built || ["Implementing", "Ready to Test", "In Review"].includes(o.stage)
    ? `Code exists for this task. Change it to match the update, update .consort/ship/SPEC.md and the ticket files there, run the relevant tests and typecheck, and commit.${o.prUrl ? ` PR ${o.prUrl} is open: push the commits to it.` : ""}`
    : "No code is written yet. Update only the planning files in .consort/ship (SPEC.md, GRILLING.md, issues) so the next steps use the new requirements.";
  return `The owner posted an update about this task in the Slack thread. Current stage: ${o.stage}.

${messages}

Do this:
1. Read every update, every attached file (open PDFs, images and documents), .consort/ship/TICKET.md, and SPEC.md and GRILLING.md when present.
2. Write the full revised ticket description in Markdown to ${o.ticketFile}. It replaces the ticket's description, so keep every detail that is still true, change what the update changes, and add new requirements. Do not include the ticket title or Consort's metadata header. If the update does not change the requirements, write the current description unchanged.
3. ${code}
4. Never merge. If the update contradicts an earlier owner decision or would break a working business flow, return [ask-user: ...] and stop.
End with one line: [update-summary: what changed in the ticket and the code, under 30 words].`;
}

export const parseUpdateSummary = (text: string) => /\[update-summary:\s*([^\]]+)\]/i.exec(text)?.[1].trim();

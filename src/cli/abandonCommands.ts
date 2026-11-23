/** Task-chat commands are handled by Consort, never sent to a coding agent as feature feedback. */
const plain = (text: string) => text.toLowerCase().replace(/<@[A-Z0-9]+>/gi, "").replace(/[’']/g, "'").replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();

export function isAbandonRequest(text: string): boolean {
  const t = plain(text);
  if (t.length > 400 || /\b(?:don't|do not|never|not to)\b/.test(t)) return false;
  return /\b(?:abandon|discard|scrap) (?:this|it|the task|this task|the job|this job)\b/.test(t)
    || /\bkill (?:this (?:task|job|process) |it )?(?:and |then )?clean ?up\b/.test(t)
    || /^(?:please )?kill (?:this|it|the process|this process|this task|this job)$/.test(t);
}

export function abandonReply(text: string): "confirm" | "cancel" | undefined {
  const t = plain(text);
  if (/^(?:yes |confirm )abandon(?: this| it| this task)?$/.test(t)) return "confirm";
  if (/^(?:cancel abandon|cancel abandonment|no keep it|no keep this task)$/.test(t)) return "cancel";
  return undefined;
}

export const isAbandonCommand = (text: string) => isAbandonRequest(text) || !!abandonReply(text);

export type ChatDraft = { text: string; files: string[] };
const EMPTY: ChatDraft = { text: "", files: [] };

// Renderer-lifetime drafts survive navigation and component unmounts.
export class ChatDraftCache {
  private drafts = new Map<string, ChatDraft>();
  private listeners = new Set<() => void>();
  private pending = new Set<string>();
  get = (id: string): ChatDraft => this.drafts.get(id) ?? EMPTY;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  update(id: string, patch: Partial<ChatDraft>) {
    const draft = { ...this.get(id), ...patch };
    if (draft.text || draft.files.length) this.drafts.set(id, draft);
    else this.drafts.delete(id);
    this.listeners.forEach(listener => listener());
  }
  async submit(id: string, send: (draft: ChatDraft) => Promise<unknown>) {
    if (this.pending.has(id)) return;
    const draft = this.get(id);
    if (!draft.text.trim() && !draft.files.length) return;
    this.pending.add(id);
    try {
      await send(draft);
      // A slow submission must not clear edits made in the meantime.
      if (this.get(id) === draft) this.update(id, { text: "", files: [] });
    } finally {
      this.pending.delete(id);
    }
  }
}

export const chatDrafts = new ChatDraftCache();

/**
 * Renderer-lifetime scroll offsets for panes that unmount when you switch views, keyed by
 * view + tab + file so each chat's copy of a document keeps its own place.
 */
export class ScrollMemory {
  private tops = new Map<string, number>();
  get = (key: string) => this.tops.get(key);
  set(key: string, top: number) {
    if (top > 0) this.tops.set(key, top);
    else this.tops.delete(key);
  }
  forget(prefix: string) {
    for (const k of [...this.tops.keys()]) if (k === prefix || k.startsWith(prefix + "|")) this.tops.delete(k);
  }
  get size() { return this.tops.size; }
}

/**
 * A remembered offset can only be applied once the content is tall enough to reach it;
 * before that (a preview still loading, a file not yet read) the caller waits and retries.
 * The 1px slack absorbs fractional layout rounding.
 */
export const canRestore = (target: number, scrollHeight: number, clientHeight: number) =>
  target <= Math.max(0, scrollHeight - clientHeight) + 1;

export const scrollKey = (...parts: (string | undefined)[]) => parts.map((p) => p ?? "").join("|");

export const scrollMemory = new ScrollMemory();

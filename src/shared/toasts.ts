export type ToastKind = "loading" | "info" | "success" | "error";
/** open: what a click on the toast should show, when it stands in for a system notification */
export type Toast = { id: string; kind: ToastKind; text: string; detail?: string; open?: { chat?: string; scope?: string } };

type Timer = (fn: () => void, ms: number) => unknown;

/** how long a settled toast lingers: successes are glanceable, failures need reading */
export const TOAST_TTL: Record<Exclude<ToastKind, "loading">, number> = { info: 7000, success: 4000, error: 10_000 };

/**
 * Renderer-lifetime toasts for operations that take a moment, like adding or deleting a
 * worktree. A loading toast stays until the operation settles, then becomes a success or
 * error toast that dismisses itself. Snapshots are immutable so useSyncExternalStore can
 * compare them by identity.
 */
export class ToastStore {
  private items: Toast[] = [];
  private listeners = new Set<() => void>();
  private seq = 0;
  private timer: Timer;
  constructor(timer: Timer = (fn, ms) => setTimeout(fn, ms)) { this.timer = timer; }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  snapshot = () => this.items;

  private emit(next: Toast[]) {
    this.items = next;
    this.listeners.forEach((l) => l());
  }
  private upsert(toast: Toast) {
    const i = this.items.findIndex((t) => t.id === toast.id);
    this.emit(i < 0 ? [...this.items, toast] : this.items.map((t, j) => (j === i ? toast : t)));
    if (toast.kind !== "loading") this.timer(() => { if (this.items.find((t) => t.id === toast.id) === toast) this.dismiss(toast.id); }, TOAST_TTL[toast.kind]);
  }

  start(text: string, id = `toast-${++this.seq}`) { this.upsert({ id, kind: "loading", text }); return id; }
  /** a settled toast with no loading phase, for things that already happened */
  notify(kind: Exclude<ToastKind, "loading">, text: string, detail?: string, open?: Toast["open"]) { const id = `toast-${++this.seq}`; this.upsert({ id, kind, text, ...(detail ? { detail } : {}), ...(open ? { open } : {}) }); return id; }
  succeed(id: string, text: string) { this.upsert({ id, kind: "success", text }); }
  fail(id: string, text: string, detail?: string) { this.upsert({ id, kind: "error", text, ...(detail ? { detail } : {}) }); }
  dismiss(id: string) { if (this.items.some((t) => t.id === id)) this.emit(this.items.filter((t) => t.id !== id)); }

  /** Narrates a promise: loading while it runs, then success or the error's message. Resolves to whether it succeeded. */
  async track<T>(work: Promise<T>, text: { start: string; done: string; fail: string }): Promise<T | undefined> {
    const id = this.start(text.start);
    try {
      const result = await work;
      this.succeed(id, text.done);
      return result;
    } catch (e) {
      this.fail(id, text.fail, String((e as Error)?.message ?? e).split("\n")[0]);
      return undefined;
    }
  }
}

export const toasts = new ToastStore();

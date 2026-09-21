/**
 * Something the app wants to tell Mitch about: a chat that finished or needs him, a command
 * that ended, a permission waiting, a reminder due. Shown as a toast while Consort is the
 * active window, and as a system notification otherwise — the same text either way.
 */
export type NoticeKind = "info" | "success" | "error";
export type Notice = {
  title: string;
  body?: string;
  /** the chat or worktree/project to open when the notice is clicked */
  open?: { chat?: string; scope?: string };
  kind?: NoticeKind;
};

/**
 * Decides where a notice goes. `active` answers whether Consort is focused and visible right
 * now; a notice sent while it is goes to the in-app toast, otherwise to the system.
 */
export class Notifier {
  private active: () => boolean;
  private toast: (n: Notice) => void;
  private system: (n: Notice) => void;
  constructor(active: () => boolean, toast: (n: Notice) => void, system: (n: Notice) => void) {
    this.active = active; this.toast = toast; this.system = system;
  }
  show(notice: Notice) {
    if (this.active()) this.toast(notice);
    else this.system(notice);
  }
  /** true when a caller that builds its own richer system notification should toast instead */
  inApp() { return this.active(); }
}

import type { Notice } from "./notices";

/**
 * A new worktree gets the repo's dependencies installed for it, in a terminal of its own. It is
 * the one terminal run the user did not start, so it says so at both ends rather than appearing
 * as an unexplained running dot.
 *
 * It also ends differently from a command they typed. A long command they ran leaves an amber
 * dot in the sidebar meaning "this finished, come and look" — but a clean install is bookkeeping
 * with nothing in it to look at, so it leaves no mark at all. A failed one still does: that one
 * needs reading.
 */
export const SETUP_TERM = "install";
export const isSetupTerm = (termId: string) => termId === SETUP_TERM;

/** the worktree's dependencies are going in; the toast opens the terminal doing it */
export const setupStartNotice = (worktree: string, command: string, scopeId: string): Notice => ({
  title: `Setting up ${worktree}`,
  body: `${command} · click to watch it run`,
  open: { scope: scopeId },
  kind: "info",
});

/** the same run, finished. Success is a plain "ready"; failure names the exit code and asks to be opened. */
export const setupDoneNotice = (worktree: string, code: number, duration: string, scopeId: string): Notice =>
  code === 0
    ? { title: `${worktree} is ready`, body: `Dependencies installed in ${duration}`, open: { scope: scopeId }, kind: "success" }
    : { title: `Setup failed in ${worktree}`, body: `exit ${code} after ${duration} · open the terminal to see why`, open: { scope: scopeId }, kind: "error" };

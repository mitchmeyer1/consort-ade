/** Evidence can include long builds. Resume saved work before asking the owner to extend its budget. */
import { ProblemError } from "../shared/headless.ts";

export const EVIDENCE_TURN_MS = 90 * 60_000;
export const EVIDENCE_CHECK_MS = 30 * 60_000;
export class TurnTimeoutError extends ProblemError {}

export function staleEvidenceTimeout(questions: string[]): boolean {
  return questions.length === 1 && /Evidence blocked\. PR not handed off/.test(questions[0]) &&
    /The agent exceeded 15 minutes on one turn and was stopped/.test(questions[0]);
}

export async function resumeEvidenceTurn(
  label: string,
  run: (guidance: string) => Promise<string>,
  notify: (message: string) => Promise<unknown>,
): Promise<string> {
  let guidance = "";
  for (let attempt = 1; ; attempt++) {
    try { return await run(guidance); }
    catch (error) {
      if (!(error instanceof TurnTimeoutError)) throw error;
      if (attempt >= 3) throw new ProblemError({
        ...error.problem, where: "evidence", what: `${label} reached its time limit on three attempts`,
        tried: "Resumed saved evidence work twice; acceptance checks remain required",
        ask: "The automatic evidence time budget is exhausted. Reply 'retry' for another attempt, or 'pause' to stop here. I recommend retrying if the last progress shows the build or checks advancing.",
      });
      await notify(`✅ ${label} reached one turn's time limit; resuming saved files and completed checks (attempt ${attempt + 1}/3). No action needed from you.`);
      guidance = "The previous turn reached its time limit. Inspect existing evidence files, logs and running processes first. Continue unfinished work; reuse valid completed checks and captures. Do not restart the whole build or duplicate running commands. Finish the required acceptance checks; never treat a timeout as missing credentials or ask the owner about the timeout.";
    }
  }
}

/** Only transport failures and retryable HTTP responses resume without a human decision. */
export function transientEvidencePublication(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timed? ?out|ClickUp(?: attachment)?:? (?:429|5\d\d)\b|HTTP (?:429|5\d\d)\b/i.test(message);
}

export async function retryEvidencePublication<T>(
  publish: () => Promise<T>,
  notify: (message: string) => Promise<unknown>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await publish(); }
    catch (error) {
      if (!transientEvidencePublication(error)) throw error;
      if (attempt === 1 || attempt % 5 === 0) await notify("✅ Evidence passed verification. A network request failed while publishing it; retrying saved uploads and comments automatically. No action needed from you.");
      await wait(Math.min(attempt * 15_000, 60_000));
    }
  }
}

export function staleEvidenceNetworkQuestion(questions: string[]): boolean {
  return questions.length === 1 && /Evidence blocked\. PR not handed off/.test(questions[0]) &&
    /• Evidence was not accepted\n• fetch failed(?:\n|$)/.test(questions[0]);
}

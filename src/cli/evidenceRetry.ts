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

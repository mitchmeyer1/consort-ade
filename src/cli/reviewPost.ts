/**
 * Posting a review to GitHub from the CLI. The same approach as the desktop app (src/main/prReview.ts):
 * one review per post; past a handful of inline comments, open the review pending, add each comment
 * as its own thread, then submit, because GitHub times out on large single requests. Lines the
 * diff does not show fall into the body (shared/review.ts reviewPayload), so nothing is lost.
 */
import { spawn } from "node:child_process";
import { commentableLines, patchesToDiff, reviewPayload, type Finding, type Review, type ReviewEvent, type ReviewPayload } from "../shared/review.ts";
import { gateText, PiiWithheldError, type GateContext } from "./phiGate.ts";

export type Gh = (args: string[], cwd: string, input?: string) => Promise<string>;
export const realGh: Gh = (args, cwd, input) => new Promise((resolve, reject) => {
  const child = spawn("gh", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  const timer = setTimeout(() => child.kill(), 90_000);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  child.on("error", reject);
  child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(err.trim() || `gh exited ${code}`)); });
  child.stdin.end(input ?? "");
});

const INLINE_BATCH = 10;
const ADD_THREAD = `mutation($review: ID!, $path: String!, $line: Int!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $review, path: $path, line: $line, side: RIGHT, body: $body }) { thread { id } }
}`;

async function post(repo: string, pr: number, payload: ReviewPayload, cwd: string, gh: Gh): Promise<{ html_url?: string; id?: number }> {
  const reviews = `repos/${repo}/pulls/${pr}/reviews`;
  const send = (path: string, body: unknown) => gh(["api", "-X", "POST", path, "--input", "-"], cwd, JSON.stringify(body)).then((s) => JSON.parse(s));
  if (payload.comments.length <= INLINE_BATCH) return send(reviews, payload);
  const pending = await send(reviews, { commit_id: payload.commit_id, body: payload.body });
  try {
    for (const c of payload.comments) {
      const out = JSON.parse(await gh(["api", "graphql", "--input", "-"], cwd, JSON.stringify({ query: ADD_THREAD, variables: { review: String(pending.node_id), path: c.path, line: c.line, body: c.body } })));
      if (out.errors?.length) throw new Error(`${c.path}:${c.line}: ${out.errors[0].message}`);
    }
    return await send(`${reviews}/${pending.id}/events`, { event: payload.event, body: payload.body });
  } catch (e) {
    await gh(["api", "-X", "DELETE", `${reviews}/${pending.id}`], cwd).catch(() => undefined);
    throw e;
  }
}

/**
 * Post the findings as one review with the given verdict. GitHub refuses APPROVE and
 * REQUEST_CHANGES on your own PR; then it posts the same review as a COMMENT and says so. With
 * the PHI/PII guard on (`gate`), a review whose body or comments carry an identifier is not
 * posted at all: PiiWithheldError.
 */
export async function postReview(review: Review, findings: Finding[], event: ReviewEvent, body: string, cwd: string, gh: Gh = realGh, gate?: GateContext): Promise<{ url: string; event: ReviewEvent; inline: number; general: number }> {
  const compare = findings.length ? JSON.parse(await gh(["api", `repos/${review.repo}/compare/${review.base}...${review.head}?per_page=300`], cwd)) : { files: [] };
  const built = reviewPayload(review, findings, commentableLines(patchesToDiff(compare.files ?? [])), { event, body });
  if (!built) throw new Error("Nothing to post: no body and no comments.");
  const verdict = gate ? gateText("review", [built.payload.body, ...built.payload.comments.map((c) => c.body)].join("\n\n"), gate) : undefined;
  if (verdict && !verdict.ok) throw new PiiWithheldError("review", verdict.categories);
  try {
    const res = await post(review.repo, review.pr, built.payload, cwd, gh);
    return { url: String(res.html_url ?? review.url), event, inline: built.inline.length, general: built.general.length };
  } catch (e) {
    if (event === "COMMENT" || !/own pull request|Can not (?:approve|request changes)/i.test((e as Error).message)) throw e;
    const res = await post(review.repo, review.pr, { ...built.payload, event: "COMMENT", body: `${body}\n\n(GitHub does not allow ${event === "APPROVE" ? "approving" : "requesting changes on"} your own pull request, so this is posted as a comment.)` }, cwd, gh);
    return { url: String(res.html_url ?? review.url), event: "COMMENT", inline: built.inline.length, general: built.general.length };
  }
}

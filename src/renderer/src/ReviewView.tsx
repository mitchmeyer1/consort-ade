/**
 * The live viewer for a `*.review.json`: the review as a document, with a decision on every
 * finding. "Comment on PR" queues a finding; "Post" sends the queue as one GitHub review;
 * "Re-investigate" re-checks a finding against the PR's newer commits. The file on disk is
 * the state, so an agent rewriting it shows up here as it happens.
 */
import React, { useEffect, useRef, useState } from "react";
import type { Api, Finding, FindingStatus, Review, Worktree } from "../../shared/types";
import { CATEGORIES, CATEGORY_LABELS, EVENT_LABELS, REVIEW_EVENTS, SEVERITIES, SEVERITY_LABELS, allDecided, approvedFindings, groupFindings, reviewCounts, suggestedEvent, verifiedHead, type Category, type ReviewEvent, type Severity } from "../../shared/review";
import { toasts } from "../../shared/toasts";

const ade = (window as any).ade as Api;
const Ico = ({ n }: { n: string }) => <i className={`ico ico-${n}`} aria-hidden />;
const CATEGORY_ICONS: Record<Category, string> = { logic: "celtic", redundant: "grapes", style: "fleur", tests: "chalice", comments: "quill" };
const SEV: Record<Severity, string> = { critical: "crit", high: "high", medium: "med", low: "low" };
const short = (sha?: string | null) => (sha ?? "").slice(0, 7);
const STATUS_LABEL: Record<FindingStatus, string> = { pending: "undecided", approved: "queued", commented: "posted", ignored: "ignored", dropped: "dropped", fixing: "fixing locally" };
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "all" }, { key: "pending", label: "undecided" }, { key: "approved", label: "queued" },
  { key: "commented", label: "posted" }, { key: "ignored", label: "ignored" }, { key: "fixing", label: "fixing locally" }, { key: "dropped", label: "dropped" }, { key: "drifted", label: "changed on PR" },
];
const when = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };

type Filter = "all" | FindingStatus | "drifted";
type Drift = Awaited<ReturnType<Api["reviewDrift"]>>;
const EVENT_HELP: Record<ReviewEvent, string> = {
  COMMENT: "Submit general feedback without explicit approval.",
  APPROVE: "Submit feedback and approve merging these changes.",
  REQUEST_CHANGES: "Submit feedback that must be addressed before merging.",
};
const DECISION_LABEL: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

export function ReviewView({ worktree, path }: { worktree: Worktree; path: string }) {
  const [review, setReview] = useState<Review>();
  const [abs, setAbs] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [drift, setDrift] = useState<Drift>();
  const [investigating, setInvestigating] = useState<Set<string>>(() => new Set());
  /** the finding "Fix locally" was clicked on, while its dialog is open */
  const [fixing, setFixing] = useState<Finding>();
  const [filter, setFilter] = useState<Filter>("all");
  /** the finish panel: open with inline comments (all decided) or as a review-only submission */
  // `at` changes on every click so the panel scrolls back into view even when it is already open
  const [finish, setFinish] = useState<{ inline: boolean; at: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const announced = useRef<string | undefined>(undefined);

  const load = () => ade.readReview(worktree.id, path).then(({ path: p, review }) => { setAbs(p); setReview(review); setErr(undefined); }, (e) => setErr(e.message));
  const checkDrift = async (announce: boolean) => {
    setChecking(true);
    try {
      const d = await ade.reviewDrift(worktree.id, path);
      setDrift(d);
      const key = `${d.head}:${d.drifted.join(",")}`;
      if (announce || announced.current !== key) {
        announced.current = key;
        if (d.drifted.length) toasts.notify("success", `${d.drifted.length} finding${d.drifted.length === 1 ? "" : "s"} touch files changed on the PR since the review — consider re-investigating`);
        else if (announce) toasts.notify("success", "No finding's file has changed on the PR since it was checked");
      }
    } catch (e) {
      if (announce) toasts.notify("error", "Couldn't check the PR for new commits", (e as Error).message);
    } finally { setChecking(false); }
  };
  useEffect(() => {
    setReview(undefined); setErr(undefined); setDrift(undefined); announced.current = undefined;
    load();
    ade.watchReview(worktree.id, path).catch(() => {});
    void checkDrift(false);
    return () => { ade.unwatchReview(worktree.id, path).catch(() => {}); };
  }, [worktree.id, path]);
  useEffect(() => ade.onReviewChanged((changed) => { if (changed === abs) load(); }), [abs, worktree.id, path]);

  const decide = async (f: Finding, status: FindingStatus) => {
    const label = status === "approved" ? `${f.id} queued for the PR` : status === "ignored" ? `${f.id} ignored` : `${f.id} back to undecided`;
    const next = await toasts.track(ade.updateReviewFinding(worktree.id, path, f.id, { status }), { start: "Saving…", done: label, fail: `Couldn't update ${f.id}` });
    if (next) setReview(next);
  };
  const saveComment = async (f: Finding, comment: string) => {
    const next = await toasts.track(ade.updateReviewFinding(worktree.id, path, f.id, { comment }), { start: "Saving comment…", done: `${f.id} comment saved`, fail: `Couldn't save ${f.id}'s comment` });
    if (next) setReview(next);
  };
  const reinvestigate = async (f: Finding) => {
    setInvestigating((s) => new Set(s).add(f.id));
    const id = toasts.start(`Re-investigating ${f.id} against the PR's current commit…`);
    try {
      const { review: next, summary, head } = await ade.reinvestigateFinding(worktree.id, path, f.id);
      setReview(next);
      toasts.succeed(id, `${summary} (checked at ${short(head)})`);
      void checkDrift(false);
    } catch (e) { toasts.fail(id, `Re-investigation of ${f.id} failed`, (e as Error).message); }
    finally { setInvestigating((s) => { const n = new Set(s); n.delete(f.id); return n; }); }
  };
  const submit = async (opts: { event: ReviewEvent; body: string; inline: boolean; draft: boolean }) => {
    if (!review) return;
    const queued = opts.inline ? approvedFindings(review).length : 0;
    const what = opts.event === "COMMENT" && !opts.body.trim() && !opts.draft
      ? `Post ${queued} comment${queued === 1 ? "" : "s"} to PR #${review.pr}`
      : `${EVENT_LABELS[opts.event]} PR #${review.pr}${queued ? ` with ${queued} inline comment${queued === 1 ? "" : "s"}` : " with no inline comments"}${!opts.body.trim() && opts.draft ? " (AI writes the summary)" : ""}`;
    if (!confirm(`${what}?`)) return;
    setBusy(true);
    const id = toasts.start(`${what}…`);
    try {
      const { review: next, result } = await ade.submitReview(worktree.id, path, opts);
      setReview(next); setFinish(null);
      const n = result.inline.length + result.general.length;
      const parts = [`${EVENT_LABELS[result.event]} submitted on PR #${review.pr}${n ? ` with ${n} comment${n === 1 ? "" : "s"}` : ""}`];
      if (result.drafted) parts.push("summary drafted by AI");
      if (result.general.length) parts.push(`${result.general.length} listed in the body, not on a diff line`);
      if (result.headMoved) parts.push("the PR has newer commits, so GitHub may mark some outdated");
      toasts.succeed(id, parts.join(" · "));
      void checkDrift(false);
    } catch (e) { toasts.fail(id, `Couldn't submit the review on PR #${review.pr}`, (e as Error).message); }
    finally { setBusy(false); }
  };
  const quickPost = () => submit({ event: "COMMENT", body: "", inline: true, draft: false });

  if (err) return <div className="error">{err}</div>;
  if (!review) return <div className="m">loading…</div>;
  const counts = reviewCounts(review);
  const queued = counts.approved;
  const groups = groupFindings(review.findings);
  const drifted = new Set(drift?.drifted ?? []);
  const visible = (f: Finding) => filter === "all" || (filter === "drifted" ? drifted.has(f.id) : f.status === filter);
  const moved = !!drift?.head && !!review.head && drift.head !== review.head;
  const decided = allDecided(review);
  const showFinish = finish ?? (decided && !review.submissions.length && !dismissed ? { inline: true, at: 0 } : null);
  const decision = drift?.reviewDecision ? DECISION_LABEL[drift.reviewDecision] ?? drift.reviewDecision.toLowerCase().replace("_", " ") : "";
  const open = (url: string) => ade.openExternal(url);
  const openChat = (chatId: string) => window.dispatchEvent(new CustomEvent("consort-open-chat", { detail: chatId }));
  // hand the finding to the worktree's chat with whatever the user added; the toast is the way back to it
  const fixLocally = async (f: Finding, note: string) => {
    setFixing(undefined);
    const id = toasts.start(`Sending ${f.id} to the chat…`);
    try {
      const res = await ade.fixFinding(worktree.id, path, f.id, note);
      setReview(res.review);
      toasts.dismiss(id);
      toasts.notify("success", `${f.id} sent to ${res.chatName}${res.queued ? ", queued behind its current task" : ""}`, "Click to open the chat", { chat: res.chatId });
    } catch (e) {
      toasts.fail(id, `Couldn't start a fix for ${f.id}`, (e as Error).message);
    }
  };
  const count = (key: Filter) => key === "all" ? review.findings.length : key === "drifted" ? drifted.size : review.findings.filter((f) => f.status === key).length;
  const card = (f: Finding) => <FindingCard key={f.id} f={f} review={review} drifted={drifted.has(f.id)} liveHead={drift?.head ?? null} investigating={investigating.has(f.id)}
    onDecide={decide} onComment={saveComment} onReinvestigate={reinvestigate} onFix={setFixing} onOpen={open} onOpenChat={openChat} />;

  return (
    <div className="rv">
      {fixing && <FixDialog f={fixing} onCancel={() => setFixing(undefined)} onStart={(note) => fixLocally(fixing, note)} />}
      <div className="rv-eyebrow"><Ico n="star" />Reviewer's writeup</div>
      <h1 className="rv-title">{review.title}</h1>
      <p className="rv-subtitle">
        PR <a href={review.url} onClick={(e) => { e.preventDefault(); if (review.url) open(review.url); }}>#{review.pr}</a>
        {review.subtitle ? ` — ${review.subtitle}` : ""}
      </p>
      <div className="rv-meta">
        <span>review SHA <b>{short(review.head) || "?"}</b></span>
        <span>base <b>{short(review.base) || "?"}</b></span>
        {drift?.head && <span>PR now <b>{short(drift.head)}</b></span>}
        {review.stats && <span><b>{review.stats.files} files</b> · +{review.stats.additions} / −{review.stats.deletions}</span>}
        {(drift?.state ?? review.state) && <span>state <b>{(drift?.state ?? review.state)!.toLowerCase()}</b></span>}
        {decision && <span>review <b>{decision}</b></span>}
        {review.ci && <span>CI <b>{review.ci.status}</b></span>}
        {review.repo && <span>repo <b>{review.repo}</b></span>}
      </div>
      {moved && <div className="rv-banner">
        The PR has new commits since this review (now <b>{short(drift!.head)}</b>).
        {drifted.size ? ` ${drifted.size} finding${drifted.size === 1 ? "" : "s"} sit in files that changed — marked below.` : " No finding's file changed."}
        {" "}Comments pin to the commit each finding was checked at, so GitHub may show some as outdated.
      </div>}

      <div className="rv-actions">
        <div className="rv-chips">
          {FILTERS.filter((f) => f.key === "all" || f.key === "pending" || count(f.key) > 0).map((f) =>
            <button key={f.key} className={"rv-chip" + (filter === f.key ? " on" : "") + (f.key === "drifted" ? " drift" : "")} onClick={() => setFilter(f.key)}>{f.label} {count(f.key)}</button>)}
        </div>
        <div className="rv-buttons">
          <button disabled={checking} title="Ask GitHub whether the PR has new commits that touch any finding" onClick={() => checkDrift(true)}>{checking ? "Checking…" : "Check for changes"}</button>
          <button disabled={busy} title="Approve, comment on, or request changes to the PR without posting the queued comments inline" onClick={() => setFinish({ inline: false, at: Date.now() })}>Submit review</button>
          <button className={showFinish?.inline ? "on" : "primary"} disabled={!queued || busy} title={queued ? `Send the ${queued} queued comment${queued === 1 ? "" : "s"} as one GitHub review, with a verdict` : "Queue findings with “Comment on PR” first"} onClick={() => setFinish({ inline: true, at: Date.now() })}>
            {busy ? "Submitting…" : queued ? `Post ${queued} to PR` : "Post to PR"}
          </button>
        </div>
      </div>
      {showFinish && <FinishPanel review={review} inline={showFinish.inline} openedAt={showFinish.at} decision={decision} busy={busy}
        onSubmit={submit} onQuick={quickPost} onClose={() => { setFinish(null); setDismissed(true); }} />}
      {review.submissions.length > 0 && <div className="rv-submissions">
        {review.submissions.map((sub, i) => <div key={i} className={`rv-sub ${sub.event.toLowerCase()}`}>
          <b>{EVENT_LABELS[sub.event]}</b> submitted {sub.at ? when(sub.at) : ""}{sub.inline.length ? ` with ${sub.inline.length} inline comment${sub.inline.length === 1 ? "" : "s"} (${sub.inline.join(", ")})` : " with no inline comments"}{sub.drafted ? " · summary drafted by AI" : ""}
          {" "}<a href={sub.url} onClick={(e) => { e.preventDefault(); open(sub.url); }}>view ↗</a>
        </div>)}
      </div>}

      {(review.whatItDoes || review.shipsToday || review.headline) && <>
        <h2 className="rv-h2"><Ico n="arch" />What it does</h2>
        {review.whatItDoes && <p className="rv-p">{review.whatItDoes}</p>}
        {review.shipsToday && <p className="rv-p"><strong>What ships today:</strong> {review.shipsToday}</p>}
        {review.headline && <p className="rv-p"><strong>Headline.</strong> {review.headline}</p>}
      </>}

      <h2 className="rv-h2"><Ico n="wreath" />Summary</h2>
      <div className="rv-counts">
        {SEVERITIES.map((s) => <div key={s} className={`rv-count ${SEV[s]}`}><div className="n">{counts.severity[s]}</div><div className="l">{SEVERITY_LABELS[s]}</div></div>)}
      </div>
      <div className="rv-counts">
        {CATEGORIES.map((c) => <div key={c} className="rv-count cat"><div className="n">{counts.category[c]}</div><div className="l"><Ico n={CATEGORY_ICONS[c]} />{CATEGORY_LABELS[c]}</div></div>)}
      </div>

      {review.flows.length > 0 && <>
        <h2 className="rv-h2"><Ico n="branch" />Flows <span className="k">{review.flows.length}</span></h2>
        {review.flows.map((flow, i) => {
          // a short gate reads as a tag; a sentence-long one gets its own line under the heading
          const gateInTag = !flow.reachable && !!flow.gate && flow.gate.length <= 28;
          return <div key={i} className="rv-flow">
          <div className="rv-flow-head">
            <h3>Flow {i + 1} — {flow.name}</h3>
            <div className="rv-tags">
              <span className={"rv-tag" + (flow.reachable ? "" : " gated")} title={flow.reachable ? undefined : flow.gate}>{flow.reachable ? "reachable today" : gateInTag ? `behind ${flow.gate}` : "gated"}</span>
              <span className={"rv-tag" + (flow.mode === "unattended" ? " unattended" : "")}>{flow.mode === "unattended" ? "unattended" : "human-driven"}</span>
            </div>
          </div>
          {!flow.reachable && flow.gate && !gateInTag && <p><strong>Behind:</strong> {flow.gate}</p>}
          {flow.trigger && <p><strong>Trigger:</strong> {flow.trigger}</p>}
          {flow.hops.length > 0 && <p>{flow.hops.map((h, j) => <React.Fragment key={j}>{j > 0 && " → "}{h.text}{h.ref && <> <span className="rv-ref">{h.ref}</span></>}</React.Fragment>)}</p>}
          {flow.endsIn && <p><strong>Ends in:</strong> {flow.endsIn}</p>}
        </div>; })}
      </>}

      {review.pattern && <>
        <h2 className="rv-h2"><Ico n="butterfly" />The pattern worth naming</h2>
        <p className="rv-p">{review.pattern}</p>
      </>}

      <h2 className="rv-h2"><Ico n="thorn" />Defects <span className="k">{counts.defects}</span></h2>
      {counts.defects === 0 && <p className="rv-empty">None found.</p>}
      {groups.defects.flatMap((g) => g.findings).filter(visible).map(card)}

      {groups.items.map((g) => <React.Fragment key={g.key}>
        <h2 className="rv-h2"><Ico n={CATEGORY_ICONS[g.key as Category] ?? "scroll"} />{g.label} <span className="k">{g.findings.length}</span></h2>
        {g.key === "tests" && review.testsExisting && <p className="rv-p"><strong>What exists:</strong> {review.testsExisting}</p>}
        {g.findings.length === 0 && <p className="rv-empty">None found.</p>}
        {g.findings.filter(visible).map(card)}
      </React.Fragment>)}

      <h2 className="rv-h2"><Ico n="scroll" />Appendix</h2>
      {review.appendix.length ? <ul className="rv-list">{review.appendix.map((a, i) => <li key={i}><strong>A{i + 1}.</strong> {a}</li>)}</ul> : <p className="rv-empty">No open questions.</p>}

      {review.wellBuilt.length > 0 && <>
        <h2 className="rv-h2"><Ico n="laurel" />Well built</h2>
        {review.wellBuilt.map((g, i) => <div key={i} className="rv-good"><h3>{g.what}</h3><p>{g.why} {g.ref && <span className="rv-ref">{g.ref}</span>}</p></div>)}
      </>}

      {review.orderOfWork.length > 0 && <>
        <h2 className="rv-h2"><Ico n="crown" />Order of work</h2>
        <ol className="rv-list">{review.orderOfWork.map((o, i) => <li key={i}><strong>{o.step}</strong>{o.why ? ` — ${o.why}` : ""}{o.refs?.length ? ` (${o.refs.join(", ")})` : ""}</li>)}</ol>
      </>}
    </div>
  );
}

type FinishProps = {
  review: Review; inline: boolean; openedAt: number; decision: string; busy: boolean;
  onSubmit: (opts: { event: ReviewEvent; body: string; inline: boolean; draft: boolean }) => void; onQuick: () => void; onClose: () => void;
};
/** GitHub's "Finish your review" box: a verdict, a body the model drafts when left blank, and whether the queued comments ride along inline. */
function FinishPanel({ review, inline: initialInline, openedAt, decision, busy, onSubmit, onQuick, onClose }: FinishProps) {
  // the action bar is sticky, so the click can come from far down the page: bring the panel to the reader and hand it focus
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openedAt) return;
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
  }, [openedAt]);
  const [event, setEvent] = useState<ReviewEvent>(() => suggestedEvent(review));
  const [body, setBody] = useState("");
  const [inline, setInline] = useState(initialInline);
  useEffect(() => { setInline(initialInline); }, [initialInline]);
  const queued = approvedFindings(review);
  const counts = reviewCounts(review);
  const decided = allDecided(review);
  const suggestion = suggestedEvent(review);
  return (
    <div className="rv-finish" role="dialog" aria-label="Finish your review" ref={panel}>
      <div className="rv-finish-head">
        <h3>Finish your review</h3>
        <span className="m">{decided ? `Every finding decided · ${counts.approved} queued · ${counts.commented} posted · ${counts.ignored} ignored${counts.fixing ? ` · ${counts.fixing} fixing locally` : ""}${counts.dropped ? ` · ${counts.dropped} dropped` : ""}` : `${counts.pending} finding${counts.pending === 1 ? "" : "s"} still undecided`}{decision ? ` · GitHub: ${decision}` : ""}</span>
        <button className="icon" title="Close" onClick={onClose}>×</button>
      </div>
      <textarea className="rv-finish-body" value={body} rows={4} spellCheck={false} placeholder="Leave blank and AI will fill out" onChange={(e) => setBody(e.target.value)} />
      <div className="rv-finish-events">
        {REVIEW_EVENTS.map((ev) => <label key={ev} className={"rv-event" + (event === ev ? " on" : "")}>
          <input type="radio" name="rv-event" checked={event === ev} onChange={() => setEvent(ev)} />
          <span><b>{EVENT_LABELS[ev]}</b>{ev === suggestion && <span className="rv-suggest">suggested</span>}<small>{EVENT_HELP[ev]}</small></span>
        </label>)}
      </div>
      <div className="rv-finish-foot">
        <label className="rv-inline-toggle" title={queued.length ? "Attach the queued comments to this review as inline comments" : "Nothing is queued; use “Comment on PR” on findings first"}>
          <input type="checkbox" checked={inline && queued.length > 0} disabled={!queued.length} onChange={(e) => setInline(e.target.checked)} />
          <span>Include {queued.length} queued comment{queued.length === 1 ? "" : "s"} inline</span>
        </label>
        <div className="rv-buttons">
          {queued.length > 0 && <button disabled={busy} title="Post only the queued comments, with no verdict and no summary" onClick={onQuick}>Comments only</button>}
          <button className="primary" disabled={busy} onClick={() => onSubmit({ event, body, inline: inline && queued.length > 0, draft: true })}>
            {busy ? "Submitting…" : `Submit review · ${EVENT_LABELS[event]}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The pause before "Fix locally" sends: the finding goes as the reviewer wrote it, and this is where the
 * user adds their own direction (a constraint, a different approach, a file to leave alone) to the prompt.
 */
function FixDialog({ f, onCancel, onStart }: { f: Finding; onCancel: () => void; onStart: (note: string) => void }) {
  const [note, setNote] = useState("");
  const where = `${f.file}${f.line ? `:${f.line}` : ""}`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className="dialog rv-fix" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dtitle"><span>Fix {f.id} locally</span><button onClick={onCancel} title="Cancel">✕</button></div>
        <p className="rv-fix-what"><b>{f.title}</b><br /><code>{where}</code></p>
        <p className="m">The finding goes to the chat in this worktree as the reviewer wrote it, with the fix it suggested. Add anything you want the fix to follow instead or as well.</p>
        <div className="field">
          <label>Your direction<small>(optional)</small></label>
          <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={5}
            placeholder="e.g. Use the member portal's throttle rather than a worker; leave the response shape alone; add a test for the cooldown path."
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onStart(note); } }} />
        </div>
        <div className="dfoot">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => onStart(note)} title="⌘↩">{f.fixRequest ? "Fix again" : "Start fixing"}</button>
        </div>
      </div>
    </div>
  );
}

type CardProps = {
  f: Finding; review: Review; drifted: boolean; liveHead: string | null; investigating: boolean;
  onDecide: (f: Finding, s: FindingStatus) => void; onComment: (f: Finding, c: string) => void; onReinvestigate: (f: Finding) => void; onFix: (f: Finding) => void;
  onOpen: (url: string) => void; onOpenChat: (chatId: string) => void;
};
function FindingCard({ f, review, drifted, liveHead, investigating, onDecide, onComment, onReinvestigate, onFix, onOpen, onOpenChat }: CardProps) {
  const [draft, setDraft] = useState(f.comment ?? "");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(f.comment ?? ""); }, [f.comment]);
  useEffect(() => { const t = box.current; if (t) { t.style.height = "0"; t.style.height = `${t.scrollHeight + 2}px`; } }, [draft]);
  const posted = f.status === "commented";
  const dropped = f.status === "dropped";
  const tone = f.kind === "defect" ? SEV[f.severity ?? "low"] : "cat";
  const defectFields: [string, string | undefined][] = [["Problem", f.problem], ["Example flow", f.exampleFlow], ["Fix", f.fix], ["Ignore if", f.ignoreIf]];
  const fields = f.kind === "defect" ? defectFields.filter((x): x is [string, string] => !!x[1]) : Object.entries(f.fields ?? {});
  const checkedAt = verifiedHead(review, f);
  const inv = f.investigation;
  const canReinvestigate = !!liveHead && liveHead !== checkedAt && !investigating;
  return (
    <div className={`rv-finding ${tone} ${f.status}${drifted ? " drifted" : ""}`}>
      <div className="head">
        <span className="num">{f.id}</span>
        {f.kind === "defect" && <span className={`rv-chip static ${tone}`}>{SEVERITY_LABELS[f.severity ?? "low"]}</span>}
        {f.category && <span className="rv-chip static cat"><Ico n={CATEGORY_ICONS[f.category]} />{CATEGORY_LABELS[f.category]}</span>}
        <h3>{f.title}</h3>
        <span className={`rv-status ${f.status}`}>{posted && f.posted ? <a href={f.posted.url} onClick={(e) => { e.preventDefault(); onOpen(f.posted!.url); }}>posted ↗</a> : STATUS_LABEL[f.status]}</span>
      </div>
      <div className="rv-refline">
        <span className="rv-ref">{f.file}{f.line ? `:${f.line}` : ""}</span>
        <span className="rv-checked" title={`This finding was last verified against commit ${checkedAt}`}>checked at {short(checkedAt) || "?"}</span>
        {drifted && <span className="rv-drift" title="The PR has changed this file since the finding was checked">file changed on PR since</span>}
        {f.fixRequest && <a href="#" className="rv-fixing" title="A chat in this worktree was asked to make this change" onClick={(e) => { e.preventDefault(); onOpenChat(f.fixRequest!.chatId); }}>fix requested{f.fixRequest.at ? ` ${when(f.fixRequest.at)}` : ""} · open chat ↗</a>}
      </div>
      {inv && <div className={`rv-inv ${inv.verdict}`}>
        <b>{inv.verdict === "same" ? "Re-checked: still holds" : inv.verdict === "modified" ? (posted ? "Re-checked: changed — posted comment may need a follow-up" : "Re-checked: still holds, comment updated") : posted ? "Re-checked: looks fixed — posted comment is stale" : "Re-checked: no longer holds"}</b>
        {" "}at {short(inv.head)}{inv.at ? `, ${when(inv.at)}` : ""}{inv.reason ? ` — ${inv.reason}` : ""}
        {inv.previousComment && <details><summary>previous comment</summary><pre>{inv.previousComment}</pre></details>}
      </div>}
      {fields.length > 0 && <dl>{fields.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{k === "Trimmed" ? <pre>{v}</pre> : v}</dd></React.Fragment>)}</dl>}
      <dl>
        <dt>PR comment</dt>
        <dd>
          <textarea ref={box} className="rv-comment" value={draft} readOnly={posted || dropped} spellCheck={false} rows={1}
            placeholder={f.kind === "defect" ? "The one-sentence comment to post…" : "Write a comment here to make this postable…"}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { if (!posted && !dropped && draft !== (f.comment ?? "")) onComment(f, draft); }} />
        </dd>
      </dl>
      <div className="rv-buttons">
        {!posted && !dropped && <>
          <button className={f.status === "approved" ? "primary" : ""} disabled={!draft.trim()} title={draft.trim() ? "Queue this comment for the next post" : "Write a comment first"}
            onClick={() => onDecide(f, f.status === "approved" ? "pending" : "approved")}>
            {f.status === "approved" ? "✓ Queued for PR" : "Comment on PR"}
          </button>
          {f.status === "fixing"
            ? <button className="on" title="Back to undecided; the chat keeps working on it either way" onClick={() => onDecide(f, "pending")}>Fixing locally · undo</button>
            : <button className={f.status === "ignored" ? "on" : ""} onClick={() => onDecide(f, f.status === "ignored" ? "pending" : "ignored")}>
                {f.status === "ignored" ? "Ignored · undo" : "Ignore"}
              </button>}
        </>}
        {!dropped && <button className={f.fixRequest ? "on" : ""} title={f.fixRequest ? "Ask again: send this finding to the chat in this worktree once more" : "This PR is yours: ask the chat in this worktree to make the change"} onClick={() => onFix(f)}>
          {f.fixRequest ? "Fix again" : "Fix locally"}
        </button>}
        <button className={drifted ? "rv-reinvestigate hot" : "rv-reinvestigate"} disabled={!canReinvestigate}
          title={!liveHead ? "GitHub has not answered yet" : liveHead === checkedAt ? "The PR has no commits newer than this finding's check" : "Re-check this finding against the PR's current commit: same comment, a modified one, or removed"}
          onClick={() => onReinvestigate(f)}>
          {investigating ? "Re-investigating…" : "Re-investigate"}
        </button>
      </div>
    </div>
  );
}

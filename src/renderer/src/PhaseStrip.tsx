import React from "react";
import { phasesFor, type Phase } from "../../shared/types";

const ICONS: Record<Phase, string> = { waiting: "candle", planning: "scroll", executing: "sun", validating: "chalice", complete: "wreath" };

export function PhaseStrip({ phase, steps, onSelect, children }: { phase: Phase; steps?: 3 | 5; onSelect: (phase: Phase) => void; children?: React.ReactNode }) {
  const phases = phasesFor(steps);
  const current = phases.indexOf(phase);
  return <div className="phases" aria-label="Chat progress">
    <div className="phase-steps">
      {phases.map((step, index) => <React.Fragment key={step}>
        {index > 0 && <svg className="phase-star" viewBox="0 0 32 40" aria-hidden="true"><path d="M16 0 19 14 26 9 22 17 32 20 22 23 26 31 19 26 16 40 13 26 6 31 10 23 0 20 10 17 6 9 13 14Z" fill="currentColor" /></svg>}
        <button className={`phase-step ${phase === "complete" || index < current ? "done" : index === current ? "on" : ""}${phase === "complete" && step === "complete" ? " final" : ""}`}
          aria-current={step === phase ? "step" : undefined} onClick={() => onSelect(step)}>
          <i className={`ico ico-${ICONS[step]}`} aria-hidden="true" />{step}
        </button>
      </React.Fragment>)}
    </div>
    {children}
  </div>;
}

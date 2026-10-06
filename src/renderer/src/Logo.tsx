import React from "react";
// The muses: three figures in a ring, cream on black. The angel with the violin stays in assets as the
// previous mark (angel.png / angel-mask.png) should we want it back.
// PNG source is white-on-black; a thresholded alpha mask paints it in currentColor so it follows the theme
import mask from "./assets/muses-mask.png"; // magick: gray, threshold 50%, trim, resize 800, alpha copy

const MASK = { WebkitMaskImage: `url(${mask})`, maskImage: `url(${mask})` } as React.CSSProperties;
// the wrapper becomes a dark circle in light mode so the mark stays cream-on-black
export const Mark = ({ className }: { className?: string }) => (
  <span className={"markwrap " + (className ?? "")}><span className="mark" style={MASK} aria-label="Consort" /></span>
);

export const Lockup = () => (
  <div className="brand">
    <Mark />
    <div>
      <div className="word">Consort</div>
      <div className="sub">Branch &amp; worktree ADE</div>
    </div>
  </div>
);

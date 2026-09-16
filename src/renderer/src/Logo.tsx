import React from "react";
// Violin glyph, cream on black, run through a turbulence warp for the melty look
// PNG is white-on-black; a luminance mask turns it into currentColor on transparent, so it follows the theme
import mask from "./assets/angel-mask.png"; // pre-thresholded alpha mask (magick: threshold 50%, alpha copy, trim)

const MASK = { WebkitMaskImage: `url(${mask})`, maskImage: `url(${mask})` } as React.CSSProperties;
// the wrapper becomes a dark oval in light mode so the angel stays cream-on-black
export const Mark = ({ className }: { className?: string }) => (
  <span className={"markwrap " + (className ?? "")}><span className="mark" style={MASK} aria-label="Consort" /></span>
);

export const Lockup = () => (
  <div className="brand">
    <Mark />
    <div>
      <div className="word">Consort</div>
      <div className="sub">An Agentic Workspace</div>
    </div>
  </div>
);

// ═══════════════ MONDAY — mode selector ═══════════════
// DRILL · EXAM · POSTMORTEM · TEACH · PAUSE. The header shows the live mode as a
// chip; picking EXAM changes what the whole app looks like (see
// `:root[data-mode='EXAM']` in app.css and <ExamBanner/> below), because a mode
// that only changes a word is a mode nobody notices they are in.

import React, { useState } from 'react';
import { MODES, MODE_HINT } from './constants.js';

export default function ModeSelector({ mode = 'DRILL', onMode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="menu-wrap">
      <button
        className={`btn tiny mode-btn m-${mode.toLowerCase()}`}
        onClick={() => setOpen((o) => !o)}
        title={MODE_HINT[mode]}
      >
        {mode} ▾
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu mode-menu">
            {MODES.map((m) => (
              <div
                key={m}
                className={`menu-item ${m === mode ? 'on' : ''}`}
                onClick={() => { onMode(m); setOpen(false); }}
              >
                <b>{m}</b>
                <div className="mode-hint">{MODE_HINT[m]}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

/** Full-width hazard band under the header. Only ever visible in EXAM. */
export function ExamBanner({ mode }) {
  if (mode !== 'EXAM') return null;
  return (
    <div className="exam-band" role="status">
      <span className="exam-band-tag">EXAM</span>
      <span className="exam-band-text">
        Timer forced · no hints · no Socratic prompting · Monday is silent · marking at the end
      </span>
    </div>
  );
}

/** Fixed hard frame around the viewport, so EXAM is unmistakable at a glance. */
export function ExamFrame({ mode }) {
  if (mode !== 'EXAM') return null;
  return <div className="exam-frame" aria-hidden="true" />;
}

/** PAUSE has to be impossible to forget — the existing `pause tutor mode` hatch
 *  used to be invisible, which is exactly how sessions quietly stopped counting. */
export function PauseBanner({ mode }) {
  if (mode !== 'PAUSE') return null;
  return (
    <div className="pause-band" role="status">
      <span className="pause-band-tag">PAUSED</span>
      <span className="exam-band-text">Tutor mode off — nothing here is being marked, logged, or remembered.</span>
    </div>
  );
}

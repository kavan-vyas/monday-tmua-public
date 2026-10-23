// ═══════════════ MONDAY — status line + mood popover ═══════════════
//   ◉ MONDAY · FOCUSED · L14 · 55d TO EXAM · 68/100 READY · CTX 34% · ⏱ 12:04
// The orb is rendered by the header next to the logo; everything after it lives
// here. Clicking the mood chip opens Monday explaining its own state: the mood,
// the `reason` string straight off `monday_state`, and a sparkline of how the
// mood has moved.

import React, { useEffect, useRef, useState } from 'react';
import { MOOD_MANNER, MOOD_RANK, moodColor, moodInk } from './constants.js';

// ── sparkline ────────────────────────────────────────────────────────────────
function MoodSpark({ history, theme, width = 260, height = 46 }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = width * dpr;
    cv.height = height * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = theme === 'dark';
    const line = dark ? '#3d3a35' : '#cdc7bc';
    ctx.clearRect(0, 0, width, height);

    const pts = (history ?? []).slice(-60);
    // frame — a hairline, matching the rest of the shell
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.strokeRect(.5, .5, width - 1, height - 1);
    if (pts.length < 2) {
      ctx.fillStyle = dark ? '#847e74' : '#8a847a';
      ctx.font = "10px 'IBM Plex Mono', ui-monospace, Menlo, monospace";
      ctx.fillText('not enough history yet', 10, height / 2 + 3);
      return;
    }

    const pad = 6;
    const w = width - pad * 2;
    const h = height - pad * 2;
    const step = w / (pts.length - 1);
    const y = (mood) => pad + h - ((MOOD_RANK[mood] ?? 1) / 5) * h;

    // stepped line — moods are discrete states, not a continuous signal
    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = line;
    pts.forEach((p, i) => {
      const x = pad + i * step;
      const yy = y(p.mood);
      if (i === 0) ctx.moveTo(x, yy);
      else { ctx.lineTo(x, y(pts[i - 1].mood)); ctx.lineTo(x, yy); }
    });
    ctx.stroke();

    // one hard square per sample, filled in that mood's colour
    pts.forEach((p, i) => {
      const x = pad + i * step;
      const yy = y(p.mood);
      ctx.fillStyle = moodColor(p.mood, theme);
      ctx.beginPath();
      ctx.arc(x, yy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
  }, [history, theme, width, height]);
  return <canvas ref={ref} className="mood-spark" style={{ width, height }} />;
}

// ── popover ──────────────────────────────────────────────────────────────────
function MoodPopover({ state, history, theme, onClose }) {
  const mood = state?.mood ?? 'focused';
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} />
      <div className="menu mood-pop">
        <div className="mood-pop-head">
          <span className="mood-swatch" style={{ background: moodColor(mood, theme) }} />
          <b>{mood}</b>
          <span className="quick-spacer" />
          <span className="mood-pop-mode">{state?.mode ?? 'DRILL'}</span>
        </div>
        <div className="mood-pop-reason">{state?.reason || 'No reason reported yet.'}</div>
        <div className="mood-pop-manner">{MOOD_MANNER[mood] ?? ''}</div>
        <div className="mood-pop-spark">
          <div className="mood-pop-label">Mood over time · {history.length} sample{history.length === 1 ? '' : 's'}</div>
          <MoodSpark history={history} theme={theme} />
          <div className="mood-pop-axis"><span>gentle</span><span>grave</span></div>
        </div>
        {state && (
          <div className="mood-pop-facts">
            <span>streak {state.streak > 0 ? `+${state.streak}` : state.streak ?? 0}</span>
            <span>
              session {state.sessionAccuracy?.correct ?? 0}/{state.sessionAccuracy?.total ?? 0}
            </span>
            <span>backlog {state.backlogDue ?? 0}</span>
            {state.lastSessionDate && <span>last {state.lastSessionDate}</span>}
          </div>
        )}
      </div>
    </>
  );
}

// ── status line ──────────────────────────────────────────────────────────────
export default function StatusLine({ state, moodHistory, ctx, theme, connection, elapsedMs, onOpenReadiness }) {
  const [open, setOpen] = useState(false);
  const mood = state?.mood ?? null;
  const sep = <span className="st-sep">·</span>;

  return (
    <span className="statusline">
      <span className="st-name">MONDAY</span>
      {connection !== 'connected' && (
        <>
          {sep}
          <span className="st-chip st-down">{connection === 'connecting' ? 'connecting' : 'offline'}</span>
        </>
      )}
      {mood && (
        <>
          {sep}
          <span className="menu-wrap">
            <button
              className="st-chip st-mood"
              style={{ background: moodColor(mood, theme), color: moodInk(mood, theme) }}
              onClick={() => setOpen((o) => !o)}
              title="why this mood — click"
            >
              {mood}
            </button>
            {open && (
              <MoodPopover state={state} history={moodHistory ?? []} theme={theme} onClose={() => setOpen(false)} />
            )}
          </span>
        </>
      )}
      {Number.isFinite(state?.lesson) && (<>{sep}<span className="st-chip">L{state.lesson}</span></>)}
      {Number.isFinite(state?.daysToExam) && (
        <>
          {sep}
          <span className={`st-chip ${state.daysToExam <= 30 ? 'hot' : ''}`}>{state.daysToExam}d to exam</span>
        </>
      )}
      {Number.isFinite(state?.readiness?.overall) && (
        <>
          {sep}
          <button className="st-chip st-ready" onClick={onOpenReadiness} title="open the readiness pane">
            {Math.round(state.readiness.overall)}/100 ready
          </button>
        </>
      )}
      {ctx && (
        <>
          {sep}
          <span
            className={`st-chip ${ctx.pct >= 70 ? 'hot' : ''}`}
            title={`context: ${Math.round(ctx.tokens / 1000)}k / ${Math.round(ctx.max / 1000)}k tokens — auto-compacts when full`}
          >
            CTX {ctx.pct}%
          </span>
        </>
      )}
      {elapsedMs != null && (<>{sep}<span className="st-chip st-clock">⏱ {elapsedMs}</span></>)}
    </span>
  );
}

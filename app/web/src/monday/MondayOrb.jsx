// ═══════════════ MONDAY — the orb ═══════════════
// Five states, one canvas, no soft glows:
//   dormant  — socket down. Dim, still, a flat ring.
//   idle     — 4 s breathing pulse.
//   thinking — three concentric arcs rotating at different rates, turn in flight.
//   speaking — ring radius driven by the live AnalyserNode on the playback graph,
//              so it moves with the actual voice.
//   alert    — double flash when a proactive nudge lands, then back.
// Colour follows mood. Drawn with a hard 2 px stroke in the theme's line colour —
// the stroke weight is fixed by ACC-UI-17, which also forbids any glow or blur,
// so the orb stays a crisp object rather than gaining a halo.

import React, { useEffect, useRef } from 'react';
import { moodColor } from './constants.js';

const TAU = Math.PI * 2;

export default function MondayOrb({
  state = 'idle',
  mood = 'focused',
  theme = 'light',
  level = () => 0,
  size = 30,
  title,
  onClick,
}) {
  const canvasRef = useRef(null);
  // live refs so the animation loop is started once and never re-created
  const stateRef = useRef(state);
  const moodRef = useRef(mood);
  const themeRef = useRef(theme);
  const levelRef = useRef(level);
  const alertRef = useRef(0); // timestamp the current alert began

  useEffect(() => {
    // entering `alert` restarts the double-flash clock
    if (state === 'alert' && stateRef.current !== 'alert') alertRef.current = performance.now();
    stateRef.current = state;
  }, [state]);
  useEffect(() => { moodRef.current = mood; }, [mood]);
  useEffect(() => { themeRef.current = theme; }, [theme]);
  useEffect(() => { levelRef.current = level; }, [level]);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    const ctx = cv.getContext('2d');
    let raf = 0;
    let smoothed = 0;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    cv.width = size * dpr;
    cv.height = size * dpr;

    function frame(t) {
      raf = requestAnimationFrame(frame);
      const s = stateRef.current;
      const dark = themeRef.current === 'dark';
      // token neutrals — --line-strong and --surface, kept in sync with tokens.js
      const line = dark ? '#3d3a35' : '#cdc7bc';
      const panel = dark ? '#1b1a18' : '#ffffff';
      const col = moodColor(moodRef.current, themeRef.current);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2;
      const cy = size / 2;
      const rMax = size / 2 - 2.5;

      // ── the shell: always present, so the orb reads as a solid object ──
      ctx.lineWidth = 2;
      ctx.strokeStyle = line;
      ctx.fillStyle = panel;
      ctx.beginPath();
      ctx.arc(cx, cy, rMax, 0, TAU);
      ctx.fill();
      ctx.stroke();

      if (s === 'dormant') {
        // dim, still — a struck-through dead eye
        ctx.globalAlpha = 0.42;
        ctx.fillStyle = dark ? '#847e74' : '#8a847a';
        ctx.beginPath();
        ctx.arc(cx, cy, rMax * 0.34, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = dark ? '#847e74' : '#8a847a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - rMax * 0.72, cy + rMax * 0.72);
        ctx.lineTo(cx + rMax * 0.72, cy - rMax * 0.72);
        ctx.stroke();
        return;
      }

      let core = rMax * 0.42;
      let alpha = 1;

      if (s === 'idle') {
        // 4 s breath. sin over a 4000 ms period, shallow.
        const b = (Math.sin((t / 4000) * TAU) + 1) / 2;
        core = rMax * (0.36 + 0.12 * b);
        smoothed *= 0.9;
      } else if (s === 'thinking') {
        core = rMax * 0.3;
        // three arcs, different rates and different directions
        const arcs = [
          [rMax * 0.96, t / 900, 1.9],
          [rMax * 0.74, -t / 1400, 1.2],
          [rMax * 0.53, t / 620, 2.6],
        ];
        ctx.lineWidth = 2;
        ctx.strokeStyle = col;
        for (const [r, phase, span] of arcs) {
          ctx.beginPath();
          ctx.arc(cx, cy, r, phase % TAU, (phase % TAU) + span);
          ctx.stroke();
        }
      } else if (s === 'speaking') {
        // radius driven by the real waveform, lightly smoothed so it reads as
        // speech rather than noise
        const lv = Math.min(1, levelRef.current?.() ?? 0);
        smoothed = smoothed * 0.55 + lv * 0.45;
        core = rMax * (0.3 + 0.62 * smoothed);
        // a second ring at the peak, so loud syllables punch outward
        ctx.lineWidth = 2;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(rMax - 1, rMax * (0.5 + 0.5 * smoothed)), 0, TAU);
        ctx.stroke();
      } else if (s === 'alert') {
        // double flash: on/off/on/off over ~900 ms, then hold bright
        const dt = t - alertRef.current;
        const on = dt % 220 < 130 && dt < 900;
        core = rMax * (on ? 0.86 : 0.3);
        alpha = on ? 1 : 0.6;
        if (on) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.arc(cx, cy, rMax - 0.5, 0, TAU);
          ctx.stroke();
        }
      }

      // ── core: flat mood-coloured disc with the same hard black edge ──
      ctx.globalAlpha = alpha;
      ctx.fillStyle = col;
      ctx.strokeStyle = line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(1.5, Math.min(core, rMax - 1.5)), 0, TAU);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      className={`monday-orb ${state}`}
      style={{ width: size, height: size, cursor: onClick ? 'pointer' : 'default' }}
      title={title ?? `MONDAY — ${state} · ${mood}`}
      onClick={onClick}
    />
  );
}

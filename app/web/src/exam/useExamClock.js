// The exam clock.
//
// Derived, never decremented. The deadline is recomputed from the server's own startedAt
// on every tick, so a throttled background tab, a sleeping laptop or a page reload cannot
// gain or lose the student a single second — which matters, because the whole reason this
// simulator exists is that none of his six practice papers were sat against a clock.
import { useEffect, useRef, useState } from 'react';

export function useExamClock({ startedAt, durationSec, elapsedSec, breakSecondsUsed = 0, paused = false, onExpire }) {
  // Anchor local time to the server's clock once, so a skewed browser clock cannot
  // shorten the exam: offset = what the server thinks has elapsed vs what we think.
  const anchor = useRef(null);
  if (anchor.current === null && startedAt) {
    anchor.current = { at: Date.now(), serverElapsedMs: (elapsedSec ?? 0) * 1000 };
  }

  const pausedAt = useRef(null);
  const pausedMs = useRef((breakSecondsUsed ?? 0) * 1000);
  const fired = useRef(false);
  const [, tick] = useState(0);

  useEffect(() => {
    if (paused && pausedAt.current === null) pausedAt.current = Date.now();
    if (!paused && pausedAt.current !== null) {
      pausedMs.current += Date.now() - pausedAt.current;
      pausedAt.current = null;
    }
  }, [paused]);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);

  const a = anchor.current;
  const frozen = paused && pausedAt.current !== null ? Date.now() - pausedAt.current : 0;
  const elapsedMs = a
    ? Math.max(0, a.serverElapsedMs + (Date.now() - a.at) - (pausedMs.current - (breakSecondsUsed ?? 0) * 1000) - frozen)
    : 0;

  const remainingMs = durationSec == null ? null : Math.max(0, durationSec * 1000 - elapsedMs);

  useEffect(() => {
    if (remainingMs === 0 && !fired.current && durationSec != null) {
      fired.current = true;
      onExpire?.();
    }
  });

  return {
    elapsedSec: Math.floor(elapsedMs / 1000),
    remainingSec: remainingMs == null ? null : Math.floor(remainingMs / 1000),
    expired: remainingMs === 0 && durationSec != null,
    breakMs: pausedMs.current,
  };
}

/** 74:54 — minutes past an hour are not wrapped; the real screen counts 120:00 down flat. */
export const clockText = (sec) => {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

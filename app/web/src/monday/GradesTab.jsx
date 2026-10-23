// ═══════════════ MONDAY — GRADES pane ═══════════════
// A private raw-mark → TMUA-grade converter, built off the table in gradeTable.js.
// Everything here is client-only: no fetch, no server round-trip, nothing leaves
// the browser. The only persistence is a single localStorage key so the mark you
// last typed survives a reload — see LS_KEY below.
//
// The table itself is preserved verbatim (see gradeTable.js's header comment for
// the two known oddities — 12 and 13 sharing a band, and bands overlapping at
// their edges). This file does not try to smooth either of those out.

import React, { useEffect, useMemo, useState } from 'react';
import {
  GRADE_TABLE,
  MAX_MARK,
  MIN_MARK,
  TOP_BAND_FLOOR,
  gradeForMark,
  gradeLow,
  marksToNextBand,
  minMarkForGrade,
} from './gradeTable.js';

// Never touched by any network call — this component performs no HTTP
// requests of any kind, deliberately.
const LS_KEY = 'monday-grades-mark';

// ── shared inline style fragments (tokens only, no hand-coded colours) ──────
const card = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  padding: 'var(--sp-6)',
};
const label = {
  fontSize: 'var(--t-3xs)',
  fontWeight: 'var(--fw-semi)',
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: 'var(--ink-3)',
};
const input = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--t-md)',
  fontWeight: 'var(--fw-semi)',
  color: 'var(--ink)',
  background: 'var(--sunken)',
  border: '1px solid var(--line-strong)',
  borderRadius: 'var(--r-sm)',
  padding: 'var(--sp-3) var(--sp-4)',
  width: '84px',
  textAlign: 'center',
};

function clampMark(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(MAX_MARK, Math.max(MIN_MARK, n));
}

export default function GradesTab() {
  // ── mark entry, persisted ──────────────────────────────────────────────
  const [markStr, setMarkStr] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved != null && saved !== '') return saved;
    } catch { /* private browsing, quota, etc — fall through to default */ }
    return '';
  });

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, markStr); } catch { /* best-effort only */ }
  }, [markStr]);

  const mark = markStr === '' ? null : clampMark(markStr);
  const markGrade = mark == null ? null : gradeForMark(mark);
  const toNext = mark == null ? null : marksToNextBand(mark);

  // ── reverse lookup: target grade → minimum mark ────────────────────────
  const [targetStr, setTargetStr] = useState('');
  const target = targetStr === '' ? null : Number(targetStr);
  const minMark = target != null && Number.isFinite(target) ? minMarkForGrade(target) : null;

  // ── slope visual: every band's low-end grade, scaled 1.0–9.0 → 0–100% ──
  const bars = useMemo(
    () => GRADE_TABLE.map(([m, g]) => ({
      mark: m,
      grade: g,
      pct: ((gradeLow(g) - 1) / (9 - 1)) * 100,
    })).slice().reverse(), // low mark → high mark, left to right
    [],
  );

  return (
    <div className="tab-fill gr-tab" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 'var(--sp-6)', padding: 'var(--sp-6)', overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-4)' }}>
        <span style={{ fontSize: 'var(--t-lg)', fontWeight: 'var(--fw-semi)', color: 'var(--ink)' }}>Grades</span>
        <span style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-3)' }}>raw mark → TMUA grade, private, never sent anywhere</span>
      </div>

      {/* ── headroom card: the 9.0 band, framed as room to spare ── */}
      <div style={{ ...card, borderColor: 'var(--c-green)', background: 'var(--sunken)' }}>
        <div style={label}>Top band</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--sp-5)', marginTop: 'var(--sp-3)' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-2xl)', fontWeight: 'var(--fw-bold)', color: 'var(--c-green-ink)' }}>9.0</span>
          <span style={{ fontSize: 'var(--t-sm)', color: 'var(--ink-2)' }}>
            at {TOP_BAND_FLOOR}/{MAX_MARK} — that is {MAX_MARK - TOP_BAND_FLOOR} marks of headroom before the grade even starts to move.
          </span>
        </div>
      </div>

      {/* ── mark entry ── */}
      <div style={card}>
        <div style={label}>Enter a raw mark</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-6)', marginTop: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <input
            type="number"
            min={MIN_MARK}
            max={MAX_MARK}
            step={1}
            value={markStr}
            onChange={(e) => setMarkStr(e.target.value)}
            placeholder="0–40"
            style={input}
          />
          {mark != null && markGrade != null && (
            <>
              <div>
                <div style={label}>Grade</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-xl)', fontWeight: 'var(--fw-semi)', color: 'var(--ink)' }}>{markGrade}</div>
              </div>
              <div>
                <div style={label}>To next band</div>
                <div style={{ fontSize: 'var(--t-sm)', color: toNext > 0 ? 'var(--ink-2)' : 'var(--c-green-ink)' }}>
                  {toNext > 0 ? `${toNext} more mark${toNext === 1 ? '' : 's'}` : 'already at the top band'}
                </div>
              </div>
            </>
          )}
          {markStr !== '' && mark == null && (
            <span style={{ fontSize: 'var(--t-xs)', color: 'var(--c-red-ink)' }}>enter a whole number 0–40</span>
          )}
        </div>
      </div>

      {/* ── reverse lookup ── */}
      <div style={card}>
        <div style={label}>Target grade → minimum mark</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-6)', marginTop: 'var(--sp-4)', flexWrap: 'wrap' }}>
          <input
            type="number"
            min={1}
            max={9}
            step={0.1}
            value={targetStr}
            onChange={(e) => setTargetStr(e.target.value)}
            placeholder="e.g. 7.5"
            style={input}
          />
          {target != null && Number.isFinite(target) && (
            <div>
              <div style={label}>Minimum mark</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--t-xl)', fontWeight: 'var(--fw-semi)', color: 'var(--ink)' }}>
                {minMark != null ? `${minMark}/${MAX_MARK}` : 'not reachable'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── slope visual: bar height per mark, no chart library ── */}
      <div style={card}>
        <div style={label}>Slope</div>
        <div style={{ fontSize: 'var(--t-xs)', color: 'var(--ink-3)', marginTop: 'var(--sp-2)', marginBottom: 'var(--sp-5)' }}>
          Each mark is worth roughly 0.3–0.5 of a grade between 20 and 34 marks; flat at both ends.
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1px', height: '96px' }}>
          {bars.map((b) => (
            <div
              key={b.mark}
              title={`${b.mark}/${MAX_MARK} → ${b.grade}`}
              style={{
                flex: 1,
                height: `${Math.max(4, b.pct)}%`,
                background: b.mark === mark ? 'var(--c-brand)' : b.mark >= TOP_BAND_FLOOR ? 'var(--c-green)' : 'var(--c-blue)',
                opacity: b.mark === mark ? 1 : 0.55,
                borderRadius: '2px 2px 0 0',
              }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--t-3xs)', color: 'var(--ink-3)', fontFamily: 'var(--font-mono)', marginTop: 'var(--sp-2)' }}>
          <span>{MIN_MARK}</span>
          <span>{MAX_MARK}</span>
        </div>
      </div>
    </div>
  );
}

// ═══════════════ MONDAY — READINESS pane ═══════════════
// Renders the `readiness` event from plangamma.md §C3:
//   { overall, projected, weakest:[{topic,score}], topics:[{topic,score,attempted,available,accuracy,lastSeen}] }
// Per-topic bars, projected TMUA score against the target (a setting — Settings →
// Study → target score, shipped live on every report), and days to exam.
// Fetches GET /api/readiness on mount so the pane is populated the moment it is
// opened rather than waiting for the next broadcast, instead of an empty state.

import React, { useEffect, useMemo, useState } from 'react';
import { TARGET_SCORE } from './constants.js';

const pretty = (t) => String(t).replace(/_/g, ' ');
const band = (s) => (s >= 75 ? 'good' : s >= 55 ? 'mid' : s >= 35 ? 'low' : 'bad');
const daysSince = (iso) => {
  if (!iso) return null;
  const d = Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
  return Number.isFinite(d) ? d : null;
};

export default function ReadinessTab({ readiness, daysToExam }) {
  const [fetched, setFetched] = useState(null);
  const [sort, setSort] = useState('weakest'); // weakest | name | coverage
  const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    fetch('/api/readiness')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (!dead && d && !d.error) setFetched(d); })
      .catch(() => { if (!dead) setErr('no /api/readiness yet — showing the last broadcast'); });
    return () => { dead = true; };
  }, []);

  // whichever we have that actually carries topics wins
  const r = (readiness?.topics?.length ? readiness : null) ?? (fetched?.topics?.length ? fetched : null) ?? readiness ?? fetched;

  const topics = useMemo(() => {
    const list = (r?.topics ?? []).slice();
    if (sort === 'name') list.sort((a, b) => String(a.topic).localeCompare(String(b.topic)));
    else if (sort === 'coverage') list.sort((a, b) => (a.attempted / (a.available || 1)) - (b.attempted / (b.available || 1)));
    else list.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    return list;
  }, [r, sort]);

  if (!r) {
    return (
      <div className="tab-fill rd-tab">
        <div className="rd-bar"><span className="rd-title">Readiness</span></div>
        <div className="rd-empty">
          Nothing measured yet. Monday computes this from coverage × accuracy × recency —
          it fills in as soon as the server sends a readiness report.
        </div>
      </div>
    );
  }

  const overall = Math.round(r.overall ?? 0);
  const projected = Number(r.projected ?? 0);
  // The target is a SETTING now (settings pane → Study → target score), and the
  // server ships the live value on every readiness report. TARGET_SCORE is only
  // the fallback for a report that predates it.
  const target = Number.isFinite(Number(r.target)) ? Number(r.target) : TARGET_SCORE;
  const gap = projected - target;
  const onTrack = gap >= -0.25;
  // projected scale runs 1.0–9.0; position the target marker on the same scale
  const pos = (v) => `${Math.min(100, Math.max(0, ((v - 1) / 8) * 100))}%`;

  return (
    <div className="tab-fill rd-tab">
      <div className="rd-bar">
        <span className="rd-title">Readiness</span>
        {[['weakest', 'Weakest'], ['coverage', 'Least covered'], ['name', 'A–Z']].map(([k, l]) => (
          <button key={k} className={`btn tiny ${sort === k ? 'on' : ''}`} onClick={() => setSort(k)}>{l}</button>
        ))}
        <span className="quick-spacer" />
        {Number.isFinite(daysToExam) && (
          <span className={`rd-count ${daysToExam <= 30 ? 'hot' : ''}`}>{daysToExam}d TO EXAM</span>
        )}
      </div>

      <div className="rd-top">
        <div className="rd-big">
          <div className="rd-big-num">{overall}<span className="rd-big-den">/100</span></div>
          <div className="rd-big-label">Overall</div>
        </div>
        <div className="rd-proj">
          <div className="rd-proj-head">
            <span>Projected TMUA</span>
            <b className={onTrack ? 'ok' : 'bad'}>{projected.toFixed(1)}</b>
            <span className="rd-proj-target">TARGET {target.toFixed(1)}</span>
          </div>
          <div className="rd-scale">
            <div className={`rd-scale-fill ${onTrack ? 'ok' : 'bad'}`} style={{ width: pos(projected) }} />
            <div className="rd-scale-target" style={{ left: pos(target) }} title={`target ${target}`} />
          </div>
          <div className="rd-proj-note">
            {onTrack
              ? 'On the target trajectory. Hold it.'
              : `${Math.abs(gap).toFixed(1)} short of ${target.toFixed(1)} on current form.`}
          </div>
        </div>
      </div>

      {err && <div className="rd-err">{err}</div>}

      <div className="rd-body">
        {topics.length === 0 && <div className="rd-empty">No per-topic breakdown in this report.</div>}
        {topics.map((t) => {
          const score = Math.round(t.score ?? 0);
          const cov = t.available ? Math.round((t.attempted / t.available) * 100) : null;
          const stale = daysSince(t.lastSeen);
          return (
            <div key={t.topic} className="rd-row">
              <div className="rd-row-head">
                <span className="rd-topic">{pretty(t.topic)}</span>
                <span className="quick-spacer" />
                {cov != null && <span className="rd-meta">{t.attempted}/{t.available} done</span>}
                {Number.isFinite(t.accuracy) && <span className="rd-meta">{Math.round(t.accuracy * (t.accuracy <= 1 ? 100 : 1))}% acc</span>}
                {stale != null && <span className={`rd-meta ${stale >= 21 ? 'stale' : ''}`}>{stale}d ago</span>}
                <span className={`rd-score ${band(score)}`}>{score}</span>
              </div>
              <div className="rd-track">
                <div className={`rd-fill ${band(score)}`} style={{ width: `${Math.min(100, Math.max(0, score))}%` }} />
                {cov != null && <div className="rd-cov" style={{ width: `${Math.min(100, cov)}%` }} title={`coverage ${cov}%`} />}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rd-foot">
        Score = coverage × accuracy × recency decay. A topic untouched for 21 days decays
        toward a floor whatever the accuracy was — the thin bar underneath each track is coverage.
      </div>
    </div>
  );
}

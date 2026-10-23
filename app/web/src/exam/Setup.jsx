// The prestart page — choose what to sit, then Start Test.
//
// Drawn inside the test driver frame (title bar, tool bar with Color Scheme, nav bar)
// in the driver's own content style — Arial 12pt, plain tables, native radios and
// checkboxes — so the whole visit, from this page to the last question, looks like one
// piece of exam software. Start Test is a user click, which is what lets the next screen
// enter full screen.
import React, { useMemo, useState } from 'react';
import Driver from './pv/Driver.jsx';

const ARIAL = { fontFamily: 'arial', fontSize: '12pt' };
const TIMINGS = [
  { id: 'real', label: '75 minutes per paper', note: 'Real test conditions' },
  { id: 'long', label: '120 minutes per paper', note: 'Extended sitting' },
  { id: 'untimed', label: 'Untimed', note: 'No clock is shown, as in the untimed sample test' },
];

const td = { padding: '4px 10px 4px 2px', verticalAlign: 'top', borderTop: '1px solid #c8c8c8' };
const th = { ...td, fontWeight: 'bold', borderTop: 'none', textAlign: 'left' };

/** Every sittable set: {key, title, set, papers: {1: row, 2: row}}. */
function setsFrom(papers) {
  const out = new Map();
  for (const p of papers) {
    if (p.transcribed !== 'full') continue;
    const key = `${p.collection}|${p.set}`;
    if (!out.has(key)) out.set(key, { key, collection: p.collection_title ?? p.collection, set: p.set, papers: {}, title: '' });
    out.get(key).papers[p.paper] = p;
  }
  for (const s of out.values()) {
    const any = s.papers[1] ?? s.papers[2];
    s.title = (any.short ?? any.title).replace(/\s*Paper\s*[12]\s*$/i, '').trim() || `Set ${s.set}`;
  }
  return [...out.values()];
}

export default function Setup({ papers, unfinished = [], busy, error, scheme, onScheme, onStart }) {
  const sets = useMemo(() => setsFrom(papers), [papers]);
  const [setKey, setSetKey] = useState(sets[0]?.key ?? '');
  const [which, setWhich] = useState('both');
  const [timing, setTiming] = useState('real');
  const [shuffle, setShuffle] = useState(false);
  const [extraTime, setExtraTime] = useState(false);
  const [explain, setExplain] = useState(false);
  const [allowPause, setAllowPause] = useState(false);

  const chosen = sets.find((s) => s.key === setKey) ?? null;
  const has1 = Boolean(chosen?.papers[1]); const has2 = Boolean(chosen?.papers[2]);
  const mode = has1 && has2 ? which : has1 ? 'p1' : 'p2';
  const paperIds = !chosen ? [] : mode === 'both' ? [chosen.papers[1].id, chosen.papers[2].id]
    : mode === 'p1' ? [chosen.papers[1].id] : [chosen.papers[2].id];
  const ready = paperIds.length > 0 && !busy;

  const groups = useMemo(() => {
    const by = new Map();
    for (const s of sets) {
      if (!by.has(s.collection)) by.set(s.collection, []);
      by.get(s.collection).push(s);
    }
    return [...by.entries()];
  }, [sets]);

  const start = () => ready && onStart({ paperIds, timing, shuffle, extraTime, explain, allowPause });

  return (
    <Driver scheme={scheme} onScheme={onScheme} nav={{ action: ready ? { label: busy ? 'Starting…' : 'Start Test', k: 'S', onClick: start, tele: 'start' } : null }}>
      <div id="abe-readMe" className="contentPaneLanguageWrapper" tabIndex={0}>
        <div className="abe-tt abe-content-root abe-block-leading Block abe-noPadding" style={{ backgroundColor: '#fff' }}>
          {unfinished.length ? (
            <div className="abe-verticalPadding">
              <p><b style={ARIAL}>Continue a paused paper</b></p>
              <p><span style={ARIAL}>&nbsp;</span></p>
              <table style={{ borderCollapse: 'collapse', ...ARIAL }}>
                <tbody>
                  {unfinished.map((u) => {
                    const left = u.durationSec == null ? null : Math.max(0, u.durationSec - (u.elapsedSec ?? 0));
                    return (
                      <tr key={u.id}>
                        <td style={td}>{u.title}</td>
                        <td style={td}>{u.answered} answered</td>
                        <td style={td}>{left == null ? 'untimed' : `${Math.floor(left / 60)} minutes left`}</td>
                        <td style={td}>
                          <button type="button" className="pv-setup-btn" data-tele="continue-sitting"
                            onClick={() => { window.location.href = `/exam?id=${encodeURIComponent(u.id)}`; }}>Continue</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="abe-verticalPadding">
            <p><b style={ARIAL}>Choose a test</b></p>
            <p><span style={ARIAL}>&nbsp;</span></p>
            {sets.length === 0 ? <p><span style={ARIAL}>No transcribed papers yet.</span></p> : null}
            <table style={{ borderCollapse: 'collapse', ...ARIAL, minWidth: 620 }}>
              <thead><tr><th style={{ ...th, width: 30 }} /><th style={th}>Author</th><th style={th}>Set</th><th style={th}>Papers</th></tr></thead>
              <tbody>
                {groups.map(([collection, list]) => list.map((s, i) => (
                  <tr key={s.key} onClick={() => setSetKey(s.key)} style={{ cursor: 'default' }} data-tele={`set-${s.key}`}>
                    <td style={td}><input type="radio" name="pv-set" checked={setKey === s.key} onChange={() => setSetKey(s.key)} /></td>
                    <td style={td}>{i === 0 ? collection : ''}</td>
                    <td style={td}>{s.title}</td>
                    <td style={td}>{[s.papers[1] ? 'Paper 1' : null, s.papers[2] ? 'Paper 2' : null].filter(Boolean).join(', ')}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>

          {chosen && has1 && has2 ? (
            <div className="abe-verticalPadding">
              <p><b style={ARIAL}>Which papers</b></p>
              <p><span style={ARIAL}>&nbsp;</span></p>
              {[
                ['both', 'Paper 1, then Paper 2 (the full test, with the interval between them)'],
                ['p1', 'Paper 1 only'],
                ['p2', 'Paper 2 only'],
              ].map(([id, label]) => (
                <p key={id} style={{ margin: '0 0 10px' }}><label style={ARIAL}>
                  <input type="radio" name="pv-which" checked={which === id} onChange={() => setWhich(id)} data-tele={`which-${id}`} />{' '}{label}
                </label></p>
              ))}
            </div>
          ) : null}

          <div className="abe-verticalPadding">
            <p><b style={ARIAL}>Timing</b></p>
            <p><span style={ARIAL}>&nbsp;</span></p>
            {TIMINGS.map((t) => (
              <p key={t.id} style={{ margin: '0 0 10px' }}><label style={ARIAL}>
                <input type="radio" name="pv-timing" checked={timing === t.id} onChange={() => setTiming(t.id)} data-tele={`timing-${t.id}`} />{' '}{t.label}
                <span style={{ color: '#555' }}> — {t.note}</span>
              </label></p>
            ))}
          </div>

          <div className="abe-verticalPadding">
            <p><b style={ARIAL}>Options</b></p>
            <p><span style={ARIAL}>&nbsp;</span></p>
            {[
              [shuffle, setShuffle, 'Shuffle the question order', 'shuffle'],
              [extraTime, setExtraTime, '25% extra time (access arrangement)', 'extra'],
              [allowPause, setAllowPause, 'Show the Pause Exam button (practice only — the real test has none)', 'pause'],
              [explain, setExplain, 'Show the Explain Answer button (practice only — as in the untimed sample test)', 'explain'],
            ].map(([on, set, label, tele]) => (
              <p key={tele} style={{ margin: '0 0 10px' }}><label style={ARIAL}>
                <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} data-tele={`opt-${tele}`}
                  disabled={tele === 'extra' && timing === 'untimed'} />{' '}{label}
              </label></p>
            ))}
          </div>

          <div className="abe-verticalPadding">
            {error ? <p><span style={{ ...ARIAL, color: '#c00' }}>{error}</span></p> : null}
            <p><span style={ARIAL}>The test opens in full screen. Click the </span><b style={ARIAL}>Start Test (S)</b><span style={ARIAL}> button when you are ready.</span></p>
          </div>
        </div>
      </div>
    </Driver>
  );
}

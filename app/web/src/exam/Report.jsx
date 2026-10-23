// /exam/report?ids=a,b — the analysis page a sitting lands on after Finish.
//
// This is deliberately NOT the driver look: the test is over, so the page switches back
// to the app's own house style (app.css tokens) — the same visual language as the rest
// of Monday. One card per paper, a combined line when both papers were sat, then every
// question with time, changes, revisits and flags, worst first where it matters.
import React, { useEffect, useMemo, useState } from 'react';
import katex from 'katex';
import './report.css';

const get = async (url) => {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
};

function texHtml(src) {
  const s = String(src ?? '');
  let out = ''; let last = 0;
  const re = /\$\$([\s\S]+?)\$\$|\$([^$]+)\$/g;
  let m;
  const esc = (x) => x.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    try { out += katex.renderToString(m[1] ?? m[2], { displayMode: Boolean(m[1]), throwOnError: false }); } catch { out += esc(m[0]); }
    last = m.index + m[0].length;
  }
  return out + esc(s.slice(last));
}
const Tex = ({ children }) => <span dangerouslySetInnerHTML={{ __html: texHtml(children) }} />;

const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

function TimeBars({ questions, budget }) {
  const max = Math.max(budget * 2, ...questions.map((q) => q.timeSec ?? 0), 1);
  const W = 640; const H = 120; const bw = W / questions.length;
  return (
    <svg className="rp-bars" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Time per question">
      <line x1="0" x2={W} y1={H - (budget / max) * H} y2={H - (budget / max) * H} className="rp-budget" />
      {questions.map((q, i) => {
        const h = ((q.timeSec ?? 0) / max) * H;
        const cls = q.correct === false ? 'wrong' : q.correct === true ? 'right' : 'unmarked';
        return (
          <g key={q.qnum}>
            <rect x={i * bw + 2} y={H - h} width={bw - 4} height={Math.max(1, h)} className={`rp-bar ${cls}`}>
              <title>{`Q${i + 1}: ${mmss(q.timeSec)}${q.correct === false ? ' — wrong' : ''}`}</title>
            </rect>
            <text x={i * bw + bw / 2} y={H + 13} textAnchor="middle" className="rp-barlabel">{i + 1}</text>
          </g>
        );
      })}
    </svg>
  );
}

function PaperCard({ r }) {
  const s = r.score;
  const budget = r.sitting.durationSec ? r.sitting.durationSec / r.questions.length : 225;
  const wrong = r.questions.filter((q) => q.correct === false);
  const slow = [...r.questions].filter((q) => (q.timeSec ?? 0) > budget * 1.5).sort((a, b) => b.timeSec - a.timeSec);
  const changedToWrong = r.questions.filter((q) => q.changes > 0 && q.correct === false);
  const flaggedWrong = r.questions.filter((q) => q.flagged && q.correct === false);
  const unanswered = r.questions.filter((q) => !q.yourAnswer);
  const ord = (q) => r.sitting.order.indexOf(q.qnum) + 1;
  const list = (qs) => (qs.length ? qs.map((q) => `Q${ord(q)}`).join(', ') : 'none');

  return (
    <section className="rp-card">
      <header className="rp-card-head">
        <div>
          <div className="rp-eyebrow">{r.sitting.section ? `Paper ${r.paper.paper ?? r.sitting.section}` : 'Paper'}</div>
          <h2>{r.paper.title}</h2>
          <div className="rp-sub">
            {r.sitting.durationSec == null ? 'Untimed' : `${Math.round(r.sitting.durationSec / 60)} minutes`}
            {r.sitting.shuffle ? ' · shuffled' : ''}{r.sitting.extraTime ? ' · 25% extra time' : ''}
            {r.sitting.reason === 'ended' ? ' · ended early' : ''}
          </div>
        </div>
        <div className="rp-score">
          {r.paper.marked ? <><b>{s.raw}</b><span>/{s.outOf}</span></> : <span className="rp-unmarked">not marked</span>}
          {s.gradeLabel ? <div className="rp-grade">≈ grade {s.gradeLabel}</div> : null}
        </div>
      </header>

      <dl className="rp-facts">
        <div><dt>Answered</dt><dd>{s.answered}/{s.outOf}</dd></div>
        <div><dt>Time used</dt><dd>{mmss(s.totalTimeSec)}</dd></div>
        <div><dt>Per question</dt><dd>{mmss(s.avgPerQuestionSec)}</dd></div>
        <div><dt>Flagged</dt><dd>{r.questions.filter((q) => q.flagged).length}</dd></div>
      </dl>

      <div className="rp-section-title">Time per question <span className="rp-muted">(line = even pace, {mmss(budget)})</span></div>
      <TimeBars questions={r.questions} budget={budget} />

      <div className="rp-section-title">What stands out</div>
      <ul className="rp-notes">
        <li><b>Wrong:</b> {list(wrong)}</li>
        <li><b>Over 1.5× pace:</b> {list(slow)}</li>
        <li><b>Changed answer and ended wrong:</b> {list(changedToWrong)}</li>
        <li><b>Flagged and wrong:</b> {list(flaggedWrong)}</li>
        {unanswered.length ? <li><b>Left blank:</b> {list(unanswered)}</li> : null}
      </ul>

      <div className="rp-section-title">Every question</div>
      <table className="rp-table">
        <thead><tr><th>#</th><th>Question</th><th>Yours</th><th>Key</th><th>Time</th><th>Changes</th><th>Visits</th><th /></tr></thead>
        <tbody>
          {r.questions.map((q, i) => (
            <tr key={q.qnum} className={q.correct === false ? 'wrong' : q.correct === true ? 'right' : ''}>
              <td>{i + 1}</td>
              <td className="rp-stem"><Tex>{String(q.stem ?? '').split('\n')[0]}</Tex></td>
              <td>{q.yourAnswer ?? '—'}</td>
              <td>{q.correctAnswer ?? '—'}</td>
              <td>{mmss(q.timeSec)}</td>
              <td>{q.changes || ''}</td>
              <td>{q.revisits ? q.revisits + 1 : 1}</td>
              <td>{q.flagged ? '⚑' : ''}{q.correct === true ? ' ✓' : q.correct === false ? ' ✗' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function Report() {
  const ids = useMemo(() => (new URLSearchParams(window.location.search).get('ids') ?? '').split(',').filter(Boolean), []);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        // The finish call may still be landing when Finish is clicked; retry briefly.
        const one = async (id) => {
          for (let i = 0; i < 6; i += 1) {
            try { return await get(`/api/exam/results?id=${encodeURIComponent(id)}`); } catch (e) {
              if (i === 5) throw e;
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          return null;
        };
        setResults(await Promise.all(ids.map(one)));
      } catch (e) { setError(String(e.message || e)); }
    })();
  }, [ids]);

  const total = results && results.length > 1 && results.every((r) => r.paper.marked)
    ? { raw: results.reduce((a, r) => a + r.score.raw, 0), outOf: results.reduce((a, r) => a + r.score.outOf, 0) }
    : null;

  return (
    <div className="rp-page">
      <div className="rp-top">
        <div>
          <div className="rp-eyebrow">Monday · test analysis</div>
          <h1>{results?.[0]?.paper.title?.replace(/\s*Paper\s*[12]\s*$/i, '') ?? 'Your test'}</h1>
        </div>
        <div className="rp-actions">
          <a className="rp-btn" href="/exam">Sit another</a>
          <a className="rp-btn primary" href="/">Back to Monday</a>
        </div>
      </div>
      {error ? <div className="rp-error">{error}</div> : null}
      {!results && !error ? <div className="rp-muted">Loading your analysis…</div> : null}
      {total ? (
        <div className="rp-total">
          <span>Both papers</span><b>{total.raw}</b><span>/{total.outOf}</span>
          <span className="rp-muted">· {results.map((r) => `Paper ${r.paper.paper}: ${r.score.raw}/${r.score.outOf}`).join(' · ')}</span>
        </div>
      ) : null}
      {results?.map((r) => <PaperCard key={r.sitting.id} r={r} />)}
      <p className="rp-muted rp-foot">The full record — every selection, change, revisit and second — is saved with the sitting. Ask Monday for a post-mortem of it at any time.</p>
    </div>
  );
}

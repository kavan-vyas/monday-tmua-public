// ═══════════════ PAPER FLOW — guided per-question rework of a JZ mock ═══════════════
// The right-hand panel of the flow layout (video | paper / MS | this). For each question:
// attempt it cold with the QP showing, Reveal (the MS replaces it, the correct letter and
// R2D2's review video appear), mark Y / M / N, write what happened, Next. One pausable
// paper clock; the seconds spent on each question are recorded separately. Everything
// autosaves to the server, so a reload resumes on the same question. Finish writes the
// ledger rows and puts every n / m in the backlog.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAttention } from './attention.js';

const N_Q = 20;
const MARK_LABEL = { y: 'Y — got it', m: 'M — maybe', n: 'N — wrong' };
const BUCKETS = [['didnt_know', "didn't know"], ['slipped', 'slipped'], ['timing', 'timing']];
const DEFAULT_BUCKET = { n: 'didnt_know', m: 'slipped' };

const clock = (sec) => {
  const s = Math.max(0, Math.round(Math.abs(sec)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then((r) => r.json());

/** Which page of `path` holds question `qnum` — the server's page index, else page 1. */
async function pageOf(path, ref, kind) {
  try {
    const q = new URLSearchParams({ path, ref, exam: 'TMUA', kind });
    const d = await (await fetch(`/api/question-page?${q}`)).json();
    if (Number(d?.page) > 0) return Number(d.page);
  } catch { /* opens at the top */ }
  return 1;
}

// ── the picker: shown when no paper is chosen ───────────────────────────────────
function Picker({ onPick }) {
  const [papers, setPapers] = useState(null);
  useEffect(() => { fetch('/api/paperflow/list?collection=jz').then((r) => r.json()).then((d) => setPapers(d.papers ?? [])).catch(() => setPapers([])); }, []);
  if (!papers) return <div className="pf-empty">Loading papers…</div>;
  return (
    <div className="pf-picker">
      <div className="pf-title">🎬 JZ flow — pick a paper</div>
      <div className="pf-pick-grid">
        {papers.map((p) => (
          <button key={p.id} className={`pf-pick ${p.status}`} onClick={() => onPick(p.id)}>
            <b>{p.short}</b>
            <span>{p.status === 'new' ? 'not started'
              : p.status === 'finished' ? `done · ${p.tally.y} y ${p.tally.m} m ${p.tally.n} n`
                : `in progress · ${p.marked}/20 marked, on Q${p.current}`}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function PaperFlowTab({ paper, mode, onPick, onPdf, onVideo, onExit }) {
  const [st, setSt] = useState(null);
  const [answers, setAnswers] = useState({});
  const [paths, setPaths] = useState({ qp: null, ms: null });
  const [video, setVideo] = useState(null);       // {id,title} | {id:null,query}
  const [held, setHeld] = useState(false);        // the ⏸ button
  const [resumeBanner, setResumeBanner] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);     // after Finish
  const [error, setError] = useState(null);
  const attentive = useAttention(mode);
  const running = attentive && !held && st?.status !== 'finished' && !result;
  const dirty = useRef({});                       // pending per-question patches
  const stRef = useRef(null);
  stRef.current = st;

  // load (or resume) the paper
  useEffect(() => {
    if (!paper) return;
    setSt(null); setResult(null); setError(null); setVideo(null);
    fetch(`/api/paperflow/state?paper=${paper}`).then((r) => r.json()).then((d) => {
      if (d.error) { setError(d.error); return; }
      setSt(d.state); setAnswers(d.answers ?? {}); setPaths({ qp: d.qp, ms: d.ms });
      // Coming back to a paper with work in it: the clock waits for "Continue", so the
      // seconds spent finding your place and settling in never count.
      const begun = Object.values(d.state.questions ?? {}).some((x) => x.mark || x.seconds > 0 || x.comment);
      setHeld(begun);
      setResumeBanner(begun && d.state.status !== 'finished');
      if (d.state.status === 'finished') setResult(d.state.result);
    }).catch((e) => setError(String(e)));
  }, [paper]);

  const q = st ? st.current : 1;
  const cur = st?.questions?.[String(q)];
  const ref = (n) => `JZ S${(paper ?? '').split('_')[1]?.toUpperCase()} P${(paper ?? '').slice(-1)} Q${n}`;

  // put a PDF in the middle at question n: the mark scheme (ms=true) or the paper
  const showPdf = useCallback(async (n, ms) => {
    const path = ms ? paths.ms : paths.qp;
    if (!path) return;
    onPdf?.(path, await pageOf(path, ref(n), ms ? 'ms' : 'qp'), ms ? 'ms' : 'qp');
  }, [paths.qp, paths.ms, paper]); // eslint-disable-line react-hooks/exhaustive-deps

  // the middle follows the current question: the paper until it is revealed, then the MS
  useEffect(() => { if (st && paths.qp) showPdf(q, !!cur?.revealed); }, [q, paths.qp]); // eslint-disable-line react-hooks/exhaustive-deps

  // the review video: looked up once per paper, loaded on the first reveal
  const loadVideo = useCallback(async () => {
    if (video?.id) return;
    const v = video ?? await fetch(`/api/paperflow/video?paper=${paper}`).then((r) => r.json()).catch(() => ({ id: null }));
    setVideo(v);
    if (v?.id) onVideo?.(v.id, v.title);
  }, [video, paper, onVideo]);

  // ── save: merge locally at once, flush to the server every few seconds ─────────
  const patchQ = useCallback((n, fields) => {
    setSt((s) => (s ? { ...s, questions: { ...s.questions, [String(n)]: { ...s.questions[String(n)], ...fields } } } : s));
    dirty.current[String(n)] = { ...(dirty.current[String(n)] ?? {}), ...fields };
  }, []);
  const flush = useCallback(async (extra = {}) => {
    const s = stRef.current;
    if (!s || s.status === 'finished' || !paper) return;
    const qs = dirty.current; dirty.current = {};
    if (!Object.keys(qs).length && !Object.keys(extra).length) return;
    // seconds always go up as an absolute value, never a delta, so a retried save is safe
    for (const k of Object.keys(qs)) qs[k].seconds = s.questions[k].seconds;
    await post('/api/paperflow/state', { paper, patch: { questions: qs, ...extra } }).catch(() => { Object.assign(dirty.current, qs); });
  }, [paper]);
  useEffect(() => { const iv = setInterval(() => flush(), 5000); return () => { clearInterval(iv); flush(); }; }, [flush]);

  // Lid shut, tab switched or window closed: save NOW (a beacon survives the page
  // unloading) and hold the clock, so coming back is a deliberate "Continue".
  useEffect(() => {
    const away = () => {
      if (document.visibilityState === 'visible') return;
      const s = stRef.current;
      if (!s || s.status === 'finished' || !paper) return;
      const qs = dirty.current; dirty.current = {};
      for (const k of Object.keys(qs)) qs[k].seconds = s.questions[k].seconds;
      try {
        navigator.sendBeacon('/api/paperflow/state', JSON.stringify({ paper, patch: { questions: qs, current: s.current } }));
      } catch { Object.assign(dirty.current, qs); }
      setHeld(true);
      setResumeBanner(true);
    };
    document.addEventListener('visibilitychange', away);
    window.addEventListener('pagehide', away);
    return () => { document.removeEventListener('visibilitychange', away); window.removeEventListener('pagehide', away); };
  }, [paper]);

  const pauseAndClose = async () => { setHeld(true); await flush({ current: stRef.current?.current }); onExit?.(); };
  const cont = () => { setHeld(false); setResumeBanner(false); };

  // ── the clock: one tick a second adds to the CURRENT question while running ────
  useEffect(() => {
    if (!running) return undefined;
    const iv = setInterval(() => {
      const s = stRef.current;
      if (!s) return;
      const n = s.current;
      patchQ(n, { seconds: (s.questions[String(n)].seconds ?? 0) + 1 });
    }, 1000);
    return () => clearInterval(iv);
  }, [running, patchQ]);

  const go = useCallback((n) => {
    const target = Math.min(N_Q, Math.max(1, n));
    setSt((s) => (s ? { ...s, current: target } : s));
    flush({ current: target });
  }, [flush]);

  const reveal = useCallback(() => {
    patchQ(q, { revealed: true });
    showPdf(q, true);
    loadVideo();
  }, [q, patchQ, showPdf, loadVideo]);

  const mark = useCallback((m) => {
    patchQ(q, { mark: m, bucket: m === 'y' ? null : (cur?.bucket ?? DEFAULT_BUCKET[m]), revealed: true });
    if (!cur?.revealed) { showPdf(q, true); loadVideo(); }
  }, [q, cur, patchQ, showPdf, loadVideo]);

  // keys: 1/2/3 = Y/M/N, R = reveal, → / ← = next / prev (never while typing)
  useEffect(() => {
    const onKey = (e) => {
      if (!st || result || e.target.closest?.('textarea, input')) return;
      if (e.key === '1') mark('y'); else if (e.key === '2') mark('m'); else if (e.key === '3') mark('n');
      else if (e.key === 'r' || e.key === 'R') reveal();
      else if (e.key === 'ArrowRight') go(q + 1); else if (e.key === 'ArrowLeft') go(q - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [st, result, mark, reveal, go, q]);

  const finish = async () => {
    setSaving(true);
    await flush();
    const r = await post('/api/paperflow/finish', { paper }).catch((e) => ({ error: String(e) }));
    setSaving(false);
    if (r.error) { setError(r.error); return; }
    setResult(r);
    setSt((s) => (s ? { ...s, status: 'finished' } : s));
  };

  if (!paper) return <Picker onPick={onPick} />;
  if (error) return <div className="pf-empty">⚠ {error} <button className="btn tiny" onClick={() => onPick(null)}>Back to papers</button></div>;
  if (!st) return <div className="pf-empty">Loading…</div>;

  const qs = st.questions;
  const spent = Object.values(qs).reduce((a, x) => a + (x.seconds || 0), 0);
  const left = st.durationSec - spent;
  const tally = { y: 0, m: 0, n: 0 };
  for (const x of Object.values(qs)) if (x.mark) tally[x.mark] += 1;
  const marked = tally.y + tally.m + tally.n;

  if (result) {
    return (
      <div className="pf">
        <div className="pf-title">{st.title} — saved</div>
        <div className="pf-score"><b className="m-y">{result.tally.y} Y</b> <b className="m-m">{result.tally.m} M</b> <b className="m-n">{result.tally.n} N</b> · {result.marked} marked · {clock(result.totalSec)}</div>
        <div className="pf-note">{result.backlog.length} added to the backlog ({result.backlog.map((b) => `Q${b.qnum}`).join(', ') || 'none'}). Ledger and activity log updated.</div>
        <div className="pf-row">
          <button className="btn" onClick={() => onPick(null)}>Another paper</button>
          <button className="btn" onClick={onExit}>Close flow</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pf">
      <div className="pf-top">
        <div className="pf-title">{st.title}</div>
        <span className="quick-spacer" />
        <button className="btn tiny" onClick={() => onPick(null)} title="pick another paper (progress is saved)">Papers</button>
        <button className="btn tiny" onClick={pauseAndClose} title="save everything, stop the clock and restore your normal layout — pick it up later from 🎬 Continue">⏸ Pause &amp; close</button>
      </div>

      <div className="pf-clock-row">
        <span className={`pf-clock ${left <= 0 ? 'up' : left <= 300 ? 'low' : ''}`}>{running ? '⏱' : '⏸'} {left < 0 ? `+${clock(-left)}` : clock(left)}</span>
        <span className="pf-sub">of {clock(st.durationSec)} · Q{q}: {clock(cur.seconds)}</span>
        <span className="quick-spacer" />
        <button className="btn tiny" onClick={() => (held ? cont() : setHeld(true))}>{held ? '▶ Resume' : '⏸ Pause'}</button>
      </div>

      {resumeBanner && held && (
        <div className="pf-resume">
          <div>
            <b>Paused on Q{q}</b> · {marked}/20 marked · {left < 0 ? `+${clock(-left)} over` : `${clock(left)} left`}.
            <br />Everything is saved — the clock starts when you continue.
          </div>
          <button className="btn primary" onClick={cont}>▶ Continue</button>
        </div>
      )}

      <div className="pf-dots">
        {Array.from({ length: N_Q }, (_, i) => i + 1).map((n) => (
          <button key={n} className={`pf-dot ${qs[String(n)].mark ? `m-${qs[String(n)].mark}` : ''} ${n === q ? 'on' : ''}`}
            onClick={() => go(n)} title={`Q${n}${qs[String(n)].mark ? ` — ${qs[String(n)].mark}` : ''}`}>{n}</button>
        ))}
      </div>

      <div className="pf-card">
        <div className="pf-q">Question {q}</div>
        {!cur.revealed ? (
          <>
            <div className="pf-note">Attempt it cold from the paper in the middle. The mark scheme and video stay hidden until you reveal.</div>
            <button className="btn pf-reveal" onClick={reveal}>Reveal mark scheme + video <kbd>R</kbd></button>
          </>
        ) : (
          <div className="pf-note">
            Answer: <b>{answers[String(q)] ?? '—'}</b>
            {video && !video.id && (
              <> · <a href={`https://www.youtube.com/results?search_query=${encodeURIComponent(video.query ?? '')}`} target="_blank" rel="noreferrer">search YouTube</a> (no video found)</>
            )}
            {' · '}<button className="btn tiny" onClick={() => showPdf(q, false)}>📄 paper</button>{' '}
            <button className="btn tiny" onClick={() => showPdf(q, true)}>🔑 MS</button>
          </div>
        )}

        <div className="pf-marks">
          {['y', 'm', 'n'].map((m, i) => (
            <button key={m} className={`btn pf-mark m-${m} ${cur.mark === m ? 'on' : ''}`} onClick={() => mark(m)}>
              {MARK_LABEL[m]} <kbd>{i + 1}</kbd>
            </button>
          ))}
        </div>

        {(cur.mark === 'm' || cur.mark === 'n') && (
          <div className="pf-buckets">
            {BUCKETS.map(([k, label]) => (
              <button key={k} className={`btn tiny ${cur.bucket === k ? 'on' : ''}`} onClick={() => patchQ(q, { bucket: k })}>{label}</button>
            ))}
          </div>
        )}

        <textarea className="pf-comment" placeholder="What happened — how you went wrong, what to do next time…"
          value={cur.comment} onChange={(e) => patchQ(q, { comment: e.target.value })} />

        <div className="pf-row">
          <button className="btn" disabled={q === 1} onClick={() => go(q - 1)}>← Prev</button>
          <span className="quick-spacer" />
          {q < N_Q
            ? <button className="btn" onClick={() => go(q + 1)}>Next →</button>
            : <button className="btn primary" disabled={!marked || saving} onClick={finish}>{saving ? 'Saving…' : `Finish & save (${marked} marked)`}</button>}
        </div>
      </div>

      <div className="pf-foot">
        <span><b className="m-y">{tally.y}</b> y · <b className="m-m">{tally.m}</b> m · <b className="m-n">{tally.n}</b> n · {marked}/20</span>
        <span className="quick-spacer" />
        {marked > 0 && q < N_Q && <button className="btn tiny" disabled={saving} onClick={finish}>Finish now</button>}
      </div>
    </div>
  );
}

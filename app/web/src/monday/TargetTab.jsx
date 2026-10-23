// ═══════════════ MONDAY — 8.5+ pane ═══════════════
// One page: how far the record is from 8.5 (35/40), where the marks leak, and the
// day-by-day plan to the exam with tick boxes. Everything but the ticks is derived on
// the server from the ledger + backlog (GET /api/target85); ticks persist through
// POST /api/target85/task.
import React, { useCallback, useEffect, useState } from 'react';

const pretty = (t) => String(t).replace(/_/g, ' ');
const LOGIC = new Set(['logical_deduction', 'sufficiency_or_necessity', 'proof', 'mcq_eliminate_options']);
const dayLabel = (d, today, exam) => {
  if (d === exam) return 'Exam day';
  if (d === today) return 'Today';
  const dt = new Date(`${d}T12:00:00Z`);
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};

// Full timed sittings out of 40, one bar each, with the 35 line drawn across.
function SittingsChart({ full, need }) {
  const [hover, setHover] = useState(null);
  const W = 420; const H = 200; const padL = 28; const padB = 26; const padT = 12;
  const lo = 20; const hi = 40;
  const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
  const slot = (W - padL) / Math.max(full.length, 1);
  const bw = Math.min(44, slot * 0.5);
  return (
    <div className="t85-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Full timed official sittings, marks out of 40">
        {[20, 25, 30, 35, 40].map((v) => (
          <g key={v}>
            <line x1={padL} x2={W} y1={y(v)} y2={y(v)} className="t85-grid" />
            <text x={padL - 6} y={y(v) + 3} className="t85-axis" textAnchor="end">{v}</text>
          </g>
        ))}
        {full.map((s, i) => {
          const x = padL + slot * i + (slot - bw) / 2;
          return (
            <g key={s.year} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + slot * i} y={padT} width={slot} height={H - padT - padB} fill="transparent" />
              <path className={`t85-bar${hover === i ? ' on' : ''}`}
                d={`M${x},${y(lo)} V${y(s.total) + 4} q0,-4 4,-4 H${x + bw - 4} q4,0 4,4 V${y(lo)} Z`} />
              <text x={x + bw / 2} y={y(s.total) - 6} className="t85-val" textAnchor="middle">{s.total}</text>
              <text x={x + bw / 2} y={H - 8} className="t85-axis" textAnchor="middle">{s.year}</text>
            </g>
          );
        })}
        <line x1={padL} x2={W} y1={y(need)} y2={y(need)} className="t85-target" />
        <text x={W - 2} y={y(need) - 5} className="t85-target-label" textAnchor="end">8.5 = {need}</text>
      </svg>
      {hover != null ? (
        <div className="t85-tip" style={{ left: `${((padL + slot * hover + slot / 2) / W) * 100}%` }}>
          <b>TMUA {full[hover].year}</b> · {full[hover].total}/40 → {full[hover].grade}
          <div>P1 {full[hover].p1}/20 · P2 {full[hover].p2}/20 · {full[hover].date}</div>
          <div>{full[hover].total >= need ? 'at 8.5+' : `${need - full[hover].total} short of 8.5`}</div>
        </div>
      ) : null}
    </div>
  );
}

export default function TargetTab({ onOpenBacklog, onOpenPdf, onExam }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [table, setTable] = useState(false);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    fetch('/api/target85').then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setD).catch((e) => setErr(`could not load: ${e.message}`));
  }, []);
  useEffect(() => { load(); }, [load]);

  const task = (body) => fetch('/api/target85/task', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).then((r) => { if (r.plan) setD((x) => ({ ...x, plan: r.plan })); });

  if (!d) return <div className="t85-tab"><div className="t85-empty">{err || 'loading…'}</div></div>;

  const need = d.target.mark;
  const latest = d.latest;
  const p1Gap = latest ? Math.max(0, d.perPaperNeed.P1 - latest.p1) : null;
  const p2Gap = latest ? Math.max(0, d.perPaperNeed.P2 - latest.p2) : null;
  const logic = d.leaks.byType.filter((t) => LOGIC.has(t.type));
  const logicWrong = logic.reduce((a, t) => a + t.wrong, 0);
  const logicAtt = logic.reduce((a, t) => a + t.attempted, 0);
  const sittings = Math.max(d.full.length, 1);
  const p1Refs = d.leaks.byType.flatMap((t) => t.refs.filter((r) => / P1 /.test(r)).map(() => t.type));
  const p1Calc = p1Refs.filter((t) => t === 'mcq_direct_calculation').length;
  const maxRate = Math.max(...d.leaks.byType.map((t) => t.rate), 1);

  const days = [...new Set(d.plan.tasks.map((t) => t.day))].sort();
  const done = d.plan.tasks.filter((t) => t.done).length;
  const act = (t) => {
    if (t.action === 'backlog') return <button className="btn tiny" onClick={onOpenBacklog}>Backlog →</button>;
    if (t.action === 'doom') return <button className="btn tiny" onClick={() => onOpenPdf('tutor_data/doom/doom.pdf', 'Doom')}>Doom PDF →</button>;
    if (t.action === 'exam') return <button className="btn tiny" onClick={onExam}>Exam →</button>;
    return null;
  };

  return (
    <div className="t85-tab">
      <div className="rd-bar">
        <span className="rd-title">8.5+</span>
        <span className={`rd-count${d.daysLeft <= 3 ? ' hot' : ''}`}>{d.daysLeft} days to {d.examDate}</span>
        <span className="rd-count">plan {done}/{d.plan.tasks.length}</span>
        <button className="btn tiny" onClick={load} style={{ marginLeft: 'auto' }}>↻</button>
      </div>

      <div className="t85-body">
        <section className="t85-heroes">
          <div className="t85-hero"><div className="t85-num">{latest ? latest.total : '–'}<span>/40</span></div><div className="t85-lab">latest full sitting · {latest?.grade ?? '–'}</div></div>
          <div className="t85-hero goal"><div className="t85-num">{need}<span>/40</span></div><div className="t85-lab">needed for 8.5</div></div>
          <div className="t85-hero"><div className="t85-num">{d.gap ? `+${d.gap}` : '✓'}</div><div className="t85-lab">{d.gap ? `marks to find · ${Math.ceil(d.gap / 2)} per paper` : 'at 8.5: now make it repeatable'}</div></div>
          <div className="t85-hero"><div className="t85-num">{d.avgP1 ?? '–'}<span> / </span>{d.avgP2 ?? '–'}</div><div className="t85-lab">P1 / P2 · last two of each</div></div>
        </section>

        <section className="t85-card">
          <h3>{d.gap ? `Where the ${d.gap} marks are` : `At ${need}+: where the margin comes from`}</h3>
          <ul className="t85-where">
            <li><b>Paper 1:</b> {latest?.p1}/20 → <b>{d.perPaperNeed.P1}</b> {p1Gap ? `(+${p1Gap})` : '✓'}. {p1Calc} of your {p1Refs.length} timed P1 misses are <i>direct calculation</i>, mostly slips you logged. Fix: write every line, ± on every root, and substitute back into the options.</li>
            <li><b>Paper 2:</b> {latest?.p2}/20 → <b>{d.perPaperNeed.P2}</b> {p2Gap ? `(+${p2Gap})` : '✓'}. On logic, sufficiency and proof questions you get {logicWrong} of {logicAtt} wrong ({Math.round((100 * logicWrong) / Math.max(logicAtt, 1))}%), against about 17% on calculation. That is about {(logicWrong / sittings).toFixed(1)} marks per sitting, and the biggest single lever.</li>
            <li><b>Exam room:</b> 3:45 per question. Skip at 5 minutes and flag it. One stuck question costs two easy ones.</li>
          </ul>
        </section>

        <section className="t85-card">
          <div className="t85-cardhead">
            <h3>Full timed sittings</h3>
            <button className="btn tiny" onClick={() => setTable((v) => !v)}>{table ? 'Chart' : 'Table'}</button>
          </div>
          {table ? (
            <table className="t85-table">
              <thead><tr><th>Paper</th><th>Marks</th><th>Date</th></tr></thead>
              <tbody>
                {d.papers.map((p) => <tr key={p.key}><td>TMUA {p.key}</td><td>{p.correct}/20</td><td>{p.date}</td></tr>)}
                {d.full.map((s) => <tr key={s.year} className="sum"><td>TMUA {s.year} total</td><td>{s.total}/40 → {s.grade}</td><td>{s.date}</td></tr>)}
              </tbody>
            </table>
          ) : <SittingsChart full={d.full} need={need} />}
        </section>

        <section className="t85-card">
          <h3>Where marks leak: wrong rate by question type (timed official papers)</h3>
          <div className="t85-leaks">
            {d.leaks.byType.map((t) => (
              <div key={t.type} className="t85-leak" title={t.refs.join(', ')}>
                <span className="t85-leak-name">{pretty(t.type)}</span>
                <span className="t85-leak-track"><span className={`t85-leak-fill${LOGIC.has(t.type) ? ' hot' : ''}`} style={{ width: `${(t.rate / maxRate) * 100}%` }} /></span>
                <span className="t85-leak-n">{t.wrong}/{t.attempted} · {t.rate}%</span>
              </div>
            ))}
          </div>
        </section>

        <section className="t85-card">
          <h3>Exactly what to do</h3>
          {days.map((day) => (
            <div key={day} className={`t85-day${day === d.today ? ' today' : ''}${day < d.today ? ' past' : ''}`}>
              <div className="t85-dayname">{dayLabel(day, d.today, d.examDate)}</div>
              {d.plan.tasks.filter((t) => t.day === day).map((t) => (
                <div key={t.id} className={`t85-task${t.done ? ' done' : ''}`}>
                  <input type="checkbox" checked={!!t.done} onChange={(e) => task({ id: t.id, done: e.target.checked })} />
                  <div className="t85-task-text">
                    <div>{t.text}</div>
                    {t.why ? <div className="t85-why">{t.why}</div> : null}
                  </div>
                  {act(t)}
                  <button className="t85-x" title="remove" onClick={() => task({ id: t.id, remove: true })}>×</button>
                </div>
              ))}
            </div>
          ))}
          <form className="t85-add" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { task({ text: draft.trim(), day: d.today }); setDraft(''); } }}>
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="add a task for today…" />
            <button className="btn tiny" type="submit">Add</button>
          </form>
        </section>

        <section className="t85-card">
          <div className="t85-cardhead">
            <h3>Rework first: official papers, slips first ({d.backlog.official} official · {d.backlog.due} due of {d.backlog.open})</h3>
            <button className="btn tiny" onClick={onOpenBacklog}>Backlog →</button>
          </div>
          <table className="t85-table">
            <thead><tr><th>Question</th><th>Bucket</th><th>Topic</th><th>Due</th></tr></thead>
            <tbody>
              {d.backlog.priority.map((i) => (
                <tr key={i.id} className={i.due <= d.today ? 'due' : ''}><td>{i.ref}</td><td>{pretty(i.bucket ?? '')}</td><td>{pretty(i.topic ?? '')}</td><td>{i.due}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

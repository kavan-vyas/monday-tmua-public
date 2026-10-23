// The improvement board — the model behind the published dashboard.
//
// ONE headline number: the share of every question he has ever logged that is either
// right first time or has since been reworked. The only thing that holds it below 100%
// is a question he got wrong (or flagged "maybe") and has not gone back to. Rework the
// whole pile and it reads 100%, whatever the first-time accuracy was. First-time
// accuracy is still reported, but as a secondary figure — it describes the past, and
// nothing he does today can move it; this number moves every time he reworks one.
//
// Pure: takes records in, returns a plain object. No fs, so it is unit-tested directly.
//
// ANONYMITY: output is published. Refs, topics, dates and the notes already public in
// questions.json only — never the backlog's detail/correction lines.

const DAY = 86400000;
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => iso(new Date(`${d}T00:00:00Z`).getTime() + n * DAY);
const round1 = (n) => Math.round(n * 10) / 10;
const pct = (n, d) => (d > 0 ? round1((100 * n) / d) : 100);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s);
const minDate = (...ds) => ds.filter(isDate).map((d) => d.slice(0, 10)).sort()[0] ?? null;

/** Monday of the ISO week containing `d`. */
export function weekOf(d) {
  const t = new Date(`${d.slice(0, 10)}T00:00:00Z`);
  const dow = (t.getUTCDay() + 6) % 7;
  return iso(t.getTime() - dow * DAY);
}

/**
 * Which paper a question belongs to, and its label within that paper. Every id scheme
 * the record has used is handled; anything unrecognised becomes its own one-question
 * paper rather than being dropped.
 */
export function paperOf(id) {
  const s = String(id ?? '').trim();
  let m;
  if ((m = s.match(/^MAT (\d{4})([A-J])$/))) return { paper: `MAT ${m[1]}`, q: m[2], family: 'MAT' };
  if ((m = s.match(/^(\d{4}) P(\d) Q(\d+)$/))) return { paper: `TMUA ${m[1]} P${m[2]}`, q: `Q${m[3]}`, family: 'TMUA' };
  if ((m = s.match(/^TMUA (\d{4}|practice|specimen)\s*P(\d) (Q.+)$/i))) return { paper: `TMUA ${m[1]} P${m[2]}`, q: m[3], family: 'TMUA' };
  if ((m = s.match(/^STEP (\d{4})\s*Q(\d+)$/))) return { paper: `STEP ${m[1]}`, q: `Q${m[2]}`, family: 'STEP' };
  if ((m = s.match(/^(.+?) Q(\d+)$/))) return { paper: m[1], q: `Q${m[2]}`, family: 'MOCK' };
  return { paper: s || 'Other', q: '·', family: 'OTHER' };
}

const qNum = (q) => { const m = String(q).match(/\d+/); return m ? Number(m[0]) : String(q).charCodeAt(0) - 64; };

/**
 * Classify one question.
 *   clean     never wrong, never flagged
 *   todo      wrong or flagged, and not yet gone back to   ← the only thing below 100%
 *   reworked  gone back to, and the latest go was right
 *   retry     gone back to, but the latest go was wrong    (still counts: it was reviewed)
 * A flagged-but-correct question needs review only if it went into the backlog; a
 * shaky note with no backlog item was a question he got right and annotated.
 */
export function classify(q, item, queueEntry) {
  const hist = Array.isArray(item?.history) ? item.history.filter((h) => h && h.date) : [];
  const wrong = q ? q.ever_wrong === true || q.correct === false : true;
  const flagged = !wrong && (q?.status === 'shaky') && !!item;
  const needed = wrong || flagged;
  let state = 'clean';
  let reviewedOn = null;
  let lastResult = null;
  if (needed) {
    if (hist.length) {
      reviewedOn = hist.map((h) => h.date).sort()[0];
      lastResult = hist[hist.length - 1].result ?? null;
      state = item.status === 'done' || lastResult === 'pass' ? 'reworked' : 'retry';
    } else if (item && Number(item.tier) > 1) {
      // A rung above the first is only reached by a right rework, so the rework
      // happened even where no history row survived (early migrations). Date it to
      // the start of the current rung.
      state = 'reworked';
      reviewedOn = isDate(item.due) ? addDays(item.due.slice(0, 10), -Number(item.tier)) : item.created ?? null;
    } else if (item?.status === 'done') {
      state = 'reworked';
      reviewedOn = minDate(item.closed, item.due, item.created);
    } else if (q?.status === 'resolved') {
      state = 'reworked';
      reviewedOn = q.last_date ?? null;
    } else if ((queueEntry?.times_reviewed ?? 0) > 0) {
      state = 'reworked';
      reviewedOn = queueEntry.review_date ?? null;
    } else {
      state = 'todo';
    }
  }
  return { state, wrong, flagged, reviewedOn, lastResult, reworks: hist.length };
}

/**
 * Build the board.
 * @param {object} p
 * @param {Array}  p.questions   buildQuestions() output (one row per question, canonical_id set)
 * @param {Array}  p.backlog     backlog.json items
 * @param {Array}  p.reviewQueue session_memory.review_queue
 * @param {Array}  p.activityDays activity.json days (for streaks)
 * @param {Array}  p.sittings    simulator sittings (finished)
 * @param {string} p.today       YYYY-MM-DD
 * @param {string} p.examDate    YYYY-MM-DD
 */
export function computeBoard({ questions = [], backlog = [], reviewQueue = [], activityDays = [], sittings = [], today, examDate }) {
  const byCid = new Map(backlog.filter((i) => i.cid).map((i) => [i.cid, i]));
  const byRef = new Map(backlog.map((i) => [i.ref, i]));
  const queue = new Map(reviewQueue.map((r) => [r.year == null && r.part ? String(r.part) : `${r.paper || 'MAT'} ${r.year}${r.part}`, r]));
  const used = new Set();

  // Earliest date anything was logged, so undated rows (bulk self-study imports) sit at
  // the start of the timeline instead of vanishing from it.
  const allDates = [
    ...questions.map((q) => q.first_date), ...backlog.map((i) => i.created),
  ].filter(isDate).sort();
  const origin = allDates[0] ?? today;

  const rows = [];
  for (const q of questions) {
    const item = byCid.get(q.canonical_id) ?? byRef.get(q.id) ?? null;
    if (item) used.add(item);
    const c = classify(q, item, queue.get(q.id));
    const p = paperOf(q.id);
    rows.push({
      id: q.id, paper: p.paper, q: p.q, family: p.family, exam: q.exam, topic: q.topic ?? 'unknown',
      state: c.state, wrong: c.wrong, flagged: c.flagged,
      // Only the question's own date. An undated row (bulk imports) stays undated —
      // borrowing the backlog item's creation date made a paper look sat the day it was filed.
      first: q.first_date ?? null,
      reviewed_on: c.reviewedOn, reworks: c.reworks, last_result: c.lastResult,
      attempts: q.attempts ?? 1,
      due: item && item.status !== 'done' ? item.due ?? null : null,
      tier: item && item.status !== 'done' ? item.tier ?? null : null,
      seconds: item?.time_seconds || null,
      note: q.misconception || q.shaky_note || q.note || q.description || null,
    });
  }
  // Backlog items that never became a question row (logged straight into the app).
  for (const item of backlog) {
    if (used.has(item)) continue;
    const c = classify(null, item, null);
    const p = paperOf(item.ref);
    rows.push({
      id: item.ref, paper: p.paper, q: p.q, family: p.family, exam: item.exam, topic: item.topic ?? 'unknown',
      state: c.state, wrong: true, flagged: false,
      first: item.created ?? null, reviewed_on: c.reviewedOn, reworks: c.reworks, last_result: c.lastResult,
      attempts: 1,
      due: item.status !== 'done' ? item.due ?? null : null,
      tier: item.status !== 'done' ? item.tier ?? null : null,
      seconds: item.time_seconds || null,
      note: null,
    });
  }

  const count = (list, s) => list.filter((r) => r.state === s).length;
  const total = rows.length;
  const todo = count(rows, 'todo');
  const flaggedTotal = rows.filter((r) => r.wrong || r.flagged).length;
  const firstTimeRight = rows.filter((r) => !r.wrong).length;

  // ── the curve: improved % at the end of every day ────────────────────────────
  const firstOf = (r) => (isDate(r.first) ? r.first.slice(0, 10) : origin);
  const reviewOf = (r) => (r.state === 'todo' || r.state === 'clean' ? null : (isDate(r.reviewed_on) ? r.reviewed_on.slice(0, 10) : firstOf(r)));
  const series = [];
  for (let d = origin; d <= today; d = addDays(d, 1)) {
    let n = 0; let owed = 0;
    for (const r of rows) {
      if (firstOf(r) > d) continue;
      n += 1;
      if ((r.wrong || r.flagged) && r.state !== 'clean') {
        const rv = reviewOf(r);
        if (!rv || rv > d) owed += 1;
      }
    }
    series.push({ date: d, total: n, todo: owed, pct: pct(n - owed, n) });
  }

  // ── rework events, for pace and the weekly digest ────────────────────────────
  const events = [];
  for (const item of backlog) {
    for (const h of item.history ?? []) if (h?.date) events.push({ date: h.date.slice(0, 10), result: h.result, seconds: h.seconds ?? null, topic: item.topic, ref: item.ref });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // ── papers: one row of tiles each, newest first ──────────────────────────────
  const papers = new Map();
  for (const r of rows) {
    const p = papers.get(r.paper) ?? { paper: r.paper, family: r.family, exam: r.exam, date: null, tiles: [] };
    p.date = minDate(p.date, r.first);
    p.tiles.push(r);
    papers.set(r.paper, p);
  }
  const paperList = [...papers.values()].map((p) => {
    p.tiles.sort((a, b) => qNum(a.q) - qNum(b.q) || String(a.q).localeCompare(String(b.q)));
    const n = p.tiles.length;
    return {
      paper: p.paper, family: p.family, exam: p.exam, date: p.date, n,
      clean: count(p.tiles, 'clean'), todo: count(p.tiles, 'todo'),
      reworked: count(p.tiles, 'reworked'), retry: count(p.tiles, 'retry'),
      first_time: pct(p.tiles.filter((t) => !t.wrong).length, n),
      pct: pct(n - count(p.tiles, 'todo'), n),
      tiles: p.tiles.map((t) => t.id),
    };
  }).sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || a.paper.localeCompare(b.paper));

  // ── topics ───────────────────────────────────────────────────────────────────
  const topics = new Map();
  for (const r of rows) {
    const t = topics.get(r.topic) ?? { topic: r.topic, n: 0, clean: 0, todo: 0, reworked: 0, retry: 0, wrong: 0 };
    t.n += 1; t[r.state] += 1; if (r.wrong) t.wrong += 1;
    topics.set(r.topic, t);
  }
  const topicList = [...topics.values()].map((t) => ({
    ...t, pct: pct(t.n - t.todo, t.n), first_time: pct(t.n - t.wrong, t.n),
  })).sort((a, b) => b.todo - a.todo || a.pct - b.pct || b.n - a.n);

  // ── weekly digest: the brief timeline ────────────────────────────────────────
  const weeks = new Map();
  const wk = (d) => { const k = weekOf(d); if (!weeks.has(k)) weeks.set(k, { week: k, logged: 0, wrong: 0, reworks: 0, passes: 0, papers: new Set() }); return weeks.get(k); };
  for (const r of rows) {
    if (!isDate(r.first)) continue;
    const w = wk(r.first); w.logged += 1; if (r.wrong) w.wrong += 1;
    w.papers.add(r.paper);
  }
  for (const e of events) { const w = wk(e.date); w.reworks += 1; if (e.result === 'pass') w.passes += 1; }
  const pctAt = (d) => { const hit = [...series].reverse().find((s) => s.date <= d); return hit ? hit.pct : 100; };
  const weekList = [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).map((w) => {
    const end = addDays(w.week, 6) > today ? today : addDays(w.week, 6);
    const before = addDays(w.week, -1);
    return {
      week: w.week, end, logged: w.logged, wrong: w.wrong, reworks: w.reworks, passes: w.passes,
      papers: [...w.papers].sort(), pct: pctAt(end), delta: round1(pctAt(end) - pctAt(before)),
    };
  }).reverse();

  // ── pace, projection, streak ─────────────────────────────────────────────────
  const since = (days) => events.filter((e) => e.date > addDays(today, -days) && e.date <= today);
  const last14 = since(14);
  const perDay = round1(last14.length / 14);
  const clearDays = todo === 0 ? 0 : perDay > 0 ? Math.ceil(todo / perDay) : null;
  const daysLeft = examDate ? Math.max(0, Math.round((new Date(`${examDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / DAY)) : null;
  const needPerDay = daysLeft ? round1(todo / daysLeft) : null;
  const due = backlog.filter((i) => i.status !== 'done' && i.due && i.due <= today).length;

  const worked = new Set(activityDays.filter((d) => (d.level ?? 0) >= 2).map((d) => d.date));
  for (const e of events) worked.add(e.date);
  // A streak survives until the day is over: today not yet worked still counts
  // yesterday's run.
  let streak = 0;
  for (let d = worked.has(today) ? today : addDays(today, -1); worked.has(d); d = addDays(d, -1)) streak += 1;
  let best = 0; let run = 0;
  for (const d of [...worked].sort()) {
    run = worked.has(addDays(d, -1)) ? run + 1 : 1;
    best = Math.max(best, run);
  }

  const passes = events.filter((e) => e.result === 'pass').length;
  const timed = backlog.filter((i) => (i.time_seconds ?? 0) > 0);
  const avgRework = timed.length ? Math.round(timed.reduce((s, i) => s + i.time_seconds, 0) / timed.length) : null;
  const ladder = [1, 7, 21].map((tier) => ({ tier, count: backlog.filter((i) => i.status !== 'done' && i.tier === tier).length }));
  ladder.push({ tier: 'done', count: backlog.filter((i) => i.status === 'done').length });

  const peak = series.reduce((m, s) => (s.pct >= (m?.pct ?? -1) ? s : m), null);
  const low = series.reduce((m, s) => (s.pct < (m?.pct ?? 101) ? s : m), null);
  const weekAgo = pctAt(addDays(today, -7));

  const markedSittings = sittings.filter((s) => s.raw != null);

  return {
    generated: today,
    headline: {
      pct: pct(total - todo, total),
      todo, total,
      per_rework: total ? Math.round(10000 / total) / 100 : 0,
      week_delta: round1(pct(total - todo, total) - weekAgo),
      reviewed: flaggedTotal - todo,
      flagged: flaggedTotal,
    },
    next: {
      due, days_left: daysLeft, exam_date: examDate ?? null,
      pace_per_day: perDay, clear_in_days: clearDays, need_per_day: needPerDay,
      on_track: clearDays != null && daysLeft != null ? clearDays <= daysLeft : null,
    },
    stats: {
      first_time_pct: pct(firstTimeRight, total),
      first_time_right: firstTimeRight,
      questions: total,
      papers: paperList.length,
      topics: topicList.length,
      reworks: events.length,
      rework_pass_pct: pct(passes, events.length),
      reworks_14d: last14.length,
      avg_rework_sec: avgRework,
      streak, best_streak: best,
      days_worked: worked.size,
      mocks_sat: paperList.filter((p) => p.family === 'MOCK').length,
      sittings: sittings.length,
      best_sitting: markedSittings.length ? Math.max(...markedSittings.map((s) => s.percent ?? 0)) : null,
      peak: peak ? { pct: peak.pct, date: peak.date } : null,
      low: low ? { pct: low.pct, date: low.date } : null,
      ladder,
      states: { clean: count(rows, 'clean'), reworked: count(rows, 'reworked'), retry: count(rows, 'retry'), todo },
    },
    series,
    weeks: weekList,
    papers: paperList,
    topics: topicList,
    questions: rows,
  };
}

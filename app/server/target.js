// The 8.5+ page: one place that says how far he is from 8.5 and exactly what to do about
// it before the exam.
//
// 8.5 is 35/40 on the grade table (design/gradeTable.js, the same table the simulator and
// the dashboard use). Everything here is DERIVED from the record on each request — the
// timed official sittings in the ledger, the open backlog, the tag index — except the
// plan's tick boxes, which live in tutor_data/target85.json so they survive a reload.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA } from './paths.js';
import { GRADE_TABLE, gradeForMark, minMarkForGrade } from '../design/gradeTable.js';
import { budgetFor } from './backlog.js';

const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const BACKLOG = path.join(TUTOR_DATA, 'backlog.json');
const TMUA_INDEX = path.join(TUTOR_DATA, 'reference', 'tmua_full_tag_index.json');
const PLAN_FILE = path.join(TUTOR_DATA, 'target85.json');
const BOARD = path.join(TUTOR_DATA, 'dashboard-site', 'data', 'board.json');

export const TARGET_GRADE = 8.5;
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, p);
};
const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => iso(new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000));

// ── the plan ────────────────────────────────────────────────────────────────────
// Seeded once, then his: tasks can be ticked, added and removed. `action` is what the
// task's button does in the app ('backlog', 'doom', 'exam', 'flow', or none).
function seedPlan(today, examDate) {
  const d = (n) => addDays(today, n);
  const t = (day, text, why, action = null) => ({ id: `t${Math.random().toString(36).slice(2, 9)}`, day, text, why, action, done: false });
  return {
    created: today,
    examDate,
    tasks: [
      t(d(1), 'Rework the 9 new 2022 backlog items cold, timed (P1 Q8, Q13, Q16, Q17 · P2 Q9, Q16, Q17, Q19, Q20)',
        'Converting three of these nine is 32 → 35. For each one, decide: real slip, or a method gap?', 'backlog'),
      t(d(1), 'Read Mathematical Doom → Logic & Proof part (MAJOR entries only)',
        'Four of the five P2 misses were "which conclusions must follow" questions.', 'doom'),
      t(d(2), 'Sit TMUA 2019 Paper 1 + Paper 2: timed 75 min each, randomised, on the sim site',
        'Your one unseen official sitting left — the closest thing to the real test. Log it here after.'),
      t(d(3), 'Rework every 2019 wrong answer cold the next morning, before looking at the solution',
        'Converting this week\'s misses is worth more than any new paper.', 'backlog'),
      t(d(3), 'Clear everything due in the backlog (slips first)', 'Slips are the cheapest marks there are.', 'backlog'),
      t(d(4), 'One last timed paper: Specimen P2 (or Practice P2) — Paper 2 only, 75 min',
        'Paper 2 is the weaker paper (avg below P1); one more rep of its timing.'),
      t(d(5), 'Light day: The Doom Rules page + backlog due only. No new papers.', 'Fresh beats crammed.', 'doom'),
      t(d(5), 'In bed by 22:30', 'Sleep is one of your three pillars for a reason — it is worth marks tomorrow.'),
      t(examDate, 'Exam: 3:45 per question budget · skip at 5 min and flag · sketch every graph · write ± on every root · reread the last line of each stem',
        'Your own Doom rules that cost the most marks this term.'),
    ],
  };
}

export function readPlan(today = iso(Date.now())) {
  const mem = readJson(SESSION_MEMORY, {});
  const examDate = mem.exam_date ?? '2026-10-12';
  let plan = readJson(PLAN_FILE);
  if (!plan) { plan = seedPlan(today, examDate); writeJson(PLAN_FILE, plan); }
  return plan;
}

export function updateTask({ id, done, text, day, remove } = {}) {
  const plan = readPlan();
  if (!id && text) {
    const t = { id: `t${Math.random().toString(36).slice(2, 9)}`, day: day ?? iso(Date.now()), text: String(text).slice(0, 300), why: '', action: null, done: false };
    plan.tasks.push(t);
  } else {
    const t = plan.tasks.find((x) => x.id === id);
    if (!t) return { error: 'no such task' };
    if (remove) plan.tasks = plan.tasks.filter((x) => x.id !== id);
    else {
      if (typeof done === 'boolean') { t.done = done; t.doneAt = done ? new Date().toISOString() : null; }
      if (typeof text === 'string' && text.trim()) t.text = text.slice(0, 300);
      if (typeof day === 'string') t.day = day;
    }
  }
  writeJson(PLAN_FILE, plan);
  return plan;
}

// ── the numbers ─────────────────────────────────────────────────────────────────
/** Timed official sittings from the ledger: one row per paper, pairs by year. */
export function officialSittings(rows) {
  const papers = new Map();
  for (const r of rows) {
    const m = /^(20\d\d|Practice|Specimen) (P[12]) Q(\d+)$/.exec(String(r.qid ?? ''));
    if (!m || !r.timed) continue;
    const key = `${m[1]} ${m[2]}`;
    if (!papers.has(key)) papers.set(key, { key, year: m[1], paper: m[2], n: 0, correct: 0, date: r.date, qs: [] });
    const p = papers.get(key);
    p.n += 1; if (r.correct === true) p.correct += 1;
    if (r.date > p.date) p.date = r.date;
    p.qs.push(r);
  }
  const list = [...papers.values()].filter((p) => p.n >= 20).sort((a, b) => a.date.localeCompare(b.date));
  const byYear = new Map();
  for (const p of list) { if (!byYear.has(p.year)) byYear.set(p.year, {}); byYear.get(p.year)[p.paper] = p; }
  const full = [...byYear.entries()].filter(([, v]) => v.P1 && v.P2).map(([year, v]) => {
    const total = v.P1.correct + v.P2.correct;
    return { year, p1: v.P1.correct, p2: v.P2.correct, total, grade: gradeForMark(total), date: v.P2.date > v.P1.date ? v.P2.date : v.P1.date };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { papers: list.map(({ qs, ...p }) => p), full };
}

/** Where the marks go: wrong answers on timed official papers by question type. */
function leaks(rows, index) {
  const tag = new Map(index.map((q) => [q.id, q]));
  const count = new Map();
  let wrongTotal = 0;
  for (const r of rows) {
    const m = /^(20\d\d) (P[12]) Q(\d+)$/.exec(String(r.qid ?? ''));
    if (!m || !r.timed) continue;
    const q = tag.get(`TMUA${m[1]}${m[2]}Q${m[3].padStart(2, '0')}`);
    if (!q) continue;
    const type = q.question_type ?? 'other';
    const c = count.get(type) ?? { type, attempted: 0, wrong: 0, refs: [] };
    c.attempted += 1;
    if (r.correct !== true) { c.wrong += 1; wrongTotal += 1; c.refs.push(`${m[1]} ${m[2]} Q${m[3]}`); }
    count.set(type, c);
  }
  return {
    wrongTotal,
    byType: [...count.values()].filter((c) => c.wrong).sort((a, b) => b.wrong - a.wrong || b.attempted - a.attempted)
      .map((c) => ({ ...c, rate: Math.round((100 * c.wrong) / c.attempted) })),
  };
}

export function computeTarget(now = Date.now()) {
  const today = iso(now);
  const mem = readJson(SESSION_MEMORY, {});
  const rows = mem.questions_attempted ?? [];
  const examDate = mem.exam_date ?? '2026-10-12';
  const daysLeft = Math.max(0, Math.round((Date.parse(`${examDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000));
  const needMark = minMarkForGrade(TARGET_GRADE);
  const { papers, full } = officialSittings(rows);
  const best = full.reduce((b, s) => (!b || s.total > b.total ? s : b), null);
  const latest = full[full.length - 1] ?? null;
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  const p1 = papers.filter((p) => p.paper === 'P1');
  const p2 = papers.filter((p) => p.paper === 'P2');
  const recent = (arr) => arr.slice(-2);
  const avgP1 = avg(recent(p1).map((p) => p.correct));
  const avgP2 = avg(recent(p2).map((p) => p.correct));
  const projected = avgP1 != null && avgP2 != null ? Math.round(avgP1 + avgP2) : null;

  const backlog = (readJson(BACKLOG, { items: [] }).items ?? []).filter((i) => i.status !== 'done');
  const due = backlog.filter((i) => i.due <= today);
  
  const order = { slipped: 0, timing: 1, didnt_know: 2 };
  const isOfficial = (i) => /^(20\d\d|Practice|Specimen) P[12] Q\d+$/.test(i.ref);
  const priority = [...backlog].sort((a, b) =>
    (isOfficial(b) - isOfficial(a)) || ((order[a.bucket] ?? 3) - (order[b.bucket] ?? 3)) || a.due.localeCompare(b.due))
    .slice(0, 10)
    .map((i) => ({ id: i.id, ref: i.ref, bucket: i.bucket, due: i.due, topic: i.topic, budget: budgetFor(i) }));

  const board = readJson(BOARD, {})?.headline ?? null;
  return {
    today,
    examDate,
    daysLeft,
    target: { grade: TARGET_GRADE, mark: needMark, table: GRADE_TABLE.filter(([m]) => m >= 28 && m <= 38) },
    best, latest, full, papers,
    avgP1: avgP1 == null ? null : Math.round(avgP1 * 10) / 10,
    avgP2: avgP2 == null ? null : Math.round(avgP2 * 10) / 10,
    projected, projectedGrade: projected == null ? null : gradeForMark(projected),
    gap: best ? Math.max(0, needMark - best.total) : needMark,
    perPaperNeed: { P1: Math.ceil(needMark / 2), P2: Math.floor(needMark / 2) },
    leaks: leaks(rows, readJson(TMUA_INDEX, { questions: [] }).questions ?? []),
    backlog: { open: backlog.length, due: due.length, official: backlog.filter(isOfficial).length, priority },
    clearance: board,
    plan: readPlan(today),
  };
}

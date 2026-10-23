// Spaced-repetition backlog, implementing the sprint plan's standing rules:
//   "Revisits. +1 day, +7 days, +21 days."
//   "Definition of done. A question closes only when reworked correctly from a
//    blank sheet, at least a day later, solution unseen."
//   Buckets: didn't know it / slipped / ran out of time.
//
// Every mistake is ranked 1 / 7 / 21 when logged. Completing a revisit promotes it
// to the next tier; clearing 21 closes it. A failed revisit drops back to tier 1.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TUTOR_DATA } from './paths.js';
import { canonicalId } from './canonical.js';
import { insightForCanonical } from './tagindex.js';

const FILE = path.join(TUTOR_DATA, 'backlog.json');
const STATE = path.join(TUTOR_DATA, '.backlog-state.json');

export const TIERS = [1, 7, 21];
/** Exams whose questions close on a first clean rework instead of climbing the tiers. */
export const NO_CYCLE = new Set(['MAT']);
export const BUCKETS = ['didnt_know', 'slipped', 'timing'];
export const EXAMS = ['TMUA', 'MAT', 'STEP', 'OTHER'];

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let idc = 0;
const newId = () => `b${Date.now().toString(36)}${(idc++).toString(36)}`;

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { items: Array.isArray(j.items) ? j.items : [] };
  } catch {
    return { items: [] };
  }
}
function write(store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(store, null, 2));
}

/**
 * Key for duplicate detection.
 *
 * A ref that canonical.js can place on an actual paper keys on that canonical id, so every
 * spelling of one question collapses to one key: "JAM Q11", "James Chen 2025 Paper 1 Q11"
 * and "JC 25 P1 Q11" are the same backlog item, and — the reason this changed — "Chen 2025
 * Paper 1 Q11" and "Chen 2026 Paper 1 Q11" are NOT. Under the old strip-the-noise rule
 * both lost the word "paper" and the year did the distinguishing only by luck; a source
 * with four papers instead of one needed the identity to be real.
 *
 * Anything canonical.js cannot place (it says so by leaving a ? in the id) falls back to
 * the loose form: strip source-name noise and punctuation, compare exam + question number.
 */
export function refKey(exam, ref) {
  const canon = canonicalId(exam, ref);
  if (canon && !canon.includes('?')) return `${String(exam ?? '').toUpperCase()}|${canon}`;
  const r = String(ref ?? '')
    .toLowerCase()
    .replace(/\b(jam|test|chen|james|paper|custom|mock)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return `${String(exam ?? '').toUpperCase()}|${r}`;
}

// ── timing as a second axis ─────────────────────────────────────────────────
// A rework used to produce one bit: pass or fail. That is the wrong shape for an
// exam that does not ask "can you do this question" but "can you do it in 3:45
// while nineteen others wait". Every attempt now also records how long it took and
// what it was measured against, on the history entry beside the result.
//
// Per-paper pace, scaled two ways:
//   difficulty — a 1/5 remainder-theorem question and a 4/5 trapezium-symmetry
//     question should not share a budget. The 1-5 rubric is on every indexed
//     question already, and rides along on the item as `insight.difficulty`.
//   tier squeeze — a question seen twice should be FASTER than exam pace, not
//     equal to it. Still needing the full 3:45 on the third exposure means the
//     method never consolidated; you are re-deriving it every time. The standard
//     rises as the interval lengthens.
const PACE_BASE = { TMUA: 225, MAT: 600, STEP: 1800, OTHER: 225 }; // TMUA: 75min / 20Q
const TIER_SQUEEZE = { 1: 1.0, 7: 0.9, 21: 0.8 };

export function budgetFor(it) {
  const base = PACE_BASE[it?.exam] ?? PACE_BASE.OTHER;
  // `> 0`, not just finite: Number(null) is 0 and Number.isFinite(0) is true, so a
  // difficulty of null would score as a 0/5 question and hand it a 158-second budget —
  // the same null-read-as-zero mistake the seconds field is guarded against.
  const diff = Number(it?.insight?.difficulty);
  const scale = 0.7 + 0.15 * (Number.isFinite(diff) && diff > 0 ? diff : 3);
  return Math.round(base * scale * (TIER_SQUEEZE[it?.tier] ?? 1));
}

// Grade the band, do not just threshold it — a 4-minute answer and a 9-minute
// answer are not the same failure. Past 4x it is "walked away", not "slow": the
// same judgement DailyTime makes when it refuses to count a 5-second gap as study.
export const PACE_SLOW = 1.0;      // over budget at all
export const PACE_FAIL = 1.5;      // badly over
export const PACE_ABANDONED = 4.0; // not a measurement of anything

export function paceBand(seconds, budget) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0 || !budget) return null;
  const r = seconds / budget;
  if (r > PACE_ABANDONED) return 'abandoned';
  if (r > PACE_FAIL) return 'timing_fail';
  if (r > PACE_SLOW) return 'slow';
  return 'clean';
}

// SHADOW MODE. Record and display everything; enforce nothing. There is no timing
// history at all yet, and a gate calibrated on nothing feels arbitrary — you stop
// trusting the queue, which costs more than the gate wins. Flip this on once
// paceStats has real medians (~40 timed attempts) and tune the budgets to the
// actual distribution rather than to this file's arithmetic.
export const ENFORCE_PACE = true;

// What the gate makes of one attempt. Three outcomes, not two: 'slow' is a correct
// answer that took too long, and it is neither a pass (nothing consolidated — he is
// still re-deriving it) nor a fail (the method is there). A null band means the attempt
// was never timed, and silence is not evidence of slowness, so it grades as a pass.
export function paceOutcome(result, band) {
  if (result === 'fail') return 'fail';
  return band && band !== 'clean' ? 'slow' : 'pass';
}

/** Find one item by id or exact/fuzzy ref. For tools that read a single question. */
export function findItem(idOrRef) {
  const items = read().items;
  const direct = items.find((x) => x.id === idOrRef || x.ref === idOrRef);
  if (direct) return direct;
  const key = refKey(null, idOrRef);
  return items.find((x) => refKey(x.exam, x.ref) === refKey(x.exam, idOrRef))
    || items.find((x) => key && key.split('|')[1] && refKey(x.exam, x.ref).endsWith(key.split('|')[1]))
    || null;
}

export function addItem({ exam, ref, topic, bucket, tier, detail, correction }) {
  const store = read();
  const t = TIERS.includes(Number(tier)) ? Number(tier) : 1;

  // If an OPEN entry already covers this question, enrich it rather than duplicate.
  // Detail/correction fill in if they were blank; the sooner due date wins so a
  // re-log never pushes a review further out.
  const key = refKey(exam, ref);
  const dup = store.items.find((x) => x.status !== 'done' && refKey(x.exam, x.ref) === key && key.includes('|') && key.split('|')[1]);
  if (dup) {
    if (detail && !dup.detail) dup.detail = detail;
    if (correction && !dup.correction) dup.correction = correction;
    if (topic && (!dup.topic || dup.topic === 'unknown')) dup.topic = topic;
    write(store);
    return { ...dup, _merged: true };
  }
  const exOut = EXAMS.includes(String(exam).toUpperCase()) ? String(exam).toUpperCase() : 'OTHER';
  const refOut = String(ref ?? '').slice(0, 80);
  const item = {
    id: newId(),
    created: today(),
    cid: canonicalId(exOut, refOut),
    exam: exOut,
    ref: refOut,
    topic: topic ?? 'unknown',
    bucket: BUCKETS.includes(bucket) ? bucket : 'didnt_know',
    tier: t,
    due: addDays(today(), t),
    detail: detail ?? '',
    correction: correction ?? '',
    status: 'open',
    history: [],
  };
  // Attach the tag-index entry now. budgetFor reads insight.difficulty on every pass,
  // so an item created without it silently gets the default-3 budget for life — which
  // is what happened to every mock question logged before this line existed.
  const ins = insightForCanonical(item.cid);
  if (ins) item.insight = ins;
  store.items.push(item);
  write(store);
  return item;
}

// result: 'pass' promotes to the next tier (21 closes it); 'fail' resets to tier 1.
// `seconds` is THIS attempt alone. time_seconds keeps the lifetime total, but a total
// cannot answer "was that one fast enough" — it only ever grows, so a 14-minute
// lifetime says nothing about whether today's sitting was 3:40 or 10:20.
export function completeItem(id, result = 'pass', note = '', seconds = null) {
  const store = read();
  const it = store.items.find((x) => x.id === id || x.ref === id);
  if (!it) return { error: `No backlog item "${id}".` };
  if (it.status === 'done') return { error: `"${it.ref}" is already closed.` };

  // Read the budget the question had going IN. Taken after the tier moves, a promotion
  // would regrade the attempt against the tighter squeeze of a tier it had not reached
  // while the clock was running — the same attempt scored two different ways.
  const budget = budgetFor(it);
  const n = Number(seconds);
  // null is not 0. An untimed attempt stays untimed for good: a 0 here reads as
  // instant and perfect, and would promote questions on evidence that never existed.
  const secs = seconds != null && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  const band = paceBand(secs, budget);
  const gate = paceOutcome(result, band);

  // Snapshot enough to put it back: an accidental double-click on REWORKED is the
  // whole reason undoItem exists, and it cannot guess a due date it never recorded.
  // `at` orders two actions taken on the same question on the same day. bucket_before
  // joins them because the gate is the first thing that ever rewrites a bucket.
  it.history.push({
    date: today(), at: new Date().toISOString(), tier: it.tier, result, note,
    due_before: it.due, status_before: it.status, bucket_before: it.bucket,
    seconds: secs, budget, pace: band, pace_gate: gate,
  });
  if (secs != null) it.time_seconds = (Number(it.time_seconds) || 0) + secs;

  // LIVE since the exam simulator started producing timed attempts. The axis shipped in
  // shadow mode because the backlog had no real timed history to calibrate against — every
  // `seconds` was null and the bands were theory. A JZ sitting produces twenty measured
  // attempts at once, so the gate now steers the schedule: `gate` decides, not `result`
  // alone. Setting this back to false restores the old pass/fail scheduling exactly.
  const outcome = ENFORCE_PACE ? gate : (result === 'fail' ? 'fail' : 'pass');
  if (outcome === 'fail') {
    it.tier = 1;
    it.due = addDays(today(), 1);
  } else if (outcome === 'slow') {
    // Tier held rather than lost: the method is there, the pace is not, and dropping
    // to 1 day would re-teach something he already knows. Two days is short enough
    // that the second sitting still remembers the method being drilled.
    it.bucket = 'timing';
    it.due = addDays(today(), 2);
  } else if (NO_CYCLE.has(String(it.exam).toUpperCase())) {
    // MAT does not cycle. Q1 is a bank of 240 distinct multiple-choice items, not a deck
    // to be re-drilled: once he has reworked one cold, the value is in the next unseen
    // part, not in seeing that one again in three weeks. TMUA and the mocks still cycle,
    // because there the same twenty questions ARE the exam.
    it.status = 'done';
    it.closed = today();
    it.due = null;
  } else {
    const next = TIERS[TIERS.indexOf(it.tier) + 1];
    if (next === undefined) {
      it.status = 'done';
      it.closed = today();
      it.due = null;
    } else {
      it.tier = next;
      it.due = addDays(today(), next);
    }
  }
  write(store);
  return it;
}

/**
 * Reverse the most recent pass/fail, restoring the tier, due date and open/closed state
 * it had before. For the misclick: a stray double-click on REWORKED COLD promotes a
 * question you never actually redid, or closes it outright, and the spacing is then a
 * lie. Undo pops the history entry too, so the record does not claim work that happened.
 */
export function undoItem(id) {
  const store = read();
  const it = store.items.find((x) => x.id === id || x.ref === id);
  if (!it) return { error: `No backlog item "${id}".` };
  const h = Array.isArray(it.history) ? it.history : [];
  if (!h.length) return { error: `"${it.ref}" has nothing to undo.` };
  const last = h.pop();
  it.tier = TIERS.includes(Number(last.tier)) ? Number(last.tier) : 1;
  // Entries written before this function existed carry no snapshot. The question was
  // being reworked, so it was ripe: put it back on today's list rather than invent a date.
  it.due = last.due_before ?? today();
  it.status = last.status_before ?? 'open';
  // Once the gate enforces, a 'slow' verdict rewrites the bucket to 'timing'. Undo has
  // to put that back or an undone mark leaves the question permanently relabelled —
  // the one mutation completeItem makes that the tier/due snapshot does not cover.
  if (last.bucket_before) it.bucket = last.bucket_before;
  if (it.status !== 'done') delete it.closed;
  write(store);
  return it;
}

/**
 * Correct an entry in place.
 *
 * Without this the only way to fix a mislabelled item was to add a corrected copy and
 * fail the original, which left both in the due list as duplicates — exactly what
 * happened when a run of TMUA 2018 Paper 1 questions had been logged as MAT Q1.
 * Only the fields passed are touched; scheduling (tier/due) is deliberately untouched,
 * because relabelling what a question IS should not reset when it comes back.
 */
export function editItem(id, patch = {}) {
  const store = read();
  const it = store.items.find((x) => x.id === id || x.ref === id);
  if (!it) return null;
  for (const k of ['exam', 'ref', 'topic', 'bucket', 'detail', 'correction']) {
    if (patch[k] !== undefined && patch[k] !== null && String(patch[k]).trim() !== '') {
      it[k] = String(patch[k]).trim();
    }
  }
  if (patch.exam) it.exam = EXAMS.includes(it.exam.toUpperCase()) ? it.exam.toUpperCase() : 'OTHER';
  if (patch.bucket && !BUCKETS.includes(it.bucket)) it.bucket = 'didnt_know';
  write(store);
  return it;
}

/**
 * Attach a note to an item. author is 'student' or 'monday'; both write to the same
 * item so the two can read each other's notes. Passing text replaces that author's
 * note wholesale (the UI autosaves the full textarea), keeping one live note per side
 * plus a light history stamp. Empty text clears it.
 */
export function addNote(id, author = 'student', text = '') {
  const store = read();
  const it = store.items.find((x) => x.id === id || x.ref === id);
  if (!it) return null;
  const who = author === 'monday' ? 'monday' : 'student';
  if (!it.notes || typeof it.notes !== 'object' || Array.isArray(it.notes)) it.notes = { student: [], monday: [] };
  it.notes[who] = String(text ?? '');
  it.notes_updated = { ...(it.notes_updated || {}), [who]: today() };
  write(store);
  return it;
}

/**
 * Accumulate time spent on an item (seconds), fed by the driven "Do backlog" session's
 * per-question timer. Additive, so multiple sittings sum. The number is the student's
 * own pace data — Monday may see aggregate pace but never grades.
 */
export function addTime(id, seconds = 0) {
  const store = read();
  const it = store.items.find((x) => x.id === id || x.ref === id);
  if (!it) return null;
  const s = Number(seconds);
  if (Number.isFinite(s) && s > 0) it.time_seconds = (Number(it.time_seconds) || 0) + Math.round(s);
  write(store);
  return it;
}

/** Delete outright. For duplicates and things logged in error — not for finished work,
 *  which goes through completeItem so the history survives. */
export function removeItem(id) {
  const store = read();
  const i = store.items.findIndex((x) => x.id === id || x.ref === id);
  if (i === -1) return null;
  const [gone] = store.items.splice(i, 1);
  write(store);
  return gone;
}

// When a question was last marked pass/fail. `at` is a full timestamp on new entries
// and orders two actions on the same day; older entries only have the date.
export const lastAction = (i) => (Array.isArray(i.history) && i.history.length ? i.history[i.history.length - 1] : null);
const actionStamp = (i) => { const h = lastAction(i); return h ? (h.at ?? `${h.date}T00:00:00.000Z`) : ''; };

// The most recent attempt that was actually timed — not simply the last one. The 29
// entries logged before timing existed carry no seconds, and one of them on top of a
// timed rework must not blank out the number underneath it.
export function lastPace(it) {
  const h = Array.isArray(it.history) ? it.history : [];
  for (let i = h.length - 1; i >= 0; i -= 1) {
    const e = h[i];
    const s = Number(e.seconds);
    if (e.seconds == null || !Number.isFinite(s) || s <= 0) continue;
    const b = Number(e.budget);
    // Entries always store the budget they were graded against; fall back to today's
    // only if one somehow lacks it, so a ratio is never divided by nothing.
    const budget = Number.isFinite(b) && b > 0 ? b : budgetFor(it);
    return {
      seconds: s, budget,
      band: e.pace ?? paceBand(s, budget),
      ratio: Math.round((s / budget) * 100) / 100,
      result: e.result ?? null,
      at: e.at ?? (e.date ? `${e.date}T00:00:00.000Z` : null),
    };
  }
  return null;
}

// "Right but not fast" — the questions a pass/fail queue is structurally blind to.
// Two ways in, because on day one there are no timed attempts at all: a pass that ran
// over budget, or a bucket the tutor already logged as "ran out of time".
const isSlow = (it) => {
  if (it.bucket === 'timing') return true;
  const p = lastPace(it);
  return !!p && p.result !== 'fail' && p.band != null && p.band !== 'clean';
};

export function listItems({ dueOnly = false, exam = null, includeDone = false, recentDays = null, slowOnly = false } = {}) {
  const t = today();
  let items = read().items;
  // "Recently reworked" spans open and closed alike — a misclick that promoted 1 → 7
  // leaves the item open, so filtering to closed ones would hide the common case.
  if (recentDays != null) {
    const cutoff = addDays(t, -Math.abs(recentDays));
    items = items.filter((i) => { const h = lastAction(i); return h && h.date >= cutoff; });
    if (exam) items = items.filter((i) => i.exam === String(exam).toUpperCase());
    return items.sort((a, b) => actionStamp(b).localeCompare(actionStamp(a)));
  }
  if (!includeDone) items = items.filter((i) => i.status !== 'done');
  if (exam) items = items.filter((i) => i.exam === String(exam).toUpperCase());
  if (slowOnly) items = items.filter(isSlow);
  if (dueOnly) items = items.filter((i) => i.due && i.due <= t);
  return items.sort((a, b) => String(a.due ?? '9999').localeCompare(String(b.due ?? '9999')));
}

export function summary() {
  const t = today();
  const all = read().items;
  const open = all.filter((i) => i.status !== 'done');
  const due = open.filter((i) => i.due && i.due <= t);
  const byExam = {};
  for (const i of open) {
    byExam[i.exam] = byExam[i.exam] ?? { open: 0, due: 0 };
    byExam[i.exam].open += 1;
    if (i.due && i.due <= t) byExam[i.exam].due += 1;
  }
  return {
    today: t,
    total: all.length,
    open: open.length,
    done: all.filter((i) => i.status === 'done').length,
    due: due.length,
    overdue: open.filter((i) => i.due && i.due < t).length,
    byExam,
    byTier: TIERS.map((x) => ({ tier: x, count: open.filter((i) => i.tier === x).length })),
  };
}

// ── pace statistics ─────────────────────────────────────────────────────────
// Median, never mean. n per group is single digits, and one attempt where he answered
// the door drags a mean somewhere no attempt actually was; the median does not notice
// it. Attempts past 4x budget are not slow answers at all, they are interrupted
// sittings, so they leave the distribution entirely and are reported as their own
// count — dropping them silently would understate how often a rework goes nowhere.
const median = (xs) => {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
// Nearest-rank, not interpolated: at n=5 there is nothing to interpolate between, and
// the question "how bad is a bad one" wants a real attempt rather than a synthetic one.
const p75 = (xs) => {
  if (!xs.length) return null;
  const a = xs.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.ceil(0.75 * a.length) - 1)];
};
const round2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

// Later half minus earlier half, as a change in median RATIO: negative means faster.
// Under four attempts there are no halves worth comparing and a trend line through two
// points is a line through noise, so it returns null and the UI shows nothing rather
// than telling him he is improving because one sitting happened to land well.
function trendOf(stamps) {
  if (stamps.length < 4) return null;
  const a = stamps.slice().sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const h = Math.floor(a.length / 2); // odd n drops the middle attempt, not a half
  const early = median(a.slice(0, h).map((x) => x.ratio));
  const late = median(a.slice(a.length - h).map((x) => x.ratio));
  return early == null || late == null ? null : round2(late - early);
}

const groupKeys = (it, groupBy) => {
  if (groupBy === 'exam') return [it.exam ?? 'OTHER'];
  if (groupBy === 'bucket') return [it.bucket ?? 'didnt_know'];
  // An attempt counts toward EVERY trap on its item. The question carries all of them
  // at once and there is no way to know which one cost the minute on a given sitting,
  // so splitting the attempt between them would invent a precision that is not there.
  if (groupBy === 'trap') return Array.isArray(it.insight?.trap) ? it.insight.trap : [];
  return [it.topic ?? 'unknown'];
};

/**
 * Pace by topic / exam / bucket / trap, over every timed attempt in the history.
 *
 * Raw seconds are not comparable across boards — 6 minutes is a disaster on TMUA and
 * early on MAT — so every group also carries a median RATIO against the budget the
 * attempt was actually graded on, which is the number to compare between groups.
 */
export function paceStats({ groupBy = 'topic', exam = null } = {}) {
  const want = exam ? String(exam).toUpperCase() : null;
  const groups = new Map();
  for (const it of read().items) {
    if (want && it.exam !== want) continue;
    const keys = groupKeys(it, groupBy);
    if (!keys.length) continue;
    for (const h of Array.isArray(it.history) ? it.history : []) {
      // Untimed attempts are SKIPPED, never counted as zero. Coercing the pre-timing
      // entries to 0 would manufacture a flawless baseline nobody ever earned.
      const sec = Number(h.seconds);
      const bud = Number(h.budget);
      if (h.seconds == null || !Number.isFinite(sec) || sec <= 0) continue;
      if (!Number.isFinite(bud) || bud <= 0) continue;
      const ratio = sec / bud;
      for (const k of keys) {
        if (!groups.has(k)) groups.set(k, { key: k, secs: [], ratios: [], stamps: [], abandoned: 0 });
        const g = groups.get(k);
        if (ratio > PACE_ABANDONED) { g.abandoned += 1; continue; }
        g.secs.push(sec);
        g.ratios.push(ratio);
        g.stamps.push({ at: h.at ?? `${h.date ?? ''}T00:00:00.000Z`, ratio });
      }
    }
  }
  return [...groups.values()].map((g) => ({
    key: g.key,
    n: g.secs.length, // graded attempts only; the abandoned ones are counted apart
    median: g.secs.length ? Math.round(median(g.secs)) : null,
    p75: p75(g.secs),
    median_ratio: round2(median(g.ratios)),
    over_budget_rate: g.ratios.length ? round2(g.ratios.filter((r) => r > PACE_SLOW).length / g.ratios.length) : null,
    abandoned: g.abandoned,
    trend: trendOf(g.stamps),
  })).sort((a, b) => b.n - a.n || String(a.key).localeCompare(String(b.key)));
}

export function formatForModel(items, s) {
  if (!items.length) return `Backlog clear — nothing due today (${s.open} open, none ripe).`;
  const t = today();
  const lines = items.map((i) => {
    const late = i.due < t ? ` OVERDUE by ${Math.round((new Date(t) - new Date(i.due)) / 86400000)}d` : '';
    return `  [${i.id}] ${i.exam} ${i.ref} — ${i.topic} · ${i.bucket} · tier ${i.tier}d · due ${i.due}${late}\n      ${i.detail}${i.correction ? `\n      fix: ${i.correction}` : ''}`;
  });
  return `${items.length} due today (${s.open} open overall, ${s.overdue} overdue):\n${lines.join('\n')}`;
}

// ---- daily notification ----
// Fires at most once a day, and only when something is actually due. Doing the work
// early empties the queue, so no notification is sent — exactly as intended.
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
export function maybeNotify({ force = false } = {}) {
  const s = summary();
  const st = readState();
  if (!force && st.lastNotified === s.today) return { sent: false, reason: 'already notified today' };
  if (s.due === 0) return { sent: false, reason: 'nothing due' };

  const title = 'TMUA backlog';
  const body = `${s.due} item${s.due === 1 ? '' : 's'} due today${s.overdue ? ` · ${s.overdue} overdue` : ''}`;
  try {
    execFile('/usr/bin/osascript', ['-e',
      `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} sound name "Submarine"`],
      () => {});
  } catch {}
  fs.writeFileSync(STATE, JSON.stringify({ lastNotified: s.today, due: s.due }, null, 2));
  return { sent: true, due: s.due, overdue: s.overdue };
}

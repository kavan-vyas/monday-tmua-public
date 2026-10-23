// The exam simulator's server side: papers registry, sitting lifecycle, telemetry,
// scoring, results.
//
// Two properties this file exists to guarantee, both of them correctness rather than
// nicety:
//
//   1. THE ANSWER KEY IS NEVER IN THE SITTING PAYLOAD. Answers live in a separate
//      file (tutor_data/exams/answers/) that the sitting code path never opens, so it
//      is structurally impossible for a letter to reach the browser mid-exam — not a
//      field this module remembers to strip.
//   2. AN ANSWER IS NEVER LOST TO TELEMETRY. /api/exam/answer writes synchronously and
//      atomically; the event log is a separate, append-only file whose loss costs
//      analysis and nothing else.
//
// The module owns all IO under tutor_data/exams/ plus the two record writes a finished
// sitting makes (activity_log.json, backlog.json). The two things it cannot own — the
// WebSocket emit and the session mode — arrive as injected hooks, which is also what
// makes them observable in tests.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA, insideTutorData } from './paths.js';
import { writeJsonAtomic } from './annotations.js';
import { gradeForMark, MAX_MARK } from '../design/gradeTable.js';
import { PAPERS, OFFICIAL_PAPERS, paperRow, QUESTIONS_PER_PAPER } from './papers.js';

export const SCHEMA_VERSION = 1;

export const EXAMS_DIR = path.join(TUTOR_DATA, 'exams');
export const QUESTIONS_DIR = path.join(EXAMS_DIR, 'questions');
export const ANSWERS_DIR = path.join(EXAMS_DIR, 'answers');
export const FIGURES_DIR = path.join(EXAMS_DIR, 'figures');
export const SITTINGS_DIR = path.join(EXAMS_DIR, 'sittings');
const ACTIVITY_LOG = path.join(TUTOR_DATA, 'activity_log.json');
const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');

export { QUESTIONS_PER_PAPER };

// Chosen at setup and recorded per sitting, so a 75-minute run and a 120-minute run are
// never averaged into one meaningless pace figure. The 'long' key is a 120-minute sitting,
// which any paper can be sat under.
export const TIMINGS = { real: 75 * 60, long: 120 * 60, untimed: null };
export const EXTRA_TIME_FACTOR = 1.25;

// One POST cannot append more than this. A runaway client with a leaking buffer would
// otherwise fill the disk in a single request; the browser flushes every 5s.
const MAX_EVENTS_PER_POST = 2000;

const pad2 = (n) => String(n).padStart(2, '0');

/** An error that already knows what HTTP status it deserves. */
export class ExamError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ------------------------------------------------------------------ paper identity

/**
 * A paper id resolves to its registry row — id, set, paper, title, PDF paths and all. The
 * name is kept because every call site reads like a parse; there is no parsing left, which
 * is the point: "jc_25_p1" is a paper for exactly the same reason "jz_a_p1" is, because
 * papers.js says so.
 */
export const parsePaperId = (id) => paperRow(id);

/** Absolute path to a paper's PDF. Chen prints solutions in the question paper itself. */
export function pdfPathFor(row, kind = 'QP') {
  if (!row) return null;
  return kind === 'MS' ? row.ms : row.qp;
}

// Three registry rows have `ms: null` — Rosie, Asher Falcon and the Euclid R2Drew
// edition are published with no mark scheme at all. Passing that null straight to
// fs.existsSync is a deprecation warning today and a throw on some future Node.
const exists = (p) => { if (typeof p !== 'string' || !p) return false; try { return fs.existsSync(p); } catch { return false; } };
const readJson = (abs, fallback = null) => {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; }
};

// ------------------------------------------------------------------ question store

/** The transcribed questions for a paper, or null when phases 2-3 have not reached it. */
export function readQuestions(id) {
  const p = parsePaperId(id);
  if (!p) return null;
  const abs = insideTutorData(path.join(QUESTIONS_DIR, `${p.id}.json`));
  if (!abs) return null;
  const doc = readJson(abs);
  if (!doc || !Array.isArray(doc.questions)) return null;
  return doc;
}

/**
 * The answer key, tags, difficulty and worked-solution page refs — phase 4, and absent
 * today. Accepts either a list or a map keyed by question number, so whichever shape the
 * extraction pass finds easiest to emit is fine.
 */
export function readAnswers(id) {
  const p = parsePaperId(id);
  if (!p) return null;
  const abs = insideTutorData(path.join(ANSWERS_DIR, `${p.id}.json`));
  if (!abs) return null;
  const doc = readJson(abs);
  if (!doc) return null;
  const raw = doc.answers ?? doc.questions ?? null;
  const byQnum = new Map();
  if (Array.isArray(raw)) {
    for (const a of raw) if (a && Number.isFinite(Number(a.qnum))) byQnum.set(Number(a.qnum), a);
  } else if (raw && typeof raw === 'object') {
    for (const [k, a] of Object.entries(raw)) {
      if (!Number.isFinite(Number(k))) continue;
      byQnum.set(Number(k), typeof a === 'string' ? { qnum: Number(k), answer: a } : { qnum: Number(k), ...a });
    }
  }
  if (!byQnum.size) return null;
  return { ...doc, byQnum, ms_pdf: doc.ms_pdf ?? pdfPathFor(p, 'MS') };
}

/**
 * Every paper in the registry, always — a paper nobody has transcribed yet is a row saying
 * so, not a missing row, or the setup screen would silently shrink as the data lags the
 * code. The setup screen groups by `collection`, so a new collection appears there the
 * moment its rows exist in papers.js.
 *
 * `transcribed` is DERIVED from the question count rather than read from the file's own
 * `transcribed` field: the two agree today, and deriving it means they cannot drift when
 * a later transcription pass forgets to update the field.
 */
export function listPapers() {
  // Official papers first: they are the ones the real exam is modelled on.
  return [...OFFICIAL_PAPERS, ...PAPERS].map((row) => {
    const doc = readQuestions(row.id);
    const n = doc ? doc.questions.length : 0;
    return {
      id: row.id,
      collection: row.collection,
      collection_title: row.collectionTitle,
      set: row.set,
      paper: row.paper,
      title: row.title,
      short: row.short,
      questions: n,
      transcribed: n === 0 ? 'none' : n >= QUESTIONS_PER_PAPER ? 'full' : 'partial',
      has_answers: Boolean(readAnswers(row.id)),
      default_timing: row.defaultTiming,
      pdf: exists(row.qp) ? row.qp : null,
      ms_pdf: exists(row.ms) ? row.ms : null,
    };
  });
}

// ------------------------------------------------------------------ sitting files

const ID_OK = /^[a-z0-9]+$/;

function sittingFile(id, ext = '.json') {
  const s = String(id ?? '');
  // Checked before the join, not after: a traversal attempt must never reach the
  // filesystem layer at all. insideTutorData is then belt and braces.
  if (!ID_OK.test(s)) throw new ExamError(400, 'bad sitting id');
  const abs = insideTutorData(path.join(SITTINGS_DIR, `${s}${ext}`));
  if (!abs) throw new ExamError(403, 'refused');
  return abs;
}

export const eventsFile = (id) => sittingFile(id, '.events.jsonl');

let seq = 0;
const newSittingId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function readSitting(id) {
  const doc = readJson(sittingFile(id));
  if (!doc || doc.id !== id) return null;
  return doc;
}

const writeSitting = (s) => writeJsonAtomic(sittingFile(s.id), s);

// ------------------------------------------------------------------ telemetry

/**
 * Append-only click stream, one JSON object per line. New pattern in this codebase and
 * deliberately so: activity_log.json is a whole-file rewrite at minute granularity and
 * cannot hold a click stream.
 */
export function appendEvents(sittingId, events) {
  const sitting = readSitting(sittingId);
  if (!sitting) throw new ExamError(404, 'no such sitting');
  const list = Array.isArray(events) ? events.slice(0, MAX_EVENTS_PER_POST) : [];
  const at = new Date().toISOString();
  let lines = '';
  let accepted = 0;
  for (const ev of list) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
    lines += JSON.stringify({ ...ev, sitting: sitting.id, at }) + '\n';
    accepted += 1;
  }
  if (accepted) {
    fs.mkdirSync(SITTINGS_DIR, { recursive: true });
    fs.appendFileSync(eventsFile(sitting.id), lines);
  }
  return accepted;
}

/**
 * Read the log back. A torn final line — the server was killed mid-append — must cost
 * that one line and not the four thousand above it, so parse failures are skipped
 * rather than thrown.
 */
export function replayEvents(sittingId) {
  let text = '';
  try { text = fs.readFileSync(eventsFile(sittingId), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const ev = JSON.parse(s);
      if (ev && typeof ev === 'object' && !Array.isArray(ev)) out.push(ev);
    } catch { /* torn line, or a half-flushed buffer */ }
  }
  return out;
}

const evTime = (ev) => { const t = Number(ev?.t); return Number.isFinite(t) && t >= 0 ? t : null; };
const byTime = (evs) => evs.filter((e) => evTime(e) != null).sort((a, b) => evTime(a) - evTime(b));

/**
 * Rest breaks have no route of their own — the pause is driven entirely client side and
 * shows up as break_start / break_end in the event log — so the paused time has to be
 * reconstructed here, on every read, rather than incremented by a handler.
 *
 * Returns paused milliseconds, how many breaks were taken, and the offset of a break
 * that is still open (the clock is frozen at that instant until break_end lands).
 */
export function breakSpans(events) {
  let openAt = null;
  let pausedMs = 0;
  let breaksUsed = 0;
  for (const ev of byTime(events)) {
    const t = evTime(ev);
    if (ev.type === 'break_start' && openAt == null) { openAt = t; breaksUsed += 1; }
    else if (ev.type === 'break_end' && openAt != null) { pausedMs += Math.max(0, t - openAt); openAt = null; }
  }
  return { pausedMs, breaksUsed, openAt };
}

/**
 * Practice pauses — NOT the real test's rest breaks. A sitting can be paused any number of
 * times for any length (start a paper in a free period, finish it after school), and the
 * paused time never counts. Stored on the sitting itself with SERVER timestamps, so the
 * maths is plain wall-clock and survives the laptop lid closing mid-paper.
 */
export function pauseSpans(sitting, now = Date.now()) {
  const started = Date.parse(sitting.startedAt);
  const end = sitting.finishedAt ? Date.parse(sitting.finishedAt) : now;
  let ms = 0;
  let open = false;
  for (const p of sitting.pauses ?? []) {
    const a = Math.max(Date.parse(p.start), started);
    const stop = p.end ? Date.parse(p.end) : end;
    if (!p.end) open = true;
    const b = Math.min(stop, end);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) ms += b - a;
  }
  return { pausedMs: ms, open };
}

/** Pause the clock (idempotent: an open pause stays open). */
export function pauseSitting(sittingId, now = Date.now()) {
  const s = readSitting(sittingId);
  if (!s) throw new ExamError(404, 'no such sitting');
  if (s.status !== 'active') return { paused: false, status: s.status };
  s.pauses = s.pauses ?? [];
  if (!s.pauses.some((p) => !p.end)) {
    s.pauses.push({ start: new Date(now).toISOString(), end: null });
    writeSitting(s);
  }
  return { paused: true };
}

/** Resume the clock. Returns the fresh payload so the screen re-anchors its clock. */
export function resumeSitting(sittingId, now = Date.now()) {
  const s = readSitting(sittingId);
  if (!s) throw new ExamError(404, 'no such sitting');
  const open = (s.pauses ?? []).find((p) => !p.end);
  if (open) { open.end = new Date(now).toISOString(); writeSitting(s); }
  return sittingPayload(sittingId, now);
}

/**
 * The exam clock. `elapsedSec` is time ON the paper: wall time since the sitting started,
 * minus every second spent paused (practice pauses, always) and in a rest break (only
 * when rest breaks are on), including one still running.
 */
export function clockFor(sitting, events, now = Date.now()) {
  const started = Date.parse(sitting.startedAt);
  const end = sitting.finishedAt ? Date.parse(sitting.finishedAt) : now;
  const wallMs0 = Math.max(0, (Number.isFinite(end) ? end : now) - (Number.isFinite(started) ? started : now));
  const pause = pauseSpans(sitting, now);
  const pauseSec = Math.round(pause.pausedMs / 1000);
  const wallMs = Math.max(0, wallMs0 - pause.pausedMs);
  // restBreaks off means break events cannot move the clock even if a stray one is logged.
  if (!sitting.restBreaks) {
    return { elapsedSec: Math.round(wallMs / 1000), breakSecondsUsed: 0, breaksUsed: 0, pauseSec, paused: pause.open };
  }
  const { pausedMs, breaksUsed, openAt } = breakSpans(events);
  const ongoingMs = openAt != null && sitting.status === 'active' ? Math.max(0, wallMs - openAt) : 0;
  const totalPaused = Math.min(wallMs, pausedMs + ongoingMs);
  return {
    elapsedSec: Math.max(0, Math.round((wallMs - totalPaused) / 1000)),
    breakSecondsUsed: Math.round(totalPaused / 1000),
    breaksUsed,
    pauseSec,
    paused: pause.open,
  };
}

// ------------------------------------------------------------------ projections

/**
 * What the browser is allowed to see during a sitting. Built by explicit field pick, not
 * by deleting keys off the stored object, so a field added to the questions file in a
 * later phase cannot leak by omission.
 */
function publicQuestion(q, id) {
  const options = Array.isArray(q.options)
    ? q.options.map((o) => ({ letter: String(o.letter ?? '').toUpperCase(), latex: String(o.latex ?? '') }))
    : [];
  const figure = q.figure && typeof q.figure === 'object'
    ? { ...q.figure, url: `/api/exam/figure?paper=${encodeURIComponent(id)}&q=${q.qnum}` }
    : null;
  return {
    qnum: Number(q.qnum),
    id: q.id ?? null,
    cid: q.cid ?? null,
    stem: q.stem ?? '',
    display: q.display ?? null,
    options,
    figure,
  };
}

const inOrder = (doc, order, id) => {
  const by = new Map(doc.questions.map((q) => [Number(q.qnum), q]));
  return order.map((n) => by.get(n)).filter(Boolean).map((q) => publicQuestion(q, doc.paper_id ?? id));
};

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Chosen timing, then extra time. Untimed plus extra time is still untimed, not NaN. */
export function durationFor(timing, extraTime) {
  if (!(timing in TIMINGS)) throw new ExamError(400, `unknown timing "${timing}"`);
  const base = TIMINGS[timing];
  if (base == null) return null;
  return extraTime ? Math.round(base * EXTRA_TIME_FACTOR) : base;
}

// ------------------------------------------------------------------ lifecycle

/**
 * Start a sitting. `hooks.setMode` is how EXAM gets forced — voice off, proactivity
 * dead, show_video refused, mood pinned clinical — through the same setConfig path the
 * WS set_mode message uses.
 */
export async function createSitting(body = {}, hooks = {}) {
  const p = parsePaperId(body.paperId);
  if (!p) throw new ExamError(400, `unknown paper "${body.paperId}"`);
  const timing = String(body.timing ?? 'real');
  const durationSec = durationFor(timing, Boolean(body.extraTime));

  const doc = readQuestions(p.id);
  if (!doc || doc.questions.length === 0) {
    throw new ExamError(409, `${p.id} has not been transcribed yet`, { paperId: p.id, transcribed: 'none' });
  }

  const qnums = doc.questions.map((q) => Number(q.qnum)).filter(Number.isFinite);
  const order = body.shuffle ? shuffled(qnums) : qnums.slice().sort((a, b) => a - b);

  const sitting = {
    schema_version: SCHEMA_VERSION,
    id: newSittingId(),
    paperId: p.id,
    startedAt: new Date().toISOString(),
    durationSec,
    timing,
    shuffle: Boolean(body.shuffle),
    extraTime: Boolean(body.extraTime),
    restBreaks: Boolean(body.restBreaks),
    // Practice switches chosen on the prestart page. "explain" turns on the driver's
    // Explain Answer button (untimed practice only),
    // and is the ONLY thing that lets the answer key reach the browser mid-sitting.
    explain: Boolean(body.explain),
    allowPause: Boolean(body.allowPause),
    // A Paper 1 + Paper 2 run is two sittings; the group id ties them together for the
    // analysis page, and section is this paper's position in the run (1 or 2).
    groupId: typeof body.groupId === 'string' && /^[a-z0-9-]{4,40}$/.test(body.groupId) ? body.groupId : null,
    section: Number.isInteger(body.section) ? body.section : 1,
    // The whole run's papers in order, so a reload mid-run still knows Paper 2 follows.
    plan: Array.isArray(body.plan) ? body.plan.filter((x) => parsePaperId(x)).map((x) => parsePaperId(x).id).slice(0, 2) : [p.id],
    order,
    answers: {},
    flags: {},
    seen: {},
    status: 'active',
    breaksUsed: 0,
    breakSecondsUsed: 0,
    finishedAt: null,
    reason: null,
    summary: null,
  };
  fs.mkdirSync(SITTINGS_DIR, { recursive: true });
  writeSitting(sitting);
  // Written server side so the log exists from the first instant: a browser that dies
  // before its first flush must still leave a sitting with a start marker.
  appendEvents(sitting.id, [{ t: 0, type: 'sitting_start', qnum: null, paperId: p.id, timing, durationSec }]);

  try { await hooks.setMode?.('EXAM'); } catch { /* a mode that will not move must not lose the exam */ }

  return {
    sittingId: sitting.id,
    paper: { id: p.id, title: p.title, set: p.set, paper: p.paper, collection: p.collection },
    durationSec,
    questions: inOrder(doc, order, p.id),
  };
}

/** Resume: everything the exam screen needs to redraw itself after a reload or a crash. */
export function sittingPayload(id, now = Date.now()) {
  const sitting = readSitting(id);
  if (!sitting) throw new ExamError(404, 'no such sitting');
  const doc = readQuestions(sitting.paperId);
  const clock = clockFor(sitting, replayEvents(sitting.id), now);
  return {
    sitting: {
      id: sitting.id,
      paperId: sitting.paperId,
      startedAt: sitting.startedAt,
      durationSec: sitting.durationSec,
      elapsedSec: clock.elapsedSec,
      timing: sitting.timing,
      shuffle: sitting.shuffle,
      extraTime: sitting.extraTime,
      restBreaks: sitting.restBreaks,
      explain: Boolean(sitting.explain),
      allowPause: Boolean(sitting.allowPause),
      groupId: sitting.groupId ?? null,
      section: sitting.section ?? 1,
      plan: sitting.plan ?? [sitting.paperId],
      order: sitting.order,
      answers: sitting.answers ?? {},
      flags: sitting.flags ?? {},
      seen: sitting.seen ?? {},
      status: sitting.status,
      breaksUsed: clock.breaksUsed,
      breakSecondsUsed: clock.breakSecondsUsed,
      paused: clock.paused,
      pauseSec: clock.pauseSec,
    },
    questions: doc ? inOrder(doc, sitting.order, sitting.paperId) : [],
  };
}

/**
 * The authoritative answer write. Synchronous and atomic, on its own route, precisely so
 * that losing the telemetry buffer can never lose an answer.
 */
export function recordAnswer({ sittingId, qnum, choice, flagged }) {
  const sitting = readSitting(sittingId);
  if (!sitting) throw new ExamError(404, 'no such sitting');
  if (sitting.status !== 'active') throw new ExamError(409, 'this sitting has already been submitted');

  const n = Number(qnum);
  if (!Number.isFinite(n) || !sitting.order.includes(n)) throw new ExamError(400, `question ${qnum} is not in this sitting`);

  if (choice !== undefined) {
    if (choice === null || choice === '') {
      delete sitting.answers[n];
    } else {
      const letter = String(choice).toUpperCase();
      const doc = readQuestions(sitting.paperId);
      const q = doc?.questions.find((x) => Number(x.qnum) === n);
      // A letter the question does not offer would otherwise be stored and then marked
      // WRONG at the end, when the truth is that nothing was answered.
      const ok = (q?.options ?? []).some((o) => String(o.letter).toUpperCase() === letter);
      if (!ok) throw new ExamError(400, `"${letter}" is not an option on question ${n}`);
      sitting.answers[n] = letter;
    }
    sitting.seen[n] = true;
  }
  // Only when the key is present: an answer write must not silently clear a flag.
  if (flagged !== undefined) {
    if (flagged) sitting.flags[n] = true; else delete sitting.flags[n];
    sitting.seen[n] = true;
  }
  writeSitting(sitting);
  return { ok: true };
}

// ------------------------------------------------------------------ derivation

/**
 * Per-question timing and behaviour, from the event log. Three tiers, because the log may
 * be complete, partial or entirely absent and the results page has to render either way:
 *
 *   1. question_leave events carrying dwell_ms — authoritative, that is the client's own
 *      measurement of the interval it owned.
 *   2. otherwise, the gaps between consecutive timestamped events, attributed to whichever
 *      question was current.
 *   3. no usable events at all — timeSec is null per question and the results page says
 *      so rather than inventing a number.
 */
export function deriveQuestions(events, sitting, totalSec) {
  const per = new Map();
  const row = (n) => {
    if (!per.has(n)) per.set(n, { timeMs: 0, changes: 0, selects: 0, revisits: 0, firstMs: null });
    return per.get(n);
  };

  // The browser's dwell is wall clock, so a pause taken on a question would otherwise be
  // billed to that question. Each dwell is placed by its leave event's server timestamp
  // and loses whatever part of it overlaps a pause span.
  const pauses = (sitting.pauses ?? [])
    .map((p) => [Date.parse(p.start), p.end ? Date.parse(p.end) : Infinity])
    .filter(([a, b]) => Number.isFinite(a) && b > a);
  const pausedWithin = (endAt, ms) => {
    const end = Date.parse(endAt);
    if (!pauses.length || !Number.isFinite(end)) return 0;
    const start = end - ms;
    return pauses.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, end) - Math.max(a, start)), 0);
  };

  const ordered = byTime(events);
  let dwellSeen = false;
  for (const ev of ordered) {
    const n = Number(ev.qnum);
    if (ev.type === 'question_leave' && Number.isFinite(n) && Number.isFinite(Number(ev.dwell_ms))) {
      const ms = Math.max(0, Number(ev.dwell_ms));
      row(n).timeMs += Math.max(0, ms - pausedWithin(ev.at, ms));
      dwellSeen = true;
    }
  }
  if (!dwellSeen) {
    let cur = null;
    let curT = 0;
    for (const ev of ordered) {
      const t = evTime(ev);
      const n = Number(ev.qnum);
      if (!Number.isFinite(n)) continue;
      if (cur == null) { cur = n; curT = t; continue; }
      if (n !== cur) { row(cur).timeMs += Math.max(0, t - curT); cur = n; curT = t; }
    }
    if (cur != null) row(cur).timeMs += Math.max(0, totalSec * 1000 - curT);
  }

  for (const ev of ordered) {
    const n = Number(ev.qnum);
    if (!Number.isFinite(n)) continue;
    const r = row(n);
    if (ev.type === 'option_change') r.changes += 1;
    if (ev.type === 'option_select') r.selects += 1;
    if (ev.type === 'question_enter') r.revisits += 1;
    if (r.firstMs == null && (ev.type === 'option_select' || ev.type === 'option_change' || ev.type === 'flag_set')) {
      r.firstMs = evTime(ev);
    }
  }

  const out = new Map();
  for (const n of sitting.order) {
    const r = per.get(n);
    if (!r) { out.set(n, { timeSec: ordered.length ? 0 : null, changes: 0, revisits: 0, firstInteractionSec: null }); continue; }
    out.set(n, {
      timeSec: Math.round(r.timeMs / 1000),
      changes: r.changes || Math.max(0, r.selects - 1),
      revisits: Math.max(0, r.revisits - 1),
      firstInteractionSec: r.firstMs == null ? null : Math.round(r.firstMs / 1000),
    });
  }
  return out;
}

// ------------------------------------------------------------------ scoring

/**
 * Results. With no answer key on disk every marked field is null — never a guess. The
 * grade goes through the 40-mark table on raw*2, which is the same line tmua.io shows
 * ("19/20 · 38/40 equivalent"); expressed as raw*40/outOf so a part-transcribed paper
 * still converts sensibly.
 */
export function buildResults(id, now = Date.now()) {
  const sitting = readSitting(id);
  if (!sitting) throw new ExamError(404, 'no such sitting');
  const p = parsePaperId(sitting.paperId);
  const doc = readQuestions(sitting.paperId);
  if (!doc) throw new ExamError(409, `${sitting.paperId} is no longer readable`);
  const key = readAnswers(sitting.paperId);

  const events = replayEvents(sitting.id);
  const clock = clockFor(sitting, events, now);
  const totalTimeSec = clock.elapsedSec;
  const derived = deriveQuestions(events, sitting, totalTimeSec);

  const byQnum = new Map(doc.questions.map((q) => [Number(q.qnum), q]));
  const outOf = sitting.order.length;
  let raw = key ? 0 : null;
  let answered = 0;

  const questions = sitting.order.map((n) => {
    const q = byQnum.get(n) ?? { qnum: n, stem: '', display: null, options: [] };
    const pub = publicQuestion(q, sitting.paperId);
    const your = sitting.answers?.[n] ?? null;
    if (your) answered += 1;
    const a = key?.byQnum.get(n) ?? null;
    const correctAnswer = a?.answer ? String(a.answer).toUpperCase() : null;
    const correct = correctAnswer == null ? null : your === correctAnswer;
    if (correct === true) raw += 1;
    const d = derived.get(n) ?? { timeSec: null, changes: 0, revisits: 0, firstInteractionSec: null };
    // Worked solutions are PAGE REFERENCES into a PDF, not text: pdftotext mangles their
    // mathematics, so the results page renders the real pages through /api/pdf-page. The
    // page lives in a separate mark scheme for some collections and in the back of the
    // question paper itself for others — the registry row says which. A solution can run
    // over several pages, so carry all of them.
    const sol = a?.solution ?? null;
    const solPages = Array.isArray(sol?.pages)
      ? sol.pages.map(Number).filter((x) => Number.isFinite(x) && x > 0)
      : [Number(a?.solution_page)].filter((x) => Number.isFinite(x) && x > 0);
    const solPath = sol?.path ?? key?.ms_pdf ?? null;
    return {
      qnum: n,
      stem: pub.stem,
      display: pub.display,
      options: pub.options,
      figure: pub.figure,
      yourAnswer: your,
      correctAnswer,
      correct,
      jz_tags: a?.jz_tags ?? null,
      jz_difficulty: a?.jz_difficulty ?? null,
      solution: solPages.length && solPath
        ? { type: 'pdf_page', path: solPath, page: solPages[0], pages: solPages }
        : null,
      timeSec: d.timeSec,
      changes: d.changes,
      revisits: d.revisits,
      firstInteractionSec: d.firstInteractionSec,
      flagged: Boolean(sitting.flags?.[n]),
    };
  });

  const equivalentRaw40 = raw == null || outOf === 0
    ? null
    : Math.max(0, Math.min(MAX_MARK, Math.round((raw * MAX_MARK) / outOf)));

  const score = {
    raw,
    outOf,
    percent: raw == null || outOf === 0 ? null : Math.round((raw / outOf) * 1000) / 10,
    answered,
    avgPerQuestionSec: outOf === 0 ? null : Math.round((totalTimeSec / outOf) * 10) / 10,
    totalTimeSec,
    gradeLabel: equivalentRaw40 == null ? null : gradeForMark(equivalentRaw40),
    equivalentRaw40,
  };

  return {
    sitting: {
      id: sitting.id,
      paperId: sitting.paperId,
      startedAt: sitting.startedAt,
      finishedAt: sitting.finishedAt,
      durationSec: sitting.durationSec,
      elapsedSec: totalTimeSec,
      timing: sitting.timing,
      shuffle: sitting.shuffle,
      extraTime: sitting.extraTime,
      restBreaks: sitting.restBreaks,
      order: sitting.order,
      answers: sitting.answers ?? {},
      flags: sitting.flags ?? {},
      seen: sitting.seen ?? {},
      status: sitting.status,
      reason: sitting.reason,
      groupId: sitting.groupId ?? null,
      section: sitting.section ?? 1,
      breaksUsed: clock.breaksUsed,
      breakSecondsUsed: clock.breakSecondsUsed,
    },
    paper: {
      id: sitting.paperId,
      title: p ? p.title : sitting.paperId,
      set: p?.set ?? null,
      paper: p?.paper ?? null,
      pdf: p && exists(p.qp) ? p.qp : null,
      ms_pdf: p && exists(p.ms) ? p.ms : null,
      marked: Boolean(key),
    },
    score,
    questions,
  };
}

/**
 * Explain Answer: one question's key and solution pages, mid-sitting. Refused unless the
 * sitting was started with Explain Answer switched on — otherwise the "the key is never
 * in the browser during the exam" rule holds exactly as before.
 */
export function explainAnswer(id, qnum) {
  const sitting = readSitting(id);
  if (!sitting) throw new ExamError(404, 'no such sitting');
  if (!sitting.explain) throw new ExamError(403, 'Explain Answer is off for this sitting');
  const n = Number(qnum);
  if (!sitting.order.includes(n)) throw new ExamError(404, 'no such question in this sitting');
  const key = readAnswers(sitting.paperId);
  const a = key?.byQnum.get(n) ?? null;
  const doc = readQuestions(sitting.paperId);
  const q = doc?.questions.find((x) => Number(x.qnum) === n) ?? null;
  const sol = a?.solution ?? null;
  const pages = Array.isArray(sol?.pages) ? sol.pages.map(Number).filter((x) => x > 0) : [];
  return {
    qnum: n,
    answer: a?.answer ? String(a.answer).toUpperCase() : null,
    option: q?.options?.find((o) => o.letter === String(a?.answer ?? '').toUpperCase())?.latex ?? null,
    solution: pages.length && (sol?.path ?? key?.ms_pdf) ? { path: sol?.path ?? key?.ms_pdf, pages } : null,
  };
}

/** Results are answers. They are refused until the sitting is actually over. */
export function results(id, now = Date.now()) {
  const sitting = readSitting(id);
  if (!sitting) throw new ExamError(404, 'no such sitting');
  if (sitting.status !== 'finished') throw new ExamError(409, 'this sitting is still running');
  return buildResults(id, now);
}

// ------------------------------------------------------------------ finish

const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${pad2(Math.round(s % 60))}`);

function logActivity(entry) {
  let store = { entries: [] };
  try { store = JSON.parse(fs.readFileSync(ACTIVITY_LOG, 'utf8')); } catch { /* first ever entry */ }
  if (!Array.isArray(store.entries)) store.entries = [];
  store.entries.push(entry);
  fs.mkdirSync(path.dirname(ACTIVITY_LOG), { recursive: true });
  fs.writeFileSync(ACTIVITY_LOG, JSON.stringify(store, null, 2));
  return entry;
}

const sessionNumber = () => {
  const n = Number(readJson(SESSION_MEMORY, {})?.session_number);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * End the sitting: score it, write the record, seed the backlog, tell the app.
 *
 * Idempotent. A double-click on Submit, or a `pagehide` beacon arriving after the button
 * already fired, must not create a second set of backlog items or a second activity row —
 * so a sitting that is already finished simply returns its results again.
 */
export async function finishSitting({ sittingId, reason = 'submitted' }, hooks = {}) {
  const sitting = readSitting(sittingId);
  if (!sitting) throw new ExamError(404, 'no such sitting');
  if (sitting.status === 'finished') return buildResults(sitting.id);

  const REASONS = ['submitted', 'time_expired', 'ended'];
  sitting.reason = REASONS.includes(reason) ? reason : 'ended';
  sitting.status = 'finished';
  sitting.finishedAt = new Date().toISOString();
  const clock = clockFor(sitting, replayEvents(sitting.id));
  sitting.breaksUsed = clock.breaksUsed;
  sitting.breakSecondsUsed = clock.breakSecondsUsed;
  writeSitting(sitting);

  const res = buildResults(sitting.id);
  sitting.summary = {
    derivedAt: new Date().toISOString(),
    score: res.score,
    questions: res.questions.map((q) => ({
      qnum: q.qnum, yourAnswer: q.yourAnswer, correctAnswer: q.correctAnswer, correct: q.correct,
      timeSec: q.timeSec, changes: q.changes, revisits: q.revisits,
      firstInteractionSec: q.firstInteractionSec, flagged: q.flagged,
    })),
  };
  writeSitting(sitting);

  const marked = res.paper.marked;
  const wrong = res.questions.filter((q) => q.correct === false);
  const flagged = res.questions.filter((q) => q.flagged);
  const timingLabel = sitting.durationSec == null ? 'untimed' : `${Math.round(sitting.durationSec / 60)} min`;

  // One row per sitting, never one per question. `correct` is OMITTED: activity_log's own
  // convention is that a multi-question summary has no single outcome (session.js).
  const entry = {
    ts: new Date().toISOString().slice(0, 16),
    type: 'question',
    detail: marked
      ? `${res.paper.title} under exam conditions (${timingLabel}) — ${res.score.raw}/${res.score.outOf}`
        + ` in ${mmss(res.score.totalTimeSec)}, avg ${mmss(res.score.avgPerQuestionSec)}/question;`
        + ` ${wrong.length} wrong, ${flagged.length} flagged. Ended: ${sitting.reason}.`
      : `${res.paper.title} under exam conditions (${timingLabel}) — not yet marked;`
        + ` ${res.score.answered}/${res.score.outOf} answered in ${mmss(res.score.totalTimeSec)},`
        + ` ${flagged.length} flagged. Ended: ${sitting.reason}.`,
    source: 'tmua',
    topic: 'mock paper',
  };
  const sn = sessionNumber();
  if (sn !== undefined) entry.session_number = sn;
  logActivity(entry);

  // NO BACKLOG SEEDING. A simulator sitting used to open a tier-1 item for every wrong or
  // flagged question, which after one paper meant twenty of them. Every paper in the
  // registry is an unofficial mock, all of them harder than the real test by design — Chen's
  // are self-described as whimsical and partly off-spec. Missing these is
  // the expected experience, not a catalogue of gaps, and burying the backlog under twenty
  // of them per sitting drowned the questions that came off real papers.
  //
  // Everything is still recorded: the sitting keeps its per-question timings, answer
  // changes, revisits and flags, and the activity log keeps its row. Nothing sat in the
  // simulator enters the spaced-repetition queue.
  const backlogAdded = [];

  try {
    hooks.broadcast?.({
      type: 'exam_finished',
      sittingId: sitting.id,
      paperId: sitting.paperId,
      title: res.paper.title,
      reason: sitting.reason,
      raw: res.score.raw,
      outOf: res.score.outOf,
      percent: res.score.percent,
      gradeLabel: res.score.gradeLabel,
      elapsedSec: res.score.totalTimeSec,
      backlogAdded: backlogAdded.length,
    });
  } catch { /* a dead socket must not fail the finish */ }

  // Leaving EXAM lands in POSTMORTEM, never DRILL — modes.js:145's own rule.
  try { await hooks.setMode?.('POSTMORTEM'); } catch { /* see above */ }

  return res;
}

// ------------------------------------------------------------------ figures

/** The cropped diagram for a question, or null. Never leaves tutor_data/exams/figures. */
export function figureFor(id, qnum) {
  const p = parsePaperId(id);
  const n = Number(qnum);
  if (!p || !Number.isFinite(n)) return null;
  const doc = readQuestions(p.id);
  const q = doc?.questions.find((x) => Number(x.qnum) === n);
  const named = q?.figure?.file ? String(q.figure.file) : null;
  const candidates = [named, `${p.id}_q${pad2(n)}.png`].filter(Boolean);
  for (const file of candidates) {
    if (file.includes('/') || file.includes('\\')) continue;
    const abs = insideTutorData(path.join(FIGURES_DIR, file));
    if (abs && exists(abs)) return { file, path: abs };
  }
  return null;
}

// ------------------------------------------------------------------ reading sittings back

/**
 * Every sitting on disk, newest first — the index Monday reads when he says "how did the
 * Set C paper go". Reads the stored summary rather than recomputing, so this stays cheap
 * enough to call at the top of a conversation.
 */
export function listSittings({ limit = 20, paperId = null, groupId = null } = {}) {
  if (!fs.existsSync(SITTINGS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(SITTINGS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const s = readJson(path.join(SITTINGS_DIR, f));
    if (!s?.id) continue;
    if (paperId && s.paperId !== paperId) continue;
    if (groupId && s.groupId !== groupId) continue;
    const p = parsePaperId(s.paperId);
    out.push({
      id: s.id,
      paperId: s.paperId,
      title: p ? p.title : s.paperId,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt ?? null,
      status: s.status,
      reason: s.reason ?? null,
      timing: s.timing,
      durationSec: s.durationSec,
      extraTime: Boolean(s.extraTime),
      score: s.summary?.score ?? null,
      answered: s.summary?.score?.answered ?? Object.keys(s.answers ?? {}).filter((k) => s.answers[k]).length,
      elapsedSec: s.status === 'active' ? clockFor(s, replayEvents(s.id)).elapsedSec : null,
      paused: s.status === 'active' ? pauseSpans(s).open : false,
      flagged: Object.values(s.flags ?? {}).filter(Boolean).length,
      groupId: s.groupId ?? null,
      section: s.section ?? 1,
    });
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
}

const fmtSec = (s) => (s == null ? '—' : s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.round(s)}s`);

/**
 * One sitting, written for the model rather than for a screen.
 *
 * This is the whole point of recording the sitting: not the score, which he already knows,
 * but the shape of it — where the time went, which answers he changed and in which
 * direction, what he flagged and never came back to, and whether he was still working when
 * the clock ran out. None of that survives in an activity-log line.
 */
export function sittingReport(id) {
  const s = readSitting(id);
  if (!s) throw new ExamError(404, 'no such sitting');
  const res = s.status === 'finished' && s.summary ? { score: s.summary.score, questions: s.summary.questions } : buildResults(id);
  const p = parsePaperId(s.paperId);
  const title = p ? p.title : s.paperId;
  const events = replayEvents(id);
  const clock = clockFor(s, events, Date.now());

  const qs = res.questions ?? [];
  const wrong = qs.filter((q) => q.correct === false);
  const blank = qs.filter((q) => !q.yourAnswer);
  const flagged = qs.filter((q) => q.flagged);
  const changed = qs.filter((q) => (q.changes ?? 0) > 0);
  // A changed answer that ended up wrong is the most actionable thing in the whole record:
  // he had it, or nearly had it, and talked himself out of it.
  const changedToWrong = changed.filter((q) => q.correct === false);
  const slowest = [...qs].filter((q) => q.timeSec != null).sort((a, b) => b.timeSec - a.timeSec).slice(0, 3);

  const L = [];
  L.push(`${title} — ${s.timing === 'untimed' ? 'untimed' : `${Math.round((s.durationSec ?? 0) / 60)} min`}${s.extraTime ? ' (25% extra time)' : ''}, sat ${String(s.startedAt).slice(0, 16).replace('T', ' ')}`);
  L.push(`Status: ${s.status}${s.reason ? ` (${s.reason})` : ''} · time on paper ${fmtSec(clock.elapsedSec)}${clock.breaksUsed ? ` · ${clock.breaksUsed} rest break(s), ${fmtSec(Math.round(clock.breakSecondsUsed))}` : ''}`);
  if (res.score?.raw != null) L.push(`Score: ${res.score.raw}/${res.score.outOf} (${res.score.percent}%) · ${res.score.equivalentRaw40}/40 equivalent · grade ${res.score.gradeLabel}`);
  else L.push('Score: not marked — this paper has no answer key on disk.');
  L.push(`Answered ${qs.filter((q) => q.yourAnswer).length}/${qs.length}${blank.length ? `, left blank: ${blank.map((q) => q.qnum).join(', ')}` : ''}`);
  if (wrong.length) L.push(`Wrong: ${wrong.map((q) => `Q${q.qnum} (chose ${q.yourAnswer}, answer ${q.correctAnswer}, ${fmtSec(q.timeSec)})`).join('; ')}`);
  if (flagged.length) L.push(`Flagged for review: ${flagged.map((q) => `Q${q.qnum}${q.correct === false ? ' (and wrong)' : ''}`).join(', ')}`);
  if (changedToWrong.length) L.push(`CHANGED A RIGHT-LOOKING ANSWER AND ENDED UP WRONG: ${changedToWrong.map((q) => `Q${q.qnum}`).join(', ')} — worth asking what made him switch.`);
  else if (changed.length) L.push(`Changed answer on: ${changed.map((q) => `Q${q.qnum} (${q.changes}x)`).join(', ')}`);
  if (slowest.length) L.push(`Longest: ${slowest.map((q) => `Q${q.qnum} ${fmtSec(q.timeSec)}`).join(', ')}`);
  const revisited = qs.filter((q) => (q.revisits ?? 0) > 1);
  if (revisited.length) L.push(`Came back to: ${revisited.map((q) => `Q${q.qnum} (${q.revisits}x)`).join(', ')}`);
  // The clock no longer ends a sitting: it holds at 0:00 and he can keep going. So "ran
  // out" splits the record in two — what he had inside the limit, and what came after.
  const expiredAt = events.find((e) => e.type === 'time_expired')?.t;
  if (expiredAt != null) {
    const late = [...new Set(events.filter((e) => e.type === 'option_select' && e.t > expiredAt).map((e) => e.qnum))];
    const lateWork = Math.max(0, ...events.map((e) => e.t)) - expiredAt;
    L.push(late.length
      ? `THE CLOCK RAN OUT and he carried on for ${fmtSec(lateWork / 1000)}. Answered or changed AFTER time: ${late.map((n) => `Q${n}`).join(', ')} — in the real test those would be blank or his earlier choice.`
      : 'THE CLOCK RAN OUT — nothing was answered or changed after 0:00.');
  }
  L.push('');
  L.push('Per question: qnum answer correct time changes revisits flagged');
  for (const q of qs) {
    L.push(`  Q${String(q.qnum).padStart(2)}  ${q.yourAnswer ?? '-'}  ${q.correct == null ? '?' : q.correct ? 'Y' : 'N'}  ${String(fmtSec(q.timeSec)).padStart(6)}  ${q.changes ?? 0}  ${q.revisits ?? 0}  ${q.flagged ? 'flag' : ''}`);
  }
  return L.join('\n');
}

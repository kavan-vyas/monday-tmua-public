// Readiness: how ready is he, per topic and overall, and what does that project to?
//
// Three inputs, multiplied:
//   COVERAGE  — how much of the available material on a topic he has actually done,
//               attempted (topic_stats) against available (the 540-question tag index).
//   ACCURACY  — how often he gets it right (topic_stats), shrunk toward a prior so a
//               2-from-2 topic does not outrank a 23-from-29 one.
//   RECENCY   — untouched material decays. Nothing for the first 21 days, then a slow
//               slide toward a floor. Knowing it in July is not the same as knowing it
//               in October.
//
// READ ONLY. This module never writes anything, and in particular never touches
// session_memory.json, which is the student record the dashboard parses.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA } from './paths.js';
import { allQuestions } from './tagindex.js';

const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');

// ---------------------------------------------------------------- model constants

/** Accuracy prior: an unseen topic is assumed 60% until evidence says otherwise. */
const PRIOR_ACCURACY = 0.60;
/** Strength of that prior, in pseudo-questions. */
const PRIOR_WEIGHT = 3;

/** Coverage floor: doing none of a topic still leaves some credit for general skill. */
const COVERAGE_FLOOR = 0.45;
/** Sub-linear so the first few questions on a topic count for more than the last few. */
const COVERAGE_EXPONENT = 0.6;
/**
 * Coverage saturation, in questions. Coverage measures "have you sampled this topic
 * enough for the accuracy figure to mean anything", NOT "have you done all 268 algebra
 * questions in the index" — nobody does, and scoring against that would understate
 * everybody permanently. Twelve attempts on a topic is treated as full exposure; below
 * that the score is pulled down because the estimate is thin, not because he is weak.
 */
const COVERAGE_SATURATION = 12;

/** Days of grace before recency decay starts. */
const DECAY_GRACE_DAYS = 21;
/** Decay half-life in days once it starts. */
const DECAY_HALFLIFE_DAYS = 45;
/** Recency never drags a topic below this fraction of its knowledge score. */
const RECENCY_FLOOR = 0.65;
/**
 * Some topic_stats entries carry attempts imported in bulk with no per-question dates
 * (the self-study import). Penalising those as fully stale is as wrong as treating them
 * as fresh, so they sit at the midpoint and report lastSeen "unknown" rather than
 * inventing a date.
 */
const RECENCY_UNDATED = (1 + 0.65) / 2;

/**
 * Overall-to-TMUA mapping. TMUA is reported 1.0–9.0. Anchored so that an overall of
 * 90 projects to 9.0 and it scales linearly below that, clamped at 1.0. This is a
 * heuristic, not a published conversion — it is stated as such wherever it surfaces.
 */
const TMUA_ANCHOR = 90;
export const TARGET_SCORE = 9.0;
// The exam date lives in session_memory.exam_date — the one place the student
// owns and the dashboard already reads (dashboard.js:212). resolveExamDate() is
// the single source of truth; the constant below is only the fallback for a
// record that has no date yet. Default: the October 2026 sitting; set your own in settings.
export const DEFAULT_EXAM_DATE = '2026-10-12';

// Read the student's own exam date. Never cached — the file is edited by hand.
export function resolveExamDate() {
  const mem = readJson(SESSION_MEMORY, {});
  const d = typeof mem.exam_date === 'string' ? mem.exam_date.trim() : '';
  return parseDate(d) ? d : DEFAULT_EXAM_DATE;
}

// ---------------------------------------------------------------- helpers

function readJson(abs, fallback) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; }
}

const DAY = 86400000;

function daysBetween(a, b) {
  return Math.floor((b - a) / DAY);
}

function parseDate(s) {
  const t = Date.parse(String(s ?? ''));
  return Number.isFinite(t) ? t : null;
}

/** Topics on a tag-index question. The index stores them comma-separated in `topic`. */
function topicsOf(q) {
  const raw = q?.topic;
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  return String(raw ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

/** How many questions in the index touch each topic. */
function availableByTopic() {
  const counts = new Map();
  for (const q of allQuestions()) {
    for (const t of topicsOf(q)) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

/**
 * Most recent date he attempted anything on each topic. Both records are consulted:
 * questions_attempted is the authoritative one, activity_log catches anything logged
 * live that has not been folded back into it yet.
 */
function lastSeenByTopic(mem, log) {
  const last = new Map();
  const note = (t, d) => {
    const topic = String(t ?? '').trim();
    if (!topic || d == null) return;
    if (!last.has(topic) || d > last.get(topic)) last.set(topic, d);
  };
  for (const a of mem.questions_attempted ?? []) note(a.topic, parseDate(a.date));
  for (const e of log.entries ?? []) note(e.topic, parseDate(e.ts));
  return last;
}

function recencyFactor(lastSeenMs, now, attempted) {
  if (lastSeenMs == null) return attempted > 0 ? RECENCY_UNDATED : RECENCY_FLOOR;
  const idle = Math.max(0, daysBetween(lastSeenMs, now));
  if (idle <= DECAY_GRACE_DAYS) return 1;
  const over = idle - DECAY_GRACE_DAYS;
  const decayed = Math.pow(0.5, over / DECAY_HALFLIFE_DAYS);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * decayed;
}

// ---------------------------------------------------------------- core

let memo = { at: 0, key: '', value: null };
const MEMO_MS = 30000;

/** The user's target, clamped to the 1.0-9.0 TMUA scale. Defaults to 9.0. */
function resolveTarget(target) {
  const n = Number(target);
  if (!Number.isFinite(n)) return TARGET_SCORE;
  return Math.round(Math.min(9, Math.max(1, n)) * 10) / 10;
}

function computeSync({ now = Date.now(), examDate = resolveExamDate(), target } = {}) {
  const targetScore = resolveTarget(target);
  // The target is part of the memo key: changing it in settings must change the
  // very next report, not the one after the 30-second memo expires.
  const key = `${examDate}|${targetScore}`;
  if (memo.value && memo.key === key && now - memo.at < MEMO_MS) return memo.value;

  const mem = readJson(SESSION_MEMORY, {});
  const log = readJson(path.join(TUTOR_DATA, 'activity_log.json'), { entries: [] });
  const stats = mem.topic_stats ?? {};
  const available = availableByTopic();
  const lastSeen = lastSeenByTopic(mem, log);

  // Union of topics: everything he has statistics for, plus everything the index has.
  const names = new Set([...Object.keys(stats), ...available.keys()]);

  const topics = [];
  for (const topic of names) {
    const s = stats[topic] ?? {};
    const attempted = Number(s.attempted ?? 0);
    const correct = Number(s.correct ?? 0);
    const avail = available.get(topic) ?? 0;

    const accuracy = (correct + PRIOR_ACCURACY * PRIOR_WEIGHT) / (attempted + PRIOR_WEIGHT);
    const rawAccuracy = attempted > 0 ? correct / attempted : null;

    // Saturate against 12 questions, or the whole topic if the index holds fewer.
    const need = avail > 0 ? Math.min(avail, COVERAGE_SATURATION) : COVERAGE_SATURATION;
    const coverage = Math.min(1, attempted / need);
    const coverageFactor = COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * Math.pow(coverage, COVERAGE_EXPONENT);

    const seen = lastSeen.get(topic) ?? null;
    const recency = recencyFactor(seen, now, attempted);

    const score = Math.round(100 * accuracy * coverageFactor * recency);

    topics.push({
      topic,
      score,
      attempted,
      correct,
      available: avail,
      coverage: Math.round(coverage * 1000) / 1000,
      accuracy: rawAccuracy == null ? null : Math.round(rawAccuracy * 1000) / 1000,
      shrunkAccuracy: Math.round(accuracy * 1000) / 1000,
      recency: Math.round(recency * 1000) / 1000,
      lastSeen: seen == null ? (attempted > 0 ? 'undated' : null) : new Date(seen).toISOString().slice(0, 10),
      daysSinceSeen: seen == null ? null : Math.max(0, daysBetween(seen, now)),
    });
  }

  topics.sort((a, b) => a.score - b.score || a.topic.localeCompare(b.topic));

  // Weight each topic by how much of the real papers it accounts for. A topic that
  // shows up in 46 questions matters more than one that shows up in 2.
  const weighted = topics.filter((t) => t.available > 0);
  const totalWeight = weighted.reduce((n, t) => n + t.available, 0);
  const overall = totalWeight
    ? Math.round(weighted.reduce((n, t) => n + t.score * t.available, 0) / totalWeight)
    : 0;

  const projected = Math.round(Math.min(9, Math.max(1, 1 + 8 * (overall / TMUA_ANCHOR))) * 10) / 10;

  const examMs = parseDate(examDate) ?? parseDate(DEFAULT_EXAM_DATE);
  // Calendar days, counted midnight-to-midnight, so this agrees with the published
  // dashboard (dashboard.js:213). Counting from the current clock instead makes the
  // status line read one day fewer than the dashboard all afternoon.
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const daysToExam = examMs == null ? null : Math.max(0, Math.round((examMs - midnight.getTime()) / DAY));

  // Trajectory: you are not expected to be at 9.0 four months out. Expected projected
  // ramps from 6.5 at 120+ days out to the target on the day.
  const ramp = daysToExam == null ? 0 : Math.min(1, Math.max(0, daysToExam / 120));
  const trajectory = Math.round(Math.max(1, targetScore - 2.5 * ramp) * 10) / 10;

  const value = {
    overall,
    projected,
    target: targetScore,
    trajectory,
    onTrack: projected >= trajectory,
    daysToExam,
    examDate,
    weakest: topics.filter((t) => t.available > 0).slice(0, 3).map((t) => ({ topic: t.topic, score: t.score })),
    strongest: [...topics].filter((t) => t.available > 0).reverse().slice(0, 3).map((t) => ({ topic: t.topic, score: t.score })),
    topics,
    generatedAt: new Date(now).toISOString(),
    note: 'Projected score is a heuristic anchored so overall 90 maps to TMUA 9.0. Not a published conversion.',
  };

  memo = { at: now, key, value };
  return value;
}

/** Sync form — mood.js needs readiness inside a synchronous computeState(). */
export function computeReadinessSync(opts = {}) {
  return computeSync(opts);
}

/**
 * C2 contract form.
 * @returns {Promise<{overall:number, projected:number, weakest:{topic:string,score:number}[], topics:object[]}>}
 */
export async function computeReadiness(opts = {}) {
  return computeSync(opts);
}

/** Drop the memo — used by tests that move the clock. */
export function resetReadinessCache() {
  memo = { at: 0, key: '', value: null };
}

/** Human-readable version, for the model and for a "how ready am I" answer. */
export function formatReadiness(r) {
  const lines = [
    `READINESS ${r.overall}/100 — projected TMUA ${r.projected.toFixed(1)} against a ${r.target.toFixed(1)} target.`,
    r.daysToExam == null
      ? 'No exam date set.'
      : `${r.daysToExam} days out. Trajectory at this point wants ${r.trajectory.toFixed(1)} — ${r.onTrack ? 'on track' : 'BEHIND'}.`,
    '',
    'topic                  score  done/avail  acc    last seen',
  ];
  for (const t of r.topics) {
    lines.push(
      `${t.topic.padEnd(22)} ${String(t.score).padStart(5)}  ${String(t.attempted).padStart(3)}/${String(t.available).padEnd(4)}  ` +
      `${t.accuracy == null ? '  — ' : (t.accuracy * 100).toFixed(0).padStart(3) + '%'}   ${t.lastSeen ?? 'never'}`
    );
  }
  return lines.join('\n');
}

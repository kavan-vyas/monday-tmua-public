// Mood — Monday's read of where the student actually is, recomputed every turn.
//
// WHY THIS IS NOT IN THE PROMPT: the system prompt is frozen when the SDK session
// starts (session.js). A mood baked in there would be the mood he was in an hour ago.
// So the character lives in the prompt and the STATE lives here, rendered into a
// ~120-token <monday-state> preamble that the integrator prepends to every user
// message. Always current, and it survives resume for free.
//
// Everything this reads is already on disk: session_memory.json, activity_log.json,
// backlog.json, the tag index, the chat transcript, and the clock. Nothing here
// writes to the student record.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA } from './paths.js';
import { MODES, modeGates, normaliseMode, DEFAULT_MODE } from './modes.js';
import { computeReadinessSync, DEFAULT_EXAM_DATE } from './readiness.js';
import { summary as backlogSummary } from './backlog.js';
import { recordMood } from './mondaymem.js';
import { MOOD } from '../design/tokens.js';

const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const ACTIVITY_LOG = path.join(TUTOR_DATA, 'activity_log.json');

// ---------------------------------------------------------------- moods

/**
 * Precedence, strongest first. A mood only displaces the sitting one if it is at
 * least as strong, or if the sitting one has already had its two turns.
 */
export const MOOD_PRECEDENCE = ['clinical', 'grave', 'gentle', 'sharp', 'wry', 'focused'];
const rank = (m) => {
  const i = MOOD_PRECEDENCE.indexOf(m);
  return i < 0 ? MOOD_PRECEDENCE.length : i;
};

/**
 * Mood colours. THE VALUES LIVE IN app/design/tokens.js — the same file the four
 * surfaces' CSS is generated from, so a mood colour cannot drift between the
 * server, the React app, the dashboard and the tracker.
 *
 * The exported shape is unchanged: { mood: { light, dark } } of hex strings.
 * `focused` is still deliberately the house colour — but the house colour is now
 * a readable gold rather than the old #ffde00 neon, which could not carry text
 * and was being used for ten unrelated things at once.
 */
export const MOOD_COLORS = Object.fromEntries(
  Object.entries(MOOD).map(([mood, v]) => [mood, { light: v.light, dark: v.dark }])
);

// NO MANNER TABLE HERE, DELIBERATELY. There used to be a MOOD_BLURBS one-liner per
// mood, and nothing on the server ever imported it — the model reads the long-form
// version with exemplars out of prompt.js's SIX MOODS block, which is frozen into the
// system prompt. The only one-liner anyone actually renders is MOOD_MANNER in
// web/src/monday/constants.js. A third transcription of plangamma.md §B2's `manner`
// column that no code reads can only ever drift away from the two that are read.
// It cannot be shared from here either: this module pulls in node:fs, so the bundler
// cannot take it the way it takes modes.js.

// ---------------------------------------------------------------- thresholds

const SHARP_STREAK = 5;           // correct in a row before the needling starts
const SHARP_EASY_STREAK = 7;      // long enough that difficulty no longer matters
const GENTLE_WRONG_STREAK = 3;    // wrong in a row
const GENTLE_SESSION_MS = 90 * 60 * 1000;
const GENTLE_HOUR = 22.5;         // 22:30
const GENTLE_HOUR_END = 4;        // ...through to 04:00
const GRAVE_DAYS = 30;
const BEATEN_ACCURACY = 0.75;     // topic accuracy that counts as "already beaten"
const SESSION_LOOKBACK_MS = 12 * 60 * 60 * 1000;
const HOLD_TURNS = 2;             // hysteresis: a mood holds at least this many turns

// Moods that only ever arrive via modeGates().lockMood. They are imposed, not measured,
// so they must not survive the mode that imposed them (see the hysteresis block).
const LOCKED_MOODS = new Set(MODES.map((m) => modeGates(m).lockMood).filter(Boolean));

// ---------------------------------------------------------------- helpers

function readJson(abs, fallback) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; }
}

const DAY = 86400000;

function parseTs(s) {
  const t = Date.parse(String(s ?? ''));
  return Number.isFinite(t) ? t : null;
}

// Mirrors scope.js's preScreen without importing it — scope.js pulls in the whole
// Agent SDK, and mood.js runs on every turn and in tests.
const STUDY = /math|tmua|mat\b|step\b|paper|question|\bq\d|exam|mark ?scheme|solution|answer|topic|backlog|revis|session|log|drill|practice|algebra|calculus|integrat|different|trig|logarith|geometr|graph|sequence|series|probab|combinator|proof|logic|polynomial|quadratic|equation|inequal|function|vector|matri|modul|factor|root|derivat|tangent|circle|triangle|binomial|induction|contradiction|counterexample|homework|timer|schedule|dashboard|score|grade|stuck|explain|working|method|formula|theorem|tired|ill\b|sick|busy|stress|sleep/i;
const MATHSY = /[=+\-×÷^√∫∑π]|\d\s*[a-z]\b|\b[a-z]\s*[=<>]|\bx\^|\bdx\b|\bf\(x\)/i;
const BANTER = /\b(lol|lmao|haha+|ha ha|nice one|cheeky|you'?re funny|are you (a )?(robot|human|real|conscious|alive)|what are you|do you (sleep|dream|get bored|actually care)|good morning|good evening|how are you)\b/i;

function offTopicish(text) {
  const t = String(text ?? '').trim();
  if (t.length < 15) return false;
  return !STUDY.test(t) && !MATHSY.test(t);
}

function lastUserText(chat) {
  const tr = chat?.transcript;
  if (!Array.isArray(tr)) return '';
  for (let i = tr.length - 1; i >= 0; i--) {
    if (tr[i]?.type === 'user_message') return String(tr[i].text ?? '');
  }
  return '';
}

/**
 * The signed streak, session accuracy, and whether the run happened on material he
 * has already beaten. Reads activity_log entries that carry a boolean `correct` —
 * those are single-question outcomes; batch self-reports deliberately omit the field.
 */
function readRun({ log, stats, sessionStart, now }) {
  const graded = (log.entries ?? [])
    .map((e) => ({ ...e, at: parseTs(e.ts) }))
    .filter((e) => typeof e.correct === 'boolean' && e.at != null)
    .sort((a, b) => a.at - b.at);

  const inSession = graded.filter((e) => e.at >= sessionStart && e.at <= now + DAY);

  // Streak runs off the session's own answers. Nothing this session, no streak —
  // a run from three days ago is not a mood.
  let streak = 0;
  let beaten = 0;
  if (inSession.length) {
    const lastCorrect = inSession[inSession.length - 1].correct;
    let easy = 0;
    for (let i = inSession.length - 1; i >= 0; i--) {
      if (inSession[i].correct !== lastCorrect) break;
      streak++;
      const t = String(inSession[i].topic ?? '');
      const s = stats[t];
      const d = inSession[i].difficulty;
      // "Already beaten" = the topic he is on sits above the accuracy bar, or the
      // question itself is tagged easy when the index gave us a difficulty.
      if ((typeof d === 'number' && d <= 2) || (s && s.attempted >= 4 && s.correct / s.attempted >= BEATEN_ACCURACY)) easy++;
    }
    if (!lastCorrect) streak = -streak;
    beaten = streak > 0 ? easy / Math.abs(streak) : 0;
  }

  const correct = inSession.filter((e) => e.correct).length;
  const sessionAccuracy = { correct, total: inSession.length };

  const last20 = graded.slice(-20);
  const rolling20 = last20.length
    ? Math.round((last20.filter((e) => e.correct).length / last20.length) * 100)
    : null;

  // "A genuinely elegant method" is not detectable from the student's words. It IS
  // detectable from the record: an insight logged correct this session is exactly the
  // moment something clicked.
  const elegant = (log.entries ?? []).some((e) => {
    const at = parseTs(e.ts);
    return e.type === 'insight' && e.correct === true && at != null && at >= sessionStart;
  });

  return { streak, beaten, sessionAccuracy, rolling20, elegant, graded: inSession.length };
}

// ---------------------------------------------------------------- hysteresis

/** chatId -> { mood, reason, held } */
const held = new Map();

/** Drop the hysteresis memory. Tests, and a new chat. */
export function resetMoodMemory(chatId = null) {
  if (chatId == null) held.clear();
  else held.delete(chatId);
}

// ---------------------------------------------------------------- main

/**
 * @param {{chat?: object, config?: object, now?: number, snapshot?: object, advance?: boolean}} opts
 *   chat      the active chat ({ id, createdAt, transcript }) — may be null
 *   config    .state.json config: { examDate, mode, ... }
 *   now       ms epoch; defaults to Date.now()
 *   snapshot  TEST/OVERRIDE HOOK. Any MondayState-ish field placed here wins over the
 *             value read from disk, which is how each mood is forced in the smoke test.
 *   advance   false to peek without spending a hysteresis turn (default true)
 * @returns {import('./mood.js').MondayState}
 */
export function computeState({ chat = null, config = {}, now = Date.now(), snapshot = {}, advance = true } = {}) {
  const s = snapshot ?? {};
  const mem = s.memory ?? readJson(SESSION_MEMORY, {});
  const log = s.log ?? readJson(ACTIVITY_LOG, { entries: [] });
  const stats = mem.topic_stats ?? {};

  const mode = normaliseMode(s.mode ?? config.mode ?? DEFAULT_MODE);
  const gates = modeGates(mode);

  const examDate = config.examDate ?? DEFAULT_EXAM_DATE;
  const readiness = s.readiness ?? computeReadinessSync({ now, examDate, target: config.targetScore });
  const daysToExam = s.daysToExam ?? readiness.daysToExam ?? 0;

  const sessionStart = s.sessionStartedAt
    ?? Math.max(chat?.createdAt ?? (now - SESSION_LOOKBACK_MS), now - SESSION_LOOKBACK_MS);
  const sessionElapsedMs = s.sessionElapsedMs ?? Math.max(0, now - sessionStart);

  const run = readRun({ log, stats, sessionStart, now });
  const streak = s.streak ?? run.streak;
  const sessionAccuracy = s.sessionAccuracy ?? run.sessionAccuracy;
  const rolling20 = s.rolling20 ?? run.rolling20;
  const beaten = s.beaten ?? run.beaten;
  const elegant = s.elegant ?? run.elegant;

  let backlogDue = s.backlogDue;
  if (backlogDue == null) {
    try { backlogDue = backlogSummary().due; } catch { backlogDue = 0; }
  }

  const lesson = s.lesson ?? mem.session_number ?? 0;
  const lastSessionDate = s.lastSessionDate ?? mem.last_session_date ?? null;

  const d = new Date(now);
  const hourFloat = s.hour ?? (d.getHours() + d.getMinutes() / 60);
  const userText = s.lastUserText ?? lastUserText(chat);

  // ---- candidate moods, strongest first ------------------------------------

  let mood = 'focused';
  let reason = 'nothing unusual — working through it';

  if (mode === 'TEACH') reason = 'teaching mode — explanation first';

  if (elegant) {
    mood = 'wry';
    reason = 'he found a genuinely better route than the one lined up';
  } else if (BANTER.test(userText)) {
    // Checked before the off-topic test: banter is the more specific reading, and
    // "haha are you a robot" would otherwise be reported as a scope failure.
    mood = 'wry';
    reason = 'he is bantering rather than working';
  } else if (offTopicish(userText)) {
    mood = 'wry';
    reason = 'that was not a maths question';
  }

  if (streak >= SHARP_EASY_STREAK) {
    mood = 'sharp';
    reason = `${streak} correct in a row — the question selection is too soft`;
  } else if (streak >= SHARP_STREAK && beaten >= 0.6) {
    mood = 'sharp';
    reason = `${streak} correct in a row on material already beaten`;
  }

  if (streak <= -GENTLE_WRONG_STREAK) {
    mood = 'gentle';
    reason = `${Math.abs(streak)} wrong in a row`;
  } else if (sessionElapsedMs >= GENTLE_SESSION_MS) {
    mood = 'gentle';
    reason = `${Math.round(sessionElapsedMs / 60000)} minutes in — that is past useful`;
  } else if (hourFloat >= GENTLE_HOUR || hourFloat < GENTLE_HOUR_END) {
    mood = 'gentle';
    reason = `it is ${String(Math.floor(hourFloat)).padStart(2, '0')}:${String(Math.round((hourFloat % 1) * 60)).padStart(2, '0')} — tired brain, not a gap`;
  }

  if (daysToExam != null && daysToExam < GRAVE_DAYS && readiness.onTrack === false) {
    mood = 'grave';
    reason = `${daysToExam} days out and projected ${readiness.projected.toFixed(1)} against a ${readiness.target.toFixed(1)} target`;
  }

  if (gates.lockMood) {
    mood = gates.lockMood;
    reason = `${mode} mode`;
  }

  // ---- hysteresis ----------------------------------------------------------
  // A mood holds for HOLD_TURNS unless something at least as strong fires, so Monday
  // does not change register halfway through an explanation.
  const key = chat?.id ?? '__default__';
  const prev = held.get(key);
  // A mood the MODE imposed is not Monday's own register, so leaving that mode must
  // drop it at once. Nothing outranks `clinical`, so without this exception the hold
  // kept EXAM's voice for a turn after EXAM was over — the status line said CLINICAL
  // beside a DRILL chip, and the state block told the model it was still under exam
  // conditions. A mode change is a stronger signal than the hold.
  const heldByMode = prev && LOCKED_MOODS.has(prev.mood) && prev.mood !== gates.lockMood;
  if (prev && !heldByMode && prev.held < HOLD_TURNS && rank(mood) > rank(prev.mood)) {
    mood = prev.mood;
    reason = prev.reason;
  }
  if (advance) {
    if (prev && prev.mood === mood) held.set(key, { mood, reason, held: prev.held + 1 });
    else held.set(key, { mood, reason, held: 1 });
    if (!s.noRecord) recordMood(mood, reason);
  }

  return {
    mood,
    reason,
    mode,
    lesson,
    sessionElapsedMs,
    daysToExam,
    streak,
    sessionAccuracy,
    rolling20,
    backlogDue: backlogDue ?? 0,
    lastSessionDate,
    readiness: {
      overall: readiness.overall,
      projected: readiness.projected,
      target: readiness.target,
      trajectory: readiness.trajectory,
      onTrack: readiness.onTrack,
      weakest: readiness.weakest,
      // Must travel with the rest of it. renderStateBlock prints `exam: <date>`
      // beside `<daysToExam> days out`; without this the date silently fell back
      // to the module default while the count came from config.examDate, so the
      // two lines contradicted each other the moment the two values differed.
      examDate: readiness.examDate,
    },
    gates,
    color: MOOD_COLORS[mood],
    at: now,
  };
}

// ---------------------------------------------------------------- render

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function clock(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm} ${DAYS[d.getDay()]}`;
}

function agoDays(dateStr, now) {
  const t = parseTs(dateStr);
  if (t == null) return '';
  const n = Math.max(0, Math.floor((now - t) / DAY));
  if (n === 0) return ' (today)';
  return ` (${n} day${n === 1 ? '' : 's'} ago)`;
}

// "sequences_and_series" is nine syllables of prompt for no gain.
const SHORT = {
  sequences_and_series: 'sequences',
  coordinate_geometry: 'coord geom',
  logic_and_proof: 'proof',
  graph_sketching: 'sketching',
  logarithms: 'logs',
  combinatorics: 'combinatorics',
  trigonometry: 'trig',
  probability: 'probability',
  integration: 'integration',
};
const shortTopic = (t) => SHORT[t] ?? t;

/**
 * The preamble prepended to every user message. Roughly 120 tokens. Kept in a fixed
 * shape so the model learns to read it at a glance rather than parsing it.
 */
export function renderStateBlock(state) {
  const s = state ?? {};
  const pad = (v, n) => String(v).padEnd(n);
  const elapsed = `${Math.round((s.sessionElapsedMs ?? 0) / 60000)}m`;
  const streak = s.streak > 0 ? `+${s.streak}` : String(s.streak ?? 0);
  const acc = s.sessionAccuracy ?? { correct: 0, total: 0 };
  const roll = s.rolling20 == null ? 'n/a' : `${s.rolling20}%`;
  const r = s.readiness ?? {};
  const weak = (r.weakest ?? []).map((w) => `${shortTopic(w.topic)} ${w.score}`).join(', ');
  const exam = r.examDate ?? s.examDate ?? DEFAULT_EXAM_DATE;

  return [
    '<monday-state>',
    `mood: ${pad(s.mood ?? 'focused', 12)}(why: ${s.reason ?? '—'})`,
    `mode: ${s.mode ?? 'DRILL'}`,
    `lesson: ${pad(s.lesson ?? 0, 10)}session elapsed: ${pad(elapsed, 9)}local time: ${clock(s.at ?? Date.now())}`,
    `exam: ${pad(exam, 12)}${s.daysToExam ?? '?'} days out`,
    `streak: ${pad(streak, 10)}session accuracy: ${pad(`${acc.correct}/${acc.total}`, 7)}rolling 20: ${roll}`,
    `backlog due: ${pad(s.backlogDue ?? 0, 5)}last session: ${s.lastSessionDate ?? 'unknown'}${agoDays(s.lastSessionDate, s.at ?? Date.now())}`,
    `readiness: ${pad(`${r.overall ?? '?'}/100`, 7)}(projected ${r.projected == null ? '?' : r.projected.toFixed(1)} vs ${r.target == null ? '9.0' : r.target.toFixed(1)} target${weak ? `; weakest: ${weak}` : ''})`,
    '</monday-state>',
  ].join('\n');
}

/** Convenience for the integrator: state + preamble + the user's own text. */
export function withStateBlock(state, userText) {
  return `${renderStateBlock(state)}\n\n${userText}`;
}

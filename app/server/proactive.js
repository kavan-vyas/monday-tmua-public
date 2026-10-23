// Proactivity — Monday raising things unprompted.
//
// The user's constraint, verbatim: "such a good idea but needs to be on/off things."
// So the design rule here is absolute: NOTHING FIRES UNLESS ITS OWN SWITCH IS ON.
// There is no trigger that ignores its toggle, no "important enough to override",
// no master-switch-only fallback. On top of that:
//
//   - every trigger is individually switchable, and `late_night` ships OFF;
//   - ALL triggers are suppressed in EXAM mode, in code, not by asking nicely;
//   - one interruption per ten minutes globally, whatever else is due;
//   - each trigger has its own dedupe window on top of that, so "3 backlog items due"
//     is said once a day and an exam milestone is said once per milestone, ever.
//
// Two classes of trigger:
//   TEMPLATE   — cheap. Emits a finished line straight to the UI. No model turn, no
//                tokens, instant. Used where the content is entirely known already.
//   DIAGNOSTIC — pushes a hidden instruction into the SDK queue so Monday raises it in
//                its own words with real context. Costs a turn; used where the value is
//                in the judgement, not the fact.
//
// Writes ONLY to tutor_data/monday/proactive_state.json. Never touches the student
// record.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TUTOR_DATA } from './paths.js';
import { MONDAY_DIR } from './mondaymem.js';
import { summary as backlogSummary, listItems as listBacklog } from './backlog.js';

const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const ACTIVITY_LOG = path.join(TUTOR_DATA, 'activity_log.json');
const STATE_FILE = path.join(MONDAY_DIR, 'proactive_state.json');

const MIN = 60000;
const DAY = 86400000;

/** Global floor between any two interruptions, however many are due. The default;
 *  the live value is config.proactiveRateLimitMin, set from the settings pane. */
export const RATE_LIMIT_MS = 10 * MIN;
/** Bounds the settings pane offers, in minutes. Also enforced in mergeConfig(). */
export const RATE_LIMIT_MIN_RANGE = [1, 240];

const IDLE_MS = 6 * MIN;
const DEBRIEF_MS = 40 * MIN;
const REPEAT_WINDOW_DAYS = 14;
const AVOIDED_DAYS = 21;
const AVOIDED_ACCURACY = 0.60;
const LATE_NIGHT_HOUR = 23;
const MILESTONES = [90, 60, 30, 14, 7, 1];

/**
 * The seven. `enabled` is the DEFAULT — the live value comes from
 * config.proactive in .state.json, which the settings popover writes.
 */
export const TRIGGERS = [
  { id: 'idle_nudge', kind: 'diagnostic', enabled: true, severity: 'info', description: 'No message for 6 minutes in an active session.' },
  { id: 'repeat_mistake', kind: 'diagnostic', enabled: true, severity: 'alert', description: 'The same misconception logged twice within 14 days.' },
  { id: 'avoided_topic', kind: 'diagnostic', enabled: true, severity: 'alert', description: 'A topic under 60% accuracy, untouched for 21 days.' },
  { id: 'backlog_due', kind: 'template', enabled: true, severity: 'nudge', description: 'Spaced-revision items due today. Once a day, only if something is actually due.' },
  { id: 'session_debrief', kind: 'diagnostic', enabled: true, severity: 'nudge', description: 'Past 40 minutes with no close sequence.' },
  { id: 'exam_milestone', kind: 'template', enabled: true, severity: 'nudge', description: '90 / 60 / 30 / 14 / 7 / 1 days out. Once per milestone.' },
  { id: 'late_night', kind: 'template', enabled: false, severity: 'info', description: 'Past 23:00 with a session running. OFF by default.' },
];

export const DEFAULT_TOGGLES = Object.fromEntries(TRIGGERS.map((t) => [t.id, t.enabled]));

// Evaluation order. Not the same as the toggle order: when several are due in the
// same tick, only one fires, and it should be the one that matters most.
const ORDER = ['repeat_mistake', 'avoided_topic', 'exam_milestone', 'backlog_due', 'session_debrief', 'late_night', 'idle_nudge'];

// ---------------------------------------------------------------- state file

function readJson(abs, fallback) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; }
}

function loadState() {
  const s = readJson(STATE_FILE, null);
  return s && typeof s === 'object' ? s : { lastFireAt: 0, seen: {}, lastByTrigger: {} };
}

function saveState(s) {
  try {
    fs.mkdirSync(MONDAY_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* a missed dedupe is survivable; a crashed tick is not */ }
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const parseTs = (s) => { const t = Date.parse(String(s ?? '')); return Number.isFinite(t) ? t : null; };

/** Stable-ish signature for a free-text misconception, so "the same one" is decidable. */
function misconceptionKey(topic, text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 4);
  return `${String(topic ?? '?').toLowerCase()}|${words.slice(0, 5).join('-')}`;
}

// ---------------------------------------------------------------- factory

/**
 * @param {{
 *   emit: (evt: object) => void,          // routed to broadcast(evt, false)
 *   queueInstruction: (s: string) => void,// pushed into the SDK queue as a hidden turn
 *   getState: () => object,               // MondayState, ideally + lastUserMessageAt / sessionActive
 *   toggles?: Record<string, boolean>,    // from config.proactive
 *   now?: () => number,                   // injectable clock, for tests
 * }} deps
 * @returns {{ tick: (opts?: object) => object, setToggles: (t: object) => void, getToggles: () => object, TRIGGERS: typeof TRIGGERS }}
 */
export function createProactive({ emit, queueInstruction, getState, toggles = {}, rateLimitMs = RATE_LIMIT_MS, now = () => Date.now() } = {}) {
  let live = { ...DEFAULT_TOGGLES, ...(toggles ?? {}) };
  let limitMs = clampLimit(rateLimitMs);

  const fire = ({ id, severity, text, instruction, dedupeKey, state, at }) => {
    if (instruction) queueInstruction?.(instruction);
    else emit?.({ type: 'proactive', trigger: id, text, severity });

    state.lastFireAt = at;
    state.lastByTrigger[id] = at;
    if (dedupeKey) state.seen[dedupeKey] = at;
    saveState(state);
    return { fired: id, text: text ?? instruction, severity, kind: instruction ? 'diagnostic' : 'template' };
  };

  /**
   * Evaluate every trigger, fire at most one.
   * @param {{force?: string, dryRun?: boolean}} [opts] force: evaluate only this
   *   trigger and ignore the global rate limit (its own toggle still applies).
   */
  function tick(opts = {}) {
    const at = opts.at ?? now();
    const st = getState?.() ?? {};
    const state = loadState();

    // 1. EXAM suppresses everything. No exceptions, no severity override.
    if (st.mode === 'EXAM') return { fired: null, reason: 'EXAM mode — all proactivity suppressed' };

    // 2. The master switch. C's settings popover presents "never interrupt me" as a
    //    real switch, so it is enforced here rather than at one call site.
    if (st.proactiveEnabled === false) {
      return { fired: null, reason: 'proactivity switched off (master)' };
    }

    // 3. Modes that gate proactivity in code (PAUSE) suppress it too.
    if (st.gates && st.gates.proactiveEnabled === false) {
      return { fired: null, reason: `${st.mode} mode — proactivity gated off` };
    }

    // 4. Global rate limit. Configurable (settings pane -> proactiveRateLimitMin),
    //    but never removable: the floor cannot be set below one minute.
    if (!opts.force && at - (state.lastFireAt ?? 0) < limitMs) {
      const wait = Math.ceil((limitMs - (at - state.lastFireAt)) / 1000);
      return { fired: null, reason: `rate limited — ${wait}s until the next interruption is allowed` };
    }

    const order = opts.force ? [opts.force] : ORDER;
    const checked = [];

    for (const id of order) {
      // 5. Its own switch. This is checked before any work is done, so a disabled
      //    trigger costs nothing and can never fire by any route.
      if (!live[id]) { checked.push(`${id}: off`); continue; }

      const candidate = evaluate(id, { st, state, at });
      if (!candidate) { checked.push(`${id}: no`); continue; }
      if (candidate.dedupeKey && state.seen[candidate.dedupeKey]) { checked.push(`${id}: already said`); continue; }

      if (opts.dryRun) return { fired: null, wouldFire: id, candidate, checked };
      const r = fire({ id, state, at, ...candidate });
      if (id === 'backlog_due') notifyMac(candidate.text);
      return { ...r, checked };
    }

    return { fired: null, reason: 'nothing due', checked };
  }

  function setToggles(t) {
    live = { ...DEFAULT_TOGGLES, ...(t ?? {}) };
    return { ...live };
  }

  /** Change the global floor between interruptions, in milliseconds. */
  function setRateLimit(ms) {
    limitMs = clampLimit(ms);
    return limitMs;
  }

  return {
    tick, setToggles, getToggles: () => ({ ...live }),
    setRateLimit, getRateLimit: () => limitMs,
    TRIGGERS,
  };
}

/** A rate limit is a FLOOR, so it is clamped, never disabled. */
function clampLimit(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return RATE_LIMIT_MS;
  const [lo, hi] = RATE_LIMIT_MIN_RANGE;
  return Math.min(hi * MIN, Math.max(lo * MIN, Math.round(n)));
}

// ---------------------------------------------------------------- the triggers

function evaluate(id, ctx) {
  const fn = CHECKS[id];
  return fn ? fn(ctx) : null;
}

const CHECKS = {
  // --- diagnostic -----------------------------------------------------------

  /** Six minutes of nothing, in a session that is actually running. */
  idle_nudge({ st, at }) {
    if (!st.sessionActive) return null;
    const last = st.lastUserMessageAt;
    if (!last) return null; // the integrator has not supplied it; fail silent, never guess
    const idle = at - last;
    if (idle < IDLE_MS) return null;
    return {
      severity: 'info',
      instruction:
        `[proactive: idle_nudge] He has said nothing for ${Math.round(idle / MIN)} minutes. ` +
        `Say one short line — not a nag. Either he is stuck on the question in front of him, in ` +
        `which case offer the smallest possible nudge without giving anything away, or he has ` +
        `walked off, in which case say what is next and leave it there. One or two sentences. ` +
        `Do not mention that a timer told you to do this.`,
    };
  },

  /** The same misconception logged twice inside a fortnight. */
  repeat_mistake({ at }) {
    const mem = readJson(SESSION_MEMORY, {});
    const log = readJson(ACTIVITY_LOG, { entries: [] });
    const cutoff = at - REPEAT_WINDOW_DAYS * DAY;

    const hits = new Map();
    const note = (topic, text, ts) => {
      if (!text || ts == null || ts < cutoff) return;
      const k = misconceptionKey(topic, text);
      if (!k.includes('|') || k.endsWith('|')) return;
      const cur = hits.get(k) ?? { count: 0, topic, text, last: 0 };
      cur.count++;
      cur.last = Math.max(cur.last, ts);
      cur.text = text;
      hits.set(k, cur);
    };

    for (const q of mem.questions_attempted ?? []) note(q.topic, q.misconception, parseTs(q.date));
    for (const e of log.entries ?? []) if (e.type === 'misconception') note(e.topic, e.detail, parseTs(e.ts));

    let worst = null;
    for (const [k, v] of hits) {
      if (v.count < 2) continue;
      if (!worst || v.count > worst.v.count || v.last > worst.v.last) worst = { k, v };
    }
    if (!worst) return null;

    return {
      severity: 'alert',
      dedupeKey: `repeat:${worst.k}:${iso(worst.v.last)}`,
      instruction:
        `[proactive: repeat_mistake] The same misconception has been logged ${worst.v.count} times in the ` +
        `last ${REPEAT_WINDOW_DAYS} days — topic "${worst.v.topic}": ${worst.v.text}. ` +
        `Raise it yourself, now, in your own words. Call monday_recall for "${worst.v.topic}" FIRST and ` +
        `check how you explained it last time; if that approach is on record as having bounced, use a ` +
        `different one and say that you are. Then put a question in front of him that tests exactly ` +
        `this. Do not lecture about the repetition — one line naming it, then the work.`,
    };
  },

  /** Weak and being avoided. The two together are the signal; either alone is not. */
  avoided_topic({ at }) {
    const mem = readJson(SESSION_MEMORY, {});
    const log = readJson(ACTIVITY_LOG, { entries: [] });
    const stats = mem.topic_stats ?? {};

    const lastSeen = new Map();
    const note = (t, ts) => {
      const k = String(t ?? '').trim();
      if (!k || ts == null) return;
      if (!lastSeen.has(k) || ts > lastSeen.get(k)) lastSeen.set(k, ts);
    };
    for (const q of mem.questions_attempted ?? []) note(q.topic, parseTs(q.date));
    for (const e of log.entries ?? []) note(e.topic, parseTs(e.ts));

    let worst = null;
    for (const [topic, s] of Object.entries(stats)) {
      const attempted = Number(s.attempted ?? 0);
      if (attempted < 2) continue;
      const acc = Number(s.correct ?? 0) / attempted;
      if (acc >= AVOIDED_ACCURACY) continue;
      const seen = lastSeen.get(topic);
      const days = seen == null ? null : Math.floor((at - seen) / DAY);
      if (days == null || days < AVOIDED_DAYS) continue;
      if (!worst || acc < worst.acc) worst = { topic, acc, days, attempted, correct: Number(s.correct ?? 0) };
    }
    if (!worst) return null;

    return {
      severity: 'alert',
      dedupeKey: `avoided:${worst.topic}:${iso(at).slice(0, 7)}`, // once a month per topic
      instruction:
        `[proactive: avoided_topic] "${worst.topic}" is ${worst.correct} from ${worst.attempted} ` +
        `(${Math.round(worst.acc * 100)}%) and he has not touched it in ${worst.days} days. That is not a ` +
        `coincidence and you both know it. Say so in one dry line, then use query_tag_index to pull a ` +
        `question on it and put it up. Do not ask whether he would like to; name it and start.`,
    };
  },

  /** Past forty minutes with no sign of a close sequence. */
  session_debrief({ st, at }) {
    if (!st.sessionActive) return null;
    const elapsed = st.sessionElapsedMs ?? 0;
    if (elapsed < DEBRIEF_MS) return null;
    const acc = st.sessionAccuracy ?? { correct: 0, total: 0 };
    if (acc.total === 0) return null; // forty minutes of talking is not a session to debrief
    return {
      severity: 'nudge',
      dedupeKey: `debrief:${iso(at)}:${Math.floor(elapsed / DEBRIEF_MS)}`,
      instruction:
        `[proactive: session_debrief] ${Math.round(elapsed / MIN)} minutes in, ${acc.correct} from ` +
        `${acc.total}, and no close sequence yet. Offer the debrief: what actually went wrong today ` +
        `by topic rather than by question, what goes in the backlog, and one thing for next time. ` +
        `Two or three sentences, then let him decide whether to carry on. Do not end the session ` +
        `unilaterally unless the state block says you are in gentle.`,
    };
  },

  // --- template (cheap, no model turn) --------------------------------------

  /** Spaced-revision items due. Folds in the old backlog.js daily notification. */
  backlog_due({ at }) {
    let s;
    try { s = backlogSummary(); } catch { return null; }
    if (!s || !s.due) return null;

    let head = '';
    try {
      const items = listBacklog({ dueOnly: true }).slice(0, 2);
      head = items.map((i) => `${i.ref} (${i.topic})`).join(', ');
    } catch { /* the count alone is enough */ }

    const overdue = s.overdue ? `, ${s.overdue} of them overdue` : '';
    return {
      severity: 'nudge',
      dedupeKey: `backlog:${s.today ?? iso(at)}`,
      text: s.due === 1
        ? `One thing due for revision today${overdue}${head ? ` — ${head}` : ''}. It will take five minutes.`
        : `${s.due} due for revision today${overdue}${head ? ` — starting with ${head}` : ''}. Worth clearing before we start anything new.`,
    };
  },

  /** The countdown, at the points where it means something. */
  exam_milestone({ st, at }) {
    const d = st.daysToExam;
    if (d == null || !MILESTONES.includes(d)) return null;
    const r = st.readiness ?? {};
    const where = r.overall == null
      ? ''
      : ` Readiness ${r.overall}/100, projected ${Number(r.projected).toFixed(1)} against ${Number(r.target ?? 9).toFixed(1)}.`;
    const line = {
      90: `Ninety days. Far enough out that everything is still fixable, close enough that "later" has stopped being a real answer.`,
      60: `Sixty days out.${where} This is the part where coverage gets decided.`,
      30: `Thirty days.${where} From here it is consolidation, not new ground.`,
      14: `Fortnight.${where} Papers under timed conditions from now on.`,
      7: `One week.${where} Nothing new. Sleep, timing, and the mistakes you already know about.`,
      1: `Tomorrow. Nothing useful left to learn tonight. Stop at a sensible hour.`,
    }[d];
    return { severity: d <= 14 ? 'alert' : 'nudge', dedupeKey: `milestone:${d}:${st.examDate ?? ''}`, text: line };
  },

  /** OFF by default. He asked for this to be his own choice, so it is. */
  late_night({ st, at }) {
    if (!st.sessionActive) return null;
    const h = new Date(at).getHours();
    if (h < LATE_NIGHT_HOUR && h >= 4) return null;
    return {
      severity: 'info',
      dedupeKey: `latenight:${iso(at - 4 * 3600000)}`, // one per night, not per calendar day
      text: `It is ${String(h).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}. Nothing you learn now will survive to the morning. Stop.`,
    };
  },
};

// ---------------------------------------------------------------- mac notification

// Carried over from backlog.js:139-155, re-voiced. The old maybeNotify() also owned
// its own daily dedupe in tutor_data/.backlog-state.json; that job now belongs to this
// module's dedupeKey, so the integrator should stop calling maybeNotify().
function notifyMac(body) {
  try {
    execFile('/usr/bin/osascript', ['-e',
      `display notification ${JSON.stringify(String(body).slice(0, 200))} with title "Monday" sound name "Submarine"`],
      () => {});
  } catch { /* not fatal, and not worth a log line */ }
}

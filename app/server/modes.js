// Session modes, and the gates each one enforces.
//
// The point of this file is that the gates are enforced IN CODE, not only in the
// prompt. A prompt rule is only as strong as the model's compliance on the day, and
// that has already failed once in this project (scope.js exists for the same reason).
// EXAM in particular has to be real: no hints, no voice, no interruptions, mood
// pinned to clinical — whatever the model feels like doing.
//
// Pure. No file reads, no side effects.

/** @typedef {'DRILL'|'EXAM'|'POSTMORTEM'|'TEACH'|'PAUSE'} Mode */

// The single list. web/src/monday/constants.js re-exports this rather than keeping
// its own copy, which is what the "pure" note above has to stay true for.
export const MODES = ['DRILL', 'EXAM', 'POSTMORTEM', 'TEACH', 'CONSOLIDATION', 'PAUSE'];

export const DEFAULT_MODE = 'DRILL';

const GATES = {
  // The normal working mode: questions, marking, spaced revision.
  DRILL: {
    voiceEnabled: true,
    proactiveEnabled: true,
    videoAllowed: true,
    hintsAllowed: true,
    timerForced: false,
    lockMood: null,
  },
  // Real exam conditions. Everything that could help, comfort or interrupt is off.
  // Marking happens at the end, not per question. videoAllowed:false is what makes
  // show_video refuse in EXAM — a tutorial video mid-paper is a hint with pictures.
  EXAM: {
    voiceEnabled: false,
    proactiveEnabled: false,
    videoAllowed: false,
    hintsAllowed: false,
    timerForced: true,
    lockMood: 'clinical',
  },
  // Working back through what went wrong. No new questions, so no timer pressure,
  // but hints are the entire point.
  POSTMORTEM: {
    voiceEnabled: true,
    proactiveEnabled: true,
    videoAllowed: true,
    hintsAllowed: true,
    timerForced: false,
    lockMood: null,
  },
  // Explanation first. Monday consults mondayRecall before picking an approach.
  TEACH: {
    voiceEnabled: true,
    proactiveEnabled: true,
    videoAllowed: true,
    hintsAllowed: true,
    timerForced: false,
    lockMood: null,
  },
  // Phase-2 consolidation: volume and speed. Hints still allowed but the prompt keeps
  // them short — throughput over Socratic depth — and the timer is forced so pace is
  // always visible. Doing more papers, faster, is the whole point.
  CONSOLIDATION: {
    voiceEnabled: true,
    proactiveEnabled: true,
    videoAllowed: true,
    hintsAllowed: true,
    timerForced: true,
    lockMood: null,
  },
  // The master prompt's "pause tutor mode" hatch, promoted to a real mode so it
  // cannot be silently forgotten and left running. Proactivity is off: he asked to
  // be left to think, and nudging him mid-thought is the opposite of that.
  PAUSE: {
    voiceEnabled: true,
    proactiveEnabled: false,
    videoAllowed: true,
    hintsAllowed: true,
    timerForced: false,
    lockMood: null,
  },
};

/**
 * @param {Mode} mode
 * @returns {{voiceEnabled:boolean, proactiveEnabled:boolean, videoAllowed:boolean, hintsAllowed:boolean, timerForced:boolean, lockMood:string|null}}
 */
export function modeGates(mode) {
  const g = GATES[String(mode ?? '').toUpperCase()] ?? GATES[DEFAULT_MODE];
  return { ...g }; // copy — callers must not be able to unlock EXAM by mutation
}

export function isMode(m) {
  return MODES.includes(String(m ?? '').toUpperCase());
}

export function normaliseMode(m) {
  const up = String(m ?? '').toUpperCase();
  return MODES.includes(up) ? up : DEFAULT_MODE;
}

// One-line description shown in the UI mode selector / popover.
export const MODE_BLURBS = {
  DRILL: 'Normal working session — questions, marking, spaced revision.',
  EXAM: 'Exam conditions. Timer forced, no hints, no interruptions, marking at the end.',
  POSTMORTEM: 'Last session’s errors and standing misconceptions. No new questions.',
  TEACH: 'Explanation first. Monday checks what worked before choosing an approach.',
  CONSOLIDATION: 'Volume and speed — more papers, faster. Timer on, hints kept short.',
  PAUSE: 'Drill protocol dropped so Monday can just explain. Say "resume session" to come back.',
};

// ---------------------------------------------------------------------------
// Additive helper — NOT part of the C2 contract, but the master prompt already
// specifies these trigger phrases (Section 7, PAUSE MODE) and they were previously
// enforced by nothing but the model noticing them. Cheap to make real.

const ENTER_PAUSE = /\b(pause tutor mode|just explain this|i'?m figuring this out|im figuring this out)\b/i;
const LEAVE_PAUSE = /\b(resume session|resume tutor mode|back to (the )?drill|carry on with the questions)\b/i;
const ENTER_EXAM = /\b(exam mode|exam conditions|mock conditions|sit (this|the) paper (under|in) (exam|timed) conditions)\b/i;
const LEAVE_EXAM = /\b(end exam|stop exam|exam over|time'?s up|finished the paper)\b/i;
const ENTER_POSTMORTEM = /\b(post-?mortem|go through (my|the) (mistakes|errors)|review (my|the) (mistakes|errors))\b/i;
const ENTER_TEACH = /\b(teach me|explain the topic|i want to learn|go over the theory)\b/i;
const ENTER_CONSOLIDATION = /\b(consolidation mode|volume mode|consolidat|push through papers|more papers faster|speed run)\b/i;
const LEAVE_CONSOLIDATION = /\b(end consolidation|stop consolidation|back to drill)\b/i;

/**
 * Best-effort mode detection from a user message. Returns the new mode, or null to
 * leave the current one alone. Deliberately conservative: an unrecognised message
 * never changes mode.
 *
 * @param {string} text
 * @param {Mode} current
 * @returns {Mode|null}
 */
export function detectMode(text, current = DEFAULT_MODE) {
  const t = String(text ?? '');
  const cur = normaliseMode(current);

  // Leaving a mode wins over entering one, so "resume session" always works.
  if (cur === 'PAUSE' && LEAVE_PAUSE.test(t)) return 'DRILL';
  if (cur === 'EXAM') return LEAVE_EXAM.test(t) ? 'POSTMORTEM' : null; // nothing else escapes EXAM
  if (cur === 'CONSOLIDATION' && LEAVE_CONSOLIDATION.test(t)) return 'DRILL';
  if (ENTER_PAUSE.test(t)) return 'PAUSE';
  if (ENTER_EXAM.test(t)) return 'EXAM';
  if (ENTER_POSTMORTEM.test(t)) return 'POSTMORTEM';
  if (ENTER_CONSOLIDATION.test(t)) return 'CONSOLIDATION';
  if (ENTER_TEACH.test(t)) return 'TEACH';
  return null;
}

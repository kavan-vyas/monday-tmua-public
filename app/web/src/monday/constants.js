// ═══════════════ MONDAY — shared front-end constants ═══════════════
import { MOOD } from '../../../design/tokens.js';
// Mirrors the contracts in plangamma.md §C1/§C2/§C3. Nothing here talks to the
// server; these are the shapes the UI renders and the vocabulary it speaks in.

/** Mood → colour, one per theme.
 *  THE VALUES COME FROM app/design/tokens.js, the same file that generates every
 *  surface's CSS and that app/server/mood.js reads for its MOOD_COLORS export.
 *  This is no longer a hand-copied fallback that could drift — it is the source.
 *  The server still ships its palette down on the `config` event and
 *  setMoodColors() overwrites in place, which keeps a server with a different
 *  palette authoritative at runtime. */
export const MOOD_COLORS = Object.fromEntries(
  Object.entries(MOOD).map(([mood, v]) => [mood, { light: v.light, dark: v.dark }])
);
export const MOODS = Object.keys(MOOD_COLORS);

/** The text colour to place ON a mood fill.
 *  A fill dark enough to read as a 2px rule against paper cannot also carry black
 *  text — the two are different jobs, so they are stated separately rather than
 *  fudged into one value. Not part of the server contract; derived here. */
export const MOOD_INK = Object.fromEntries(
  Object.entries(MOOD).map(([mood, v]) => [mood, { light: v.onLight, dark: v.onDark }])
);

/** Adopt the server's palette. Mutates in place so every module that already holds
 *  a reference to MOOD_COLORS — and moodColor(), which reads it per call — follows. */
export function setMoodColors(next) {
  if (!next || typeof next !== 'object') return MOOD_COLORS;
  for (const [mood, pair] of Object.entries(next)) {
    if (pair && typeof pair === 'object' && MOOD_COLORS[mood]) Object.assign(MOOD_COLORS[mood], pair);
  }
  return MOOD_COLORS;
}

// Rank used by the mood sparkline: calm at the bottom, severe at the top.
export const MOOD_RANK = { gentle: 0, focused: 1, wry: 2, clinical: 3, sharp: 4, grave: 5 };

export const moodColor = (mood, theme) =>
  (MOOD_COLORS[mood] ?? MOOD_COLORS.focused)[theme === 'dark' ? 'dark' : 'light'];

/** Legible text colour for a label sitting on that mood's fill. */
export const moodInk = (mood, theme) =>
  (MOOD_INK[mood] ?? MOOD_INK.focused)[theme === 'dark' ? 'dark' : 'light'];

/** One-line manner note, shown in the mood popover under the reason.
 *  THE ONLY COPY IN CODE of plangamma.md §B2's `manner` column. server/mood.js kept a
 *  second one that nothing read; it was deleted rather than shared, because mood.js
 *  imports node:fs and so can never be re-exported the way modes.js is below.
 *  What the MODEL is told lives in server/prompt.js's SIX MOODS block, in long form
 *  with exemplars. These lines are the user-facing gloss of it — a mood must not mean
 *  one thing there and another thing here. */
export const MOOD_MANNER = {
  focused:  'Level, economical, quietly attentive.',
  sharp:    'Dry needling. Difficulty goes up and I say so.',
  gentle:   'Slower, edge off. Fatigue named as fatigue.',
  clinical: 'Almost no personality. I come back at the debrief.',
  wry:      'The most character I show. Short.',
  grave:    'Sober. No jokes. This one is rare.',
};

// ── modes ────────────────────────────────────────────────────────────────────
// Re-exported, not restated. server/modes.js is pure data — no node builtins, no
// side effects — so the bundler takes it, and the list cannot drift the way a
// hand-copied one could. Same argument as MOOD_COLORS above.
export { MODES } from '../../../server/modes.js';
export const MODE_HINT = {
  DRILL:      'default — questions, marking, backlog',
  EXAM:       'timer forced · no hints · silent · full marking at the end',
  POSTMORTEM: 'last session’s errors only — no new questions',
  TEACH:      'explanation first, then a test',
  CONSOLIDATION: 'volume & speed — more papers faster, timer on, hints kept short',
  PAUSE:      'tutor mode off — nothing is marked or logged',
};

// ── proactive triggers (plangamma.md §B2 / §C4) ──────────────────────────────
export const PROACTIVE_TRIGGERS = [
  ['idle_nudge',      'Idle nudge',      'no message for 6 min in a live session', true],
  ['repeat_mistake',  'Repeat mistake',  'same misconception twice within 14 days', true],
  ['avoided_topic',   'Avoided topic',   'below 60% and untouched for 21 days', true],
  ['backlog_due',     'Backlog due',     'revision items falling due', true],
  ['session_debrief', 'Session debrief', 'past 40 min with no close sequence', true],
  ['exam_milestone',  'Exam milestone',  '90 / 60 / 30 / 14 / 7 / 1 days out', true],
  ['late_night',      'Late night',      'past 23:00 with a session running', false],
];

export const DEFAULT_PROACTIVE = Object.fromEntries(PROACTIVE_TRIGGERS.map(([k, , , d]) => [k, d]));
/** §C4 fixes this block as exactly { enabled, volume }. Prosody lives in SPEECH. */
export const DEFAULT_VOICE = { enabled: true, volume: 0.9 };

/** How often Monday may interrupt, in minutes. Mirrors the server's clamp. */
export const RATE_LIMIT_RANGE = [1, 240];
export const DEFAULT_RATE_LIMIT_MIN = 10;

// ── speech: how Monday talks, as opposed to whether ──────────────────────────
// These mirror server/session.js DEFAULT_SPEECH and its ranges exactly. The
// server is authoritative and clamps everything again; these are the values the
// panel draws with before the first `config` event lands.
export const SPEECH_RANGE = { rate: [0.6, 1.4], pause: [0.4, 2.5], maxChars: [80, 4000] };
export const DEFAULT_PROSODY = Object.fromEntries(MOODS.map((m) => [m, { rate: 1, pause: 1 }]));
export const DEFAULT_SPEECH = {
  rate: 1,
  longForm: true,
  maxChars: 480,
  prosody: DEFAULT_PROSODY,
};

// ── appearance ───────────────────────────────────────────────────────────────
// Density and font size are applied by REDEFINING TOKENS on the root element
// (see app.css), never by overriding individual rules — so every pane, present
// and future, follows without knowing these settings exist.
export const THEMES = [
  ['system', 'System', 'follow whatever the machine is set to'],
  ['light',  'Light',  'warm paper, for a lit room'],
  ['dark',   'Dark',   'for late sessions'],
];
export const DENSITIES = [
  ['comfortable', 'Comfortable', 'the default spacing'],
  ['compact',     'Compact',     'tighter padding — more on screen at once'],
];
export const FONT_SIZES = [
  ['small',  'Small',  'one step down from the default'],
  ['normal', 'Normal', '14px body text'],
  ['large',  'Large',  'one step up, for long reading sessions'],
];
export const DEFAULT_APPEARANCE = { theme: 'system', density: 'comfortable', fontSize: 'normal' };

/** The theme actually in force, resolving 'system' against the OS setting. */
export function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

// ── models and effort ────────────────────────────────────────────────────────
// Mirrors MODELS / EFFORTS in server/session.js.
export const MODELS = [
  ['sonnet', 'Sonnet', 'the working default — fast, and good enough for marking'],
  ['opus',   'Opus',   'slowest and strongest; for teaching a topic from scratch'],
  ['fable',  'Fable',  'the newest model'],
  ['haiku',  'Haiku',  'cheapest and quickest; fine for admin, weak on proof'],
];
export const EFFORTS = [
  ['low',    'Low',    'answers fast, thinks little'],
  ['medium', 'Medium', 'a balance'],
  ['high',   'High',   'the default — thinks before marking'],
  ['xhigh',  'Extra',  'slowest; for a proof it keeps getting wrong'],
];

// ── what each mode gates ─────────────────────────────────────────────────────
// The labels only. The truthful values come from GET /api/config's `modeGates`,
// which is read straight out of server/modes.js — the panel never asserts a gate
// the server has not confirmed.
export const GATE_LABELS = [
  ['voiceEnabled',     'Monday speaks'],
  ['hintsAllowed',     'Hints allowed'],
  ['videoAllowed',     'Videos allowed'],
  ['proactiveEnabled', 'May interrupt'],
  ['timerForced',      'Timer forced'],
];

/** Bytes → a short human string. Used by the DATA section. */
export function bytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── first-person tool captions ───────────────────────────────────────────────
// `tool_use` carries { name, detail, page }. `detail` is a file path (basename
// already stripped by the caller) and is very often empty — every template here
// has to read well with no detail at all.
const withDetail = (withD, without) => (d) => (d ? withD(d) : without);

export const TOOL_VOICE = {
  // ── papers ──
  show_pdf:         withDetail((d) => `putting ${d} on screen`, 'putting the paper on screen'),
  get_pdf_page:     withDetail((d) => `reading ${d}`, 'reading the page'),
  find_in_pdf:      withDetail((d) => `searching ${d} for it`, 'searching the paper for it'),
  // ── backlog ──
  add_backlog:      withDetail((d) => `logging that for rework — ${d}`, 'logging that one for rework'),
  list_backlog:     () => 'pulling up what you still owe me',
  relabel_backlog:   withDetail((d) => `correcting the label on ${d}`, 'correcting a mislabelled backlog entry'),
  remove_backlog:    withDetail((d) => `removing ${d} from the backlog`, 'removing a duplicate from the backlog'),
  complete_backlog: () => 'closing that one off',
  read_backlog_notes: withDetail((d) => `pulling up the full record on ${d}`, 'pulling up the full record on that question'),
  write_backlog_note: withDetail((d) => `leaving you a note on ${d}`, 'leaving you a note on that question'),
  // ── the index ──
  query_tag_index:  withDetail((d) => `checking the index — ${d}`, 'checking the index'),
  question_profile: withDetail((d) => `looking up ${d} properly`, 'looking that question up properly'),
  drill_set:        () => 'building you a drill set',
  index_stats:      () => 'counting what I actually have',
  audit_paper:      withDetail((d) => `auditing ${d}`, 'auditing the paper'),
  // ── the paper itself: his marks and mine ──
  read_annotations:  withDetail((d) => `reading what you marked on ${d}`, 'reading what you marked on the page'),
  annotate_pdf:      withDetail((d) => `marking up ${d}`, 'marking that up on the page'),
  clear_annotations: withDetail((d) => `wiping my marks off ${d}`, 'wiping my marks off the page'),
  // ── intake ──
  triage_pdf:        withDetail((d) => `reading ${d} to see what it actually is`, 'reading that to see what it actually is'),
  add_paper:         withDetail((d) => `filing ${d} as a paper and classifying it`, 'filing that as a paper and classifying it'),
  file_to_library:   withDetail((d) => `filing ${d} into the library`, 'filing that into the library'),
  // ── video ──
  find_video:        withDetail((d) => `looking for a video on ${d}`, 'looking for a video that covers this'),
  show_video:        withDetail((d) => `putting ${d} on screen`, 'putting the video on screen'),
  // ── records ──
  get_schedule:     () => 'checking what’s on your calendar',
  start_timer:      () => 'starting the clock',
  exam_sittings:    () => 'looking up the mocks you have sat',
  sitting_report:   () => 'reading back that sitting',
  log_activity:     () => 'writing that into the log',
  journal_note:     () => 'noting that down',
  // ── Monday's own memory (agent B) ──
  monday_recall:    withDetail((d) => `remembering how ${d} went last time`, 'remembering how this went last time'),
  monday_note:      () => 'making a note on what just worked',
  monday_self:      () => 'checking my own wiring',
  // ── SDK built-ins that can still surface ──
  Read:             withDetail((d) => `reading ${d}`, 'reading a file'),
  Write:            withDetail((d) => `writing ${d}`, 'writing a file'),
  Edit:             withDetail((d) => `editing ${d}`, 'editing a file'),
  Glob:             () => 'looking through the files',
  Grep:             () => 'searching the files',
  TodoWrite:        () => 'keeping my own list straight',
  Task:             () => 'handing part of this to a sub-agent',
};

/** tool_use event → the sentence Monday says while doing it. */
export function toolCaption(ev) {
  const name = String(ev.name ?? '').replace('mcp__tutor__', '');
  const detail = String(ev.detail ?? '').split('/').pop();
  const page = ev.page ? ` p${ev.page}` : '';
  const fn = TOOL_VOICE[name];
  if (fn) return `${fn(detail)}${page}`;
  return `${name.replace(/_/g, ' ')}${detail ? ` — ${detail}` : ''}${page}`;
}

/** ms → m:ss, for the session clock in the status line. */
export function clock(ms) {
  const s = Math.max(0, Math.floor((ms ?? 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export const TARGET_SCORE = 9.0;

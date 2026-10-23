import fs from 'node:fs';
import path from 'node:path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { buildSystemPrompt } from './prompt.js';
import { PROJECT_ROOT, insideRoot, insideTutorData } from './paths.js';
import { rasterizeBase64, searchPdf } from './pdf.js';
import { buildDashboard, appendJournal } from './dashboard.js';
import { triage as triagePdf, summarise as triageSummary } from './triage.js';
import { getSchedule, formatForModel } from './calendar.js';
import { queryIndex, drillSet, indexStats, resolvePaths, formatQuestion, formatList } from './tagindex.js';
import { auditPaper, formatAudit, plan } from './ingest.js';
import { enqueuePaper } from './organise.js';
import {
  keyForPath, pathForKey, readDoc, saveDoc, addMarks, clearMarks, applyPages, countMarks, formatDoc,
  MONDAY_COLOR,
} from './annotations.js';
import { findVideo, formatSegments, knowsVideo, loadVideoIndex } from './video.js';
import {
  addItem as addBacklog, listItems as listBacklog, completeItem as completeBacklog,
  editItem as editBacklog, removeItem as removeBacklog,
  summary as backlogSummary, formatForModel as formatBacklog,
  findItem as findBacklog, addNote as addBacklogNote,
} from './backlog.js';
import { mondayRecall, mondayNote, mondaySelf, recordMood } from './mondaymem.js';
import { computeState, withStateBlock } from './mood.js';
import { modeGates, normaliseMode, isMode, detectMode, DEFAULT_MODE } from './modes.js';
import { DEFAULT_EXAM_DATE } from './readiness.js';
import { DEFAULT_TOGGLES } from './proactive.js';
import { createSpeechStream, MOODS as VOICE_MOODS, setVoiceOptions } from './voice.js';
import { TOOL_NAMES, TOOL_COUNT } from './toolnames.js';
import { listSittings, sittingReport } from './exam.js';

// Every tool the tutor server registers, checked against the SDK init message so a
// silent tool-search deferral is caught at startup. The list itself lives in
// toolnames.js so prompt.js can state the count without an import cycle.
export { TOOL_NAMES, TOOL_COUNT };

/**
 * Resolve the `paper` argument of the annotation tools. Accepts, in order:
 *   - an absolute (or project-relative) path to a PDF,
 *   - a tag-index question id (MAT2016H, TMUA2019P1Q07) — resolved through the manifest,
 *   - a manifest key (tmua/2019/p1), which is also the annotation storage key.
 * Returns { abs, label } or { error }.
 */
export function resolvePaperArg(paper) {
  const raw = String(paper ?? '').trim();
  if (!raw) return { error: 'Which paper? Pass a PDF path, a question id like TMUA2019P1Q07, or a manifest key like tmua/2019/p1.' };

  if (raw.includes('/') || /\.pdf$/i.test(raw)) {
    const abs = insideRoot(raw);
    if (abs && fs.existsSync(abs)) return { abs, label: path.basename(abs) };
  }
  const q = resolvePaths(raw);
  if (q?.paper) return { abs: q.paper, label: `${q.label} (${path.basename(q.paper)})` };
  const viaKey = pathForKey(raw);
  if (viaKey) return { abs: viaKey, label: `${raw} (${path.basename(viaKey)})` };
  if (raw.includes('/') || /\.pdf$/i.test(raw)) {
    return { error: `No such PDF: ${raw}. Paths must be absolute and inside the project.` };
  }
  return { error: `Cannot work out which paper "${raw}" is. Use question_profile to get the exact paper path, or a manifest key like tmua/2019/p1.` };
}

const BACKUPS = path.join(PROJECT_ROOT, 'tutor_data', '.backups');
const REBUILD_EVERY = 2; // assistant turns between dashboard refreshes

// Keep the last few versions of any JSON the tutor edits, so corruption is recoverable.
function snapshot(abs) {
  try {
    if (!fs.existsSync(abs)) return;
    fs.mkdirSync(BACKUPS, { recursive: true });
    const base = path.basename(abs);
    fs.copyFileSync(abs, path.join(BACKUPS, `${base}.${Date.now()}`));
    const mine = fs.readdirSync(BACKUPS).filter((f) => f.startsWith(base + '.')).sort();
    for (const old of mine.slice(0, -8)) fs.rmSync(path.join(BACKUPS, old), { force: true });
  } catch {}
}

export const MODELS = ['sonnet', 'fable', 'opus', 'haiku'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh'];

// ── the settings vocabulary ─────────────────────────────────────────────────
// Everything the settings pane can write lives here, with its legal range. The
// client is NEVER trusted: mergeConfig() below is the only door into `config`,
// it drops any key not on this list, and it clamps or rejects every value.
export const THEMES = ['system', 'light', 'dark'];
export const DENSITIES = ['comfortable', 'compact'];
export const FONT_SIZES = ['small', 'normal', 'large'];

/** Speaking-rate and pause-scale bounds, shared by the server and the panel. */
export const VOICE_LIMITS = {
  volume:   [0, 1],
  rate:     [0.6, 1.4],     // global speaking rate multiplier
  pause:    [0.4, 2.5],     // per-mood pause scale
  maxChars: [80, 4000],     // how much of a reply "short lines only" will speak
};
export const PROACTIVE_RATE_LIMIT_MIN = [1, 240];
export const TARGET_SCORE_RANGE = [1, 9];

/** Per-mood prosody. 1.0 / 1.0 is exactly the preset in tts/prosody.py. */
export const DEFAULT_PROSODY = Object.fromEntries(
  VOICE_MOODS.map((m) => [m, { rate: 1, pause: 1 }])
);

// §C4 fixes `config.voice` as exactly { enabled, volume } and the acceptance
// suite asserts that shape byte for byte (ACC-CFG-02). So the prosody knobs the
// settings pane adds live in their own block, `config.speech`, rather than
// widening a contract other code already depends on.
export const DEFAULT_VOICE = { enabled: true, volume: 0.9 };

/** How Monday speaks, as opposed to whether. Read live by voice.js per chunk. */
export const DEFAULT_SPEECH = {
  rate: 1,             // global speaking-rate multiplier over the mood preset
  longForm: true,      // false: speak the opening of a reply, then stay quiet
  maxChars: 480,       // the cap "short lines only" enforces, in characters
  prosody: DEFAULT_PROSODY,
};

export const DEFAULT_APPEARANCE = { theme: 'system', density: 'comfortable', fontSize: 'normal' };

export const DEFAULT_CONFIG = {
  model: 'sonnet',
  effort: 'high',
  mode: DEFAULT_MODE,
  voice: DEFAULT_VOICE,
  speech: DEFAULT_SPEECH,
  proactive: { ...DEFAULT_TOGGLES },
  proactiveEnabled: true,
  proactiveRateLimitMin: 10,     // the global floor between two interruptions
  examDate: DEFAULT_EXAM_DATE,   // mirror of session_memory.exam_date (readiness.js owns it)
  targetScore: 9,
  appearance: DEFAULT_APPEARANCE,
};

/** The keys a config is allowed to acquire FROM A CLIENT. A patch key outside
 *  this list is dropped; a key already in the stored state is carried through
 *  untouched, because §C4 says the migration loses nothing (ACC-CFG-07). */
export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

/** Keys the migration deliberately destroys. §C4: "nothing except persona". */
const RETIRED_KEYS = ['persona'];

// ── validators ──────────────────────────────────────────────────────────────
// Each returns `undefined` for "not a legal value", which is what drives the
// three-step fallback in take(): the patch, then what was already stored, then
// the default. A bad patch value therefore never resets a good stored one.
const vBool = (v) => (typeof v === 'boolean' ? v : undefined);
const vEnum = (list) => (v) => (list.includes(v) ? v : undefined);
/**
 * Number(null), Number(''), Number([]) and Number(false) are all 0, and
 * Number(true) is 1 — so a plain Number() coercion turns four different kinds of
 * "not a number" into a legal setting. Only a real finite number, or a string
 * that is entirely a number, gets through here.
 */
const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const vNum = ([lo, hi], step = 0.01) => (v) => {
  const n = toNumber(v);
  if (n === undefined) return undefined;
  const clamped = Math.min(hi, Math.max(lo, n));
  // Snapped to the step the slider uses, so a round trip through the panel is
  // stable and .state.json never fills up with 0.9000000000000001.
  return Number((Math.round(clamped / step) * step).toFixed(4));
};
const vInt = ([lo, hi]) => (v) => {
  const n = toNumber(v);
  if (n === undefined) return undefined;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
/** A real calendar date in YYYY-MM-DD. Not "any string that parses". */
const vDate = (v) => {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toISOString().slice(0, 10) === s ? s : undefined;
};

/** patch → stored → default, taking the first that validates. */
const take = (fn, patchVal, baseVal, dflt) => {
  const a = fn(patchVal);
  if (a !== undefined) return a;
  const b = fn(baseVal);
  if (b !== undefined) return b;
  return dflt;
};

function mergeVoice(base = {}, patch = {}) {
  const b = base ?? {};
  const p = patch ?? {};
  return {
    enabled: take(vBool, p.enabled, b.enabled, DEFAULT_VOICE.enabled),
    volume: take(vNum(VOICE_LIMITS.volume), p.volume, b.volume, DEFAULT_VOICE.volume),
  };
}

function mergeSpeech(base = {}, patch = {}) {
  const b = base ?? {};
  const p = patch ?? {};
  const prosody = {};
  // Only the six real moods. A client cannot invent a seventh and have it stored.
  for (const mood of VOICE_MOODS) {
    const bp = b.prosody?.[mood] ?? {};
    const pp = p.prosody?.[mood] ?? {};
    prosody[mood] = {
      rate: take(vNum(VOICE_LIMITS.rate), pp.rate, bp.rate, 1),
      pause: take(vNum(VOICE_LIMITS.pause), pp.pause, bp.pause, 1),
    };
  }
  return {
    rate: take(vNum(VOICE_LIMITS.rate), p.rate, b.rate, DEFAULT_SPEECH.rate),
    longForm: take(vBool, p.longForm, b.longForm, DEFAULT_SPEECH.longForm),
    maxChars: take(vInt(VOICE_LIMITS.maxChars), p.maxChars, b.maxChars, DEFAULT_SPEECH.maxChars),
    prosody,
  };
}

function mergeProactive(base = {}, patch = {}) {
  const out = { ...DEFAULT_TOGGLES };
  for (const id of Object.keys(DEFAULT_TOGGLES)) {
    // Only the seven known trigger ids survive; a client cannot invent an eighth.
    out[id] = take(vBool, patch?.[id], base?.[id], DEFAULT_TOGGLES[id]);
  }
  return out;
}

function mergeAppearance(base = {}, patch = {}) {
  const b = base ?? {};
  const p = patch ?? {};
  return {
    theme: take(vEnum(THEMES), p.theme, b.theme, DEFAULT_APPEARANCE.theme),
    density: take(vEnum(DENSITIES), p.density, b.density, DEFAULT_APPEARANCE.density),
    fontSize: take(vEnum(FONT_SIZES), p.fontSize, b.fontSize, DEFAULT_APPEARANCE.fontSize),
  };
}

/**
 * Merge a (possibly sparse) config patch over a base, validating EVERY value.
 *
 * Four rules, in order:
 *   1. a key the PATCH carries that is not in CONFIG_KEYS is dropped. The client
 *      cannot invent settings, and cannot use the config as scratch storage.
 *   2. a key the STORED config already carries is passed through untouched, even
 *      if this module does not model it — §C4 requires the migration to lose
 *      nothing but `persona` (ACC-CFG-07), and a future key must survive a
 *      downgrade. Nothing reads those keys; they are only carried.
 *   3. every modelled value is checked against its own range or enum.
 *   4. an invalid patch value falls back to what was already stored, and only
 *      then to the default — so a malformed write cannot silently reset a real
 *      setting to a default the user never chose.
 *
 * `voice`, `speech`, `speech.prosody`, `proactive` and `appearance` merge
 * key-by-key, so a sparse patch cannot clear a sibling and a setting added later
 * still arrives with its default.
 */
export function mergeConfig(base, patch = {}) {
  const b = base ?? {};
  const p = patch ?? {};
  const raw = {};
  for (const k of CONFIG_KEYS) if (k in p) raw[k] = p[k];

  // Rule 2: carry unmodelled stored keys, minus the ones we deliberately retire.
  const carried = {};
  for (const [k, v] of Object.entries(b)) {
    if (CONFIG_KEYS.includes(k) || RETIRED_KEYS.includes(k)) continue;
    carried[k] = v;
  }

  return {
    ...carried,
    model: take(vEnum(MODELS), raw.model, b.model, DEFAULT_CONFIG.model),
    effort: take(vEnum(EFFORTS), raw.effort, b.effort, DEFAULT_CONFIG.effort),
    mode: take((v) => (isMode(v) ? normaliseMode(v) : undefined), raw.mode, b.mode, DEFAULT_CONFIG.mode),
    voice: mergeVoice(b.voice, raw.voice),
    speech: mergeSpeech(b.speech, raw.speech),
    proactive: mergeProactive(b.proactive, raw.proactive),
    proactiveEnabled: take(vBool, raw.proactiveEnabled, b.proactiveEnabled, DEFAULT_CONFIG.proactiveEnabled),
    proactiveRateLimitMin: take(vInt(PROACTIVE_RATE_LIMIT_MIN), raw.proactiveRateLimitMin, b.proactiveRateLimitMin, DEFAULT_CONFIG.proactiveRateLimitMin),
    examDate: take(vDate, raw.examDate, b.examDate, DEFAULT_CONFIG.examDate),
    targetScore: take(vNum(TARGET_SCORE_RANGE, 0.1), raw.targetScore, b.targetScore, DEFAULT_CONFIG.targetScore),
    appearance: mergeAppearance(b.appearance, raw.appearance),
  };
}

// broadcast(event, record=true): send to all websocket clients; record=false for deltas.
export function createTutor(broadcast, initialSessionId = null, initialConfig = {}, hooks = {}) {
  let queue = null;
  // Turns since the student last actually typed. A closed session once produced ~35
  // consecutive turns of "(standby)" / "(session inactive)" — each a real billed turn
  // carrying the whole system prompt, ~$0.65 spent saying nothing. Whatever restarts
  // the loop, the cost is the same, so the guard is here in code rather than a line in
  // the prompt asking the model not to.
  let autoTurns = 0;
  const AUTO_TURN_CAP = 3;
  let sessionId = initialSessionId;
  let currentQuery = null;
  let turns = 0;
  // `initialConfig` is .state.json, not a client patch: it is spread in as the
  // BASE so mergeConfig's carry rule keeps any key this build does not model
  // (§C4 / ACC-CFG-07). Everything arriving later through setConfig() is a patch
  // and goes through the whitelist.
  let config = mergeConfig({ ...DEFAULT_CONFIG, ...(initialConfig ?? {}) }, {});
  // The voice worker has to know the prosody settings from the first word it
  // says, not from the first time the panel is touched.
  try { setVoiceOptions(config.speech); } catch { /* voice is never a dependency */ }
  // The chat object lives in index.js; mood needs it for session-elapsed and hysteresis.
  const getChat = hooks.getChat ?? (() => null);

  // Monday's state for the turn in flight. Computed once per user message (computeState
  // advances the mood hysteresis counter, so calling it twice a turn halves the hold).
  // When THIS sitting began. mood.js otherwise dates the session from the chat's
  // createdAt, so reopening a chat from three days ago reads as a twelve-hour
  // session and pins the mood to `gentle` with the untrue reason "720 minutes in".
  // A sitting is anchored to the student's FIRST message, not process start — the
  // server can be up for hours before he opens the app, and reading server uptime as
  // study time pinned the mood to gentle ("222 minutes in") the moment he arrived. It
  // also restarts after a real break, so a genuine pause resets the clock.
  const SITTING_GAP_MS = 25 * 60 * 1000;
  let sessionStartedAt = Date.now();
  let lastUserMessageAt = 0;
  // Any real use of the app counts — clicks and keys in the backlog, the JZ flow, a PDF —
  // not only chat messages. He mostly works without talking to Monday, and a sitting
  // anchored to chat alone read server uptime as study time ("28 hours").
  let lastActivityAt = 0;
  function touch(at = Date.now()) {
    if (!lastActivityAt || at - lastActivityAt > SITTING_GAP_MS) sessionStartedAt = at;
    lastActivityAt = at;
  }
  /** The current sitting for mood.js: zero when nobody has been here for SITTING_GAP_MS. */
  function sitting(now = Date.now()) {
    const live = lastActivityAt && now - lastActivityAt <= SITTING_GAP_MS;
    // a live sitting is never exactly 0, so the UI can tell "just started" from "none"
    return { sessionStartedAt: live ? sessionStartedAt : now, sessionElapsedMs: live ? Math.max(1, now - sessionStartedAt) : 0 };
  }
  let lastState = computeState({ chat: getChat(), config, now: Date.now(), advance: false, snapshot: sitting() });
  let speech = null;          // the live speech stream for the assistant turn in flight

  // A turn Monday raises itself, minutes after the tool that started it returned —
  // add_paper's classification finishing, for instance. Same shape as sendHidden, but
  // reachable from inside the tool handlers, which close over this scope.
  function pushHidden(text) {
    try {
      if (!text) return;
      ensureSession();
      queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    } catch { /* no live session to tell */ }
  }

  const tutorServer = createSdkMcpServer({
    name: 'tutor',
    version: '1.0.0',
    // Without this the SDK defers these behind tool search, and the tutor cannot see
    // them — it reported "PDF tools not up here" and fell back to Read on raw PDFs,
    // bypassing show_pdf/find_in_pdf/log_activity entirely. These are the core tools;
    // they must always be in the prompt.
    alwaysLoad: true,
    tools: [
      tool(
        'show_pdf',
        'Display a PDF page in the student’s viewer pane. Use when presenting a question (paper page) and when marking (solutions page).',
        { path: z.string().describe('Absolute path to the PDF'), page: z.number().int().min(1) },
        async ({ path: p, page }) => {
          const abs = insideRoot(p);
          if (!abs) return { content: [{ type: 'text', text: 'Path outside project root — refused.' }] };
          broadcast({ type: 'show_pdf', path: abs, page });
          return { content: [{ type: 'text', text: `Displayed ${path.basename(abs)} page ${page} to student.` }] };
        }
      ),
      tool(
        'get_pdf_page',
        'Return one PDF page as an image so you can read the exact question text, options, or mark scheme. Fetch only pages you need.',
        { path: z.string().describe('Absolute path to the PDF'), page: z.number().int().min(1) },
        async ({ path: p, page }) => {
          const abs = insideRoot(p);
          if (!abs) return { content: [{ type: 'text', text: 'Path outside project root — refused.' }] };
          const data = await rasterizeBase64(abs, page, 120);
          return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
        }
      ),
      tool(
        'find_in_pdf',
        'Find which page of a PDF contains some text, without rasterising anything. Use it to locate the exact question or mark-scheme page before calling get_pdf_page — never guess a page number and never answer from memory. Mark schemes label parts like "H." or "H" or "E:", so try those forms.',
        {
          path: z.string().describe('Absolute path to the PDF (from file_manifest.json)'),
          query: z.string().describe('Text to find, e.g. "H." for MAT Q1 part H'),
          max: z.number().int().min(1).max(20).optional(),
        },
        async ({ path: p, query, max }) => {
          const abs = insideRoot(p);
          if (!abs) return { content: [{ type: 'text', text: 'Path outside project root — refused.' }] };
          try {
            const r = await searchPdf(abs, query, max ?? 8);
            if (!r.hits.length) {
              return { content: [{ type: 'text', text: `No match for "${query}" in ${path.basename(abs)} (${r.total_pages} pages). Try another label form ("H." / "H" / "(h)"), or the paper may be image-only — fall back to get_pdf_page.` }] };
            }
            const lines = r.hits.map((h) => `p${h.page}: ${h.snippet}`).join('\n');
            return { content: [{ type: 'text', text: `${path.basename(abs)} — ${r.total_pages} pages.\n${lines}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Search failed: ${err.message}. Fall back to get_pdf_page.` }] };
          }
        }
      ),
      // ---- the student's own marks on the paper -----------------------------
      tool(
        'read_annotations',
        'Read what has actually been drawn on a paper — his highlights (WITH the text he highlighted), his pen marks, his arrows and typed notes, plus anything you drew yourself. This is how "I have circled where I got stuck" becomes something you can act on. Call it when he refers to something he marked, before marking his working, and whenever you are about to ask him where he went wrong — the answer may already be on the page.',
        {
          paper: z.string().describe('PDF path, question id (TMUA2019P1Q07), or manifest key (tmua/2019/p1)'),
          page: z.number().int().min(1).optional().describe('One page only. Omit for the whole paper.'),
        },
        async ({ paper, page }) => {
          const r = resolvePaperArg(paper);
          if (r.error) return { content: [{ type: 'text', text: r.error }] };
          const doc = readDoc(r.abs);
          return { content: [{ type: 'text', text: formatDoc(doc, { page: page ?? null, label: r.label }) }] };
        }
      ),
      tool(
        'annotate_pdf',
        'Draw on the paper he is looking at: circle the trap, arrow the term he dropped, highlight the clause he read past, leave a short typed note. Your marks are saved as author "monday" in a distinct colour so they never blur with his, and the pane updates live without a reload. Coordinates are PDF POINTS with the ORIGIN AT THE BOTTOM-LEFT of the page — y increases UPWARDS, so a large y is near the top. A4 is 595 x 842 pt. Use this instead of describing a position in words when the position is the point.',
        {
          paper: z.string().describe('PDF path, question id, or manifest key'),
          page: z.number().int().min(1),
          marks: z.array(z.object({
            type: z.enum(['ink', 'highlight', 'arrow', 'freetext']),
            note: z.string().optional().describe('Why this mark is here — read back to you by read_annotations'),
            paths: z.array(z.array(z.number())).optional().describe('ink: [[x,y],...] in points'),
            width: z.number().optional().describe('ink stroke width in points'),
            quads: z.array(z.array(z.number())).optional().describe('highlight: [[x0,y0,x1,y1],...]'),
            text: z.string().optional().describe('freetext: the note text. highlight: the text underneath.'),
            from: z.array(z.number()).optional().describe('arrow: [x,y] tail'),
            to: z.array(z.number()).optional().describe('arrow: [x,y] head'),
            at: z.array(z.number()).optional().describe('freetext: [x,y] anchor'),
          })).min(1),
        },
        async ({ paper, page, marks }) => {
          const r = resolvePaperArg(paper);
          if (r.error) return { content: [{ type: 'text', text: r.error }] };
          const { doc, added } = addMarks(readDoc(r.abs), page, marks, { author: 'monday' });
          if (!added.length) {
            return { content: [{ type: 'text', text: 'None of those marks were usable. ink needs paths[[x,y],..], highlight needs quads[[x0,y0,x1,y1],..], arrow needs from[x,y] and to[x,y], freetext needs text.' }] };
          }
          const saved = saveDoc(doc);
          broadcast({ type: 'annotations_changed', path: r.abs, key: saved.doc.key, page, author: 'monday', added: added.length });
          return { content: [{ type: 'text', text: `Drew ${added.length} mark${added.length === 1 ? '' : 's'} on ${r.label} page ${page} in ${MONDAY_COLOR}. He can see them now.` }] };
        }
      ),
      tool(
        'clear_annotations',
        'Remove marks from a paper. Defaults to YOUR marks only — his working is his record and you do not delete it unless he asks in words, in which case pass author "student".',
        {
          paper: z.string().describe('PDF path, question id, or manifest key'),
          page: z.number().int().min(1).optional().describe('One page only. Omit for the whole paper.'),
          author: z.string().optional().describe('Whose marks. Default "monday" — your own.'),
        },
        async ({ paper, page, author }) => {
          const r = resolvePaperArg(paper);
          if (r.error) return { content: [{ type: 'text', text: r.error }] };
          const who = author ?? 'monday';
          const { doc, removed } = clearMarks(readDoc(r.abs), { page: page ?? null, author: who });
          if (!removed) return { content: [{ type: 'text', text: `Nothing to clear — no ${who} marks on ${r.label}${page ? ` page ${page}` : ''}.` }] };
          const saved = saveDoc(doc);
          broadcast({ type: 'annotations_changed', path: r.abs, key: saved.doc.key, page: page ?? null, author: who, removed });
          return { content: [{ type: 'text', text: `Cleared ${removed} ${who} mark${removed === 1 ? '' : 's'} from ${r.label}${page ? ` page ${page}` : ''}. ${countMarks(saved.doc)} marks remain.` }] };
        }
      ),
      tool(
        'add_backlog',
        'Rank a mistake for spaced revision. Call this for EVERY question the student gets wrong, every misconception, and every shaky-but-correct answer — no exceptions. tier is the revisit interval in days per the sprint plan: 1 (slip or nearly there), 7 (understood the fix but needs consolidating), 21 (did not know it — needs relearning first).',
        {
          exam: z.enum(['TMUA', 'MAT', 'STEP', 'OTHER']),
          ref: z.string().describe('Question reference, e.g. "2016 P1 Q6" or "2015 Q1B"'),
          topic: z.string().describe('Topic, from the standard vocabulary'),
          bucket: z.enum(['didnt_know', 'slipped', 'timing']).describe("Error bucket from the plan: didn't know it / slipped / ran out of time"),
          tier: z.number().int().describe('1, 7 or 21 — days until the first revisit'),
          detail: z.string().describe('The specific wrong move, one line'),
          correction: z.string().optional().describe('The one-line correction'),
        },
        async (a) => {
          const it = addBacklog(a);
          broadcast({ type: 'backlog_changed' }, false);
          return { content: [{ type: 'text', text: `Backlog: ${it.exam} ${it.ref} — tier ${it.tier}d, due ${it.due} [${it.id}]` }] };
        }
      ),
      tool(
        'list_backlog',
        'What revision is due. Call at session start. Use due_only:true for today\'s work, or false to see the whole backlog.',
        {
          due_only: z.boolean().optional(),
          exam: z.enum(['TMUA', 'MAT', 'STEP', 'OTHER']).optional(),
        },
        async ({ due_only, exam }) => {
          const items = listBacklog({ dueOnly: due_only !== false, exam: exam ?? null });
          return { content: [{ type: 'text', text: formatBacklog(items, backlogSummary()) }] };
        }
      ),
      tool(
        'relabel_backlog',
        'Correct a backlog entry in place — the exam, the reference, the topic, the detail. Use it the moment an entry turns out to be mislabelled: a run of TMUA 2018 Paper 1 questions was once logged as MAT Q1, and with no way to edit, the only option was adding corrected copies and failing the originals, which left duplicates in the due list forever. Scheduling is untouched on purpose: correcting WHAT a question is must not change WHEN it comes back.',
        {
          id: z.string().describe('Backlog id, or its exact ref'),
          exam: z.string().optional().describe('TMUA | MAT | STEP | OTHER'),
          ref: z.string().optional().describe('Corrected reference, e.g. "2018 P1 Q16"'),
          topic: z.string().optional(),
          detail: z.string().optional(),
          correction: z.string().optional(),
        },
        async ({ id, ...patch }) => {
          const it = editBacklog(id, patch);
          if (!it) return { content: [{ type: 'text', text: `No backlog item "${id}".` }] };
          broadcast({ type: 'backlog_changed' }, false);
          return { content: [{ type: 'text', text: `Relabelled: ${it.exam} ${it.ref} — ${it.topic}. Due ${it.due} (unchanged).` }] };
        }
      ),
      tool(
        'remove_backlog',
        'Delete a backlog entry outright. For duplicates and things logged in error ONLY — work he actually finished goes through complete_backlog so the history survives. Say what you removed and why.',
        { id: z.string().describe('Backlog id, or its exact ref') },
        async ({ id }) => {
          const gone = removeBacklog(id);
          if (!gone) return { content: [{ type: 'text', text: `No backlog item "${id}".` }] };
          broadcast({ type: 'backlog_changed' }, false);
          return { content: [{ type: 'text', text: `Removed ${gone.exam} ${gone.ref}.` }] };
        }
      ),
      tool(
        'complete_backlog',
        "Record a revisit attempt. Per the plan a question only closes when reworked correctly from a blank sheet, at least a day later, solution unseen — so only pass it when that actually happened. 'pass' promotes 1→7→21→closed; 'fail' resets it to 1 day.",
        {
          id: z.string().describe('Backlog id (or the exact ref)'),
          result: z.enum(['pass', 'fail']),
          note: z.string().optional(),
        },
        async ({ id, result, note }) => {
          const r = completeBacklog(id, result, note ?? '');
          if (r.error) return { content: [{ type: 'text', text: r.error }] };
          broadcast({ type: 'backlog_changed' }, false);
          const msg = r.status === 'done'
            ? `Closed: ${r.exam} ${r.ref} — cleared all three revisits.`
            : `${r.exam} ${r.ref} → tier ${r.tier}d, next due ${r.due}.`;
          return { content: [{ type: 'text', text: msg }] };
        }
      ),
      tool(
        'read_backlog_notes',
        "Read the full record for one backlog question before you talk about it: his own error detail, your correction, the topic, the tag-index insight (technique, likely traps, difficulty, a one-line description, cross-linked similar questions), BOTH sets of notes (his and yours), the rework history and time spent. This is how you answer 'why do I keep dropping this' with his actual history instead of a guess. Never comment on grades — marks and accuracy only.",
        { ref: z.string().describe('Backlog id or the question ref, e.g. "2018 P1 Q16" or "Chen Q11"') },
        async ({ ref }) => {
          const it = findBacklog(ref);
          if (!it) return { content: [{ type: 'text', text: `No backlog item matching "${ref}".` }] };
          const ins = it.insight;
          const notes = it.notes && !Array.isArray(it.notes) ? it.notes : { student: '', monday: '' };
          const lines = [
            `${it.exam} ${it.ref} — ${String(it.topic).replace(/_/g, ' ')} · ${it.bucket} · tier ${it.tier}d · due ${it.due}`,
            it.detail ? `  his error: ${it.detail}` : '',
            it.correction ? `  fix: ${it.correction}` : '',
            ins ? `  insight: difficulty ${ins.difficulty ?? '?'}/5${ins.technique?.length ? ` · technique: ${ins.technique.join(', ')}` : ''}${ins.trap?.length ? ` · traps: ${ins.trap.join(', ')}` : ''}` : '  insight: (none — mock, unclassified)',
            ins?.description ? `  about: ${ins.description}` : '',
            ins?.cross_links?.length ? `  similar: ${ins.cross_links.join(', ')}` : '',
            `  his note: ${notes.student ? notes.student : '(none yet)'}`,
            `  your note: ${notes.monday ? notes.monday : '(none yet)'}`,
            typeof it.time_seconds === 'number' && it.time_seconds > 0 ? `  time spent: ${Math.round(it.time_seconds / 60)} min` : '',
            it.history?.length ? `  history: ${it.history.map((h) => `${h.date} ${h.tier}d ${h.result}`).join(' · ')}` : '  history: not reworked yet',
          ].filter(Boolean);
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
      ),
      tool(
        'write_backlog_note',
        "Attach YOUR note to a backlog question — the two of you share the same note space, so write what you want him to see next time he opens it: the pattern you spotted, the one thing to watch, the method to use. Replaces your previous note on that item (his note is untouched). Keep it short and specific.",
        {
          ref: z.string().describe('Backlog id or the question ref'),
          text: z.string().describe('Your note. Empty string clears it.'),
        },
        async ({ ref, text }) => {
          const it = findBacklog(ref);
          if (!it) return { content: [{ type: 'text', text: `No backlog item matching "${ref}".` }] };
          const saved = addBacklogNote(it.id, 'monday', text);
          broadcast({ type: 'backlog_changed' }, false);
          return { content: [{ type: 'text', text: `Noted on ${saved.exam} ${saved.ref}.` }] };
        }
      ),
      tool(
        'query_tag_index',
        'Search the full MAT/TMUA classification index (540 questions: MAT Q1 A-J 2007-2022 + 2 specimens, TMUA P1+P2 2016-2022 + practice + specimen). Every question is tagged with topic, technique, question type, cognitive skill, likely traps and difficulty 1-5. Use this to PICK questions — "a hard integration question they have not seen", "everything testing necessary vs sufficient" — instead of guessing which paper to open. Returns question ids; feed one to question_profile or drill_set.',
        {
          family: z.enum(['MAT', 'TMUA', 'TMUA_P1', 'TMUA_P2']).optional(),
          topic: z.string().optional().describe('e.g. integration, logic_and_proof, coordinate_geometry'),
          technique: z.string().optional().describe('e.g. discriminant_condition, proof_by_contradiction'),
          trap: z.string().optional().describe('e.g. missed_case, necessary_confused_with_sufficient'),
          skill: z.string().optional().describe('cognitive skill, e.g. case_analysis'),
          question_type: z.string().optional().describe('e.g. proof, sufficiency_or_necessity, mcq_direct_calculation'),
          paper_section: z.enum(['P1_pure', 'P1_applications', 'P2_logic_and_proof']).optional(),
          year: z.number().int().optional(),
          difficulty_min: z.number().int().min(1).max(5).optional(),
          difficulty_max: z.number().int().min(1).max(5).optional(),
          verified_only: z.boolean().optional().describe('Only questions with an official worked solution (excludes TMUA 2022)'),
          limit: z.number().int().min(1).max(60).optional(),
        },
        async (f) => {
          const res = queryIndex({ ...f, limit: f.limit ?? 20 });
          const bits = Object.entries(f).filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `${k}=${v}`).join(' ');
          return { content: [{ type: 'text', text: formatList(res, `Tag index — ${bits || 'all questions'}:`) }] };
        }
      ),
      tool(
        'question_profile',
        'Everything the index knows about one question, plus the exact PDF paths and the label to search for. Call it before presenting a question: it gives you the paper path, the solutions path and the search label to pass to find_in_pdf. It tells you what the question is ABOUT — it does NOT tell you what it says, so still read the page with get_pdf_page before stating anything.',
        { id: z.string().describe('Index id, e.g. MAT2016H, TMUA2019P1Q07, TMUASPECP2Q12') },
        async ({ id }) => {
          const r = resolvePaths(id);
          if (!r) return { content: [{ type: 'text', text: `No question "${id}" in the index. Ids look like MAT2016H, TMUA2019P1Q07, MATSPEC1C, TMUAPRACP2Q04.` }] };
          const lines = [
            formatQuestion(r.question, { full: true }),
            `  ${r.label}`,
            `  paper: ${r.paper ?? '(not in manifest)'}`,
            `  solutions: ${r.solutions ?? '(none — no worked solution exists)'}`,
            `  find_in_pdf label: "${r.search_label}"`,
          ];
          return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
      ),
      tool(
        'drill_set',
        'Build a targeted drill set around one question: other questions testing the same technique AND the same trap. Use it right after the student gets something wrong — add_backlog records the mistake, drill_set gives you the questions that attack it. Returns ids with their topics and difficulty.',
        {
          id: z.string().describe('Seed question id, e.g. MAT2016H'),
          size: z.number().int().min(1).max(12).optional(),
        },
        async ({ id, size }) => {
          const r = drillSet(id, size ?? 6);
          if (!r) return { content: [{ type: 'text', text: `No question "${id}" in the index.` }] };
          if (!r.drill.length) return { content: [{ type: 'text', text: `${r.seed.id} has no close matches — it is a one-off in this collection.` }] };
          const body = r.drill.map((q) => formatQuestion(q)).join('\n');
          return { content: [{ type: 'text', text: `Drill set for ${formatQuestion(r.seed)}\nSame technique + trap:\n${body}` }] };
        }
      ),
      tool(
        'index_stats',
        'Tag frequency tables across the index — which topics, techniques and traps are most common in an exam family, and the difficulty spread. Use it to plan what is worth drilling, or to answer "what does the MAT actually test most".',
        { family: z.enum(['MAT', 'TMUA', 'TMUA_P1', 'TMUA_P2']).optional() },
        async ({ family }) => {
          const s = indexStats(family);
          const top = (rows, n = 10) => rows.slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ');
          const text = [
            `${family ?? 'ALL'} — ${s.count} questions`,
            `difficulty: ${s.difficulty.map(([d, n]) => `${d}:${n}`).join('  ')}`,
            `topics: ${top(s.topic)}`,
            `techniques: ${top(s.technique, 12)}`,
            `traps: ${top(s.trap_type, 12)}`,
            `question types: ${top(s.question_type, 8)}`,
          ].join('\n');
          return { content: [{ type: 'text', text }] };
        }
      ),
      tool(
        'audit_paper',
        'Audit a paper PDF the student has added: what it is, whether its text layer is readable, how many questions it has, whether solutions exist beside it, and whether it is registered in the manifest and classified in the tag index. READ-ONLY and instant — it changes nothing. Use it whenever the student says they have added a paper, or when a paper behaves oddly. Building the missing resources is a separate step you cannot do from here: it takes minutes, so tell the student to run the command this returns.',
        { path: z.string().describe('Absolute path to the PDF, or a path relative to the project root') },
        async ({ path: p }) => {
          const abs = insideRoot(p);
          if (!abs) return { content: [{ type: 'text', text: 'Path outside project root — refused. Move the paper under the project first.' }] };
          try {
            const a = await auditPaper(abs);
            const todo = plan(a);
            const cmd = todo.length && a.unit
              ? `\n\nTo build what is missing, the student runs this in Terminal:\n  cd ${PROJECT_ROOT}/app && npm run ingest -- "${abs}"\nThat registers it and classifies every question (a few minutes). You cannot run it yourself — no Bash.`
              : '';
            return { content: [{ type: 'text', text: formatAudit(a) + cmd }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Audit failed: ${err.message}` }] };
          }
        }
      ),
      // ---- explicit paper intake, and the library ---------------------------
      tool(
        'triage_pdf',
        'Read what a PDF actually is, from its pages: family, year, paper number, page count, whether it reads like an exam paper, whether it holds TWO papers in one file, and its title line. Free and instant — no page images, no tokens. Use it BEFORE add_paper or file_to_library on anything whose name you do not fully trust, which is most things he drops. A filename is a claim; this is evidence. It moves and renames nothing.',
        { path: z.string().describe('Absolute path to the PDF') },
        async ({ path: p }) => {
          const abs = insideRoot(p);
          if (!abs) return { content: [{ type: 'text', text: 'Path outside project root — refused.' }] };
          if (!fs.existsSync(abs)) return { content: [{ type: 'text', text: `No such file: ${abs}` }] };
          try {
            const t = await triagePdf(abs);
            return { content: [{ type: 'text', text: `${triageSummary(t)}\n\nExcerpt: ${t.first_page_excerpt}\n\n${t.note}` }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Could not read it: ${err.message}` }] };
          }
        }
      ),
      tool(
        'add_paper',
        'Register a PDF as a real exam paper: identify it, file it into the collection, add it to the manifest and classify every question into the tag index. THIS IS THE ONLY WAY A PAPER GETS ADDED — dropping a PDF into the app no longer does any of this, it only puts the file in the inbox. Call it when he says a PDF is a paper, and NOT otherwise; a worksheet, a set of notes or a textbook chapter goes to file_to_library instead. Classification takes minutes and runs in the background: this returns immediately and you are told when it finishes.',
        { path: z.string().describe('Absolute path to the PDF, usually in tutor_data/inbox/') },
        async ({ path: p }) => {
          const abs = insideRoot(p);
          if (!abs) return { content: [{ type: 'text', text: 'Path outside project root — refused.' }] };
          if (!fs.existsSync(abs)) return { content: [{ type: 'text', text: `No such file: ${abs}` }] };
          if (!abs.toLowerCase().endsWith('.pdf')) return { content: [{ type: 'text', text: 'Not a PDF. add_paper only takes exam papers.' }] };
          const name = path.basename(abs);
          broadcast({ type: 'paper_progress', file: name, text: 'picked up — identifying…' });
          enqueuePaper(abs, {
            onProgress: (text) => broadcast({ type: 'paper_progress', file: name, text }, false),
            onDone: (report) => {
              broadcast({ type: 'paper_done', file: name, ...report });
              pushHidden(`[app] add_paper finished for ${name}: ${report.message} Tell him in one line and offer to start it — do not re-audit it.`);
            },
          });
          return { content: [{ type: 'text', text: `Started on ${name}. Identifying, filing, registering and classifying — a few minutes. I will tell you when it is done; carry on in the meantime.` }] };
        }
      ),
      tool(
        'file_to_library',
        'Put a NON-paper PDF where it belongs: tutor_data/library/<topic>/. Worksheets, notes, textbook extracts, specifications, anything that is not an exam paper. The inbox is a landing strip, not storage — anything he drops that is not a paper gets filed here with a line in your journal saying what it is, so nothing silently accumulates. topic should come from the standard vocabulary (index_stats shows it), or "reference" for something that fits no topic.',
        {
          path: z.string().describe('Absolute path to the file, usually in tutor_data/inbox/'),
          topic: z.string().describe('Topic folder, e.g. "logic_and_proof", "integration", or "reference"'),
          note: z.string().describe('One line: what this is and why it is worth keeping'),
          rename: z.string().optional().describe('A clearer filename, if the current one is useless'),
        },
        async ({ path: p, topic, note, rename }) => {
          const abs = insideRoot(p);
          if (!abs) return { content: [{ type: 'text', text: 'Path outside project root — refused.' }] };
          if (!fs.existsSync(abs)) return { content: [{ type: 'text', text: `No such file: ${abs}` }] };
          const slug = String(topic).trim().toLowerCase().replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'reference';
          const dir = path.join(PROJECT_ROOT, 'tutor_data', 'library', slug);
          const base = (rename ? String(rename) : path.basename(abs)).replace(/[/\\]/g, '_');
          const named = /\.[a-z0-9]{1,5}$/i.test(base) ? base : `${base}${path.extname(abs)}`;
          let dest = path.join(dir, named);
          try {
            fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(dest)) {
              const stamp = new Date().toISOString().slice(0, 10);
              dest = path.join(dir, named.replace(/(\.[a-z0-9]{1,5})$/i, ` (${stamp})$1`));
            }
            fs.renameSync(abs, dest);
          } catch (err) {
            return { content: [{ type: 'text', text: `Could not file it: ${err.message}` }] };
          }
          try { await mondayNote({ kind: 'journal', content: `Filed "${path.basename(dest)}" into library/${slug}. ${note}`, topic: slug }); } catch {}
          broadcast({ type: 'file_changed', path: dest }, false);
          return { content: [{ type: 'text', text: `Filed as tutor_data/library/${slug}/${path.basename(dest)} and noted in your journal.` }] };
        }
      ),

      // ---- video ------------------------------------------------------------
      tool(
        'find_video',
        'Search the video index (tutor_data/reference/video_index.json) — R2Drew2’s TMUA playlist mapped onto the SAME topic / technique / trap_type vocabulary as the question index. Use it after a mistake: a wrong answer tagged necessary_confused_with_sufficient has a video that covers exactly that. Returns video ids and start times to hand to show_video. NEVER invent a video id — if it is not in here, it is not indexed, and you say so.',
        {
          topic: z.string().optional().describe('e.g. logarithms, logic_and_proof'),
          technique: z.string().optional().describe('e.g. counterexample_construction'),
          trap: z.string().optional().describe('e.g. necessary_confused_with_sufficient'),
          query: z.string().optional().describe('Free text against the title'),
          exam: z.enum(['TMUA', 'MAT']).optional().describe('For paper walkthroughs'),
          year: z.number().int().optional(),
          paper: z.number().int().min(1).max(2).optional(),
          kind: z.enum(['concept', 'paper_walkthrough', 'meta']).optional(),
          limit: z.number().int().min(1).max(20).optional(),
        },
        async (f) => {
          const res = findVideo({ ...f, limit: f.limit ?? 8 });
          const bits = Object.entries(f).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${v}`).join(' ');
          return { content: [{ type: 'text', text: formatSegments(res, `Video index — ${bits || 'everything'}:`) }] };
        }
      ),
      tool(
        'show_video',
        'Open a video in the student’s video pane at a given second. Same shape as show_pdf: it puts something on his screen, it does not return anything to you. Get the id from find_video — do NOT type a YouTube id from memory, they are unverifiable and a wrong one wastes his time. Say in one line why you are sending him there.',
        {
          videoId: z.string().describe('YouTube video id, from find_video'),
          t: z.number().int().min(0).optional().describe('Start second. Default 0.'),
          note: z.string().optional().describe('One line: what to watch for'),
        },
        async ({ videoId, t, note }) => {
          // EXAM is enforced in code, not by asking nicely. A tutorial video mid-paper
          // is a hint with pictures, and EXAM allows no hints.
          if (!modeGates(config.mode).videoAllowed) {
            return { content: [{ type: 'text', text: 'Refused: EXAM mode. No video during a paper — note it and send it to him in the post-mortem.' }] };
          }
          const id = String(videoId).trim();
          if (!/^[\w-]{11}$/.test(id)) {
            return { content: [{ type: 'text', text: `"${id}" is not a YouTube video id (they are 11 characters). Use find_video to get a real one.` }] };
          }
          const known = knowsVideo(id);
          broadcast({ type: 'show_video', videoId: id, t: t ?? 0, note: note ?? '' });
          return { content: [{ type: 'text', text: `Opened ${id} at ${t ?? 0}s in his video pane.${known ? '' : ' NOTE: that id is not in the video index, so it is unverified — if it is the wrong video, say so and use find_video.'}` }] };
        }
      ),
      tool(
        'get_schedule',
        "Read the student's Google Calendar (read-only) to see what they have on. Call it at session start to size the session to the time actually available, and whenever they mention being busy, tired, or short on time. Do not nag about non-study commitments — use it to plan realistically.",
        { days: z.number().int().min(1).max(31).optional().describe('How many days ahead. Default 7; use 1 for just today.') },
        async ({ days }) => {
          const d = days ?? 7;
          try {
            const sched = await getSchedule({ days: d });
            return { content: [{ type: 'text', text: formatForModel(sched, d) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Calendar unavailable: ${err.message}` }] };
          }
        }
      ),
      tool(
        'start_timer',
        'Start a visible countdown timer in the student’s app (Phase 2+ per-question timing). The student sees it live; you are NOT notified on expiry — ask for their answer as usual.',
        { minutes: z.number().min(0.25).max(90), label: z.string().optional().describe('e.g. "MAT 2022 Q1C"') },
        async ({ minutes, label }) => {
          broadcast({ type: 'timer', seconds: Math.round(minutes * 60), label: label ?? '' }, false);
          return { content: [{ type: 'text', text: `Timer started: ${minutes} min${label ? ` (${label})` : ''}.` }] };
        }
      ),
      tool(
        'exam_sittings',
        'List the papers the student has sat in the exam simulator (the exam simulator at /exam), newest first, with score, timing and how many he flagged. Use it when he mentions a mock, or at the start of a post-mortem, to find the sitting id you then pass to sitting_report.',
        { limit: z.number().int().min(1).max(50).optional(), paper_id: z.string().optional().describe('e.g. "jz_c_p1" or "jc_26_p2" to see only that paper') },
        async ({ limit, paper_id }) => {
          const rows = listSittings({ limit: limit ?? 20, paperId: paper_id ?? null });
          if (!rows.length) return { content: [{ type: 'text', text: 'No sittings recorded yet.' }] };
          const text = rows.map((r) => {
            const when = String(r.startedAt).slice(0, 16).replace('T', ' ');
            const score = r.score?.raw != null ? `${r.score.raw}/${r.score.outOf} (grade ${r.score.gradeLabel})` : 'unmarked';
            const clock = r.timing === 'untimed' ? 'untimed' : `${Math.round((r.durationSec ?? 0) / 60)}min${r.extraTime ? '+25%' : ''}`;
            return `${r.id}  ${when}  ${r.title}  ${clock}  ${score}  ${r.status}${r.reason ? `/${r.reason}` : ''}  flagged ${r.flagged}`;
          }).join('\n');
          return { content: [{ type: 'text', text }] };
        }
      ),
      tool(
        'sitting_report',
        'The full record of ONE simulator sitting: score, where the time went, which answers he changed and in which direction, what he flagged, what he never came back to, and whether the clock beat him. This is the evidence for a post-mortem — read it before drawing conclusions about a mock, rather than asking him to recall it.',
        { sitting_id: z.string().describe('from exam_sittings') },
        async ({ sitting_id }) => {
          try {
            return { content: [{ type: 'text', text: sittingReport(sitting_id) }] };
          } catch (err) {
            return { content: [{ type: 'text', text: `Could not read that sitting: ${err.message}` }] };
          }
        }
      ),
      tool(
        'log_activity',
        'Append one entry to the continuous record (tutor_data/activity_log.json). Call it the moment any TMUA-relevant event occurs: a question attempted, external/self-reported practice, a misconception, an insight, a resource used, or a note to remember. Append-only; never overwrites prior entries.',
        {
          type: z.enum(['question', 'self_report', 'misconception', 'insight', 'resource', 'note']),
          source: z.enum(['mat_q1', 'tmua', 'step', 'external', 'generated', 'self_reported']).optional(),
          topic: z.string().optional().describe('e.g. "integration"'),
          detail: z.string().describe('What happened, in one line. Put messiness/retries/fatigue here, never in `correct`.'),
          correct: z
            .boolean()
            .optional()
            .describe(
              'Outcome of ONE question: true if the final answer was right (even if the path was messy, slow or retried), false if wrong. OMIT for multi-question summaries, notes, resources and insights that have no single outcome.'
            ),
          session_number: z.number().int().optional(),
        },
        async ({ type, source, topic, detail, correct, session_number }) => {
          const file = path.join(PROJECT_ROOT, 'tutor_data', 'activity_log.json');
          let store = { entries: [] };
          try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
          if (!Array.isArray(store.entries)) store.entries = [];
          const entry = { ts: new Date().toISOString().slice(0, 16), type, detail };
          if (source !== undefined) entry.source = source;
          if (topic !== undefined) entry.topic = topic;
          if (correct !== undefined) entry.correct = correct;
          if (session_number !== undefined) entry.session_number = session_number;
          store.entries.push(entry);
          fs.writeFileSync(file, JSON.stringify(store, null, 2));
          broadcast({ type: 'activity_logged', entryType: type, topic: topic ?? '' }, false);
          return { content: [{ type: 'text', text: `Logged ${type}${topic ? ` (${topic})` : ''}.` }] };
        }
      ),
      tool(
        'journal_note',
        'Add one short narrative entry to the public dashboard journal. This is the ONLY dashboard file you write — stats, activity, elements and the per-question breakdown are all derived automatically from session_memory.json and activity_log.json, so never read or edit those. Keep it anonymous (no name/school) and to a few sentences.',
        {
          title: z.string().describe('Short headline, e.g. "MAT 2016 import + backlog cleared"'),
          body: z.string().describe('Two or three sentences on what happened and what it showed.'),
        },
        async ({ title, body }) => {
          const n = appendJournal(title, body);
          refreshDashboard('journal');
          return { content: [{ type: 'text', text: `Journal entry added (${n} total). Dashboard regenerated.` }] };
        }
      ),

      // ---- Monday's own memory (tutor_data/monday/) --------------------------
      tool(
        'monday_recall',
        'What you already know about teaching something to this student: which explanations landed, which bounced, which phrasings he took well. CALL THIS BEFORE re-teaching any topic he has struggled with — you have taught him before and you do not get to rediscover what already failed.',
        {
          kind: z.enum(['explanation', 'phrasing', 'observation', 'all']).optional()
            .describe('Which record to search. Default all.'),
          topic: z.string().optional().describe('Topic or keyword, e.g. "combinatorics". Omit for everything.'),
        },
        async ({ kind, topic }) => {
          const r = await mondayRecall({ kind, topic });
          return { content: [{ type: 'text', text: r.text }] };
        }
      ),
      tool(
        'monday_note',
        'Record what just happened so the next attempt is better informed. kind "explanation" (outcome landed/bounced/partial) after an explanation visibly lands or visibly bounces — do it in the same turn, while you still know what did the work. kind "phrasing" (outcome good/flat/bad) when a way of putting something got him working or put his back up. kind "observation" for a standing fact about how he works. kind "journal" for a short session-close entry in your own voice.',
        {
          kind: z.enum(['explanation', 'phrasing', 'observation', 'journal']),
          content: z.string().describe('The approach you used / the line you said / the observation / the journal text'),
          outcome: z.string().optional().describe('explanation: landed|bounced|partial. phrasing: good|flat|bad.'),
          topic: z.string().optional(),
          evidence: z.string().optional().describe('What made you say that — "got the next two unaided", "asked the same thing back"'),
          context: z.string().optional(),
        },
        async (args) => {
          const r = await mondayNote(args);
          return { content: [{ type: 'text', text: r.text }] };
        }
      ),
      tool(
        'monday_self',
        'Your own build, computed live at the moment of asking: model, reasoning effort, uptime, exact tool inventory, which tools are disallowed, read/write limits, papers on disk, index size, saved chats. Use this instead of reciting facts about yourself — the numbers change and a memorised answer goes stale.',
        {},
        async () => {
          const r = await mondaySelf();
          return { content: [{ type: 'text', text: r.text }] };
        }
      ),
    ],
  });

  // Regenerate the published dashboard from the source records. Pure code, no tokens.
  function refreshDashboard(reason) {
    try {
      const r = buildDashboard();
      broadcast({ type: 'dashboard', ...r, reason }, false);
    } catch (err) {
      broadcast({ type: 'dashboard_error', text: err.message }, false);
    }
  }

  async function canUseTool(name, input) {
    if (name.startsWith('mcp__tutor__')) return { behavior: 'allow', updatedInput: input };
    if (['Read', 'Glob', 'Grep'].includes(name)) {
      const p = input.file_path ?? input.path ?? PROJECT_ROOT;
      return insideRoot(p)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Reads are limited to the project root.' };
    }
    if (['Write', 'Edit'].includes(name)) {
      // No spreadsheet is part of this app any more. Refuse before any path check so
      // a stray .xlsx sitting in the tree can never be written or quietly relied on.
      if (/\.(xlsx?|xlsm|csv)$/i.test(String(input.file_path ?? ''))) {
        return { behavior: 'deny', message: 'Spreadsheets are off limits — no reading, no writing. He no longer keeps his workbook here; he pastes screenshots and text instead. Record everything in session_memory.json / activity_log.json.' };
      }
      const abs = input.file_path && insideTutorData(input.file_path);
      if (!abs) return { behavior: 'deny', message: 'Writes are limited to tutor_data/.' };
      // The tutor has corrupted session_memory.json with a stray trailing comma before
      // now, which silently breaks every downstream reader. Reject invalid JSON at the
      // door, and snapshot the file first so a bad edit is always recoverable.
      if (abs.endsWith('.json')) {
        if (name === 'Write' && typeof input.content === 'string') {
          try { JSON.parse(input.content); } catch (e) {
            return { behavior: 'deny', message: `Refused: that would write invalid JSON to ${path.basename(abs)} — ${e.message}. Fix the syntax (check for trailing commas) and retry.` };
          }
        }
        snapshot(abs);
      }
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `Tool ${name} is not permitted in the tutor app.` };
  }

  function makeQueue() {
    const items = [];
    let notify = null;
    return {
      push(msg) {
        items.push(msg);
        notify?.();
      },
      async *[Symbol.asyncIterator]() {
        while (true) {
          while (items.length) yield items.shift();
          await new Promise((r) => (notify = r));
        }
      },
    };
  }

  async function pump(q) {
    try {
      for await (const msg of q) {
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              sessionId = msg.session_id;
              broadcast({ type: 'session_init', session_id: sessionId }, false);
              // The tutor silently loses every custom tool if they get deferred behind
              // tool search. Say so loudly at startup rather than letting it surface as
              // "PDF tools not up here" mid-lesson.
              const loaded = (msg.tools ?? []).filter((t) => t.startsWith('mcp__tutor__'));
              if (loaded.length < TOOL_NAMES.length) {
                const missing = TOOL_NAMES.filter((n) => !loaded.includes(`mcp__tutor__${n}`));
                console.warn(`[tutor] WARNING: ${loaded.length}/${TOOL_NAMES.length} tutor tools loaded. Missing: ${missing.join(', ')}`);
              } else {
                console.log(`[tutor] ${loaded.length} tutor tools loaded.`);
              }
            } else if (msg.subtype === 'compact_boundary') {
              const m = msg.compact_metadata ?? {};
              broadcast({ type: 'compacted', trigger: m.trigger, pre_tokens: m.pre_tokens, post_tokens: m.post_tokens });
            }
            break;
          case 'stream_event': {
            const ev = msg.event;
            if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              broadcast({ type: 'assistant_delta', text: ev.delta.text }, false);
              // Sentence n is synthesised while n+1 is still arriving. The mood is
              // fixed at the start of the utterance on purpose: swapping preset
              // mid-sentence is audible as a different person.
              if (!speech && voiceAllowed()) {
                speech = createSpeechStream({ mood: lastState.mood, mode: lastState.mode, utteranceId: turnId });
              }
              speech?.push(ev.delta.text);
            }
            break;
          }
          case 'assistant':
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                // utteranceId ties the spoken audio to this exact message, so the UI
                // does not have to guess which reply a chunk belongs to.
                broadcast({ type: 'assistant_message', text: block.text, utteranceId: speech ? turnId : null, mood: lastState.mood });
              } else if (block.type === 'tool_use') {
                broadcast({
                  type: 'tool_use',
                  name: block.name,
                  detail: block.input?.file_path ?? block.input?.path ?? '',
                  page: block.input?.page,
                });
              }
            }
            break;
          case 'result':
            speech?.end();
            speech = null;
            broadcast({
              type: 'turn_done',
              cost: msg.total_cost_usd,
              duration_ms: msg.duration_ms,
              is_error: !!msg.is_error,
            });
            reportContext();
            if (++autoTurns > AUTO_TURN_CAP) {
              console.warn(`[tutor] ${autoTurns} turns with no student input — stopping the loop.`);
              broadcast({ type: 'loop_guard', turns: autoTurns }, false);
              autoTurns = 0;
              currentQuery?.interrupt?.().catch(() => {});
            }
            // every REBUILD_EVERY turns, refresh the published dashboard in code
            if (++turns % REBUILD_EVERY === 0) refreshDashboard(`turn ${turns}`);
            break;
        }
      }
    } catch (err) {
      queue = null;
      broadcast({ type: 'error', text: `Session crashed: ${err.message}. Next message starts a fresh session (resumed).` });
    }
  }

  // context gauge for the UI; failures are non-fatal
  async function reportContext() {
    try {
      const u = await currentQuery?.getContextUsage();
      if (u) broadcast({ type: 'context_usage', tokens: u.totalTokens, max: u.maxTokens, pct: Math.round(u.percentage) }, false);
    } catch {}
  }

  function ensureSession() {
    if (queue) return;
    queue = makeQueue();
    const q = (currentQuery = query({
      prompt: queue,
      options: {
        systemPrompt: buildSystemPrompt(),
        cwd: PROJECT_ROOT,
        model: config.model,
        effort: config.effort,
        // alwaysLoad MUST be set here, on the server config — createSdkMcpServer's own
        // alwaysLoad option only stamps per-tool _meta and returns {type,name,instance},
        // so the flag never reaches the config the SDK reads. Without it every tutor
        // tool gets deferred behind tool search and the tutor reports them all missing.
        mcpServers: { tutor: { ...tutorServer, alwaysLoad: true } },
        disallowedTools: ['Bash', 'Task', 'NotebookEdit', 'TodoWrite'],
        canUseTool,
        includePartialMessages: true,
        maxTurns: 200,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    }));
    pump(q);
  }

  // Voice is gated twice: the mode (EXAM is silent) and the user's own switch.
  // voice.js refuses EXAM independently, which is belt and braces, not a licence
  // to skip this.
  function voiceAllowed() {
    return config.voice?.enabled !== false && modeGates(config.mode).voiceEnabled;
  }

  // One id per assistant turn, shared by the audio chunks and the message they
  // narrate, so the UI can associate them exactly instead of by arrival order.
  let turnSeq = 0;
  let turnId = null;

  /** Recompute Monday's state for a turn and tell the UI. Exactly once per user turn. */
  function advanceState() {
    lastState = computeState({ chat: getChat(), config, now: Date.now(), snapshot: sitting() });
    try { recordMood(lastState.mood, lastState.reason); } catch {}
    broadcast({ type: 'monday_state', ...lastState }, false);
    return lastState;
  }

  return {
    sendUser(text, images = []) {
      ensureSession();
      autoTurns = 0; // the student is here; the budget resets

      // "pause tutor mode" / "resume session" are real mode changes, not a convention
      // nobody can see. Detected before the state is computed so the block reports it.
      const detected = detectMode(text ?? '', config.mode);
      if (detected && detected !== config.mode) {
        config = mergeConfig(config, { mode: detected });
        broadcast({ type: 'config', ...config }, false);
      }

      // A new message interrupts whatever Monday was still saying.
      if (speech) { try { speech.cancel(); } catch {} speech = null; }

      const at = Date.now();
      // First message of the process, or first after a break, starts a fresh sitting.
      touch(at);
      lastUserMessageAt = at;
      turnId = `t${at.toString(36)}${(turnSeq++).toString(36)}`;
      const state = advanceState();

      const content = images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      }));
      // ASYMMETRY, DELIBERATE: the transcript keeps the clean text, the model gets the
      // state block. Wrapping the broadcast instead would put <monday-state> into
      // chats/<id>.json and make it the chat title.
      if (text) content.push({ type: 'text', text: withStateBlock(state, text) });
      broadcast({ type: 'user_message', text: text ?? '', imageCount: images.length });
      queue.push({ type: 'user', message: { role: 'user', content } });
    },

    /**
     * A turn the student never sees typed: proactive.js pushes an instruction and
     * Monday raises it in its own words. Deliberately does NOT broadcast a
     * user_message — the scaffolding must not land in the transcript.
     */
    sendHidden(text) {
      if (!text) return;
      ensureSession();
      queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
    },
    async interrupt() {
      try { await currentQuery?.interrupt(); } catch {}
      broadcast({ type: 'turn_done', cost: 0, duration_ms: 0, is_error: false }, false);
    },
    async reset() {
      try { await currentQuery?.interrupt(); } catch {}
      queue = null;
      currentQuery = null;
      sessionId = null;
    },
    // switch to a stored conversation: next message resumes that session id
    async loadSession(id) {
      try { await currentQuery?.interrupt(); } catch {}
      queue = null;
      currentQuery = null;
      sessionId = id ?? null;
    },
    /**
     * Sparse config patch. model/effort are baked into the SDK query options, so
     * changing either tears the live query down and the next message resumes with
     * the new ones. voice/proactive/mode/examDate are read live and need no restart.
     */
    async setConfig(next = {}) {
      const before = config;
      const merged = mergeConfig(config, next);
      if (JSON.stringify(merged) === JSON.stringify(before)) return config;
      config = merged;
      // Prosody, speaking rate and the long-form gate are read by voice.js per
      // chunk, so they take effect on the very next sentence — no restart.
      try { setVoiceOptions(config.speech); } catch { /* never fatal */ }
      if ((merged.model !== before.model || merged.effort !== before.effort) && queue) {
        try { await currentQuery?.interrupt(); } catch {}
        queue = null;
        currentQuery = null;
      }
      // EXAM has to go quiet the instant it is selected, not at the next turn.
      if (!voiceAllowed() && speech) { try { speech.cancel(); } catch {} speech = null; }
      broadcast({ type: 'config', ...config }, false);
      // The mode is part of the state, so the status line and the orb must follow it.
      lastState = computeState({ chat: getChat(), config, now: Date.now(), advance: false, snapshot: sitting() });
      broadcast({ type: 'monday_state', ...lastState }, false);
      return config;
    },
    getConfig: () => ({ ...config }),
    getSessionId: () => sessionId,
    /** Monday's state without spending a hysteresis turn — for ticks and new clients. */
    getState: () => computeState({ chat: getChat(), config, now: Date.now(), advance: false, snapshot: sitting() }),
    getLastState: () => lastState,
    getLastUserMessageAt: () => lastUserMessageAt,
    /** The UI saw him do something (throttled client side). Returns the fresh state. */
    noteActivity(at = Date.now()) {
      const wasIdle = !lastActivityAt || at - lastActivityAt > SITTING_GAP_MS;
      touch(at);
      if (wasIdle) {
        lastState = computeState({ chat: getChat(), config, now: at, advance: false, snapshot: sitting(at) });
        broadcast({ type: 'monday_state', ...lastState }, false);
      }
      return lastState;
    },
    isSessionLive: () => !!queue,
    cancelSpeech() { if (speech) { try { speech.cancel(); } catch {} speech = null; } },
  };
}

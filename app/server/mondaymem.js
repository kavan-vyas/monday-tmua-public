// Monday's own memory — deliberately separate from the student record.
//
// tutor_data/memory/session_memory.json, session_notes.md, activity_log.json and
// backlog.json are THE STUDENT'S record: the dashboard parses them and their format is
// not ours to change. Nothing in this file writes to any of them.
//
// tutor_data/monday/ is Monday's:
//   self_model.md  — identity + build facts, read into the system prompt at boot
//   memory.json    — { schema_version, explanations[], phrasings[], observations[], mood_history[] }
//   journal.md     — narrative entries in Monday's own voice, at session close
//
// mondaySelf() is COMPUTED, never stored. That is the whole point: "knows its own
// build" has to mean it can go and look, not that somebody wrote a paragraph about
// it once and it has been reciting that paragraph ever since. Tool inventory and
// disallowed tools are parsed out of session.js source at call time, so they stay
// correct when the integrator adds tools.
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, TUTOR_DATA } from './paths.js';

export const MONDAY_DIR = path.join(TUTOR_DATA, 'monday');
const SELF_MODEL = path.join(MONDAY_DIR, 'self_model.md');
const MEMORY = path.join(MONDAY_DIR, 'memory.json');
const JOURNAL = path.join(MONDAY_DIR, 'journal.md');

const APP_DIR = path.join(PROJECT_ROOT, 'app');
const SESSION_JS = path.join(APP_DIR, 'server', 'session.js');
const STATE_FILE = path.join(APP_DIR, '.state.json');
const CHATS_DIR = path.join(APP_DIR, 'chats');
const MANIFEST = path.join(TUTOR_DATA, 'file_manifest.json');
const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const REF = path.join(TUTOR_DATA, 'reference');

const MOOD_HISTORY_CAP = 200;
const LIST_CAP = 400; // per bucket; oldest fall off

const EMPTY = {
  schema_version: 'monday-1',
  explanations: [],
  phrasings: [],
  observations: [],
  mood_history: [],
};

// ---------------------------------------------------------------- low level io

function readJson(abs, fallback) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; }
}

/** Write via a temp file + rename, so a crash mid-write cannot leave a half file. */
function writeJsonAtomic(abs, obj) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, abs);
}

function loadMemory() {
  const m = readJson(MEMORY, null);
  if (!m || typeof m !== 'object') return { ...EMPTY };
  for (const k of ['explanations', 'phrasings', 'observations', 'mood_history']) {
    if (!Array.isArray(m[k])) m[k] = [];
  }
  if (!m.schema_version) m.schema_version = EMPTY.schema_version;
  return m;
}

function saveMemory(m) {
  for (const k of ['explanations', 'phrasings', 'observations']) {
    if (m[k].length > LIST_CAP) m[k] = m[k].slice(-LIST_CAP);
  }
  if (m.mood_history.length > MOOD_HISTORY_CAP) {
    m.mood_history = m.mood_history.slice(-MOOD_HISTORY_CAP);
  }
  writeJsonAtomic(MEMORY, m);
  return m;
}

const nowIso = () => new Date().toISOString();
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// ---------------------------------------------------------------- self model

/** The identity block folded into the system prompt at boot. Never throws. */
export function readSelfModel() {
  try {
    const txt = fs.readFileSync(SELF_MODEL, 'utf8').trim();
    if (!txt) return '';
    return `
═══════════════════════════════════════════════════════
MONDAY — SELF MODEL (tutor_data/monday/self_model.md)
These are facts about you, not instructions. Anything numeric that can drift is
deliberately absent — call monday_self to compute it instead of guessing.
═══════════════════════════════════════════════════════

${txt}
`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- recall

const KINDS = ['explanation', 'phrasing', 'observation', 'all'];

/**
 * What do I already know about teaching this?
 *
 * @param {{kind?: 'explanation'|'phrasing'|'observation'|'all', topic?: string, limit?: number}} opts
 * @returns {Promise<{kind:string, topic:string|null, hits:number, text:string, entries:object[]}>}
 */
export async function mondayRecall({ kind = 'all', topic = null, limit = 8 } = {}) {
  const k = KINDS.includes(kind) ? kind : 'all';
  const m = loadMemory();
  const needle = topic ? norm(topic) : null;
  const words = needle ? needle.split(' ').filter((w) => w.length > 3) : [];

  const match = (e) => {
    if (!needle) return true;
    const hay = norm([e.topic, e.technique, e.approach, e.context, e.line, e.content, e.evidence, e.note].join(' '));
    if (hay.includes(needle)) return true;
    return words.some((w) => hay.includes(w));
  };

  const buckets = [];
  if (k === 'explanation' || k === 'all') buckets.push(['explanations', m.explanations]);
  if (k === 'phrasing' || k === 'all') buckets.push(['phrasings', m.phrasings]);
  if (k === 'observation' || k === 'all') buckets.push(['observations', m.observations]);

  const entries = [];
  const lines = [];
  for (const [name, arr] of buckets) {
    const hits = arr.filter(match).slice(-limit).reverse();
    if (!hits.length) continue;
    lines.push(`${name.toUpperCase()}:`);
    for (const e of hits) {
      entries.push({ bucket: name, ...e });
      const when = String(e.ts ?? '').slice(0, 10);
      if (name === 'explanations') {
        lines.push(`  ${when} · ${e.topic ?? '?'} · ${e.approach ?? e.technique ?? '?'} → ${e.outcome ?? '?'}${e.evidence ? ` (${e.evidence})` : ''}`);
      } else if (name === 'phrasings') {
        lines.push(`  ${when} · "${e.line ?? ''}" → ${e.reception ?? '?'}${e.note ? ` (${e.note})` : ''}`);
      } else {
        lines.push(`  ${when} · ${e.content ?? ''}${e.outcome && e.outcome !== 'standing' ? ` [${e.outcome}]` : ''}`);
      }
    }
  }

  const label = topic ? `"${topic}"` : 'anything';
  const text = entries.length
    ? `${entries.length} thing(s) I have on record for ${label}:\n${lines.join('\n')}`
    : `Nothing on record for ${label}. First time — teach it however you judge best, then call monday_note with the outcome so there IS a record next time.`;

  return { kind: k, topic: topic ?? null, hits: entries.length, text, entries };
}

// ---------------------------------------------------------------- note

const OUTCOMES = {
  explanation: ['landed', 'bounced', 'partial'],
  phrasing: ['good', 'flat', 'bad'],
};

/**
 * Record what just happened, so the next attempt is better informed.
 *
 * kind 'explanation' → { topic, technique, approach, outcome: landed|bounced|partial, evidence }
 * kind 'phrasing'    → { line, context, reception: good|flat|bad, note }
 * kind 'observation' → { content }
 * kind 'journal'     → appended to journal.md verbatim, under a dated heading
 */
export async function mondayNote({ kind, content, outcome = null, topic = null, evidence = null, context = null } = {}) {
  const ts = nowIso();

  if (kind === 'journal') {
    const body = String(content ?? '').trim();
    if (!body) return { ok: false, text: 'Nothing to write.' };
    fs.mkdirSync(MONDAY_DIR, { recursive: true });
    const heading = `\n---\n\n## ${ts.slice(0, 10)}\n\n`;
    fs.appendFileSync(JOURNAL, heading + body + '\n');
    return { ok: true, kind, text: `Journal entry written (${body.length} chars).` };
  }

  const m = loadMemory();

  if (kind === 'explanation') {
    const oc = OUTCOMES.explanation.includes(outcome) ? outcome : 'partial';
    const entry = {
      ts,
      topic: topic ?? null,
      technique: null,
      approach: String(content ?? '').trim(),
      outcome: oc,
      evidence: evidence ?? null,
    };
    m.explanations.push(entry);
    saveMemory(m);
    return { ok: true, kind, text: `Recorded: ${topic ?? 'topic'} — that approach ${oc}.` };
  }

  if (kind === 'phrasing') {
    const rc = OUTCOMES.phrasing.includes(outcome) ? outcome : 'flat';
    m.phrasings.push({
      ts,
      line: String(content ?? '').trim(),
      context: context ?? topic ?? null,
      reception: rc,
      note: evidence ?? null,
    });
    saveMemory(m);
    return { ok: true, kind, text: `Recorded: that phrasing went down ${rc}.` };
  }

  if (kind === 'observation') {
    m.observations.push({
      ts,
      content: String(content ?? '').trim(),
      outcome: outcome ?? 'noted',
      topic: topic ?? null,
    });
    saveMemory(m);
    return { ok: true, kind, text: 'Observation recorded.' };
  }

  return { ok: false, text: `Unknown kind "${kind}". Use explanation, phrasing, observation or journal.` };
}

/**
 * Mood history for the UI sparkline. Called by mood.js, not by the model.
 * Coalesces: a run of the same mood updates the last entry rather than appending.
 */
export function recordMood(mood, reason = '') {
  try {
    const m = loadMemory();
    const last = m.mood_history[m.mood_history.length - 1];
    if (last && last.mood === mood) {
      last.until = nowIso();
      last.turns = (last.turns ?? 1) + 1;
    } else {
      m.mood_history.push({ ts: nowIso(), until: nowIso(), mood, reason, turns: 1 });
    }
    saveMemory(m);
  } catch { /* mood history is a nicety; never break a turn over it */ }
}

export function readMoodHistory(limit = MOOD_HISTORY_CAP) {
  return loadMemory().mood_history.slice(-limit);
}

// ---------------------------------------------------------------- self (live)

function liveTools() {
  // Parsed from source rather than imported: importing session.js from here would
  // be circular (session.js imports this module), and a hard-coded list would go
  // stale the moment a tool is added.
  try {
    const src = fs.readFileSync(SESSION_JS, 'utf8');
    const names = [...src.matchAll(/\btool\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)].map((m) => m[1]);
    return [...new Set(names)];
  } catch { return []; }
}

function liveDisallowed() {
  try {
    const src = fs.readFileSync(SESSION_JS, 'utf8');
    const m = src.match(/disallowedTools:\s*\[([^\]]*)\]/);
    if (!m) return [];
    return [...m[1].matchAll(/['"`]([A-Za-z0-9_]+)['"`]/g)].map((x) => x[1]);
  } catch { return []; }
}

function countPdfs(node, seen = new Set()) {
  if (typeof node === 'string') {
    if (/\.pdf$/i.test(node)) seen.add(node);
  } else if (Array.isArray(node)) {
    for (const v of node) countPdfs(v, seen);
  } else if (node && typeof node === 'object') {
    for (const v of Object.values(node)) countPdfs(v, seen);
  }
  return seen;
}

function indexSize() {
  let n = 0;
  const files = [];
  try {
    for (const f of fs.readdirSync(REF)) {
      if (/_full_tag_index\.json$/.test(f)) files.push(path.join(REF, f));
    }
  } catch { /* no reference dir */ }
  for (const f of files) {
    const d = readJson(f, null);
    if (d && Array.isArray(d.questions)) n += d.questions.length;
  }
  return { questions: n, files: files.map((f) => path.basename(f)) };
}

function humanUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/**
 * Everything about my own build, computed at the moment of asking. Nothing here is
 * remembered — if a number is wrong, the machine changed, not my memory.
 */
export async function mondaySelf() {
  const state = readJson(STATE_FILE, {});
  const cfg = state.config ?? {};
  const tools = liveTools();
  const disallowed = liveDisallowed();
  const manifest = readJson(MANIFEST, {});
  const pdfs = countPdfs(manifest);
  const idx = indexSize();
  const mem = readJson(SESSION_MEMORY, {});
  const mine = loadMemory();

  let chats = 0;
  try { chats = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json')).length; } catch {}

  const voicePresent = fs.existsSync(path.join(APP_DIR, 'tts')) || fs.existsSync(path.join(APP_DIR, 'server', 'voice.js'));

  const facts = {
    name: 'Monday',
    runtime: 'Claude Agent SDK inside a local Node HTTP + WebSocket server',
    host: `${process.platform} ${process.arch}, Node ${process.version}`,
    model: cfg.model ?? 'unknown',
    effort: cfg.effort ?? 'unknown',
    uptime_ms: Math.round(process.uptime() * 1000),
    uptime: humanUptime(process.uptime() * 1000),
    tool_count: tools.length,
    tools,
    disallowed_tools: disallowed,
    reads: `limited to ${PROJECT_ROOT}`,
    writes: `limited to ${TUTOR_DATA} — spreadsheets refused outright, JSON validated before it lands`,
    network: 'none — no web search, no fetch, no email',
    voice: voicePresent
      ? 'local text-to-speech (~82M parameters) on this machine, with a deterministic LaTeX-to-speech converter in front of it'
      : 'not installed on this machine yet',
    chats_on_disk: chats,
    papers_on_disk: pdfs.size,
    index_questions: idx.questions,
    index_files: idx.files,
    lessons_logged: mem.session_number ?? null,
    questions_on_record: Array.isArray(mem.questions_attempted) ? mem.questions_attempted.length : 0,
    review_queue: Array.isArray(mem.review_queue) ? mem.review_queue.length : 0,
    my_explanations_recorded: mine.explanations.length,
    my_phrasings_recorded: mine.phrasings.length,
    my_observations_recorded: mine.observations.length,
  };

  const text = [
    `I am Monday. Right now, measured rather than remembered:`,
    ``,
    `MODEL          ${facts.model} at ${facts.effort} effort, via the Claude Agent SDK.`,
    `HOST           a local Node server on this Mac — ${facts.host}. Up ${facts.uptime}.`,
    `TOOLS          ${facts.tool_count}: ${tools.join(', ') || '(none registered)'}.`,
    `CANNOT         ${disallowed.length ? disallowed.join(', ') + ' are disallowed at the SDK level' : 'no tool restrictions parsed'}. No web access of any kind.`,
    `READS          ${facts.reads}.`,
    `WRITES         ${facts.writes}.`,
    `VOICE          ${facts.voice}.`,
    `ON DISK        ${facts.papers_on_disk} papers, ${facts.index_questions} classified questions across ${idx.files.length} index file(s), ${facts.chats_on_disk} saved chats.`,
    `YOUR RECORD    lesson ${facts.lessons_logged ?? '?'}, ${facts.questions_on_record} questions logged, ${facts.review_queue} in the review queue.`,
    `MY RECORD      ${facts.my_explanations_recorded} explanations, ${facts.my_phrasings_recorded} phrasings, ${facts.my_observations_recorded} observations.`,
  ].join('\n');

  return { ...facts, text };
}

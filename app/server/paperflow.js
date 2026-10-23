// Paper flow — a guided per-question rework of one mock paper (built for JZ).
//
// The screen is set up by the front end: R2D2's review video on the left, the paper and
// then its mark scheme in the middle, the control panel on the right. This module owns
// the parts that must survive a reload or a crash and the parts that touch the record:
//
//   • progress, saved after every change to tutor_data/paperflow/<paperId>.json, so
//     closing the window mid-paper resumes on the same question with the same marks;
//   • the review video, found once per paper with yt-dlp and cached;
//   • finishing: one ledger row per marked question, a backlog item for every n and m,
//     and one activity-log row. Idempotent — a second Finish changes nothing.
//
// Marks are his own judgement (y / m / n), the same vocabulary as his tracker grid:
// y = got it, m = maybe / revisit (counts correct, flagged shaky), n = wrong.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { TUTOR_DATA } from './paths.js';
import { PAPERS, paperRow, questionId, QUESTIONS_PER_PAPER } from './papers.js';
import { canonicalId } from './canonical.js';
import { addItem, addTime } from './backlog.js';

const DIR = path.join(TUTOR_DATA, 'paperflow');
const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const ACTIVITY_LOG = path.join(TUTOR_DATA, 'activity_log.json');
const MOCK_INDEX = path.join(TUTOR_DATA, 'reference', 'mock_tag_index.json');
const VIDEO_CACHE = path.join(TUTOR_DATA, 'reference', 'video_search_cache.json');

export const MARKS = ['y', 'm', 'n'];
export const BUCKETS = ['didnt_know', 'slipped', 'timing'];
const DEFAULT_BUCKET = { n: 'didnt_know', m: 'slipped' };

export class FlowError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, p);
}
const today = () => new Date().toISOString().slice(0, 10);

function rowOrThrow(paperId) {
  const row = paperRow(paperId);
  if (!row) throw new FlowError(404, `unknown paper ${paperId}`);
  return row;
}
const fileFor = (paperId) => path.join(DIR, `${rowOrThrow(paperId).id}.json`);

/** "JZ SA P1 Q7" — the ledger's own qid style, which satPapers() and canonicalId() read. */
export function ledgerQid(row, qnum) {
  const name = { jz: 'JZ', tyler: 'Tyler', heracles: 'Heracles', euclid: 'Euclid', djs: 'DJS' }[row.collection] ?? row.collectionTitle;
  return `${name} S${row.set} P${row.paper} Q${qnum}`;
}

function blankState(row) {
  return {
    schema_version: 1,
    paper_id: row.id,
    title: row.title,
    status: 'active',
    started: new Date().toISOString(),
    durationSec: row.defaultTiming === 'long' ? 120 * 60 : 75 * 60,
    current: 1,
    questions: Object.fromEntries(Array.from({ length: QUESTIONS_PER_PAPER }, (_, i) => [String(i + 1),
      { mark: null, comment: '', bucket: null, seconds: 0, revealed: false }])),
  };
}

/** Saved progress, or a fresh state that is NOT written until the first save. */
export function getState(paperId) {
  const row = rowOrThrow(paperId);
  return readJson(fileFor(row.id)) ?? blankState(row);
}

/**
 * Merge a partial update from the panel. Only known fields are accepted, so a buggy or
 * stale client cannot write arbitrary keys into the record.
 */
export function saveState(paperId, patch = {}) {
  const row = rowOrThrow(paperId);
  const st = getState(row.id);
  if (st.status === 'finished') throw new FlowError(409, 'this paper flow is already finished');
  if (Number.isFinite(Number(patch.current))) st.current = Math.min(QUESTIONS_PER_PAPER, Math.max(1, Math.round(Number(patch.current))));
  if (Number.isFinite(Number(patch.durationSec)) && Number(patch.durationSec) > 0) st.durationSec = Math.round(Number(patch.durationSec));
  for (const [k, q] of Object.entries(patch.questions ?? {})) {
    const cur = st.questions[String(Number(k))];
    if (!cur || !q || typeof q !== 'object') continue;
    if ('mark' in q) cur.mark = MARKS.includes(q.mark) ? q.mark : null;
    if ('comment' in q) cur.comment = String(q.comment ?? '').slice(0, 4000);
    if ('bucket' in q) cur.bucket = BUCKETS.includes(q.bucket) ? q.bucket : null;
    if ('revealed' in q) cur.revealed = !!q.revealed;
    if ('seconds' in q && Number.isFinite(Number(q.seconds))) cur.seconds = Math.max(0, Math.round(Number(q.seconds)));
  }
  st.updated = new Date().toISOString();
  writeJson(fileFor(row.id), st);
  return st;
}

/** Every paper in a collection with its flow status, for the picker. */
export function listFlows(collection = 'jz') {
  return PAPERS.filter((p) => !collection || p.collection === collection).map((row) => {
    const st = readJson(path.join(DIR, `${row.id}.json`));
    const qs = Object.values(st?.questions ?? {});
    const tally = Object.fromEntries(MARKS.map((m) => [m, qs.filter((q) => q.mark === m).length]));
    return {
      id: row.id, title: row.title, short: row.short, set: row.set, paper: row.paper,
      status: st ? st.status : 'new',
      marked: qs.filter((q) => q.mark).length,
      started: qs.some((q) => q.mark || q.seconds > 0 || q.comment),
      updated: st?.updated ?? null,
      current: st?.current ?? null,
      tally,
    };
  });
}

/** The correct letter per question, when the paper has an answer key on disk. */
export function answerKey(paperId) {
  const row = rowOrThrow(paperId);
  const doc = readJson(path.join(TUTOR_DATA, 'exams', 'answers', `${row.id}.json`));
  return Object.fromEntries((doc?.questions ?? []).map((q) => [String(q.qnum), q.answer ?? null]));
}

function topicFor(row, qnum) {
  const id = questionId(row, qnum);
  const q = (readJson(MOCK_INDEX, { questions: [] }).questions ?? []).find((x) => x.id === id);
  return Array.isArray(q?.topic) && q.topic.length ? q.topic[0] : 'mixed';
}

/** Rebuild every derived counter from the rows — the same rule as the 17 Sep recount. */
export function recountLedger(mem) {
  const rows = mem.questions_attempted ?? [];
  mem.total_questions_attempted = rows.length;
  mem.total_correct = rows.filter((r) => r.correct === true).length;
  mem.overall_accuracy = rows.length ? Math.round((1000 * mem.total_correct) / rows.length) / 10 : 0;
  const stats = mem.topic_stats ?? {};
  for (const t of Object.keys(stats)) { stats[t].attempted = 0; stats[t].correct = 0; }
  for (const r of rows) {
    const t = r.topic ?? 'mixed';
    stats[t] = stats[t] ?? { attempted: 0, correct: 0, total_time_seconds: 0, avg_socratic_exchanges: 0 };
    stats[t].attempted += 1;
    if (r.correct === true) stats[t].correct += 1;
  }
  mem.topic_stats = stats;
  return mem;
}

/**
 * Write the paper to the record. Idempotent: a finished flow returns its stored result.
 * Only MARKED questions are written — an unmarked question was skipped, and a blank is
 * not evidence of anything.
 */
export function finishFlow(paperId) {
  const row = rowOrThrow(paperId);
  const st = getState(row.id);
  if (st.status === 'finished') return { already: true, ...st.result };
  const marked = Object.entries(st.questions).filter(([, q]) => q.mark);
  if (!marked.length) throw new FlowError(400, 'nothing has been marked yet');

  // 1. ledger rows
  const mem = readJson(SESSION_MEMORY, {});
  mem.questions_attempted = mem.questions_attempted ?? [];
  const date = today();
  for (const [k, q] of marked) {
    const qnum = Number(k);
    mem.questions_attempted.push({
      paper: 'TMUA',
      qid: ledgerQid(row, qnum),
      year: null,
      part: null,
      topic: topicFor(row, qnum),
      correct: q.mark !== 'n',
      shaky: q.mark === 'm',
      misconception: null,
      socratic_exchanges: 0,
      times_repeated: 0,
      time_seconds: q.seconds || null,
      date,
      source: 'paperflow',
      timed: true,
      note: q.comment || null,
    });
  }
  recountLedger(mem);
  writeJson(SESSION_MEMORY, mem);

  // 2. backlog: every n and m, with his comment and the seconds he spent
  const added = [];
  for (const [k, q] of marked) {
    if (q.mark === 'y') continue;
    const qnum = Number(k);
    const item = addItem({
      exam: 'TMUA',
      ref: ledgerQid(row, qnum),
      topic: topicFor(row, qnum),
      bucket: q.bucket ?? DEFAULT_BUCKET[q.mark],
      detail: q.comment || (q.mark === 'n' ? 'Wrong on the paper flow — no comment written.' : 'Marked maybe / revisit on the paper flow.'),
    });
    if (q.seconds > 0 && !item._merged) addTime(item.id, q.seconds);
    added.push({ qnum, id: item.id, cid: item.cid ?? canonicalId('TMUA', ledgerQid(row, qnum)), merged: !!item._merged });
  }

  // 3. one activity row for the paper
  const tally = Object.fromEntries(MARKS.map((m) => [m, marked.filter(([, q]) => q.mark === m).length]));
  const totalSec = marked.reduce((s, [, q]) => s + (q.seconds || 0), 0);
  const store = readJson(ACTIVITY_LOG, { entries: [] });
  if (!Array.isArray(store.entries)) store.entries = [];
  store.entries.push({
    ts: new Date().toISOString().slice(0, 16),
    type: 'question',
    detail: `${row.title} paper flow — ${tally.y} y, ${tally.m} m, ${tally.n} n over ${marked.length} questions`
      + ` in ${Math.round(totalSec / 60)} min; ${added.length} added to the backlog.`,
    source: 'tmua',
    topic: 'mock paper',
  });
  writeJson(ACTIVITY_LOG, store);

  st.status = 'finished';
  st.finished = new Date().toISOString();
  st.result = { tally, marked: marked.length, totalSec, backlog: added };
  writeJson(fileFor(row.id), st);
  return st.result;
}

/** Start the paper again from scratch (keeps the old file as a dated backup). */
export function resetFlow(paperId) {
  const row = rowOrThrow(paperId);
  const f = fileFor(row.id);
  if (fs.existsSync(f)) fs.renameSync(f, f.replace(/\.json$/, `.${Date.now()}.json`));
  return blankState(row);
}

// ------------------------------------------------------------------ the video

export function searchQuery(row) {
  return row.collection === 'jz'
    ? `R2D2 TMUA paper review of JZ set ${row.set} paper ${row.paper}`
    : `R2D2 TMUA paper review of ${row.title}`;
}

/** His phrasing first, then the way R2Drew2 actually titles them ("JZMaths Set C Paper 2"). */
export function searchQueries(row) {
  const qs = [searchQuery(row)];
  if (row.collection === 'jz') qs.push(`TMUA JZMaths Mock ${row.set} Paper ${row.paper}`);
  return qs;
}

/** Parse yt-dlp `id|title|channel` lines and pick the best: R2Drew2's own upload first. */
export function pickVideo(stdout, row) {
  const hits = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const [id, title, channel] = l.split('|'); return { id, title, channel }; })
    .filter((h) => /^[\w-]{11}$/.test(h.id ?? ''));
  const wantSet = new RegExp(`\\b(?:mock|set)\\s*${row.set}\\b`, 'i');
  const wantPaper = new RegExp(`paper\\s*${row.paper}\\b`, 'i');
  const score = (h) => (/r2drew/i.test(h.channel ?? '') ? 4 : 0) + (wantSet.test(h.title) ? 2 : 0)
    + (wantPaper.test(h.title) ? 2 : 0) + (/jz/i.test(h.title) ? 1 : 0);
  // Only a video whose title names THIS set and THIS paper counts: "Set C Paper 1" must
  // never stand in for Set C Paper 2 just because it ranked first.
  const best = hits.filter((h) => wantSet.test(h.title) && wantPaper.test(h.title)).sort((a, b) => score(b) - score(a))[0];
  return best ? { id: best.id, title: best.title, channel: best.channel ?? null } : null;
}

/** The review video for a paper: cached, else one yt-dlp search. Never throws. */
export async function findVideo(paperId, { run = runYtDlp } = {}) {
  const row = rowOrThrow(paperId);
  const cache = readJson(VIDEO_CACHE, {});
  if (cache[row.id]?.id) return cache[row.id];
  const query = searchQuery(row);
  let video = null;
  for (const q of searchQueries(row)) {
    try { video = pickVideo(await run(q), row); } catch { video = null; }
    if (video) break;
  }
  if (!video) return { id: null, query };
  cache[row.id] = { ...video, query, found: new Date().toISOString() };
  writeJson(VIDEO_CACHE, cache);
  return cache[row.id];
}

function runYtDlp(query) {
  return new Promise((resolve, reject) => {
    execFile('yt-dlp', ['--no-update', '--flat-playlist', '--print', '%(id)s|%(title)s|%(channel)s', `ytsearch5:${query}`],
      { timeout: 45000, maxBuffer: 1 << 20 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
  });
}

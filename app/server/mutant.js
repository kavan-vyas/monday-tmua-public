// Mutant papers: the study documents built out of his own record.
//
// A mutant paper is two PDFs that always ship together.
//   1. the ANALYSIS — the misconceptions, the rules, the checklist; prose, written by hand;
//   2. the COMPANION — the same questions as printed, one per page, unmarked, to sit cold.
//
// Three of these exist (logic, graph shapes, counting) and each was rebuilt at least once
// because of the same two failures. This module is the part of the process that failed:
//
//   * A DOCUMENT DREW ON A PAPER HE HAD NOT SAT. Every question in a mutant paper is a
//     spoiler for the paper it came from — the first logic set was thrown away and redone
//     for exactly this reason ("assume I have done NO james chen papers, redo everything").
//     `candidates()` cannot return a question from an unsat paper: the sat set is derived
//     from the ledger, not listed anywhere a human could forget to update.
//
//   * THE COMPANION PULLED PAGES FROM THE WRONG PDF. pdftoppm pads page numbers to the
//     width of the document it is rendering, so page 2 is "-2.png" in a 9-page file and
//     "-02.png" in a 21-page one; a shared temp directory let a stale render from the
//     previous paper win the glob. `renderPage()` gives every render its own directory and
//     finds the output by listing it rather than by guessing the name.
//
// Everything here is selection and assembly. The writing is not automated and should not be:
// the value of these documents is in the sentence that names what he actually did wrong, and
// that comes from his own notes. See MUTANT_PAPERS.md for how to write one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PROJECT_ROOT, TUTOR_DATA } from './paths.js';
import { PAPERS, paperRow } from './papers.js';
import { canonicalId } from './canonical.js';
import { locate } from './pageindex.js';

export const MUTANT_DIR = path.join(PROJECT_ROOT, 'major exams', 'tmua', 'mutant papers');
export const WORK_DIR = path.join(TUTOR_DATA, 'mutant');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');

const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

/** "Tyler SD P2 Q13" → "Tyler SD P2". */
const paperOf = (qid) => String(qid).replace(/\s*Q\s*\d+\s*$/, '').trim();

/**
 * The papers he has actually sat, derived from the ledger.
 *
 * Derived, never listed: a hand-kept list is exactly the thing that goes stale between one
 * document and the next, and the cost of it being stale is spoiling a paper he was saving.
 * A paper counts as sat when it has a full twenty rows — a part-logged paper means the
 * record is incomplete, and an incomplete record is not evidence that he has seen the pages.
 */
export function satPapers() {
  const mem = readJson(path.join(TUTOR_DATA, 'memory', 'session_memory.json'), {});
  const count = new Map();
  for (const r of mem.questions_attempted ?? []) {
    if (!r.qid) continue;
    const p = paperOf(r.qid);
    count.set(p, (count.get(p) ?? 0) + 1);
  }
  return new Set([...count].filter(([, n]) => n >= 20).map(([p]) => p));
}

/** Every index question, official and mock, in one list. */
function indexQuestions() {
  const out = [];
  for (const f of ['tmua_full_tag_index.json', 'mat_full_tag_index.json', 'mock_tag_index.json']) {
    for (const q of readJson(path.join(TUTOR_DATA, 'reference', f), { questions: [] }).questions ?? []) out.push(q);
  }
  return out;
}

/**
 * The index id → the qid the ledger uses. These are the same question under two naming
 * schemes and nothing else in the project needs to bridge them, so the map lives here.
 */
export function qidForIndexId(id) {
  const s = String(id);
  let m;
  if ((m = s.match(/^TMUA(\d{4})P([12])Q(\d+)$/))) return `${m[1]} P${m[2]} Q${Number(m[3])}`;
  if ((m = s.match(/^TMUA(PRAC|SPEC)P([12])Q(\d+)$/i))) return `${m[1].toLowerCase() === 'prac' ? 'Practice' : 'Specimen'} P${m[2]} Q${Number(m[3])}`;
  if ((m = s.match(/^JC_25_P1_Q(\d+)$/))) return `Chen Q${Number(m[1])}`;
  if ((m = s.match(/^JC_(\d\d)_P([12])_Q(\d+)$/))) return `Chen ${m[1]} P${m[2]} Q${Number(m[3])}`;
  if ((m = s.match(/^TYLER_S([A-D])_P([12])_Q(\d+)$/))) return `Tyler S${m[1]} P${m[2]} Q${Number(m[3])}`;
  if ((m = s.match(/^HER_S(\d)_P([12])_Q(\d+)$/))) return `Heracles S${m[1]} P${m[2]} Q${Number(m[3])}`;
  if ((m = s.match(/^EUC_S(\d)_P([12])_Q(\d+)$/))) return `Euclid S${m[1]} P${m[2]} Q${Number(m[3])}`;
  if ((m = s.match(/^EUC_R2D_P1_Q(\d+)$/))) return `Euclid R2D2 P1 Q${Number(m[1])}`;
  if ((m = s.match(/^JZ_S([A-E])_P([12])_Q(\d+)$/))) return `JZ S${m[1]} P${m[2]} Q${Number(m[3])}`;
  if ((m = s.match(/^ROSIE_SA_P1_Q(\d+)$/))) return `Rosie SA P1 Q${Number(m[1])}`;
  if ((m = s.match(/^AF_P1_Q(\d+)$/))) return `AF P1 Q${Number(m[1])}`;
  if ((m = s.match(/^DJS_S(ALPHA|A0|[A-C])_P([12])_Q(\d+)$/))) return `DJS S${m[1]} P${m[2]} Q${Number(m[3])}`;
  return null;
}

/**
 * How badly he needs this question, highest first. The ordering IS the editorial priority:
 * a document is worth reading in proportion to how much of it he got wrong.
 *
 *   wrong          — the reason the document exists
 *   open backlog   — he has not re-earned it, however he marked it
 *   shaky          — right, but he flagged the doubt himself
 *   noted          — right, and he wrote down the method; worth consolidating
 *   plain          — right, no comment; only useful as contrast
 */
export const WEIGHT = { wrong: 100, open: 60, shaky: 40, noted: 15, plain: 0 };

/**
 * Candidate questions for a mutant paper, from SAT PAPERS ONLY.
 *
 * @param {object} f
 * @param {string[]} f.topics      index topics, any match
 * @param {string[]} f.techniques  index techniques, any match
 * @param {string[]} f.traps       index trap types, any match
 * @param {number}   f.minWeight   drop anything scoring below this (default 1: keep only
 *                                 questions with something actually attached to them)
 * @param {boolean}  f.all        require EVERY given group to match instead of any one
 *
 * The groups are OR-ed, not AND-ed, and that is the important default. A counting question
 * tagged `probability` is still a counting question; a binomial slip tagged `algebra` is
 * still one. Asking for topic AND technique AND trap together narrows to the questions that
 * happen to carry all three labels, which on a hand-built index is a handful of rows and not
 * the ones that cost him marks. Pass `all: true` when narrowing is actually what you want.
 */
export function candidates({ topics = [], techniques = [], traps = [], minWeight = 1, all = false } = {}) {
  const sat = satPapers();
  const mem = readJson(path.join(TUTOR_DATA, 'memory', 'session_memory.json'), {});
  const attempts = new Map((mem.questions_attempted ?? []).filter((r) => r.qid).map((r) => [r.qid, r]));
  const backlog = readJson(path.join(TUTOR_DATA, 'backlog.json'), { items: [] }).items ?? [];
  const openCids = new Map(backlog.filter((i) => i.status === 'open').map((i) => [i.cid, i]));

  const given = [[q => q.topic, topics], [q => q.technique, techniques], [q => q.trap_type, traps]]
    .filter(([, list]) => list.length);
  if (!given.length) return [];                       // never "everything"
  const hit = (q, get, list) => list.some((x) => (get(q) ?? []).includes(x));
  const out = [];
  for (const q of indexQuestions()) {
    const matches = given.filter(([get, list]) => hit(q, get, list)).length;
    if (all ? matches !== given.length : matches === 0) continue;
    const qid = qidForIndexId(q.id);
    if (!qid) continue;
    const paper = paperOf(qid);
    if (!sat.has(paper)) continue;                    // the rule the first logic set broke
    const a = attempts.get(qid);
    if (!a) continue;

    const cid = canonicalId('TMUA', qid);
    const open = openCids.get(cid) ?? null;
    const note = String(a.note ?? '');
    const real = note && !/^marked |^correct \(self-report\)|^correct but slow/.test(note);
    const status = a.correct === false ? 'wrong' : open ? 'open' : a.shaky ? 'shaky' : real ? 'noted' : 'plain';
    const weight = WEIGHT[status] + (q.difficulty ?? 0) * 2 + (open ? 10 : 0);
    if (weight < minWeight) continue;

    const loc = locate(cid);
    const row = loc ? paperRow(loc.paperId) : null;
    const pageIndex = loc ? readJson(path.join(TUTOR_DATA, 'exams', 'pageindex', `${loc.paperId}.json`), null) : null;
    out.push({
      qid, cid, index_id: q.id, paper, paper_id: loc?.paperId ?? null,
      status, weight,
      topic: q.topic, technique: q.technique, trap_type: q.trap_type,
      difficulty: q.difficulty, description: q.description,
      correct: a.correct === true, shaky: a.shaky === true,
      his_note: real ? note : null,
      backlog: open && { bucket: open.bucket, tier: open.tier, due: open.due, detail: open.detail },
      // The mock indexes carry the answer; the official ones never did, so it comes off the
      // extracted key instead (scripts/extract-official-answers.mjs). A study document that
      // states the wrong answer is worse than one that states none, so this is never guessed.
      answer: q.correct_answer ?? storedAnswer(loc?.paperId, loc?.qnum),
      options_count: q.options_count ?? null,
      qp: row?.qp ?? officialPdf(loc?.paperId, 'qp'),
      ms: row ? row.ms : officialPdf(loc?.paperId, 'ms'),
      qp_page: pageIndex?.qp?.[String(loc?.qnum)] ?? null,
      ms_page: pageIndex?.ms?.[String(loc?.qnum)] ?? null,
    });
  }
  return out.sort((a, b) => b.weight - a.weight || String(a.qid).localeCompare(String(b.qid)));
}

/** The stored answer for a paper/question, from tutor_data/exams/answers. */
function storedAnswer(paperId, qnum) {
  if (!paperId || !qnum) return null;
  const doc = readJson(path.join(TUTOR_DATA, 'exams', 'answers', `${paperId}.json`), null);
  return doc?.questions?.find((q) => Number(q.qnum) === Number(qnum))?.answer ?? null;
}

/** Official papers are not in the registry; their PDFs come off the manifest. */
function officialPdf(paperId, kind) {
  if (!paperId) return null;
  const m = /^tmua_(\d{4}|prac|spec)_p([12])$/.exec(paperId);
  if (!m) return null;
  const man = readJson(path.join(TUTOR_DATA, 'file_manifest.json'), {});
  const section = m[1] === 'prac' ? man.tmua_practice : m[1] === 'spec' ? man.tmua_specimen : man.tmua?.[m[1]];
  if (!section) return null;
  return kind === 'qp' ? section[`p${m[2]}`] ?? null : section[`p${m[2]}_solutions`] ?? null;
}

/**
 * One page of a PDF as a PNG, in a directory of its own.
 *
 * See the header: a shared temp directory plus pdftoppm's variable-width page numbering is
 * how the first companion ended up with pages from a different paper in it.
 */
export function renderPage(pdf, page, { dpi = 200 } = {}) {
  if (!fs.existsSync(pdf)) throw new Error(`no such PDF: ${pdf}`);
  const key = crypto.createHash('sha1').update(`${pdf}:${page}:${dpi}`).digest('hex').slice(0, 12);
  const dir = path.join(os.tmpdir(), 'mutant-render', key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('pdftoppm', ['-r', String(dpi), '-png', '-f', String(page), '-l', String(page), pdf, path.join(dir, 'pg')],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  if (files.length !== 1) throw new Error(`${path.basename(pdf)} p${page}: expected one page, got ${files.length}`);
  return path.join(dir, files[0]);
}

/** Crop a rendered page to a vertical slice, for a page that holds more than one question. */
export function cropVertical(png, out, [top, bottom]) {
  const py = `
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w, h = im.size
im.crop((0, int(h * float(sys.argv[3])), w, int(h * float(sys.argv[4])))).save(sys.argv[2])
`;
  execFileSync('python3', ['-c', py, png, out, String(top), String(bottom)], { stdio: ['ignore', 'ignore', 'inherit'] });
  return out;
}

/** Where a finished mutant paper has to end up. Both places, every time. */
export function destinations(basename) {
  return [path.join(DOWNLOADS, basename), path.join(MUTANT_DIR, basename)];
}

/** Copy a built PDF to Downloads and to the collection, and report where it went. */
export function place(file) {
  const base = path.basename(file);
  const out = [];
  for (const dst of destinations(base)) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(file, dst);
    out.push(dst);
  }
  return out;
}

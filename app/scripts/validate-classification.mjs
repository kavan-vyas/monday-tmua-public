// Validate classification shards against the project's own controlled vocabulary.
//
// The vocabulary is parsed LIVE out of TAGGING_SPEC.md, exactly as merge_shards.py does,
// so the spec stays the single source of truth and a shard cannot invent a technique.
//
// Difficulty is accepted from a shard only when the paper's author publishes no rating of
// their own. JZ rates every question 5-9 out of 10, so a JZ shard must NOT set difficulty:
// it is computed from that rating at merge time and one classifier's sense of "hard"
// cannot drift from another's. James Chen publishes no rating at all, so a Chen shard must
// set it — refusing both ways is what stops the two rules being confused. papers.js says
// which regime a paper is in.
//
//   node scripts/validate-classification.mjs            # every shard
//   node scripts/validate-classification.mjs jz_a_p1
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paperRow, questionId } from '../server/papers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SPEC = path.join(ROOT, 'tutor_data', 'reference', 'TAGGING_SPEC.md');
const DIR = path.join(ROOT, 'tutor_data', 'exams', 'classification');
const QDIR = path.join(ROOT, 'tutor_data', 'exams', 'questions');
const ADIR = path.join(ROOT, 'tutor_data', 'exams', 'answers');

/** Pull "### topic (1+)" style sections out of the spec and read their comma lists. */
export function vocabulary(specText = fs.readFileSync(SPEC, 'utf8')) {
  const out = {};
  // The end-of-section lookahead must NOT use `$` — with the /m flag that matches every
  // line ending, so each vocabulary list would stop after its first line and two thirds of
  // the vocabulary would silently read as invalid.
  const re = /^### (\w+)[^\n]*\n([\s\S]*?)(?=\n#{2,3} |(?![\s\S]))/gm;
  let m;
  while ((m = re.exec(specText))) {
    const body = m[2].split(/\n\s*\n/)[0];
    if (m[1] === 'difficulty') continue;
    // Split on newlines as well as commas: the spec wraps these lists mid-item, so
    // splitting on commas alone glues "coordinate_geometry\ngraph_sketching" into one
    // value and silently drops both.
    out[m[1]] = new Set(body.split(/[,\n]+/).map((s) => s.trim()).filter((s) => /^[a-zA-Z][\w-]*$/.test(s)));
  }
  return out;
}

const PAPER_SECTIONS = new Set(['P1_pure', 'P1_applications', 'P2_logic_and_proof']);
const VERIFICATION = new Set(['mark_scheme_read', 'answer_key_only', 'inferred_no_solution']);

export function validateShard(doc, { questions, answers } = {}) {
  const V = vocabulary();
  const errs = [];
  const E = (m) => errs.push(m);
  const list = (v) => (Array.isArray(v) ? v : []);

  const qs = doc.questions ?? [];
  if (qs.length !== 20) E(`expected 20 questions, found ${qs.length}`);

  const row = paperRow(doc.paper_id);
  if (!row) {
    E(`paper_id "${doc.paper_id}" is not in the papers registry (app/server/papers.js)`);
    return errs;
  }
  if (String(doc.set) !== String(row.set) || Number(doc.paper) !== row.paper) {
    E(`shard header says set ${doc.set} paper ${doc.paper}; the registry says ${row.set} / ${row.paper}`);
  }

  for (const q of qs) {
    const tag = `Q${String(q.qnum).padStart(2, '0')}`;
    const paper = row.paper;

    if (q.id !== questionId(row, q.qnum)) E(`${tag}: id ${q.id} (expected ${questionId(row, q.qnum)})`);
    if (q.exam !== 'TMUA') E(`${tag}: exam ${q.exam}`);
    if (q.exam_family !== row.family) E(`${tag}: exam_family ${q.exam_family} (expected ${row.family})`);
    if (String(q.set) !== String(row.set) || Number(q.paper) !== paper) E(`${tag}: set/paper mismatch`);
    if (row.difficulty === 'source') {
      if ('difficulty' in q && q.difficulty != null) E(`${tag}: difficulty must not be set by a shard for this paper — it is computed from the author's own rating at merge`);
    } else if (!Number.isInteger(q.difficulty) || q.difficulty < 1 || q.difficulty > 5) {
      E(`${tag}: difficulty must be an integer 1-5 — this paper's author publishes no rating to compute it from`);
    }
    if (!Array.isArray(q.cross_links) || q.cross_links.length) E(`${tag}: cross_links must be []`);
    if (!VERIFICATION.has(q.verification_status)) E(`${tag}: verification_status ${q.verification_status}`);
    if (q.paper_section && !PAPER_SECTIONS.has(q.paper_section)) E(`${tag}: paper_section ${q.paper_section}`);
    // Paper 2 is logic and proof by definition. Paper 1 is not policed the same way: Chen's
    // Paper 1 deliberately mixes logic questions into a techniques paper, and the section
    // describes the question, not the cover of the paper it sits in.
    if (paper === 2 && q.paper_section !== 'P2_logic_and_proof') E(`${tag}: Paper 2 must be P2_logic_and_proof`);

    if (!q.description || !String(q.description).trim()) E(`${tag}: empty description`);
    else {
      if (String(q.description).split(/\s+/).length > 25) E(`${tag}: description over 25 words`);
      if (/[$\\]/.test(q.description)) E(`${tag}: description contains LaTeX`);
    }

    for (const [field, min] of [['topic', 1], ['technique', 1], ['cognitive_skill', 1], ['trap_type', 0]]) {
      const vals = list(q[field]);
      if (vals.length < min) E(`${tag}: ${field} needs at least ${min}`);
      for (const v of vals) if (!V[field]?.has(v)) E(`${tag}: ${field} "${v}" is not in TAGGING_SPEC`);
    }
    if (!V.question_type?.has(q.question_type)) E(`${tag}: question_type "${q.question_type}" is not in TAGGING_SPEC`);
    if (list(q.trap_type).length > 3) E(`${tag}: more than 3 traps — the spec says do not pad`);

    // The classification must agree with the transcription and the key it was built from.
    const src = questions?.questions?.find((x) => Number(x.qnum) === Number(q.qnum));
    const key = answers?.questions?.find((x) => Number(x.qnum) === Number(q.qnum));
    if (src && q.options_count != null && q.options_count !== src.options.length) E(`${tag}: options_count ${q.options_count} but the paper has ${src.options.length}`);
    if (key && q.correct_answer && q.correct_answer !== key.answer) E(`${tag}: correct_answer ${q.correct_answer} disagrees with the mark scheme (${key.answer})`);
    if (row.difficulty === 'source' && key && q.jz_difficulty != null && q.jz_difficulty !== key.jz_difficulty) E(`${tag}: jz_difficulty disagrees with the mark scheme`);
  }
  return errs;
}

const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

// Importable as a module (the merge step reuses validateShard); the CLI below only runs
// when this file is the entry point.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

function main() {
const only = process.argv[2];
if (!fs.existsSync(DIR)) { console.log('no classification shards yet'); process.exit(1); }
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && (!only || f === `${only}.json`)).sort();
if (!files.length) { console.error(only ? `no shard for ${only}` : 'no shards'); process.exit(1); }

let bad = 0;
for (const f of files) {
  const id = f.replace(/\.json$/, '');
  const errs = validateShard(readJson(path.join(DIR, f)), {
    questions: readJson(path.join(QDIR, f)),
    answers: readJson(path.join(ADIR, f)),
  });
  console.log(`${errs.length ? 'FAIL' : 'ok  '} ${id}${errs.length ? `  ${errs.length} error(s)` : ''}`);
  for (const e of errs) console.log(`       ${e}`);
  if (errs.length) bad++;
}
process.exit(bad ? 1 : 0);
}

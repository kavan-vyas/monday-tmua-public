// Build simulator files from hand transcriptions: the Daniel J Smith papers, and the
// official TMUA papers registered in OFFICIAL_PAPERS.
//
//   node scripts/build-djs.mjs                # every paper that has a transcription
//   node scripts/build-djs.mjs djs_b_p2       # just one
//   node scripts/build-djs.mjs tmua_2019_p1   # an official paper
//
// Source: tutor_data/exams/source/djs/<paper id>.txt (official: source/official/) — one block per question:
//
//   ## 7
//   stem line            (each line becomes one rendered line; $…$ and $$…$$ are maths)
//   **bold** / *italic*  (outside maths only — turned into \textbf / \textit)
//   FIG                  (a line on its own: the cropped figure drops in here)
//   FIG x0,y0,x1,y1      (same, with an exact crop box on the 200 dpi page render)
//   A| option text
//
// Answers come from source/djs/keys.json, read off DJS's own answer keys. Custom α ships without a
// key, so its letters were worked out here and the answers file says so. An official paper's
// answers file already exists (extract-official-answers.mjs read the published key), so it is
// read for the cross-check and never rewritten here.
import fs from 'node:fs';
import path from 'node:path';
import { PAPERS, OFFICIAL_PAPERS, questionId, canonicalId } from '../server/papers.js';
import { TUTOR_DATA } from '../server/paths.js';

const SRC = path.join(TUTOR_DATA, 'exams', 'source', 'djs');
const SRC_OFFICIAL = path.join(TUTOR_DATA, 'exams', 'source', 'official');
// Euclid's two sample papers: same format, their own folder and key file.
const SRC_EUCLID = path.join(TUTOR_DATA, 'exams', 'source', 'euclid');
const OUT_Q = path.join(TUTOR_DATA, 'exams', 'questions');
const OUT_A = path.join(TUTOR_DATA, 'exams', 'answers');

const KEYFILE = path.join(SRC, 'keys.json'); // one 20-letter string per paper id
const KEYS = {
  ...JSON.parse(fs.readFileSync(KEYFILE, 'utf8')),
  ...JSON.parse(fs.readFileSync(path.join(SRC_EUCLID, 'keys.json'), 'utf8')),
};
const isEuclidSample = (p) => p.collection === 'euclid' && p.set === 'sample';

// Markdown emphasis outside maths only: a `*` inside $…$ is maths, e.g. the label (*).
function emphasis(line) {
  return line.split(/(\$\$[\s\S]+?\$\$|\$[^$]+\$)/).map((part, i) => (i % 2
    ? part
    : part
      .replace(/\*\*(.+?)\*\*/g, (_, t) => `$\\textbf{${t}}$`)
      .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, (_, pre, t) => `${pre}$\\textit{${t}}$`))).join('');
}

function parse(text) {
  const qs = [];
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const h = line.match(/^## (\d+)$/);
    if (h) { cur = { qnum: Number(h[1]), stem: [], options: [], figure: false }; qs.push(cur); continue; }
    if (!cur || !line.trim()) continue;
    const o = line.match(/^([A-J])\| (.*)$/);
    if (o) { cur.options.push({ letter: o[1], latex: emphasis(o[2]) }); continue; }
    const fig = line.match(/^FIG(?: (\d+),(\d+),(\d+),(\d+))?$/);
    if (fig) { cur.figure = cur.stem.length; cur.crop = fig[1] ? fig.slice(1).map(Number) : null; continue; }
    cur.stem.push(emphasis(line));
  }
  return qs;
}

const ids = process.argv.slice(2);
const rows = [...PAPERS.filter((p) => p.collection === 'djs' || isEuclidSample(p)), ...OFFICIAL_PAPERS]
  .filter((p) => !ids.length || ids.includes(p.id));
const officialKey = (row) => {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(OUT_A, `${row.id}.json`), 'utf8'));
    return [...doc.questions].sort((a, b) => a.qnum - b.qnum).map((q) => q.answer ?? '?').join('');
  } catch { return null; }
};
for (const row of rows) {
  const official = row.collection === 'official';
  const euclid = isEuclidSample(row);
  const file = path.join(official ? SRC_OFFICIAL : euclid ? SRC_EUCLID : SRC, `${row.id}.txt`);
  if (!fs.existsSync(file)) { console.log(`${row.id}: no transcription yet`); continue; }
  const parsed = parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  if (parsed.length !== 20) problems.push(`${parsed.length} questions`);
  parsed.forEach((q, i) => {
    if (q.qnum !== i + 1) problems.push(`Q${q.qnum} out of order`);
    if (q.options.length < 2) problems.push(`Q${q.qnum} has ${q.options.length} options`);
    const letters = q.options.map((o) => o.letter).join('');
    if (letters !== 'ABCDEFGHIJ'.slice(0, letters.length)) problems.push(`Q${q.qnum} letters ${letters}`);
    if ((q.stem.join('\n').match(/\$/g) || []).length % 2) problems.push(`Q${q.qnum} unbalanced $`);
  });
  const key = official ? officialKey(row) : (KEYS[row.id] ?? null);
  if (!key || key.length !== 20) problems.push('no 20-letter answer key');
  else parsed.forEach((q, i) => { if (!q.options.some((o) => o.letter === key[i])) problems.push(`Q${q.qnum} key ${key[i]} not an option`); });
  if (problems.length) { console.log(`${row.id}: NOT WRITTEN — ${problems.join('; ')}`); continue; }

  const questions = parsed.map((q) => {
    // A FIG line splits the stem: everything before it is the head, the figure slot is the
    // first newline, so the head must be ONE line — join it if it was several.
    let stem = q.stem;
    if (q.figure !== false) stem = [stem.slice(0, q.figure).join(' '), ...stem.slice(q.figure)];
    return {
      qnum: q.qnum,
      id: questionId(row, q.qnum),
      cid: canonicalId(row, q.qnum),
      // Sets A-C open with a contents page, so question n sits on page n+1; the page scanner
      // matches the contents list instead. The original Set A and α pack several to a page,
      // and there the scanner's answer is right, so they record none.
      // The Euclid samples open with a cover page and print one question per page too.
      pdf_page: euclid || (!official && ['A', 'B', 'C'].includes(row.set)) ? q.qnum + 1 : null,
      stem: stem.join('\n'),
      display: null,
      options: q.options,
      figure: q.figure !== false
        ? { file: `${row.id}_q${String(q.qnum).padStart(2, '0')}.png`, position: 'after_stem', ...(q.crop ? { crop: q.crop } : {}) }
        : null,
      classification: null,
    };
  });
  fs.writeFileSync(path.join(OUT_Q, `${row.id}.json`), JSON.stringify({
    schema_version: 1, paper_id: row.id, set: row.set, paper: row.paper,
    source: row.title, pdf: row.qp, transcribed: 'full',
  }, null, 2).replace(/\n}$/, () => `,\n  "questions": ${JSON.stringify(questions, null, 2).replace(/\n/g, '\n  ')}\n}`) + '\n');
  // ^ a FUNCTION replacement: as a string, "$$" in the maths would be read as an escaped "$".

  if (official) {
    console.log(`${row.id}: wrote ${questions.length} questions (answers file kept: official key)`);
    continue;
  }
  if (euclid) {
    writeEuclidAnswers(row, questions, key);
    continue;
  }
  const worked = !row.ms;
  fs.writeFileSync(path.join(OUT_A, `${row.id}.json`), JSON.stringify({
    schema_version: 1,
    paper_id: row.id,
    ms_pdf: row.ms,
    generated: new Date().toISOString(),
    source: worked ? 'Worked out independently — Daniel J Smith publishes no key for Custom α' : `${row.title} — author's answer key`,
    note: worked
      ? 'NO OFFICIAL KEY. Every letter here was solved from the question, not read off a key; treat a disagreement as a reason to recheck the working, not as proof he was wrong.'
      : 'Answer key only: Daniel J Smith publishes no worked solutions and no difficulty rating.',
    questions: questions.map((q, i) => ({
      qnum: q.qnum, answer: key[i], jz_tags: null, jz_difficulty: null,
      verification: worked ? 'worked_no_key' : 'answer_key',
      // The key is one page: the last page of the paper for A and B, page 1 of its own PDF
      // for C and the original Set A.
      solution: row.ms ? { type: 'pdf_page', path: row.ms, pages: [row.ms === row.qp ? 22 : 1] } : null,
    })),
  }, null, 2) + '\n');
  console.log(`${row.id}: wrote ${questions.length} questions${questions.some((q) => q.figure) ? ` (figures: ${questions.filter((q) => q.figure).map((q) => q.qnum).join(', ')})` : ''}`);
}

// The samples have no published key: the letters were solved here, and the AI mark scheme
// (one cover page, then question n on page n+1) carries the working for each.
function writeEuclidAnswers(row, questions, key) {
  fs.writeFileSync(path.join(OUT_A, `${row.id}.json`), JSON.stringify({
    schema_version: 1,
    paper_id: row.id,
    ms_pdf: row.ms,
    generated: new Date().toISOString(),
    source: 'Worked out independently — Euclid publishes no key for the sample papers',
    note: 'NO OFFICIAL KEY. Every letter was solved from the question and checked numerically; the worked solutions are AI-written.',
    questions: questions.map((q, i) => ({
      qnum: q.qnum, answer: key[i], jz_tags: null, jz_difficulty: null,
      verification: 'worked_no_key',
      solution: { type: 'pdf_page', path: row.ms, pages: [q.qnum + 1] },
    })),
  }, null, 2) + '\n');
  console.log(`${row.id}: wrote ${questions.length} questions${questions.some((q) => q.figure) ? ` (figures: ${questions.filter((q) => q.figure).map((q) => q.qnum).join(', ')})` : ''}`);
}

// Add an official paper's classification to the official TMUA tag index.
//
//   node scripts/classify-official.mjs tmua_2023_p1 tmua_2023_p2
//
// Source: tutor_data/exams/source/official/class/<paper id>.txt, one line per question in the
// same compact form classify-djs.mjs reads:
//   qnum|topics|question_type|techniques|cognitive_skills|traps|difficulty|description
// Every tag is checked against TAGGING_SPEC's vocabulary (the validator's own parser) and a
// paper is written only when all twenty lines pass. Entries for the paper already in the
// index are replaced, so re-running after an edit is safe.
//
// cross_links are computed, not hand-picked: the six other official questions sharing the
// most techniques (weighted double), topics and traps with this one.
import fs from 'node:fs';
import path from 'node:path';
import { vocabulary } from './validate-classification.mjs';
import { paperRow } from '../server/papers.js';
import { TUTOR_DATA } from '../server/paths.js';

const SRC = path.join(TUTOR_DATA, 'exams', 'source', 'official', 'class');
const INDEX = path.join(TUTOR_DATA, 'reference', 'tmua_full_tag_index.json');
const list = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const pad = (n) => String(n).padStart(2, '0');

const V = vocabulary();
const doc = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
let questions = doc.questions;

for (const id of process.argv.slice(2)) {
  const row = paperRow(id);
  if (!row || row.collection !== 'official') { console.log(`${id}: not an official paper`); continue; }
  const lines = fs.readFileSync(path.join(SRC, `${id}.txt`), 'utf8').trim().split('\n');
  const problems = [];
  const year = Number(row.set);
  const entries = lines.map((line, i) => {
    const [n, topics, qtype, tech, skills, traps, diff, desc] = line.split('|');
    const qnum = Number(n);
    if (qnum !== i + 1) problems.push(`line ${i + 1} is Q${n}`);
    const e = {
      id: `TMUA${year}P${row.paper}Q${pad(qnum)}`,
      paper: `TMUA_P${row.paper}`,
      year,
      part: String(qnum),
      topic: list(topics),
      technique: list(tech),
      question_type: qtype,
      cognitive_skill: list(skills),
      trap_type: list(traps),
      difficulty: Number(diff),
      paper_section: row.paper === 2 ? 'P2_logic_and_proof'
        : list(topics).some((t) => t === 'probability' || t === 'geometry') ? 'P1_applications' : 'P1_pure',
      exam_family: `TMUA_P${row.paper}`,
      // Classified from the question and the official solution's conclusion, not from a
      // line-by-line read of the worked solution.
      verification_status: 'answer_key_only',
      cross_links: [],
      // Written as the index's sentences are: capitalised, full stop.
      description: String(desc ?? '').trim().replace(/^./, (c) => c.toUpperCase()).replace(/([^.])$/, '$1.'),
    };
    for (const [field, vocab] of [['topic', 'topic'], ['technique', 'technique'], ['cognitive_skill', 'cognitive_skill'], ['trap_type', 'trap_type']]) {
      for (const t of e[field]) if (!V[vocab].has(t)) problems.push(`Q${qnum} ${field} "${t}"`);
    }
    if (!V.question_type.has(e.question_type)) problems.push(`Q${qnum} question_type "${e.question_type}"`);
    if (!(e.difficulty >= 1 && e.difficulty <= 5)) problems.push(`Q${qnum} difficulty ${diff}`);
    if (!e.topic.length || !e.technique.length || !e.description) problems.push(`Q${qnum} incomplete`);
    return e;
  });
  if (entries.length !== 20) problems.push(`${entries.length} lines`);
  if (problems.length) { console.log(`${id}: NOT WRITTEN — ${problems.join('; ')}`); continue; }
  // In place: straight after the last earlier year of the same paper, so the index's own
  // order (every Paper 1, then every Paper 2, practice and specimen interleaved) is kept.
  const prefix = `TMUA${year}P${row.paper}Q`;
  questions = questions.filter((q) => !q.id.startsWith(prefix));
  let at = -1;
  questions.forEach((q, i) => { if (q.exam_family === `TMUA_P${row.paper}` && Number(q.year) < year) at = i; });
  questions.splice(at + 1, 0, ...entries);
  console.log(`${id}: ${entries.length} questions classified`);
}

// Links for the new entries only; existing entries keep their hand-made lists.
const score = (a, b) => {
  const n = (x, y) => x.filter((t) => y.includes(t)).length;
  return 2 * n(a.technique, b.technique) + n(a.topic, b.topic) + n(a.trap_type, b.trap_type)
    + (a.exam_family === b.exam_family ? 1 : 0);
};
for (const q of questions) {
  if (q.cross_links.length || !/^TMUA\d{4}P[12]Q\d\d$/.test(q.id)) continue;
  q.cross_links = questions.filter((o) => o.id !== q.id && !o.id.startsWith(q.id.slice(0, 10)))
    .map((o) => [o, score(q, o)]).filter(([, s]) => s >= 3)
    .sort((x, y) => y[1] - x[1] || y[0].year - x[0].year).slice(0, 6).map(([o]) => o.id).sort();
}

doc.questions = questions;
doc.count = questions.length;
for (const id of process.argv.slice(2)) if (doc.generation_log?.shard_units) doc.generation_log.shard_units[id] = 20;
fs.writeFileSync(INDEX, `${JSON.stringify(doc, null, 1)}\n`);
console.log(`index now ${questions.length} questions`);

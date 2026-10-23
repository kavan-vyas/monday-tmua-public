// Turn a compact Daniel J Smith classification into a shard the validator and merge accept.
//
//   node scripts/classify-djs.mjs [paper id …]
//
// Source: tutor_data/exams/source/djs/class/<paper id>.txt, one line per question:
//   qnum|topics|question_type|techniques|cognitive_skills|traps|difficulty|description
// Comma-separated lists; traps may be empty. Difficulty is assigned here per
// TAGGING_SPEC's rubric because DJS publishes no rating.
import fs from 'node:fs';
import path from 'node:path';
import { PAPERS, questionId } from '../server/papers.js';
import { TUTOR_DATA } from '../server/paths.js';

const SRC = path.join(TUTOR_DATA, 'exams', 'source', 'djs', 'class');
// Euclid's sample papers use the same line format, kept beside their transcriptions.
const SRC_EUCLID = path.join(TUTOR_DATA, 'exams', 'source', 'euclid', 'class');
const isEuclidSample = (p) => p.collection === 'euclid' && p.set === 'sample';
const OUT = path.join(TUTOR_DATA, 'exams', 'classification');
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

const ids = process.argv.slice(2);
for (const row of PAPERS.filter((p) => (p.collection === 'djs' || isEuclidSample(p)) && (!ids.length || ids.includes(p.id)))) {
  const euclid = isEuclidSample(row);
  const file = path.join(euclid ? SRC_EUCLID : SRC, `${row.id}.txt`);
  if (!fs.existsSync(file)) { console.log(`${row.id}: no classification yet`); continue; }
  const answers = JSON.parse(fs.readFileSync(path.join(TUTOR_DATA, 'exams', 'answers', `${row.id}.json`), 'utf8'));
  const qs = JSON.parse(fs.readFileSync(path.join(TUTOR_DATA, 'exams', 'questions', `${row.id}.json`), 'utf8'));
  const keyless = !row.ms || euclid; // the Euclid samples' scheme is AI-written
  const questions = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => {
    const [n, topics, qtype, tech, skills, traps, diff, desc] = line.split('|');
    const qnum = Number(n);
    const label = { A0: 'SA0', ALPHA: 'SALPHA' }[row.set] ?? `S${row.set}`;
    return {
      id: questionId(row, qnum),
      ref: euclid ? `Euclid Sample P${row.paper} Q${qnum}` : `DJS ${label} P${row.paper} Q${qnum}`,
      exam: 'TMUA',
      exam_family: row.family,
      set: row.set,
      paper: row.paper,
      qnum,
      paper_section: row.paper === 2 ? 'P2_logic_and_proof' : (list(topics).includes('logic_and_proof') ? 'P2_logic_and_proof' : 'P1_pure'),
      topic: list(topics),
      question_type: qtype.trim(),
      technique: list(tech),
      cognitive_skill: list(skills),
      trap_type: list(traps),
      difficulty: Number(diff),
      description: desc.trim(),
      correct_answer: answers.questions.find((a) => a.qnum === qnum).answer,
      options_count: qs.questions.find((q) => q.qnum === qnum).options.length,
      jz_tags: null,
      jz_difficulty: null,
      verification_status: keyless ? 'inferred_no_solution' : 'answer_key_only',
      off_spec: null,
      cross_links: [],
    };
  });
  fs.writeFileSync(path.join(OUT, `${row.id}.json`), JSON.stringify({
    schema_version: 1, paper_id: row.id, set: row.set, paper: row.paper,
    source: euclid ? `${row.title} (Euclid free sample)` : `${row.title} (danieljsmith.org)`,
    generated: new Date().toISOString(),
    note: keyless
      ? 'Classified from the question paper. No answer key exists, so correct_answer is this run\'s own worked answer. Difficulty assigned per TAGGING_SPEC (no published rating).'
      : 'Classified from the question paper and DJS\'s answer key (no worked solutions are published). Difficulty assigned per TAGGING_SPEC (no published rating).',
    questions,
  }, null, 1) + '\n');
  console.log(`${row.id}: ${questions.length} classified`);
}

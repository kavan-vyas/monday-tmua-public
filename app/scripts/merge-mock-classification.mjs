// Merge the classification shards into tutor_data/reference/mock_tag_index.json.
//
// Three deliberate choices:
//
// 1. DIFFICULTY COMES FROM ONE RULE PER PAPER, never from a classifier's mood. Where the
//    author rates their own questions (JZ: 5-9 on a 10-point scale) it is halved and
//    rounded onto the index's 1-5 here, at merge, so ten separate classification passes
//    cannot disagree about what "hard" means — and the raw number rides along in
//    `jz_difficulty` so the mapping stays auditable and reversible. Where the author
//    publishes no rating (James Chen), the shard carries the difficulty and the validator
//    insists on it. papers.js says which regime a paper is in; nothing here guesses.
//
// 2. The mock index is REPLACED for exactly the families whose shards merged in this run,
//    and left alone everywhere else. Re-running this after re-classifying one paper must
//    not duplicate its questions, and must not touch Tyler, Rosie or AF.
//
// 3. Superseded families are dropped. "CHEN" was the family for the one Chen paper that
//    existed before the 2026 pair arrived; those twenty questions are now JC_P1 set 2025,
//    transcribed and re-classified from the same PDF. Leaving the old rows in place would
//    double every one of them under a name nothing writes any more.
//
//   node scripts/merge-mock-classification.mjs           # merge every valid shard
//   node scripts/merge-mock-classification.mjs --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateShard } from './validate-classification.mjs';
import { paperRow } from '../server/papers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARDS = path.join(ROOT, 'tutor_data', 'exams', 'classification');
const QDIR = path.join(ROOT, 'tutor_data', 'exams', 'questions');
const ADIR = path.join(ROOT, 'tutor_data', 'exams', 'answers');
const INDEX = path.join(ROOT, 'tutor_data', 'reference', 'mock_tag_index.json');
const BACKUPS = path.join(ROOT, 'tutor_data', '.backups');

const dry = process.argv.includes('--dry-run');
const readJson = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);

/** An author's 5-9 out of 10 onto the index's structural 1-5. One rule, applied to all. */
export const difficultyFromJz = (jz) => {
  const n = Number(jz);
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(5, Math.max(1, Math.round(n / 2)));
};

// Importable (the tests exercise difficultyFromJz): the merge only runs when this file is
// the entry point. Without this guard, importing it REWRITES the index as a side effect —
// which it did, once, in the middle of a test run.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) merge();

function merge() {
const shards = fs.readdirSync(SHARDS).filter((f) => f.endsWith('.json')).sort();
if (!shards.length) { console.error('no shards to merge'); process.exit(1); }

const records = [];
const replaced = new Set();
// Families no shard writes any more, but whose rows are still in the index. Dropping them
// is what makes a rename a rename instead of a duplication.
const SUPERSEDED = new Set(['CHEN']);
let bad = 0;
for (const f of shards) {
  const doc = readJson(path.join(SHARDS, f));
  const errs = validateShard(doc, { questions: readJson(path.join(QDIR, f)), answers: readJson(path.join(ADIR, f)) });
  if (errs.length) {
    console.log(`SKIP ${doc.paper_id} — ${errs.length} validation error(s); fix the shard first`);
    for (const e of errs.slice(0, 5)) console.log(`       ${e}`);
    bad++;
    continue;
  }
  const row = paperRow(doc.paper_id);
  replaced.add(row.family);
  for (const q of doc.questions) {
    records.push({
      id: q.id,
      ref: q.ref,
      exam: q.exam,
      exam_family: q.exam_family,
      set: q.set,
      paper: q.paper,
      qnum: q.qnum,
      paper_section: q.paper_section ?? null,
      topic: q.topic,
      question_type: q.question_type,
      technique: q.technique,
      cognitive_skill: q.cognitive_skill,
      trap_type: q.trap_type ?? [],
      difficulty: row.difficulty === 'source' ? difficultyFromJz(q.jz_difficulty) : Number(q.difficulty),
      description: q.description,
      correct_answer: q.correct_answer,
      // How many options the question actually offers. Not a constant: TMUA prints five on
      // Paper 1 and eight on Paper 2, but the mocks do not all follow that — Euclid ranges
      // from four to eight within a single paper, and its R2Drew edition prints six on a
      // Paper 1. A guess here is a wrong denominator for anything reasoning about a blind
      // guess, so the shard carries the count read off the page.
      options_count: q.options_count ?? null,
      verification_status: q.verification_status,
      // The author's own labels, kept verbatim beside ours: they are a second opinion from
      // a different vocabulary, and the difficulty mapping above must stay checkable.
      // Chen publishes neither, so both are empty for his papers rather than invented.
      jz_tags: q.jz_tags ?? [],
      jz_difficulty: q.jz_difficulty ?? null,
      off_spec: q.off_spec ?? null,
      cross_links: [],
    });
  }
  console.log(`ok   ${doc.paper_id}  ${doc.questions.length} questions`);
}

const index = readJson(INDEX) ?? { questions: [] };
const kept = (index.questions ?? []).filter((q) => {
  const fam = String(q.exam_family ?? '');
  return !replaced.has(fam) && !SUPERSEDED.has(fam);
});
const dropped = (index.questions ?? []).length - kept.length;
const merged = [...kept, ...records].sort((a, b) => String(a.id).localeCompare(String(b.id)));

const hist = {};
for (const r of records) hist[r.difficulty] = (hist[r.difficulty] ?? 0) + 1;
console.log(`\n${kept.length} untouched questions kept · ${dropped} replaced or superseded · ${records.length} merged · ${merged.length} total`);
console.log(`families rebuilt: ${[...replaced].sort().join(', ')}`);
console.log(`difficulty spread: ${Object.entries(hist).sort().map(([k, v]) => `${k}:${v}`).join('  ')}`);

if (dry) { console.log('\n--dry-run — nothing written'); process.exit(bad ? 1 : 0); }

fs.mkdirSync(BACKUPS, { recursive: true });
if (fs.existsSync(INDEX)) fs.copyFileSync(INDEX, path.join(BACKUPS, `mock_tag_index.json.${Date.now()}`));

const out = {
  ...index,
  generated: new Date().toISOString(),
  source: 'Tyler + James Chen + Rosie + Asher Falcon + JZ Maths mocks, classified per TAGGING_SPEC.md',
  count: merged.length,
  note: 'Mock papers only. Kept SEPARATE from the official MAT/TMUA indexes so coverage and accuracy stats stay clean. Where the author rates their own questions (JZ) difficulty is computed as round(jz_difficulty / 2) clamped 1-5, with the raw rating kept in jz_difficulty; where the author publishes no rating (James Chen) the classifier assigns it. Chen questions off the TMUA specification carry off_spec.',
  questions: merged,
};
const tmp = `${INDEX}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
fs.renameSync(tmp, INDEX);
console.log(`\nwrote ${INDEX}`);
process.exit(bad ? 1 : 0);
}

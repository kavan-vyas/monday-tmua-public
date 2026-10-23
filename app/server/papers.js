// The registry of sittable papers.
//
// Everything that used to be inferred from a "jz_<set>_p<n>" string — the title, the PDF on
// disk, the question-id prefix, where difficulty comes from — is a row here instead. The
// simulator shipped knowing only JZ's ten mocks, and every one of those facts was a regex
// or a template literal spread across exam.js, the shard validator and the merge script.
// Adding James Chen's four papers meant either four more special cases in each of those
// places, or one table. This is the table.
//
// A row is the ONLY place a paper's identity is written down. Consumers ask for a row and
// read fields off it; nothing outside this file parses a paper id.
import path from 'node:path';
import { PROJECT_ROOT } from './paths.js';

// One folder per collection, one folder per set inside it. The unofficial/ tree that held
// half of these is gone: a paper's collection is now visible from its path, and a set is a
// directory rather than a convention buried in a filename.
const TMUA = path.join(PROJECT_ROOT, 'major exams', 'tmua');
export const CHEN_DIR = path.join(TMUA, 'chen');
// Filed under the spelling printed on the papers' own cover sheets, "Heracles". The files
// arrived named "Hercules", which is what every note and search of the student's will say,
// so the row carries that spelling as an alias and canonical.js accepts both.
export const HERACLES_DIR = path.join(TMUA, 'heracles');
export const EUCLID_DIR = path.join(TMUA, 'euclid');
export const TYLER_DIR = path.join(TMUA, 'tyler');
export const JZ_DIR = path.join(TMUA, 'jz');
export const DJS_DIR = path.join(TMUA, 'daniel-j-smith');

export const QUESTIONS_PER_PAPER = 20;

/**
 * `difficulty` says where a question's 1-5 difficulty comes from:
 *   'source' — computed at merge from the author's own rating (only JZ publishes one).
 *   anything else — the classification shard assigns it.
 */
// Chen prints his solutions in the back of the question paper itself, so qp and ms are the
// same file. Nothing downstream cares that they are equal — it opens whichever it wants.
const chenRow = (year, paper) => {
  const pdf = path.join(CHEN_DIR, String(year), `James Chen TMUA ${year} Paper ${paper}.pdf`);
  const yy = String(year).slice(2);
  return {
    id: `jc_${yy}_p${paper}`,
    collection: 'chen',
    collectionTitle: 'James Chen',
    set: String(year),
    paper,
    title: `James Chen ${year} Paper ${paper}`,
    short: `${year} Paper ${paper}`,
    family: `JC_P${paper}`,
    idPrefix: `JC_${yy}_P${paper}`,
    cidPrefix: `JC-${yy}-P${paper}`,
    qp: pdf,
    ms: pdf,
    defaultTiming: 'real',
    difficulty: 'shard',
    note: 'Solutions are printed at the back of the same PDF; Chen publishes no difficulty rating.',
  };
};

// JZ is the one author who rates his own questions (5-9 out of 10), so `difficulty: 'source'`
// tells the merge to compute the index's 1-5 from that rating rather than read a shard's.
// His guide sets 120 minutes a paper, which is why the default timing is the long sitting.
const jzRow = (set, paper) => ({
  id: `jz_${set.toLowerCase()}_p${paper}`,
  collection: 'jz',
  collectionTitle: 'JZ Maths',
  set,
  paper,
  title: `JZ Mock Set ${set} Paper ${paper}`,
  short: `Set ${set} Paper ${paper}`,
  family: `JZ_P${paper}`,
  idPrefix: `JZ_S${set}_P${paper}`,
  cidPrefix: `JZ-${set}-P${paper}`,
  qp: path.join(JZ_DIR, `set-${set.toLowerCase()}`, `JZ Set ${set} Paper ${paper} QP.pdf`),
  ms: path.join(JZ_DIR, `set-${set.toLowerCase()}`, `JZ Set ${set} Paper ${paper} MS.pdf`),
  defaultTiming: 'long',
  difficulty: 'source',
  note: 'JZ ships a separate mark scheme with full worked solutions and its own 1-10 rating.',
});

// Tyler ships a separate worked-solutions PDF per paper and publishes no rating of his
// own, so difficulty is the classifier's to assign — the same regime as Chen.
const tylerRow = (set, paper) => ({
  id: `tyler_${set.toLowerCase()}_p${paper}`,
  collection: 'tyler',
  collectionTitle: 'Tyler Tutoring',
  set,
  paper,
  title: `Tyler Mock Set ${set} Paper ${paper}`,
  short: `Set ${set} Paper ${paper}`,
  family: `TYLER_P${paper}`,
  idPrefix: `TYLER_S${set}_P${paper}`,
  cidPrefix: `TYLER-${set}-P${paper}`,
  qp: path.join(TYLER_DIR, `set-${set.toLowerCase()}`, `Tyler Set ${set} Paper ${paper} QP.pdf`),
  ms: path.join(TYLER_DIR, `set-${set.toLowerCase()}`, `Tyler Set ${set} Paper ${paper} MS.pdf`),
  defaultTiming: 'real',
  note: 'Tyler prints his worked solutions in a separate PDF and publishes no difficulty rating.',
});

// Heracles publishes worked solutions in a separate PDF per paper and no difficulty rating,
// so difficulty is the classifier's to assign — the same regime as Chen and Tyler.
const heraclesRow = (set, paper) => ({
  id: `her_s${set}_p${paper}`,
  collection: 'heracles',
  collectionTitle: 'Heracles',
  aliases: ['hercules'],
  set: String(set),
  paper,
  title: `Heracles Set ${set} Paper ${paper}`,
  short: `Set ${set} Paper ${paper}`,
  family: `HER_P${paper}`,
  idPrefix: `HER_S${set}_P${paper}`,
  cidPrefix: `HER-${set}-P${paper}`,
  qp: path.join(HERACLES_DIR, `set-${set}`, `Heracles Set ${set} Paper ${paper} QP.pdf`),
  ms: path.join(HERACLES_DIR, `set-${set}`, `Heracles Set ${set} Paper ${paper} MS.pdf`),
  defaultTiming: 'real',
  note: 'Filed as Heracles, tagged hercules. Separate solutions PDF; no published difficulty rating.',
});

/**
 * One-off mocks that are a single paper with no set structure. They were in the tag index
 * (AF_P1, ROSIE_P1) but not here, so question_profile fell through to the official-TMUA
 * branch and answered with a null paper and a label like "TMUA undefined P1". Rosie ships no
 * mark scheme at all, which is why `ms` may be null.
 */
const singleRow = ({ id, collection, collectionTitle, set, family, idPrefix, cidPrefix, title, qp, ms }) => ({
  id, collection, collectionTitle, set, paper: 1, title, short: title,
  family, idPrefix, cidPrefix, qp, ms: ms ?? null,
  defaultTiming: 'real', difficulty: 'shard',
  note: ms ? 'Single unofficial paper.' : 'Single unofficial paper; no mark scheme exists for it.',
});

// Euclid publishes a full worked mark scheme per paper and no difficulty rating. The
// R2Drew edition is a one-off Paper 1 that arrived without a mark scheme at all, so it is
// registered with none and cannot be marked.
const euclidRow = (set, paper) => ({
  id: `euc_s${set}_p${paper}`,
  collection: 'euclid',
  collectionTitle: 'Euclid',
  set: String(set),
  paper,
  title: `Euclid Set ${set} Paper ${paper}`,
  short: `Set ${set} Paper ${paper}`,
  family: `EUC_P${paper}`,
  idPrefix: `EUC_S${set}_P${paper}`,
  cidPrefix: `EUC-${set}-P${paper}`,
  qp: path.join(EUCLID_DIR, `set-${set}`, `Euclid Set ${set} Paper ${paper} QP.pdf`),
  ms: path.join(EUCLID_DIR, `set-${set}`, `Euclid Set ${set} Paper ${paper} MS.pdf`),
  defaultTiming: 'real',
  note: 'Separate worked mark scheme; no published difficulty rating.',
});
// Euclid's two free sample papers. They ship with no key or solutions, so the mark scheme
// beside them is AI-written (answers solved here and checked numerically), and they are
// transcribed for the simulator from tutor_data/exams/source/euclid/.
const euclidSampleRow = (paper) => ({
  ...euclidRow('sample', paper),
  id: `euc_sample_p${paper}`,
  title: `Euclid Sample Paper ${paper}`,
  short: `Sample Paper ${paper}`,
  idPrefix: `EUC_SAMPLE_P${paper}`,
  cidPrefix: `EUC-SAMPLE-P${paper}`,
  qp: path.join(EUCLID_DIR, 'set-sample', `Euclid Sample Paper ${paper} QP.pdf`),
  ms: path.join(EUCLID_DIR, 'set-sample', `Euclid Sample Paper ${paper} MS (AI).pdf`),
  difficulty: 'shard',
  note: 'Free sample paper: Euclid publishes no key; answers and worked solutions are AI-written.',
});

// Daniel J Smith (danieljsmith.org). Sets A-C are his current papers, each with an answer
// key (on the paper's last page for A and B, a separate one-page PDF for C) and no worked
// solutions or difficulty rating. "A0" is his ORIGINAL Set A, an entirely different pair
// of papers that was later replaced by the current Set A; its key is a shared one-page PDF.
// "ALPHA" is his single Custom TMUA α: twenty Paper-2-style logic questions with no key at
// all, so its answers were worked out here and are flagged as such in the answers file.
const djsSetDir = (set) => path.join(DJS_DIR, `set-${set.toLowerCase()}`);
const djsRow = (set, paper, { label, ms }) => ({
  id: `djs_${set.toLowerCase()}_p${paper}`,
  collection: 'djs',
  collectionTitle: 'Daniel J Smith',
  aliases: ['daniel j smith', 'danieljsmith'],
  set,
  paper,
  title: `Daniel J Smith ${label} Paper ${paper}`,
  short: `${label} Paper ${paper}`,
  family: `DJS_P${paper}`,
  idPrefix: `DJS_S${set}_P${paper}`,
  cidPrefix: `DJS-${set}-P${paper}`,
  qp: path.join(djsSetDir(set), `Daniel J Smith ${label} Paper ${paper} QP.pdf`),
  ms,
  defaultTiming: 'real',
  difficulty: 'shard',
  note: ms ? 'Answer key only — no worked solutions; no published difficulty rating.'
    : 'No answer key exists; answers were worked out independently.',
});
const djsQp = (set, label, paper) => path.join(djsSetDir(set), `Daniel J Smith ${label} Paper ${paper} QP.pdf`);

export const PAPERS = [
  ...['A', 'B', 'C', 'D'].flatMap((set) => [1, 2].map((paper) => tylerRow(set, paper))),
  ...['A', 'B', 'C', 'D', 'E'].flatMap((set) => [1, 2].map((paper) => jzRow(set, paper))),
  ...[2025, 2026].flatMap((year) => [1, 2].map((paper) => chenRow(year, paper))),
  ...[1, 2, 3].flatMap((set) => [1, 2].map((paper) => heraclesRow(set, paper))),
  ...[1, 2, 3, 4].flatMap((set) => [1, 2].map((paper) => euclidRow(set, paper))),
  ...[1, 2].map((paper) => euclidSampleRow(paper)),
  ...['A', 'B'].flatMap((set) => [1, 2].map((paper) =>
    djsRow(set, paper, { label: `Set ${set}`, ms: djsQp(set, `Set ${set}`, paper) }))),
  ...[1, 2].map((paper) => djsRow('C', paper, {
    label: 'Set C', ms: path.join(djsSetDir('C'), `Daniel J Smith Set C Paper ${paper} Answers.pdf`) })),
  ...[1, 2].map((paper) => djsRow('A0', paper, {
    label: 'Set A (original)', ms: path.join(djsSetDir('A0'), 'Daniel J Smith Set A (original) Answer Keys.pdf') })),
  djsRow('ALPHA', 2, { label: 'Custom α', ms: null }),
  singleRow({
    id: 'euc_r2drew_p1', collection: 'euclid', collectionTitle: 'Euclid', set: 'r2drew',
    family: 'EUC_P1', idPrefix: 'EUC_R2D_P1', cidPrefix: 'EUC-R2D-P1',
    title: 'Euclid R2Drew Edition Paper 1',
    qp: path.join(EUCLID_DIR, 'r2drew', 'Euclid R2Drew Edition Paper 1 QP.pdf'), ms: null,
  }),
  singleRow({
    id: 'af_p1', collection: 'af', collectionTitle: 'Asher Falcon', set: '1',
    family: 'AF_P1', idPrefix: 'AF_P1', cidPrefix: 'AF-P1', title: 'Asher Falcon Paper 1',
    qp: path.join(TMUA, 'asher-falcon', 'set-1', 'Asher Falcon Paper 1 QP.pdf'), ms: null,
  }),
  singleRow({
    id: 'rosie_a_p1', collection: 'rosie', collectionTitle: 'Rosie', set: 'alpha',
    family: 'ROSIE_P1', idPrefix: 'ROSIE_SA_P1', cidPrefix: 'ROSIE-A-P1', title: 'Rosie Set alpha Paper 1',
    qp: path.join(TMUA, 'rosie', 'set-alpha', 'Rosie Set alpha Paper 1 QP.pdf'), ms: null,
  }),
];

// The official papers, kept OUT of PAPERS on purpose. PAPERS is the mock registry: the
// classification merge, the file-tree tests and tagindex's family lookup all walk it, and
// the official papers have their own tag index, their own manifest entries and a folder
// per year rather than a collection folder. What they need from a row is only what the
// exam simulator needs — an id, a title, the PDFs — so they get rows here, are listed by
// the simulator and resolved by paperRow(), and nothing that walks PAPERS sees them.
// A year is added once its transcription exists (tutor_data/exams/source/official/).
// 2025 is the student-RECALLED paper (scripts/tmua2025-recalled.mjs), rebuilt to be
// sittable; its key and solutions are worked independently, not published.
export const OFFICIAL_YEARS = [2019, 2023, 2025];
const RECALLED_YEARS = new Set([2025]);
const officialRow = (year, paper) => {
  const dir = path.join(TMUA, String(year));
  const recalled = RECALLED_YEARS.has(year);
  return {
    id: `tmua_${year}_p${paper}`,
    collection: 'official',
    collectionTitle: 'Official TMUA',
    set: String(year),
    paper,
    title: `TMUA ${year} Paper ${paper}${recalled ? ' (recalled)' : ''}`,
    short: `${year} Paper ${paper}`,
    family: `TMUA_P${paper}`,
    // TMUA_2019_P1_Q07 strips to TMUA2019P1Q07, the official tag index's own id.
    idPrefix: `TMUA_${year}_P${paper}`,
    cidPrefix: `TMUA-${year}-P${paper}`,
    qp: path.join(dir, `TMUA ${year} Paper ${paper}.pdf`),
    ms: path.join(dir, `TMUA ${year} Paper ${paper} Solutions${recalled ? ' (AI)' : ''}.pdf`),
    defaultTiming: 'real',
    difficulty: 'shard',
    note: recalled
      ? 'Recalled by candidates and rebuilt as a sittable paper; answers and solutions worked independently (AI).'
      : 'Official paper: published answer key and worked solutions.',
  };
};
export const OFFICIAL_PAPERS = OFFICIAL_YEARS.flatMap((y) => [1, 2].map((n) => officialRow(y, n)));

const BY_ID = new Map([...PAPERS, ...OFFICIAL_PAPERS].map((p) => [p.id, p]));

/** The row for a paper id, or null. Nothing else is a paper id. */
export function paperRow(id) {
  return BY_ID.get(String(id ?? '').toLowerCase()) ?? null;
}

export const pad2 = (n) => String(n).padStart(2, '0');

/** "JZ_SA_P1_Q07" / "JC_25_P1_Q07" — the id a question carries in the tag index. */
export const questionId = (row, qnum) => `${row.idPrefix}_Q${pad2(qnum)}`;

/** "JZ-A-P1-Q07" / "JC-25-P1-Q07" — the canonical reference a human types. */
export const canonicalId = (row, qnum) => `${row.cidPrefix}-Q${pad2(qnum)}`;

/** Every family the registry knows about, e.g. for "replace only these" merges. */
export const families = () => [...new Set(PAPERS.map((p) => p.family))];

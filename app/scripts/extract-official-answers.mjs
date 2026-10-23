// Read the official TMUA answer keys into tutor_data/exams/answers/, like every mock has.
//
// Every unofficial collection already stores its answers as JSON, so anything that wants to
// say "the answer was C" can. The official papers — the ones that actually matter — did not:
// their keys existed only as PDFs, so each mutant paper re-read them by eye, and a study
// document that states the wrong answer is worse than no document.
//
// The keys are a plain two-column table, "Paper 1" beside "Paper 2", question number then
// letter. Both papers are parsed from the same page and cross-checked: twenty rows each,
// every letter in A-H, or the file is rejected rather than half-written.
//
//   node scripts/extract-official-answers.mjs            # every key in the manifest
//   node scripts/extract-official-answers.mjs --report   # parse and print, write nothing
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TUTOR_DATA } from '../server/paths.js';

const OUT = path.join(TUTOR_DATA, 'exams', 'answers');
const report = process.argv.includes('--report');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Pull both papers' keys out of one answer-key PDF.
 *
 * The layout is two side-by-side tables, so a line carrying two numbers and two letters is
 * "question n of Paper 1 is X, question n of Paper 2 is Y". Some years print only one table
 * per page, so single-column lines are accepted too and assigned by which table is open.
 */
export function parseKey(text) {
  const p1 = new Map();
  const p2 = new Map();
  let column = null;   // which paper a single-column line belongs to
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // A column switch is either a bare "PAPER 1" heading (2018, 2019) or a heading that
    // names the paper alongside the word answer/key (2017, 2020-2022). Requiring the word
    // was what made the two bare-heading years parse as zero rows.
    const heading = /^paper\s*([12])\b/i.exec(line);
    if (heading && (line.length <= 10 || /answer|key/i.test(line))) column = Number(heading[1]);
    // "1 C 1 A" — both papers on one row.
    let m = /^(\d{1,2})\s+([A-H])\s+(\d{1,2})\s+([A-H])$/.exec(line);
    if (m && m[1] === m[3]) {
      p1.set(Number(m[1]), m[2]);
      p2.set(Number(m[3]), m[4]);
      continue;
    }
    // "1 C" — one paper, whichever heading was last seen.
    m = /^(\d{1,2})\s+([A-H])$/.exec(line);
    if (m && column) (column === 1 ? p1 : p2).set(Number(m[1]), m[2]);
  }
  return { 1: p1, 2: p2 };
}

const complete = (m) => m.size === 20 && [...Array(20)].every((_, i) => /^[A-H]$/.test(m.get(i + 1) ?? ''));

function main() {
  const man = readJson(path.join(TUTOR_DATA, 'file_manifest.json'));
  const sources = [];
  for (const [year, e] of Object.entries(man.tmua ?? {})) {
    if (e.answer_key) sources.push({ tag: year, key: e.answer_key });
  }
  for (const [k, tag] of [['tmua_practice', 'prac'], ['tmua_specimen', 'spec']]) {
    if (man[k]?.answer_key) sources.push({ tag, key: man[k].answer_key });
  }

  let written = 0;
  let failed = 0;
  for (const { tag, key } of sources.sort((a, b) => a.tag.localeCompare(b.tag))) {
    if (!fs.existsSync(key)) { console.log(`skip ${tag}: no file`); failed++; continue; }
    const text = execFileSync('pdftotext', ['-layout', key, '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const got = parseKey(text);
    for (const paper of [1, 2]) {
      const m = got[paper];
      const id = `tmua_${tag.toLowerCase()}_p${paper}`;
      if (!complete(m)) {
        console.log(`FAIL ${id}: ${m.size}/20 parsed — left alone rather than written half-right`);
        failed++;
        continue;
      }
      const letters = [...Array(20)].map((_, i) => m.get(i + 1));
      console.log(`ok   ${id}  ${letters.join('')}`);
      if (report) continue;
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify({
        schema_version: 1,
        paper_id: id,
        ms_pdf: key,
        generated: new Date().toISOString(),
        source: `Official TMUA ${tag} answer key`,
        note: 'Read from the published answer key PDF, which prints the letter for every question. '
            + 'Both papers are parsed from the same file and a paper is only written when all twenty '
            + 'questions came back with a letter in A-H.',
        questions: letters.map((answer, i) => ({
          qnum: i + 1, answer, confidence: 'official_key',
          solution: { type: 'pdf_page', path: key, pages: [] },
        })),
      }, null, 2));
      written++;
    }
  }
  console.log(`\n${written} written, ${failed} not${report ? '  (report only)' : ''}`);
  if (failed) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

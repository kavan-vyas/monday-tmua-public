// Work out what a dropped PDF actually is, from its contents.
//
// The old ingest guessed a slot from the filename and renamed the file to match,
// which is how a Zach mock and a James Chen custom paper both ended up called
// "TMUA Practice Paper 1", and a sequences worksheet became "Practice Paper 2".
// A filename is a claim; the pages are evidence. This reads the pages.
//
// Deterministic and free — pdftotext only, no model, no tokens. It does not decide
// anything: it hands Monday the evidence, and Monday chooses add_paper or
// file_to_library. Nothing is moved or renamed here.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { poppler } from './pdf.js';

const execFileP = promisify(execFile);

const FAMILY = [
  [/\bTMUA\b|test of mathematics for university admission/i, 'TMUA'],
  [/\bMAT\b|mathematics admissions test/i, 'MAT'],
  [/\bSTEP\b|sixth term examination/i, 'STEP'],
];

// Ordered: the first match wins, so "worked answers" beats a bare "answers".
const KIND = [
  [/mark\s*scheme/i, 'mark_scheme'],
  [/worked\s+(answers|solutions)/i, 'solutions'],
  [/\bsolutions?\b/i, 'solutions'],
  [/\banswer\s*key\b/i, 'answer_key'],
  [/\banswer\s*sheet\b/i, 'answer_sheet'],
  [/\banswers?\b/i, 'solutions'],
  [/examiner|\breport\b/i, 'report'],
  [/\bspecification\b|\bsyllabus\b/i, 'specification'],
  [/\bmock\b/i, 'mock'],
  [/\bpractice\b/i, 'practice'],
];

async function pageText(pdf, first, last) {
  const bin = await poppler('pdftotext');
  const { stdout } = await execFileP(bin, ['-f', String(first), '-l', String(last), '-layout', pdf, '-']);
  return stdout;
}

async function pageCount(pdf) {
  const bin = await poppler('pdfinfo');
  const { stdout } = await execFileP(bin, [pdf]);
  const m = stdout.match(/^Pages:\s*(\d+)/m);
  return m ? Number(m[1]) : 0;
}

/**
 * Find where Paper 2 starts in a combined PDF.
 *
 * The Tyler mock sets each arrived as one file with Paper 1 on pages 1-7 and
 * Paper 2 from page 8; filing that as a single "paper" would have buried half of
 * it. Only the top of a page counts — a mid-page cross-reference to "paper 2" is
 * not a section break.
 */
async function paperTwoStart(pdf, pages) {
  for (let p = 2; p <= Math.min(pages, 40); p += 1) {
    const head = (await pageText(pdf, p, p)).split('\n').slice(0, 3).join(' ');
    if (/paper\s*(2|ii)\b/i.test(head)) return p;
  }
  return null;
}

function firstMatch(table, text) {
  for (const [re, label] of table) if (re.test(text)) return label;
  return null;
}

/** A title line: the first line with real words, not a page number or a code. */
function titleLine(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/\s+/g, ' ');
    if (line.length < 4 || line.length > 120) continue;
    if (!/[a-z]{3}/i.test(line)) continue;
    return line;
  }
  return null;
}

export async function triage(pdfPath) {
  const name = path.basename(pdfPath);
  const pages = await pageCount(pdfPath);
  const head = await pageText(pdfPath, 1, Math.min(2, pages || 1));
  const flat = head.replace(/\s+/g, ' ').trim();

  const family = firstMatch(FAMILY, flat) ?? firstMatch(FAMILY, name);
  // Kind comes from the TITLE and the filename, never from body text. A question
  // paper's own instructions say "Answer sheet" and "answer all questions", so
  // scanning the whole page labelled Mock A's paper as "solutions". What a document
  // calls itself at the top is evidence; a word buried in its rubric is not.
  // Title AND filename together, because a solutions PDF often reprints the paper's
  // own title page verbatim — "TMUA Mock A Answers.pdf" and the paper it answers both
  // open with "Mock TMUA Set A: Paper 1". KIND is ordered so a solution marker in
  // either place outranks a generic "mock"/"practice".
  const title = titleLine(head) ?? '';
  const kind = firstMatch(KIND, `${title} ${name}`);
  const yearM = flat.match(/\b(19|20)\d{2}\b/);
  const paperM = flat.match(/paper\s*(1|2|i{1,2})\b/i);
  const split = pages > 8 ? await paperTwoStart(pdfPath, pages) : null;

  // A paper announces a duration and a question count; a worksheet rarely does.
  const timed = /\b\d{2,3}\s*minutes?\b/i.test(flat);
  const counted = /\b\d{1,2}\s*questions?\b/i.test(flat);

  return {
    file: pdfPath,
    name,
    pages,
    family,                       // TMUA | MAT | STEP | null
    kind,                         // solutions | mock | practice | worksheet-ish | null
    year: yearM ? Number(yearM[0]) : null,
    paper: paperM ? paperM[1].toLowerCase().replace('ii', '2').replace('i', '1') : null,
    combined_paper2_starts: split, // non-null => two papers in one file, split first
    looks_like_exam_paper: Boolean(timed && counted),
    title_line: titleLine(head),
    first_page_excerpt: flat.slice(0, 400),
    // Said plainly so it is never treated as a decision.
    note: 'Evidence read from the pages, not the filename. Nothing has been moved or '
        + 'renamed. Decide: add_paper for a real exam paper, file_to_library for anything '
        + 'else, and give it a descriptive name if the current one is useless.',
  };
}

/** One line for a hidden nudge, so Monday can act without re-reading the file. */
export function summarise(t) {
  const bits = [
    t.family, t.year, t.paper && `Paper ${t.paper}`, t.kind,
    `${t.pages}pp`,
    t.combined_paper2_starts && `TWO PAPERS IN ONE FILE (Paper 2 starts p${t.combined_paper2_starts})`,
    t.looks_like_exam_paper ? 'reads like an exam paper' : 'does not read like an exam paper',
  ].filter(Boolean);
  return `${t.name} — ${bits.join(', ')}${t.title_line ? `. Title line: "${t.title_line}"` : ''}`;
}

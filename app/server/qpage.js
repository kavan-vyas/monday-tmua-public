// Which page is this question on?
//
// The backlog knows a question by a reference ("2007 Q1J", "2018 P2 Q14",
// "Tyler SA P1 Q20"), not by a page, so opening a paper dropped him at page 1 to scroll
// for it - every attempt, twice, once in the paper and once in the mark scheme.
//
// There is no single rule that finds it, because these collections are typeset by four
// different people:
//
//   - JZ mocks          one question per page, and the exact page is already recorded in
//                       tutor_data/exams/, so nothing needs searching.
//   - MAT papers        Q1's parts are lettered "A." to "J.", two to a page.
//   - TMUA officials    the paper's text layer is glyph-mangled - its digits arrive as
//                       Greek numerals - but it is rigidly one question per page, so the
//                       headings that do survive fix the positions of the rest.
//   - TMUA solutions    "Question 7" sits in running text and is directly searchable.
//   - Tyler / Chen      several questions to a page, numbered "7." at a line start.
//
// So: search for a heading, and where the search is defeated, interpolate from the
// headings that were found. A wrong page is no worse than page 1, which is where every
// one of these used to open.
import fs from 'node:fs';
import { extractPages } from './pdf.js';

// The officials' text layer sets its digits in a symbol font, so pdftotext hands back
// Greek numerals. Written as code points because that is what they are - a font's
// private idea of a numeral, not Greek text.
const DIGIT_ALIASES = [
  ['Ͱ', '0'], ['ͳ', '1'], ['ʹ', '2'], ['͵', '3'], ['Ͷ', '4'],
  ['ͷ', '5'], ['͸', '6'], ['͹', '7'], ['ͺ', '8'], ['ͻ', '9'],
];

export function normalisePage(text) {
  // Control characters and soft hyphens litter these layers and are never meaningful.
  let t = String(text ?? '').replace(/[\x00-\x1f\xad]/g, ' ');
  for (const [from, to] of DIGIT_ALIASES) t = t.split(from).join(to);
  // Mathematical alphanumeric digits, across their several blocks, back to ASCII.
  t = t.replace(/[\u{1D7CE}-\u{1D7FF}]/gu, (c) => String((c.codePointAt(0) - 0x1D7CE) % 10));
  return t;
}

const startsWithHeading = (page, qnum) =>
  new RegExp(`^[\\s.]*(?:Question\\s+)?${qnum}\\s*[.)\\s]`).test(page.trimStart());

const hasHeading = (page, qnum) =>
  new RegExp(`(?:^|\\n)\\s*(?:Question\\s+|Solution\\s+)?${qnum}\\s*[.)]`).test(page)
  || new RegExp(`\\b(?:Question|Solution)\\s+${qnum}\\b`).test(page);

// Tyler and Chen put several questions on a page and the extractor drags page furniture
// onto the same line, so "4." arrives mid-line rather than starting one: match a number
// followed by a full stop and a space wherever it appears.
const looseHeading = (page, qnum) =>
  new RegExp(`(?:^|\\s)${qnum}\\s*[.)]\\s`).test(page);

/**
 * Page for one question, from already-extracted page text. Pure, so the heuristics are
 * testable without a PDF. `pages` is 0-indexed; the answer is a 1-indexed page number.
 */
export function findPage(pages, { qnum = null, part = null, total = null } = {}) {
  const norm = (pages || []).map(normalisePage);
  if (!norm.length) return null;

  // A MAT part letter: "A." to "J." starting a line.
  if (part) {
    const L = String(part).toUpperCase();
    const pageOf = (letter) => {
      for (let i = 0; i < norm.length; i++) {
        if (new RegExp(`(?:^|\\n)\\s*${letter}\\s*[.)]`).test(norm[i])) return i + 1;
      }
      for (let i = 0; i < norm.length; i++) {
        if (new RegExp(`(?:^|\\s)${letter}\\s*[.)]\\s`).test(norm[i])) return i + 1;
      }
      return null;
    };
    const exact = pageOf(L);
    if (exact) return exact;
    // MAT sets two parts to a page, and only the first of each pair reliably starts a
    // line — so an unfound J is on I's page, an unfound D on C's.
    const letters = 'ABCDEFGHIJ';
    for (let k = letters.indexOf(L) - 1; k >= 0; k--) {
      const back = pageOf(letters[k]);
      if (back) return back;
    }
    return null;
  }
  if (!Number.isFinite(Number(qnum))) return null;
  const n = Number(qnum);

  // A page that opens with the question is the strongest signal.
  for (let i = 0; i < norm.length; i++) if (startsWithHeading(norm[i], n)) return i + 1;

  // Otherwise a heading anywhere on the page - but not a contents page, which lists many.
  for (let i = 0; i < norm.length; i++) {
    const listy = (norm[i].match(/\b(?:Question|Solution)\s+\d+\b/g) || []).length > 3;
    if (!listy && hasHeading(norm[i], n)) return i + 1;
  }

  // Looser still: a numbered heading anywhere on a page that is not a contents list.
  for (let i = 0; i < norm.length; i++) {
    const listy = (norm[i].match(/(?:^|\s)\d{1,2}\s*[.)]\s/g) || []).length > 6;
    if (!listy && looseHeading(norm[i], n)) return i + 1;
  }

  // Nothing for this one. If other questions were found, the paper's own spacing gives it
  // away: fit a line through the headings that were visible and read this page off it.
  const seen = [];
  const limit = Number.isFinite(Number(total)) ? Number(total) : 20;
  for (let q = 1; q <= limit; q++) {
    for (let i = 0; i < norm.length; i++) {
      if (startsWithHeading(norm[i], q) || looseHeading(norm[i], q)) { seen.push([q, i + 1]); break; }
    }
  }
  if (seen.length < 3) return null;
  const [q0, p0] = seen[0];
  const [q1, p1] = seen[seen.length - 1];
  const slope = (p1 - p0) / (q1 - q0 || 1);
  const page = Math.round(p0 + (n - q0) * slope);
  return page >= 1 && page <= norm.length ? page : null;
}

// Extracting a 40-page PDF costs about a tenth of a second, and a backlog session opens
// the same two papers repeatedly, so hold the page text against the file's mtime.
const cache = new Map();

async function pagesOf(pdfPath) {
  let key;
  try {
    const st = fs.statSync(pdfPath);
    key = `${pdfPath}|${st.mtimeMs}|${st.size}`;
  } catch { return null; }
  if (cache.has(key)) return cache.get(key);
  const pages = await extractPages(pdfPath, {});
  if (cache.size > 40) cache.clear();
  cache.set(key, pages);
  return pages;
}

/** Parse a backlog ref into something searchable. */
export function parseRef(ref, exam) {
  const r = String(ref ?? '');
  if (String(exam).toUpperCase() === 'MAT') {
    const m = r.match(/q?\s*1?\s*([a-j])\b/i);
    return { part: m ? m[1].toUpperCase() : null, qnum: null };
  }
  const m = r.match(/q\s*(\d+)/i);
  return { part: null, qnum: m ? Number(m[1]) : null };
}

export async function questionPage(pdfPath, { ref, exam, total = null } = {}) {
  if (!pdfPath) return null;
  const pages = await pagesOf(pdfPath);
  if (!pages || !pages.length) return null;
  const { qnum, part } = parseRef(ref, exam);
  if (qnum == null && !part) return null;
  return findPage(pages, { qnum, part, total });
}

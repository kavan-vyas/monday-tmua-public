// Work out which page each question starts on, for every paper in the registry.
//
// "Open paper" used to find the page by searching the PDF's text on every click, and the
// search is a heuristic: it looks for a page that opens with the question number. That is
// right often enough to feel fine and wrong often enough to be maddening — a stray "7" in
// an option list, a question that starts halfway down a page, a mark scheme that numbers
// its solutions differently. The only paper it never got wrong was JZ, because JZ had a
// transcription recording the exact page, and that fast path was written for JZ alone.
//
// This builds the same fact for every paper, once, from the question papers themselves:
// a question number sitting at the left margin, with the numbers running in order. Where a
// transcription already records the page (Chen) that wins, and where an answer key records
// the solution pages (Chen, Heracles) those are used for the mark scheme.
//
//   node scripts/build-page-index.mjs            # every registry paper
//   node scripts/build-page-index.mjs her_s1_p1  # just one
//   node scripts/build-page-index.mjs --report   # show coverage without writing
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PAPERS, paperRow, QUESTIONS_PER_PAPER } from '../server/papers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NO_OCR = process.argv.includes('--no-ocr');
const EXAMS = path.join(ROOT, 'tutor_data', 'exams');
const OUT = path.join(EXAMS, 'pageindex');

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/** Page text, one entry per page, in order. */
function pagesOf(pdf) {
  if (!fs.existsSync(pdf)) return null;
  try {
    const raw = execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return raw.split('\f');
  } catch {
    return null;
  }
}

/**
 * Lines with their left edge, per page: [[{ x, text }, …], …].
 *
 * Plain text is not enough to find a question number. A question number and the
 * denominator of a fraction both come out as a short number alone on a line, and Chen's
 * option lists are full of fractions — which is how "2" inside question 1's options got
 * read as the start of question 2. What separates them is horizontal position: question
 * numbers sit in a column at the left margin, fractions sit wherever the maths is.
 */
export function linesOf(pdf) {
  let xml;
  try {
    // poppler aborts outright on a few of these files (std::out_of_range from its own
    // string handling), so the crash has to be swallowed and the caller fall back to the
    // plain text layer rather than the paper losing its index.
    xml = execFileSync('pdftotext', ['-bbox-layout', pdf, '-'],
      { encoding: 'utf8', maxBuffer: 96 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  // pdftotext emits raw control bytes for glyphs it cannot map, and an unescaped & is
  // fatal to a parser; neither carries position, so both are scrubbed.
  xml = xml.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').replace(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g, '&amp;');
  const pages = [];
  for (const pageXml of xml.split('<page').slice(1)) {
    const lines = [];
    for (const lineXml of pageXml.split('<line').slice(1)) {
      const x = Number(/xMin="([\d.]+)"/.exec(lineXml)?.[1] ?? NaN);
      const words = [...lineXml.matchAll(/<word[^>]*>([\s\S]*?)<\/word>/g)].map((m) => m[1]);
      if (!words.length) continue;
      lines.push({ x, text: words.join(' ').trim() });
    }
    pages.push(lines);
  }
  return pages;
}

const NUMBERED = /^(?:Q(?:uestion)?\s*)?(\d{1,2})\s*[.)]?(\s|$)/i;
/**
 * A contents line — "Question 4 . . . . . . . 6" — looks exactly like a question start and
 * comes earlier in the document, so an unguarded scan indexed every solution to page 2.
 *
 * The test is dot leaders followed by a page number at the END of the line. Matching bare
 * ellipses instead threw away Tyler's question 18, whose statement is a sum written
 * "cos 2 0 + cos 2 2 + . . . + cos 2 90".
 */
const CONTENTS = /(?:\.\s*){4,}\s*\d{1,3}\s*$/;

/**
 * Question number → page.
 *
 * Numbers must arrive in order, and each must sit in the same left-hand column as the ones
 * before it — the column is learnt from the first question rather than hard-coded, because
 * Tyler indents its numbers and the official papers do not.
 */
export function indexPages(pages, { count = QUESTIONS_PER_PAPER, tolerance = 14 } = {}) {
  const found = {};
  let want = 1;
  let column = null;
  for (let i = 0; i < pages.length && want <= count; i++) {
    for (const line of pages[i]) {
      if (want > count) break;
      if (CONTENTS.test(line.text)) continue;
      const m = NUMBERED.exec(line.text);
      if (!m || Number(m[1]) !== want) continue;
      if (column == null) {
        // Seed the column on the first question, but only from a plausible left margin.
        if (Number.isFinite(line.x) && line.x > 160) continue;
        column = line.x;
      } else if (Number.isFinite(line.x) && Math.abs(line.x - column) > tolerance) {
        continue;
      }
      found[want] = i + 1;
      want += 1;
    }
  }
  return found;
}

/**
 * The same scan, from the plain text layer, for the papers poppler cannot give boxes for.
 * Without an x position the column trick is unavailable, so two weaker rules stand in: the
 * number must be near the left of the line, and a number alone on a line must have content
 * under it — a page's own footer has nothing under it.
 */
export function indexPagesText(pages, { count = QUESTIONS_PER_PAPER } = {}) {
  const found = {};
  let want = 1;
  for (let i = 0; i < pages.length && want <= count; i++) {
    const lines = pages[i].split('\n');
    const lastInk = lines.reduce((acc, l, k) => (l.trim() ? k : acc), -1);
    for (const [idx, line] of lines.entries()) {
      if (want > count) break;
      if (CONTENTS.test(line)) continue;
      const m = line.match(/^\s{0,12}(?:Q(?:uestion)?\s*)?(\d{1,2})\s*[.)]?(\s|$)/i);
      if (!m || Number(m[1]) !== want) continue;
      const bare = !/\S/.test(line.replace(/^\s*(?:Q(?:uestion)?\s*)?\d{1,2}\s*[.)]?\s*/i, ''));
      if (bare && idx >= lastInk - 1) continue;
      found[want] = i + 1;
      want += 1;
    }
  }
  return found;
}

/**
 * Read the question numbers off the rendered page, for the papers whose text layer is
 * unusable.
 *
 * TMUA 2016 and the practice set were typeset with a symbol font whose characters extract
 * as glyph soup — "UCLES" comes out as "8&/(6" — so neither the boxes nor the text can be
 * trusted. The pixels are fine, though: the question number is printed in the left margin,
 * so a narrow strip down the left of each page, put through OCR with a digits-only
 * whitelist, gives the numbers directly. Slow (a render and an OCR pass per page), which is
 * why it is the last resort and its output is cached in the index like everything else.
 */
export function ocrIndex(pdf, { count = QUESTIONS_PER_PAPER, dpi = 150 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pageindex-'));
  try {
    execFileSync('pdftoppm', ['-r', String(dpi), '-png', pdf, path.join(tmp, 'pg')],
      { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 1 << 28 });
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
    const found = {};
    let want = 1;
    for (const [i, f] of files.entries()) {
      if (want > count) break;
      const src = path.join(tmp, f);
      const strip = path.join(tmp, `strip-${i}.png`);
      // The left tenth of the page, which is where the number lives and where nothing else does.
      execFileSync('python3', ['-c',
        'import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.crop((0,0,int(im.width*0.12),im.height)).save(sys.argv[2])',
        src, strip], { stdio: ['ignore', 'ignore', 'ignore'] });
      let text = '';
      try {
        text = execFileSync('tesseract', [strip, 'stdout', '--psm', '6', '-c', 'tessedit_char_whitelist=0123456789'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { /* an unreadable page simply contributes nothing */ }
      for (const tok of text.split(/\s+/)) {
        const n = Number(tok);
        if (!Number.isInteger(n) || n !== want) continue;
        found[want] = i + 1;
        want += 1;
        if (want > count) break;
      }
    }
    return found;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function buildFor(row) {
  const out = { paper_id: row.id, title: row.title, generated: new Date().toISOString(), qp: {}, ms: {}, source: {} };

  // 1. A transcription is authoritative: it was read by hand.
  const doc = readJson(path.join(EXAMS, 'questions', `${row.id}.json`));
  if (doc?.questions?.length) {
    for (const q of doc.questions) if (q.pdf_page) out.qp[q.qnum] = q.pdf_page;
    if (Object.keys(out.qp).length) out.source.qp = 'transcription';
  }
  // 2. Otherwise read the question paper's own numbering.
  if (!Object.keys(out.qp).length) {
    const boxed = linesOf(row.qp);
    if (boxed) { out.qp = indexPages(boxed); out.source.qp = 'scanned'; }
    if (Object.keys(out.qp).length < QUESTIONS_PER_PAPER) {
      const text = pagesOf(row.qp);
      if (text) {
        const alt = indexPagesText(text);
        if (Object.keys(alt).length > Object.keys(out.qp).length) { out.qp = alt; out.source.qp = 'scanned-text'; }
      }
    }
    if (Object.keys(out.qp).length < QUESTIONS_PER_PAPER && !NO_OCR) {
      const alt = ocrIndex(row.qp);
      if (Object.keys(alt).length > Object.keys(out.qp).length) { out.qp = alt; out.source.qp = 'ocr'; }
    }
  }

  // 3. Mark scheme: the answer key records the solution pages where one exists.
  const key = row.ms === null ? null : readJson(path.join(EXAMS, 'answers', `${row.id}.json`));
  const rows = key?.questions ?? [];
  for (const a of rows) {
    const p = Array.isArray(a?.solution?.pages) ? a.solution.pages[0] : null;
    if (p) out.ms[a.qnum] = p;
  }
  if (Object.keys(out.ms).length) out.source.ms = 'answer-key';
  else if (row.ms && row.ms !== row.qp && fs.existsSync(row.ms)) {
    const boxed = linesOf(row.ms);
    if (boxed) { out.ms = indexPages(boxed); out.source.ms = 'scanned'; }
    if (Object.keys(out.ms).length < QUESTIONS_PER_PAPER) {
      const text = pagesOf(row.ms);
      if (text) {
        const alt = indexPagesText(text);
        if (Object.keys(alt).length > Object.keys(out.ms).length) { out.ms = alt; out.source.ms = 'scanned-text'; }
      }
    }
  } else if (row.ms === row.qp && Object.keys(out.qp).length) {
    // Solutions printed in the back of the same PDF and no key to say where: better to
    // say nothing than to send the reader to the question again.
    out.source.ms = 'none';
  }
  return out;
}

// Importable (the tests exercise indexPages): building only runs when this file is the
// entry point. Without the guard, importing it re-scans every paper as a side effect.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

function main() {
/**
 * The official papers are not in the registry — they are listed in file_manifest.json and
 * they are the ones the backlog opens most often. They get an index too, under the same id
 * scheme the canonical references use: tmua_2018_p2, tmua_prac_p1, tmua_spec_p2.
 */
function officialRows() {
  const man = readJson(path.join(ROOT, 'tutor_data', 'file_manifest.json')) ?? {};
  const rows = [];
  for (const [year, e] of Object.entries(man.tmua ?? {})) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const n of [1, 2]) {
      if (e[`p${n}`]) {
        rows.push({ id: `tmua_${year}_p${n}`, title: `TMUA ${year} Paper ${n}`,
          qp: e[`p${n}`], ms: e[`p${n}_solutions`] ?? null });
      }
    }
  }
  for (const [key, tag] of [['tmua_practice', 'prac'], ['tmua_specimen', 'spec']]) {
    const e = man[key] ?? {};
    for (const n of [1, 2]) {
      if (e[`p${n}`]) {
        rows.push({ id: `tmua_${tag}_p${n}`, title: `TMUA ${tag === 'prac' ? 'practice' : 'specimen'} Paper ${n}`,
          qp: e[`p${n}`], ms: e[`p${n}_solutions`] ?? null });
      }
    }
  }
  return rows;
}

const args = process.argv.slice(2);
const reportOnly = args.includes('--report');
const only = args.find((a) => !a.startsWith('--'));
const all = [...PAPERS, ...officialRows()];
const rows = only ? all.filter((r) => r.id === only) : all;
if (!rows.length) { console.error(`no such paper: ${only}`); process.exit(1); }

if (!reportOnly) fs.mkdirSync(OUT, { recursive: true });
let complete = 0;
for (const row of rows) {
  if (!fs.existsSync(row.qp)) { console.log(`skip ${row.id.padEnd(11)} no question paper on disk`); continue; }
  const idx = buildFor(row);
  const nq = Object.keys(idx.qp).length;
  const nm = Object.keys(idx.ms).length;
  const ok = nq >= QUESTIONS_PER_PAPER;
  if (ok) complete += 1;
  if (!reportOnly) fs.writeFileSync(path.join(OUT, `${row.id}.json`), `${JSON.stringify(idx, null, 2)}\n`);
  console.log(`${ok ? 'ok  ' : 'PART'} ${row.id.padEnd(11)} qp ${String(nq).padStart(2)}/20 (${idx.source.qp ?? '—'})`
    + `   ms ${String(nm).padStart(2)}/20 (${idx.source.ms ?? '—'})`);
}
console.log(`\n${complete}/${rows.length} papers fully indexed${reportOnly ? '  (report only, nothing written)' : ''}`);
}

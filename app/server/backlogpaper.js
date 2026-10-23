// Backlog papers: a sittable retry paper built out of what he still owes.
//
// A mutant paper explains; a backlog paper is something to SIT. He names topics and question
// types, and this assembles a whole paper of them out of open backlog items — the questions
// he got wrong and has not re-earned. Where his filter does not fill the paper, the rest is
// topped up from the backlog by priority, because a short paper is not a paper.
//
// It ships as two PDFs: the paper, and the mark scheme. The mark scheme is the real pages
// from the real solutions wherever they exist; only where a paper publishes none is an
// answer written by hand, and that is stated on the page so he knows which he is reading.
//
// Two things here are harder than they look.
//
//   * NOT EVERY QUESTION OWNS A PAGE. TMUA prints one per page, but MAT puts two or three
//     parts of Question 1 on one, and Rosie prints three. `sliceFor()` finds the vertical
//     span of one question by locating its own label and the next one in the PDF's text
//     layout, so a crop is derived from the page rather than guessed at.
//
//   * ORDER MATTERS, AND THE OBVIOUS ORDER IS WRONG. Grouping by topic tells him what each
//     question is before he reads it, which is exactly the help the real exam withholds.
//     `shuffle()` scatters them from a seed, so the paper is reproducible but not sorted.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TUTOR_DATA, PROJECT_ROOT } from './paths.js';
import { paperRow } from './papers.js';
import { canonicalId } from './canonical.js';
import { locate } from './pageindex.js';
import { satPapers } from './mutant.js';

export const BACKLOG_PAPER_DIR = path.join(PROJECT_ROOT, 'major exams', 'tmua', 'backlog paper');
const readJson = (p, fb = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

/** The three tag indexes, keyed by question id. */
function indexById() {
  const out = new Map();
  for (const f of ['tmua_full_tag_index.json', 'mat_full_tag_index.json', 'mock_tag_index.json']) {
    for (const q of readJson(path.join(TUTOR_DATA, 'reference', f), { questions: [] }).questions ?? []) out.set(q.id, q);
  }
  return out;
}

/** What counts as a logic question, beyond the topic label alone. */
export const LOGIC = {
  topics: ['logic_and_proof'],
  types: ['sufficiency_or_necessity', 'logical_deduction', 'proof', 'disprove_or_counterexample'],
  techniques: ['quantifier_negation', 'converse_or_contrapositive_analysis',
    'truth_table_or_exhaustive_check', 'proof_by_contradiction', 'proof_by_induction'],
  traps: ['converse_assumed_from_implication', 'necessary_confused_with_sufficient', 'quantifier_order_confused'],
};

/**
 * Every open backlog item, with the index entry and the pages it lives on. A review paper
 * also wants closed items (a question he has since understood), so `statuses` widens it.
 *
 * MAT items keep their own resolution path: they are lettered parts of one question rather
 * than numbered questions, so `locate()` does not know them and the manifest does.
 */
export function pool({ statuses = ['open'] } = {}) {
  const idx = indexById();
  const items = (readJson(path.join(TUTOR_DATA, 'backlog.json'), { items: [] }).items ?? [])
    .filter((i) => statuses.includes(i.status));
  const man = readJson(path.join(TUTOR_DATA, 'file_manifest.json'), {});
  const sat = satPapers();

  const out = [];
  for (const it of items) {
    const row = resolve(it, { idx, man, sat });
    if (row) out.push(row);
  }
  return out;
}

/**
 * One question → its index entry, PDFs, pages and crop markers, or null when it cannot be
 * found or comes from a paper he has not sat. Shared by the backlog/review papers and by
 * Mathematical Doom, which resolves questions that are not in the backlog at all.
 */
export function resolve(it, {
  idx = indexById(),
  man = readJson(path.join(TUTOR_DATA, 'file_manifest.json'), {}),
  sat = satPapers(),
} = {}) {
  const tag = idx.get(it.insight?.id) ?? null;
  const row = { ...it, tag, topic: it.topic, question_type: tag?.question_type ?? null };
  if (it.exam === 'MAT') {
    const m = /^MAT-(\d{4})-([A-J])$/.exec(it.cid ?? '');
    if (!m) return null;
    const e = man.mat?.[m[1]];
    if (!e?.paper) return null;
    const marker = new RegExp(`^${m[2]}\\.`);
    // Three label styles across the years: the papers write "A.", most solutions write
    // "A:", and 2021 writes a bare "A" followed by the working. Matching only the paper's
    // form is why every MAT mark-scheme page came back null.
    const msMarker = new RegExp(`^${m[2]}(?=[.:)]|\\s)`);
    Object.assign(row, {
      kind: 'mat', year: m[1], part: m[2],
      qp: e.paper, ms: e.solutions ?? null,
      marker, nextMarker: /^[A-J]\./,
      msMarker, msNextMarker: /^[A-J](?=[.:)]|\s)/,
      // MAT has no page index: Question 1's parts are lettered, so nothing upstream knows
      // where they are. Found by scanning for the part's own label.
      qp_page: findPage(e.paper, marker, 2, 12),
      ms_page: e.solutions ? findPage(e.solutions, msMarker, 1, 12) : null,
    });
  } else {
    const loc = locate(it.cid ?? canonicalId(it.exam ?? 'TMUA', String(it.ref)));
    if (!loc) return null;
    const paper = String(it.ref).replace(/\s*Q\s*\d+\s*$/, '').trim();
    if (!sat.has(paper)) return null;                    // a retry paper is never a first sight
    const reg = paperRow(loc.paperId);
    const pi = readJson(path.join(TUTOR_DATA, 'exams', 'pageindex', `${loc.paperId}.json`), null);
    Object.assign(row, {
      kind: 'tmua', paper_id: loc.paperId, qnum: loc.qnum,
      qp: reg?.qp ?? officialPdf(man, loc.paperId, 'qp'),
      ms: reg ? reg.ms : officialPdf(man, loc.paperId, 'ms'),
      qp_page: pi?.qp?.[String(loc.qnum)] ?? null,
      ms_page: pi?.ms?.[String(loc.qnum)] ?? null,
      marker: new RegExp(`^${loc.qnum}[.\\s]`), nextMarker: new RegExp(`^${loc.qnum + 1}[.\\s]`),
      msMarker: new RegExp(`^(?:Question\\s+)?${loc.qnum}[.:\\s]`), msNextMarker: new RegExp(`^(?:Question\\s+)?${loc.qnum + 1}[.:\\s]`),
    });
  }
  return row.qp ? row : null;
}

/** The first page of a PDF carrying a line that starts with `marker`. */
export function findPage(pdf, marker, from = 1, to = 30) {
  if (!pdf || !fs.existsSync(pdf)) return null;
  let text;
  try {
    text = execFileSync('pdftotext', ['-layout', '-f', String(from), '-l', String(to), pdf, '-'],
      { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const pages = text.split('\f');
  for (const [i, page] of pages.entries()) {
    if (page.split('\n').some((l) => marker.test(l.trim()))) return from + i;
  }
  return null;
}

function officialPdf(man, paperId, kind) {
  const m = /^tmua_(\d{4}|prac|spec)_p([12])$/.exec(paperId ?? '');
  if (!m) return null;
  const s = m[1] === 'prac' ? man.tmua_practice : m[1] === 'spec' ? man.tmua_specimen : man.tmua?.[m[1]];
  return s ? (kind === 'qp' ? s[`p${m[2]}`] : s[`p${m[2]}_solutions`]) ?? null : null;
}

/** Does this item match the stated filter? Any signal counts, as with mutant papers. */
export function matches(row, { topics = [], types = [], techniques = [], traps = [] }) {
  const t = new Set([...(row.tag?.topic ?? []), row.topic].filter(Boolean));
  const tech = new Set([...(row.tag?.technique ?? []), ...(row.insight?.technique ?? [])]);
  const trap = new Set([...(row.tag?.trap_type ?? []), ...(row.insight?.trap ?? [])]);
  return topics.some((x) => t.has(x))
    || (row.question_type && types.includes(row.question_type))
    || techniques.some((x) => tech.has(x))
    || traps.some((x) => trap.has(x));
}

/**
 * How overdue and how unearned, highest first — the order the top-up draws in.
 * An item never reworked outranks one he has at least attempted again.
 */
export function priority(row, today = new Date().toISOString().slice(0, 10)) {
  const overdue = row.due && row.due <= today ? Math.min(30, daysBetween(row.due, today)) : 0;
  return overdue
    + (row.history?.length ? 0 : 25)
    + (row.bucket === 'didnt_know' ? 15 : row.bucket === 'timing' ? 8 : 0)
    + (row.insight?.difficulty ?? 3) * 2
    + ({ 1: 6, 7: 3, 21: 0 })[row.tier] ?? 0;
}
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/**
 * Pick the questions: everything matching the filter, then top up by priority to `size`.
 * `size` is a floor, not a cap — when he asks for "everything" of a kind, the paper is as
 * long as that kind is.
 */
export function select(rows, filter, { size = 20, includeAll = [] } = {}) {
  const chosen = new Map();
  for (const r of rows) {
    if (matches(r, filter) || includeAll.includes(r.exam)) chosen.set(r.id, r);
  }
  const rest = rows.filter((r) => !chosen.has(r.id)).sort((a, b) => priority(b) - priority(a));
  for (const r of rest) {
    if (chosen.size >= size) break;
    chosen.set(r.id, r);
  }
  return [...chosen.values()];
}

/** The paper a row came from: its ref without the trailing question number. */
const sourceOf = (r) => String(r?.ref ?? r ?? '').replace(/\s*Q\s*\d+\s*$/, '').trim();

/**
 * Deterministic shuffle: a paper must not be sorted by topic, and must rebuild the same.
 *
 * A plain shuffle only scatters by luck. With a backlog heavy in one paper (eight open
 * Heracles S1 P2 questions, say) it happily deals four in a row, and a run from one
 * source hands him the topic for free. So the shuffled rows are then interleaved by
 * paper — still deterministic, and still shuffled within each paper.
 */
export function shuffle(arr, seed = 1, key = sourceOf) {
  let s = seed >>> 0 || 1;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  // Interleave: deal from whichever paper has the most left (ties to whichever comes
  // first in the shuffle), but never a third in a row while another paper still has
  // some. Each paper's own questions keep their shuffled order.
  const queues = new Map();
  for (const x of a) { const k = key(x); if (!queues.has(k)) queues.set(k, []); queues.get(k).push(x); }
  const out = [];
  let last = null, run = 0;
  while (out.length < a.length) {
    const live = [...queues.entries()].filter(([, q]) => q.length);
    live.sort((x, y) => y[1].length - x[1].length || a.indexOf(x[1][0]) - a.indexOf(y[1][0]));
    const pick = live.find(([k]) => !(k === last && run >= 2)) ?? live[0];
    const [k, q] = pick;
    out.push(q.shift());
    run = k === last ? run + 1 : 1;
    last = k;
  }
  return out;
}

/**
 * The vertical slice of one question on a page, as fractions of page height.
 *
 * Returns null when the question owns the whole page, which is the common case and the one
 * that needs no cropping. The bbox layer is the only thing that knows where a MAT part
 * starts; poppler aborts on a few files, and a null here correctly means "print the page".
 */
export function sliceFor(pdf, page, marker, nextMarker, { pad = 0.012 } = {}) {
  let xml;
  try {
    xml = execFileSync('pdftotext', ['-bbox-layout', '-f', String(page), '-l', String(page), pdf, '-'],
      { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const dims = /<page width="([\d.]+)" height="([\d.]+)"/.exec(xml);
  if (!dims) return null;
  const height = Number(dims[2]);

  const lines = [];
  for (const m of xml.matchAll(/<line xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
    lines.push({ y: Number(m[1]), yEnd: Number(m[2]), text: m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  const start = lines.find((l) => marker.test(l.text));
  if (!start) return null;
  const after = lines.filter((l) => l.y > start.y + 1 && nextMarker.test(l.text));
  const first = lines.find((l) => l.text);
  // The LOWEST line, not the last in document order: poppler can emit a footer or a
  // late-drawn label before body text that sits further down, and the last-emitted line then
  // puts the bottom of the crop above its top (MAT 2011 H).
  const last = lines.filter((l) => l.text).reduce((a, b) => (b.yEnd > (a?.yEnd ?? -1) ? b : a), null);
  // Whole page: the question is the only thing on it.
  if (!after.length && start.y <= (first?.y ?? 0) + 2) return null;
  const top = Math.max(0, start.y / height - pad);
  // Where another question follows, cut ABOVE its first line rather than below it: padding
  // downwards leaks the next question's opening line onto the page, which on a retry paper
  // is both untidy and a small spoiler for a question further down the same paper.
  const bottom = after.length
    ? Math.max(top + 0.05, after[0].y / height - pad / 2)
    : Math.min(1, (last?.yEnd ?? height) / height + pad);
  if (bottom - top > 0.94) return null;
  return [Number(top.toFixed(4)), Number(bottom.toFixed(4))];
}

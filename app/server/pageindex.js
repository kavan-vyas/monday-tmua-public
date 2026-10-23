// Which page a question is on — looked up, not searched for.
//
// /api/question-page used to answer this by scanning the PDF's text on every click and
// guessing from what it found. The guess is good on a paper that starts each question at
// the top of a page and bad on everything else, and there was exactly one fast path,
// written for a collection that no longer exists. So "open paper" sometimes landed in
// whitespace two questions further on, which is precisely the complaint.
//
// scripts/build-page-index.mjs works the answer out once per paper — from the hand
// transcription where there is one, the answer key's solution pages for a mark scheme, the
// paper's own numbering otherwise, and OCR for the few whose text layer is unusable — and
// writes it to tutor_data/exams/pageindex/<paper_id>.json. This reads that.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA } from './paths.js';
import { PAPERS } from './papers.js';
import { canonicalId } from './canonical.js';

const DIR = path.join(TUTOR_DATA, 'exams', 'pageindex');

// Cached by mtime: the index is rebuilt by a script, so the server must notice a rebuild
// without a restart, and must not re-read a 20KB file on every click either.
const cache = new Map();

function load(paperId) {
  const abs = path.join(DIR, `${paperId}.json`);
  let stat;
  try { stat = fs.statSync(abs); } catch { return null; }
  const hit = cache.get(paperId);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.data;
  try {
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    cache.set(paperId, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return null;
  }
}

/**
 * Canonical id → the paper id its index is filed under, plus the question number.
 *
 * Registry papers own a cidPrefix ("HER-1-P1"), so the match is exact. The official papers
 * are not in the registry — they live in the manifest — and their canonical ids carry the
 * year, so they map by shape.
 */
export function locate(canon) {
  const m = /^(.*)-Q(\d{1,2})$/.exec(String(canon ?? ''));
  if (!m) return null;
  const [, prefix, num] = m;
  const qnum = Number(num);
  if (!Number.isInteger(qnum) || qnum < 1) return null;

  const row = PAPERS.find((r) => r.cidPrefix === prefix);
  if (row) return { paperId: row.id, qnum };

  const official = /^TMUA-(\d{4}|PRAC|SPEC)-P([12])$/.exec(prefix);
  if (official) {
    const which = official[1] === 'PRAC' ? 'prac' : official[1] === 'SPEC' ? 'spec' : official[1];
    return { paperId: `tmua_${which.toLowerCase()}_p${official[2]}`, qnum };
  }
  return null;   // MAT is lettered, not numbered; the text search still owns it
}

/**
 * The page for a question, or null when nothing is known — in which case the caller falls
 * back to searching, exactly as before.
 *
 * @param {string} ref   a human or index reference: "2018 P2 Q10", "Heracles S1 P1 Q7"
 * @param {string} exam  the exam field from the backlog row, used to disambiguate
 * @param {'qp'|'ms'} kind
 */
export function pageFor(ref, exam, kind = 'qp') {
  const found = locate(canonicalId(exam, ref));
  if (!found) return null;
  const idx = load(found.paperId);
  if (!idx) return null;
  const table = kind === 'ms' ? idx.ms : idx.qp;
  const page = Number(table?.[found.qnum] ?? table?.[String(found.qnum)]);
  if (!Number.isFinite(page) || page < 1) return null;
  return { page, source: `index:${idx.source?.[kind] ?? 'unknown'}`, paperId: found.paperId, qnum: found.qnum };
}

/** For diagnostics: how much of the registry has an index, and where it came from. */
export function coverage() {
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  return files.map((f) => {
    const d = load(f.replace(/\.json$/, '')) ?? {};
    return {
      paper_id: d.paper_id ?? f,
      qp: Object.keys(d.qp ?? {}).length,
      ms: Object.keys(d.ms ?? {}).length,
      source: d.source ?? {},
    };
  });
}

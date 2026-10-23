// Access layer for the full MAT/TMUA classification index in tutor_data/reference/.
// 540 questions: MAT Q1 A-J 2007-2022 + 2 specimens, TMUA P1+P2 2016-2022 + practice
// + specimen. Built by tutor_data/reference/merge_shards.py; see the README there.
//
// This is the only reader of those indexes. It also serves the topic/description lookup
// the dashboard used to get from the old mat_q1_tag_index.json, which it supersedes.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA } from './paths.js';
import { canonicalFromIndexId } from './canonical.js';
import { PAPERS } from './papers.js';

const REF = path.join(TUTOR_DATA, 'reference');
const FILES = {
  MAT: path.join(REF, 'mat_full_tag_index.json'),
  TMUA: path.join(REF, 'tmua_full_tag_index.json'),
  // Unofficial mocks (Tyler, James Chen, Rosie, Asher Falcon, JZ) — a separate index, NEVER
  // merged into the official ones, so official coverage/accuracy stats stay clean.
  // Queryable by their own exam families: TYLER_P1/P2, JC_P1/P2 (James Chen), ROSIE_P1,
  // AF_P1, JZ_P1/P2.
  MOCK: path.join(REF, 'mock_tag_index.json'),
};
const MANIFEST = path.join(TUTOR_DATA, 'file_manifest.json');

const cache = new Map(); // abs path -> { mtimeMs, data }

function load(abs, fallback) {
  try {
    const { mtimeMs } = fs.statSync(abs);
    const hit = cache.get(abs);
    if (hit && hit.mtimeMs === mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
    cache.set(abs, { mtimeMs, data });
    return data;
  } catch {
    return fallback;
  }
}

/** Every question across both families, flat. */
export function allQuestions() {
  return [
    ...(load(FILES.MAT, { questions: [] }).questions ?? []),
    ...(load(FILES.TMUA, { questions: [] }).questions ?? []),
    ...(load(FILES.MOCK, { questions: [] }).questions ?? []),
  ];
}

export function getQuestion(id) {
  const norm = (s) => String(s).toUpperCase().replace(/[\s_-]/g, '');
  const want = norm(id);
  return allQuestions().find((q) => norm(q.id) === want) ?? null;
}

const has = (arr, v) => Array.isArray(arr) && arr.some((x) => x.toLowerCase() === v);

/**
 * Filter the index. Every filter is optional; list filters match if the question
 * carries the tag. Returns { total, questions } — total is the match count before
 * the limit, so the caller can say "showing 15 of 63".
 */
/**
 * The tag-index entry for a canonical id, shaped for storage on a backlog item.
 *
 * The backlog carries a copy rather than a pointer because `budgetFor` and the trap
 * roll-up read `item.insight` on every pass and must not depend on the index being
 * loadable. Items created before this existed were backfilled by hand; addItem now
 * attaches it at creation so the two cannot drift apart again.
 */
export function insightForCanonical(cid) {
  if (!cid) return null;
  const q = allQuestions().find((x) => canonicalFromIndexId(x.id) === cid);
  if (!q) return null;
  return {
    id: q.id,
    technique: q.technique ?? [],
    trap: q.trap_type ?? [],
    difficulty: q.difficulty ?? null,
    description: q.description ?? '',
    cross_links: q.cross_links ?? [],
    verified: q.verification_status ?? null,
  };
}

export function queryIndex(f = {}) {
  const {
    family, topic, technique, trap, skill, question_type, paper_section,
    year, difficulty_min, difficulty_max, verified_only, limit = 20,
  } = f;
  const lc = (v) => (v == null ? null : String(v).toLowerCase());
  const [t, tech, tr, sk, qt, sec] =
    [topic, technique, trap, skill, question_type, paper_section].map(lc);
  const fam = lc(family);

  const hits = allQuestions().filter((q) => {
    // Defensive: a question with no exam_family simply never matches a family filter,
    // rather than throwing and taking the whole query down with it.
    if (fam && !String(q.exam_family ?? '').toLowerCase().startsWith(fam)) return false;
    if (t && !has(q.topic, t)) return false;
    if (tech && !has(q.technique, tech)) return false;
    if (tr && !has(q.trap_type, tr)) return false;
    if (sk && !has(q.cognitive_skill, sk)) return false;
    if (qt && lc(q.question_type) !== qt) return false;
    if (sec && lc(q.paper_section) !== sec) return false;
    if (year != null && String(q.year) !== String(year)) return false;
    if (difficulty_min != null && q.difficulty < difficulty_min) return false;
    if (difficulty_max != null && q.difficulty > difficulty_max) return false;
    if (verified_only && q.verification_status !== 'mark_scheme_read') return false;
    return true;
  });
  return { total: hits.length, questions: hits.slice(0, limit) };
}

/**
 * A drill set around one question: the stored cross_links (same technique AND same
 * trap) first, then, if those run short, questions sharing any technique, ranked by
 * overlap. Excludes the seed question.
 */
export function drillSet(id, size = 6) {
  const seed = getQuestion(id);
  if (!seed) return null;
  const all = allQuestions();
  const byId = new Map(all.map((q) => [q.id, q]));
  const out = [];
  const push = (q) => {
    if (q && q.id !== seed.id && !out.some((o) => o.id === q.id)) out.push(q);
  };

  for (const linked of seed.cross_links ?? []) push(byId.get(linked));

  if (out.length < size) {
    const tech = new Set(seed.technique ?? []);
    const trap = new Set(seed.trap_type ?? []);
    const scored = all
      .filter((q) => q.id !== seed.id && !out.some((o) => o.id === q.id))
      .map((q) => ({
        q,
        score: (q.technique ?? []).filter((x) => tech.has(x)).length +
               2 * (q.trap_type ?? []).filter((x) => trap.has(x)).length,
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.q.id.localeCompare(b.q.id));
    for (const s of scored) { if (out.length >= size) break; push(s.q); }
  }
  return { seed, drill: out.slice(0, size) };
}

/** Tag frequency tables, for "what should I drill next" style questions. */
export function indexStats(family) {
  const { questions } = queryIndex({ family, limit: Infinity });
  const tally = (key) => {
    const c = new Map();
    for (const q of questions) {
      for (const v of Array.isArray(q[key]) ? q[key] : [q[key]]) {
        if (v == null) continue;
        c.set(v, (c.get(v) ?? 0) + 1);
      }
    }
    return [...c.entries()].sort((a, b) => b[1] - a[1]);
  };
  return {
    count: questions.length,
    topic: tally('topic'),
    technique: tally('technique'),
    trap_type: tally('trap_type'),
    cognitive_skill: tally('cognitive_skill'),
    question_type: tally('question_type'),
    difficulty: tally('difficulty').sort((a, b) => a[0] - b[0]),
  };
}

/**
 * Where a question actually lives on disk: its paper PDF and, when one exists, its
 * solutions PDF. Lets the tutor go straight from a tag-index hit to find_in_pdf /
 * show_pdf without guessing paths.
 */
export function resolvePaths(id) {
  const q = getQuestion(id);
  if (!q) return null;
  const m = load(MANIFEST, {});
  let paper = null, solutions = null, label = null;

  // Simulator papers (JZ, James Chen) live in the registry, not the manifest: their PDFs
  // are named by a rule, not registered one by one. Without this branch every one of them
  // fell through to the official-TMUA branch below, looked itself up by a year it does not
  // have, and returned a null paper with a label like "TMUA undefined P1".
  const row = PAPERS.find((r) => r.family === q.exam_family
    && (r.set == null || q.set == null || String(r.set) === String(q.set)));
  if (row) {
    return {
      question: q,
      label: row.title,
      paper: row.qp,
      solutions: row.ms,
      search_label: String(q.qnum ?? q.part ?? ''),
    };
  }

  if (q.exam_family === 'MAT') {
    if (q.paper === 'MAT_specimen') {
      const key = q.id.startsWith('MATSPEC1') ? 'specimen_1' : 'specimen_2';
      const e = m.mat_specimen?.[key] ?? {};
      paper = e.paper; solutions = e.solutions; label = `MAT ${key}`;
    } else {
      const e = m.mat?.[String(q.year)] ?? {};
      paper = e.paper; solutions = e.solutions; label = `MAT ${q.year}`;
    }
  } else {
    const p = q.exam_family === 'TMUA_P1' ? 'p1' : 'p2';
    let e = {};
    if (q.id.startsWith('TMUAPRAC')) { e = m.tmua_practice ?? {}; label = 'TMUA practice'; }
    else if (q.id.startsWith('TMUASPEC')) { e = m.tmua_specimen ?? {}; label = 'TMUA specimen'; }
    else { e = m.tmua?.[String(q.year)] ?? {}; label = `TMUA ${q.year}`; }
    paper = e[p]; solutions = e[`${p}_solutions`] ?? null;
    label += ` ${p.toUpperCase()}`;
  }
  // find_in_pdf needs the label form the paper actually prints: "H." for MAT parts,
  // the bare number for TMUA questions.
  const search = q.exam_family === 'MAT' ? `${q.part}.` : String(q.part);
  return { question: q, label, paper: paper ?? null, solutions: solutions ?? null, search_label: search };
}

/**
 * Compat shim for the dashboard, which wants {topic, description} for a MAT Q1 part.
 * Replaces the retired tutor_data/mat_q1_tag_index.json.
 */
export function matQ1Tag(year, part) {
  const q = getQuestion(`MAT${year}${part}`);
  if (!q) return null;
  return { topic: q.topic?.[0] ?? null, description: q.description ?? null };
}

// ---------- compact renderings for the model ----------

export function formatQuestion(q, { full = false } = {}) {
  const base = `${q.id} [d${q.difficulty}] ${q.topic.join('/')} — ${q.description}`;
  if (!full) return base;
  return [
    base,
    `  technique: ${q.technique.join(', ')}`,
    `  skills: ${q.cognitive_skill.join(', ')}`,
    `  traps: ${q.trap_type.length ? q.trap_type.join(', ') : '(none tagged)'}`,
    `  type: ${q.question_type}${q.paper_section ? ` · ${q.paper_section}` : ''} · ${q.verification_status}`,
    q.cross_links?.length ? `  similar: ${q.cross_links.join(', ')}` : null,
  ].filter(Boolean).join('\n');
}

export function formatList(res, header) {
  if (!res.total) return `${header}\nNo questions match.`;
  const shown = res.questions.map((q) => formatQuestion(q)).join('\n');
  const more = res.total > res.questions.length
    ? `\n(showing ${res.questions.length} of ${res.total} — narrow the filters or raise limit)` : '';
  return `${header}\n${shown}${more}`;
}

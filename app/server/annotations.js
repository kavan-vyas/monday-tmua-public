// Annotation storage for the PDF pane.
//
// THE TWO THINGS THAT MUST BE RIGHT
//
// 1. COORDINATES ARE PDF USER SPACE — points, origin bottom-left, y increasing
//    upwards. Never screen pixels. Marks then survive zoom, window resize, DPR
//    changes and re-rendering, and "top third of the page" is a statement that can be
//    computed rather than guessed. The client converts before it posts; nothing in
//    here ever sees a pixel.
//
// 2. THE KEY COMES FROM THE MANIFEST, NOT THE PATH. tutor_data/file_manifest.json
//    maps {exam, year, role} -> absolute path, and Monday re-files papers routinely.
//    A path-derived key would orphan every annotation on a paper the moment it moved.
//    So the key is the manifest POSITION of the file ("tmua/2019/p1"), and a PDF the
//    manifest has never heard of falls back to a hash of its path ("path/<sha1>").
//
// Writes go through writeJsonAtomic (tmp + rename, the same idiom as mondaymem.js) so
// a crash — or the server being killed mid-stroke — can never leave a half file.
// Deliberately NOT routed through /api/save, which is non-atomic, refuses anything
// that is not .md/.json/.txt, and bypasses the model write guard entirely.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TUTOR_DATA } from './paths.js';

export const SCHEMA_VERSION = 1;

export const ANNOTATIONS_DIR = path.join(TUTOR_DATA, 'annotations');
const MANIFEST = path.join(TUTOR_DATA, 'file_manifest.json');

/** Every mark type the store understands. */
export const MARK_TYPES = ['ink', 'highlight', 'freetext', 'arrow'];

/** Monday's marks are a different colour from the student's, always. */
export const MONDAY_COLOR = '#e0533d';
export const STUDENT_COLOR = '#1b6ef3';

// A4 in points. Only used to describe a region when the client has not told us the
// real page size; every such description says so rather than pretending.
const A4 = [595.28, 841.89];

// ------------------------------------------------------------------ low level io

function readJson(abs, fallback) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return fallback; }
}

/** Write via a temp file + rename, so a crash mid-write cannot leave a half file. */
export function writeJsonAtomic(abs, obj) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, abs);
}

// ------------------------------------------------------------------ the key

const manifestCache = { mtimeMs: -1, byPath: new Map(), byKey: new Map() };

/**
 * Walk the manifest and index every absolute PDF path it names, remembering WHERE in
 * the manifest it was found. The manifest is a tree of plain objects whose leaves are
 * paths, so the position is just the chain of keys: mat/2016/paper, tmua/2019/p1,
 * tmua/2019/p1_solutions, tmua_specimen/p2, mat_specimen/specimen_1/paper.
 */
function manifestIndex() {
  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(MANIFEST).mtimeMs; } catch { /* no manifest yet */ }
  if (mtimeMs === manifestCache.mtimeMs) return manifestCache;

  const byPath = new Map();
  const byKey = new Map();
  const m = readJson(MANIFEST, {});
  const walk = (node, trail) => {
    if (typeof node === 'string') {
      if (!/\.pdf$/i.test(node)) return;
      const key = trail.join('/');
      // First position wins, so a paper listed twice keeps one stable key.
      if (!byPath.has(node)) byPath.set(node, key);
      if (!byKey.has(key)) byKey.set(key, node);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) walk(v, [...trail, k]);
  };
  for (const [k, v] of Object.entries(m)) {
    if (k === 'generated' || k === 'base_dir') continue;
    walk(v, [k]);
  }

  manifestCache.mtimeMs = mtimeMs;
  manifestCache.byPath = byPath;
  manifestCache.byKey = byKey;
  return manifestCache;
}

const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/**
 * The storage key for a PDF.
 * @param {string} absPath absolute path to the PDF
 * @returns {{key:string, source:'manifest'|'path'}}
 */
export function keyForPath(absPath) {
  const abs = path.resolve(absPath);
  const { byPath } = manifestIndex();
  const hit = byPath.get(abs);
  if (hit) return { key: hit, source: 'manifest' };
  return { key: `path/${hashOf(abs)}`, source: 'path' };
}

/** The path the manifest currently gives for a key, or null. */
export function pathForKey(key) {
  return manifestIndex().byKey.get(String(key)) ?? null;
}

/** Where a key's document lives on disk. Slashes flatten so it stays one directory. */
export function fileForKey(key) {
  const safe = String(key).replace(/\//g, '__').replace(/[^\w.@-]/g, '_');
  return path.join(ANNOTATIONS_DIR, `${safe}.json`);
}

// ------------------------------------------------------------------ documents

function emptyDoc(key, sourcePath) {
  return {
    schema_version: SCHEMA_VERSION,
    key,
    source_path: sourcePath ?? null,
    updated_at: null,
    page_sizes: {},   // "7": [width, height] in points, when the client knows them
    pages: {},        // "7": [ mark, ... ]
  };
}

function normaliseDoc(doc, key, sourcePath) {
  if (!doc || typeof doc !== 'object') return emptyDoc(key, sourcePath);
  const out = { ...emptyDoc(key, sourcePath), ...doc };
  out.schema_version = SCHEMA_VERSION;
  out.key = key;
  // The manifest is authoritative for where the paper is NOW. A stale source_path
  // recorded before a re-file must not be believed.
  if (sourcePath) out.source_path = sourcePath;
  if (!out.pages || typeof out.pages !== 'object' || Array.isArray(out.pages)) out.pages = {};
  if (!out.page_sizes || typeof out.page_sizes !== 'object' || Array.isArray(out.page_sizes)) out.page_sizes = {};
  for (const [p, marks] of Object.entries(out.pages)) {
    if (!Array.isArray(marks)) delete out.pages[p];
  }
  return out;
}

/**
 * Read the document for a PDF. Always returns a well-formed doc, empty if there is
 * nothing on disk (or if what is on disk is unreadable — a corrupt file must not take
 * the pane down mid-session).
 */
export function readDoc(absPath) {
  const abs = path.resolve(absPath);
  const { key } = keyForPath(abs);
  return normaliseDoc(readJson(fileForKey(key), null), key, abs);
}

/** Same, addressed by key rather than by path. */
export function readDocByKey(key) {
  return normaliseDoc(readJson(fileForKey(key), null), key, pathForKey(key));
}

/** Persist a doc. Idempotent: an unchanged document is not rewritten. */
export function saveDoc(doc) {
  const file = fileForKey(doc.key);
  const next = { ...doc, updated_at: doc.updated_at ?? new Date().toISOString() };
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  // Compare with updated_at held level, so "same marks" really means "no write".
  const cmp = (s) => {
    try { const o = JSON.parse(s); delete o.updated_at; return JSON.stringify(o); } catch { return null; }
  };
  const candidate = { ...next };
  delete candidate.updated_at;
  if (before != null && cmp(before) === JSON.stringify(candidate)) {
    return { changed: false, file, doc: normaliseDoc(JSON.parse(before), doc.key, doc.source_path) };
  }
  next.updated_at = new Date().toISOString();
  writeJsonAtomic(file, next);
  return { changed: true, file, doc: next };
}

// ------------------------------------------------------------------ marks

let seq = 0;
const newId = () => `a${Date.now().toString(36)}${(seq++).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pointList = (v) =>
  Array.isArray(v)
    ? v.map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : null))
       .filter((p) => p && p[0] != null && p[1] != null)
    : [];

/** Bounding box of a list of [x,y] points, in the same space as the points. */
export function bboxOf(points) {
  const pts = pointList(points);
  if (!pts.length) return null;
  let [x0, y0] = pts[0];
  let [x1, y1] = pts[0];
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/**
 * Coerce whatever the client (or Monday) sent into a storable mark. Returns null for
 * anything unrecognisable rather than storing junk that a later reader has to guess at.
 */
export function normaliseMark(raw, { author = 'student', color = null } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const type = String(raw.type ?? '').toLowerCase();
  if (!MARK_TYPES.includes(type)) return null;

  const m = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    type,
    author: String(raw.author ?? author) === 'monday' ? 'monday' : String(raw.author ?? author),
    color: raw.color ?? color ?? (String(raw.author ?? author) === 'monday' ? MONDAY_COLOR : STUDENT_COLOR),
    ts: num(raw.ts) ?? Date.now(),
  };
  if (raw.note != null) m.note = String(raw.note);

  if (type === 'ink') {
    m.paths = pointList(raw.paths);
    if (!m.paths.length) return null;
    m.width = num(raw.width) ?? 1.6;
    m.bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : bboxOf(m.paths);
  } else if (type === 'highlight') {
    // quads are [x0,y0,x1,y1] rectangles in user space, one per text run.
    m.quads = Array.isArray(raw.quads)
      ? raw.quads.filter((q) => Array.isArray(q) && q.length === 4 && q.every((n) => num(n) != null)).map((q) => q.map(Number))
      : [];
    if (raw.text != null) m.text = String(raw.text);
    const corners = m.quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]]]);
    m.bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : bboxOf(corners);
    if (!m.quads.length && !m.bbox) return null;
  } else if (type === 'arrow') {
    const from = Array.isArray(raw.from) ? [num(raw.from[0]), num(raw.from[1])] : null;
    const to = Array.isArray(raw.to) ? [num(raw.to[0]), num(raw.to[1])] : null;
    if (!from || !to || from[0] == null || to[0] == null) return null;
    m.from = from;
    m.to = to;
    m.bbox = bboxOf([from, to]);
  } else if (type === 'freetext') {
    m.text = String(raw.text ?? '');
    if (!m.text) return null;
    m.bbox = Array.isArray(raw.bbox) && raw.bbox.length === 4 ? raw.bbox.map(Number) : null;
    if (Array.isArray(raw.at) && num(raw.at[0]) != null) m.at = [Number(raw.at[0]), Number(raw.at[1])];
    if (!m.bbox && m.at) m.bbox = [m.at[0], m.at[1], m.at[0], m.at[1]];
  }
  return m;
}

const pageKey = (p) => String(Math.trunc(Number(p)));

/**
 * Replace the marks in a document.
 *
 * scope 'author' (the default) replaces only the marks belonging to `author`, leaving
 * everyone else's alone. That is what makes the client's autosave safe: the student's
 * ~800 ms flush cannot wipe a mark Monday drew thirty seconds ago, and annotate_pdf
 * cannot wipe the student's working.
 *
 * scope 'all' replaces the page wholesale — the "this is now the entire truth" case.
 */
export function applyPages(doc, pages, { author = 'student', scope = 'author', pageSizes = null } = {}) {
  const out = { ...doc, pages: { ...doc.pages }, page_sizes: { ...doc.page_sizes } };
  if (pageSizes && typeof pageSizes === 'object') {
    for (const [p, size] of Object.entries(pageSizes)) {
      if (Array.isArray(size) && size.length === 2 && size.every((n) => num(n) != null)) {
        out.page_sizes[pageKey(p)] = size.map(Number);
      }
    }
  }
  for (const [rawPage, rawMarks] of Object.entries(pages ?? {})) {
    const p = pageKey(rawPage);
    if (!/^\d+$/.test(p) || Number(p) < 1) continue;
    const incoming = (Array.isArray(rawMarks) ? rawMarks : [])
      .map((m) => normaliseMark(m, { author }))
      .filter(Boolean);
    const kept = scope === 'all'
      ? []
      : (out.pages[p] ?? []).filter((m) => m.author !== author);
    const merged = [...kept, ...incoming].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    if (merged.length) out.pages[p] = merged;
    else delete out.pages[p];
  }
  return out;
}

/** Append marks to one page without touching anything already there. */
export function addMarks(doc, page, marks, { author = 'monday' } = {}) {
  const p = pageKey(page);
  const add = (Array.isArray(marks) ? marks : [])
    .map((m) => normaliseMark(m, { author, color: author === 'monday' ? MONDAY_COLOR : STUDENT_COLOR }))
    .filter(Boolean);
  const out = { ...doc, pages: { ...doc.pages } };
  out.pages[p] = [...(out.pages[p] ?? []), ...add];
  return { doc: out, added: add };
}

/**
 * Remove marks. Both filters are optional; `author` defaults to Monday's own marks,
 * because housekeeping should never quietly delete the student's working.
 */
export function clearMarks(doc, { page = null, author = 'monday' } = {}) {
  const out = { ...doc, pages: { ...doc.pages } };
  let removed = 0;
  const pagesToTouch = page == null ? Object.keys(out.pages) : [pageKey(page)];
  for (const p of pagesToTouch) {
    const before = out.pages[p] ?? [];
    if (!before.length) continue;
    const after = author == null ? [] : before.filter((m) => m.author !== author);
    removed += before.length - after.length;
    if (after.length) out.pages[p] = after;
    else delete out.pages[p];
  }
  return { doc: out, removed };
}

export function countMarks(doc) {
  return Object.values(doc.pages ?? {}).reduce((n, arr) => n + arr.length, 0);
}

// ------------------------------------------------------- rendering for the model

const third = (v) => (v < 1 / 3 ? 0 : v < 2 / 3 ? 1 : 2);
const ROW = ['top', 'middle', 'bottom'];
const COL = ['left', 'centre', 'right'];

/**
 * Where on the page a bbox sits, in words. PDF user space has y increasing UPWARDS,
 * so a high y is the TOP of the page — getting this backwards would have Monday
 * telling the student to look at the wrong end of the question.
 */
export function describeRegion(bbox, size) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return 'position unknown';
  const [w, h] = Array.isArray(size) && size.length === 2 ? size : A4;
  const cx = (bbox[0] + bbox[2]) / 2;
  const cy = (bbox[1] + bbox[3]) / 2;
  const row = ROW[third(1 - cy / h)];        // flip: user space y is bottom-up
  const col = COL[third(cx / w)];
  const spanW = Math.abs(bbox[2] - bbox[0]) / w;
  const spanH = Math.abs(bbox[3] - bbox[1]) / h;
  if (spanW > 0.7 && spanH > 0.5) return 'across most of the page';
  if (spanH > 0.45) return `down the ${col} of the page`;
  if (spanW > 0.6) return `across the ${row} of the page`;
  return `${row} ${col}`;
}

function describeMark(m, size) {
  const who = m.author === 'monday' ? 'you' : m.author;
  const where = describeRegion(m.bbox, size);
  switch (m.type) {
    case 'highlight':
      return m.text
        ? `highlight by ${who} (${where}) — "${m.text.trim().replace(/\s+/g, ' ')}"`
        : `highlight by ${who} (${where}) — no text captured${m.note ? ` — note: ${m.note}` : ''}`;
    case 'ink': {
      const pts = m.paths?.length ?? 0;
      const b = m.bbox ?? [0, 0, 0, 0];
      const dims = `${Math.round(Math.abs(b[2] - b[0]))}×${Math.round(Math.abs(b[3] - b[1]))} pt`;
      return `ink by ${who} (${where}, ${dims}, ${pts} points)${m.note ? ` — note: ${m.note}` : ''}`;
    }
    case 'arrow': {
      const to = describeRegion([m.to[0], m.to[1], m.to[0], m.to[1]], size);
      return `arrow by ${who} (${where}) pointing at ${to}${m.note ? ` — "${m.note}"` : ''}`;
    }
    case 'freetext':
      return `note by ${who} (${where}) — "${String(m.text ?? '').trim()}"`;
    default:
      return `${m.type} by ${who} (${where})`;
  }
}

/**
 * The document as something a language model can actually reason about.
 *
 * A raw polyline tells Monday nothing. "You highlighted 'for all real x' in the top
 * left" is a fact it can act on, and that is the whole point of storing the text layer
 * capture alongside the geometry.
 */
export function formatDoc(doc, { page = null, label = null } = {}) {
  const name = label ?? (doc.source_path ? path.basename(doc.source_path) : doc.key);
  const pages = Object.keys(doc.pages ?? {})
    .filter((p) => page == null || p === pageKey(page))
    .sort((a, b) => Number(a) - Number(b));
  const total = pages.reduce((n, p) => n + doc.pages[p].length, 0);

  if (!total) {
    return page == null
      ? `${name} — no annotations recorded (key ${doc.key}).`
      : `${name} page ${pageKey(page)} — no annotations on that page (key ${doc.key}).`;
  }

  const lines = [`${name} — ${total} mark${total === 1 ? '' : 's'} (key ${doc.key}).`];
  for (const p of pages) {
    const size = doc.page_sizes?.[p] ?? null;
    lines.push(`page ${p}${size ? '' : '  [page size not recorded — regions assume A4]'}:`);
    for (const m of doc.pages[p]) lines.push(`  - ${describeMark(m, size)}`);
  }
  const hl = pages.flatMap((p) => doc.pages[p]).filter((m) => m.type === 'highlight' && m.text);
  if (hl.length) {
    lines.push('', 'Text he highlighted, verbatim:');
    for (const m of hl) lines.push(`  · "${m.text.trim().replace(/\s+/g, ' ')}"`);
  }
  return lines.join('\n');
}

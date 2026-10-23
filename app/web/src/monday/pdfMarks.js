// Pure annotation logic — mark builders, the undo/redo ops, the autosave
// machinery. Deliberately imports nothing (no DOM, no pdf.js, no ?url worker
// resolution), so node's test runner can exercise it directly.
//
// All geometry is PDF user space: points, origin bottom-left, y increasing
// upwards — the one representation that survives zoom, resize and DPR changes.

// Duplicated from server/annotations.js (server modules aren't importable by
// Vite); the server re-asserts these defaults on every POST anyway.
export const MONDAY_COLOR = '#e0533d';
export const STUDENT_COLOR = '#1b6ef3';
export const HIGHLIGHT_COLOR = '#ffd400';

export const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const round2 = (n) => Math.round(n * 100) / 100;

export function bboxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (!Number.isFinite(x0)) return null;
  return [round2(x0), round2(y0), round2(x1), round2(y1)];
}

// ── mark builders ────────────────────────────────────────────────────────────
// Shapes match server/annotations.js normaliseMark exactly, so what we render
// locally is what reads back after a round-trip.

const base = (type, author, color) => ({ id: newId(), type, author, color, ts: Date.now() });

export function makeInk(paths, { width = 1.6, color = STUDENT_COLOR, author = 'student' } = {}) {
  const pts = paths.map(([x, y]) => [round2(x), round2(y)]);
  if (pts.length < 2) return null;
  return { ...base('ink', author, color), width: round2(width), paths: pts, bbox: bboxOf(pts) };
}

export function makeHighlight(quads, text, { color = HIGHLIGHT_COLOR, author = 'student' } = {}) {
  const qs = quads.map((q) => q.map(round2));
  if (!qs.length) return null;
  const corners = qs.flatMap((q) => [[q[0], q[1]], [q[2], q[3]]]);
  return { ...base('highlight', author, color), quads: qs, text: text ?? '', bbox: bboxOf(corners) };
}

export function makeArrow(from, to, { color = STUDENT_COLOR, author = 'student', note = null } = {}) {
  const f = [round2(from[0]), round2(from[1])];
  const t = [round2(to[0]), round2(to[1])];
  if (Math.hypot(t[0] - f[0], t[1] - f[1]) < 2) return null; // a click, not an arrow
  const m = { ...base('arrow', author, color), from: f, to: t, bbox: bboxOf([f, t]) };
  if (note) m.note = note;
  return m;
}

export function makeFreetext(at, text, wh, { color = STUDENT_COLOR, author = 'student' } = {}) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const a = [round2(at[0]), round2(at[1])];
  const [w, h] = wh ?? [0, 0];
  // `at` is the box's top-left in PDF space, so the box extends +x and −y.
  return { ...base('freetext', author, color), text: t, at: a, bbox: bboxOf([a, [a[0] + w, a[1] - h]]) };
}

// ── eraser hit-testing ───────────────────────────────────────────────────────
// Distance from a point to a mark, in PDF points. Unlike vertex-only distance,
// ink and arrows measure against their SEGMENTS — a fast pen stroke samples
// sparsely, and the eraser must still feel like it touches the line itself.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function segDist(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

export function markDistance(mark, x, y) {
  if (mark.type === 'ink' && mark.paths?.length) {
    if (mark.paths.length === 1) return Math.hypot(mark.paths[0][0] - x, mark.paths[0][1] - y);
    let best = Infinity;
    for (let i = 1; i < mark.paths.length; i++) {
      const [ax, ay] = mark.paths[i - 1];
      const [bx, by] = mark.paths[i];
      best = Math.min(best, segDist(x, y, ax, ay, bx, by));
    }
    return best;
  }
  if (mark.type === 'arrow' && mark.from && mark.to) {
    return segDist(x, y, mark.from[0], mark.from[1], mark.to[0], mark.to[1]);
  }
  const b = mark.bbox;
  if (!b) return Infinity;
  const [x0, y0, x1, y1] = b;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return 0;
  return Math.hypot(x - clamp(x, x0, x1), y - clamp(y, y0, y1));
}

// ── undo/redo ops ────────────────────────────────────────────────────────────
// One stack per document; every user action is an op, and undo applies the
// inverse. `pages` is the client's { "7": [marks] } map; ops never mutate it.

export function applyOp(pages, op) {
  const p = String(op.page);
  const cur = pages[p] ?? [];
  const next = { ...pages };
  if (op.op === 'add') next[p] = [...cur, op.mark];
  else next[p] = cur.filter((m) => m.id !== op.mark.id);
  if (!next[p].length) delete next[p];
  return next;
}

export const invertOp = (op) => ({ op: op.op === 'add' ? 'remove' : 'add', page: op.page, mark: op.mark });

// ── autosave ─────────────────────────────────────────────────────────────────

/** POST body for the dirty pages: this author's marks only (scope 'author' —
 *  the server merge that stops an autosave wiping a mark Monday just drew). */
export function buildSavePayload(path, pages, pageSizes, dirtyPages, author = 'student') {
  const out = { path, pages: {}, page_sizes: {}, author, scope: 'author' };
  for (const p of dirtyPages) {
    const k = String(p);
    out.pages[k] = (pages[k] ?? []).filter((m) => (m.author ?? author) === author);
    if (pageSizes[k]) out.page_sizes[k] = pageSizes[k];
  }
  return out;
}

/** Refetch merge: our own marks stay locally authoritative (there may be
 *  unsaved strokes), everyone else's come from the server. */
export function mergeServerPages(localPages, serverPages, author = 'student') {
  const out = {};
  const keys = new Set([...Object.keys(localPages), ...Object.keys(serverPages)]);
  for (const k of keys) {
    const mine = (localPages[k] ?? []).filter((m) => (m.author ?? author) === author);
    const theirs = (serverPages[k] ?? []).filter((m) => (m.author ?? author) !== author);
    const merged = [...theirs, ...mine].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    if (merged.length) out[k] = merged;
  }
  return out;
}

/**
 * Debounced autosave with a forced-flush path for unload.
 *  - markDirty(page): schedule a save ~`delay` ms out (restarts on new strokes).
 *  - flush(): synchronous best-effort send via `beacon` — for page change,
 *    unmount, blur, visibilitychange, beforeunload. Never a dialog.
 * A failed post re-dirties its pages and retries, so a killed server loses
 * nothing once it returns.
 */
export function makeAutosaver({ getPayload, post, beacon, delay = 800, onState = () => {} }) {
  const dirty = new Set();
  let timer = null;
  let disposed = false;

  const schedule = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  };

  function markDirty(page) {
    if (disposed) return;
    dirty.add(String(page));
    onState('dirty');
    schedule(delay);
  }

  async function run() {
    timer = null;
    if (!dirty.size) return;
    const pages = [...dirty];
    dirty.clear();
    onState('saving');
    try {
      await post(getPayload(pages));
      onState(dirty.size ? 'dirty' : 'saved');
      if (dirty.size && !timer) schedule(delay);
    } catch {
      for (const p of pages) dirty.add(p);
      onState('error');
      if (!disposed) schedule(delay * 4); // retry, backed off
    }
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty.size) return true;
    const pages = [...dirty];
    dirty.clear();
    const ok = beacon(getPayload(pages));
    if (!ok) { for (const p of pages) dirty.add(p); onState('error'); }
    else onState('saved');
    return ok;
  }

  function dispose() {
    disposed = true;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return { markDirty, flush, dispose, isDirty: () => dirty.size > 0 };
}

// ── scroll anchoring ────────────────────────────────────────────────────────
// A page's height is its width times its aspect ratio, so the instant the render
// width changes every page grows or shrinks while scrollTop stays the same number
// of pixels — and the paper slides under the reader. These two functions turn a
// pixel scroll position into a point in the DOCUMENT (which page, how far down it)
// and back again, so the same point can be put under the same part of the viewport
// once the new layout lands. Kept here, DOM-free, so the arithmetic is testable.

/**
 * Which page is under the viewport's centre, and how far down that page.
 * `pages` are {page, top, height} in any single consistent coordinate space;
 * `view` is {top, height} in the same space.
 */
export function anchorAt(pages, view) {
  const eye = view.top + view.height / 2;
  let best = null;
  let bestd = Infinity;
  for (const p of pages) {
    if (!p || !p.height) continue;
    const bottom = p.top + p.height;
    const d = eye < p.top ? p.top - eye : eye > bottom ? eye - bottom : 0;
    if (d < bestd) { bestd = d; best = { page: p.page, frac: (eye - p.top) / p.height }; }
    if (d === 0) break;
  }
  return best;
}

/**
 * How far to move the scroll so the anchored point sits back under the viewport
 * centre. `pageRect` is the anchored page's {top, height} AFTER the relayout, in the
 * same space as `view`.
 */
export function scrollDelta(anchor, pageRect, view) {
  if (!anchor || !pageRect || !pageRect.height) return 0;
  return (pageRect.top - view.top) + anchor.frac * pageRect.height - view.height / 2;
}

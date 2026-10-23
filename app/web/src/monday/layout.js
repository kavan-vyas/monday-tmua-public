// Column sizing for the tiling workspace. Pure, DOM-free, and therefore testable
// — the same split as pdfMarks.js.
//
// The bug this exists to prevent: `flex: <n> 1 0%` with a negative or non-finite
// n is INVALID CSS. The browser discards the entire declaration — React reports
// no inline style at all — and the column falls back to `flex: 0 1 auto`, which
// is content width. So one bad number stops a column growing and leaves the rest
// of the window blank, with nothing anywhere saying why. Measured on the real
// app: a stored size of -0.35 left 1225px of a 1600px window empty.

/** Smallest weight a column may hold. Small enough to feel collapsed, never 0. */
export const MIN_SIZE = 0.05;

/**
 * A column's flex weight, always a number CSS will accept.
 * Anything unusable — negative, zero, NaN, Infinity, null, a bad string —
 * becomes a sane weight rather than an invalid declaration.
 */
export function colSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(MIN_SIZE, n);
}

/** Repair a stored layout's sizes in place. Tabs and collapse state are his. */
export function healLayout(l) {
  if (!l?.columns?.length) return l;
  for (const c of l.columns) c.size = colSize(c.size);
  return l;
}

/**
 * The flex-grow each open column renders with, keyed by column id.
 *
 * Stored weights are only meaningful relative to each other, but CSS does not
 * treat them that way: when the flex-grow values of a row sum to LESS THAN 1,
 * the items take only that fraction of the free space and the rest is left
 * blank (CSS Flexbox §9.7). Closing a column takes its weight with it, so two
 * survivors at 0.20 + 0.55 filled three quarters of the window and left the
 * last quarter empty. Scaling the open columns to average 1 keeps every ratio
 * and guarantees the row is filled. Collapsed columns are fixed-width and get
 * no entry.
 *
 * @returns {Record<string, number>}
 */
export function growWeights(columns) {
  const open = (columns ?? []).filter((c) => !c.collapsed);
  const total = open.reduce((s, c) => s + colSize(c.size), 0);
  const out = {};
  for (const c of open) out[c.id] = (colSize(c.size) / total) * open.length;
  return out;
}

/**
 * Where a resizer drag leaves a neighbouring pair of columns.
 *
 * The pair's total is conserved, so clamping one end is the same as clamping the
 * drag. The version this replaces applied two `if`s in sequence, and when BOTH
 * ends wanted to go under the minimum the second subtracted from the first
 * again — driving it negative, which is the invalid weight above.
 *
 * @returns {[number, number]} the new left and right weights, both >= min
 */
export function clampPair(left0, right0, dw, total) {
  const pair = colSize(left0) + colSize(right0);
  const min = Math.min(total * 0.07, pair / 2);
  const nl = Math.max(min, Math.min(pair - min, colSize(left0) + dw));
  return [nl, pair - nl];
}

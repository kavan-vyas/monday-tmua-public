// pdf.js wiring + the annotation coordinate rules.
//
// Everything persisted is in PDF USER SPACE: points, origin bottom-left, exactly as
// the PDF itself measures. Screen pixels are a rendering detail that changes with
// zoom, window size and devicePixelRatio, so storing them would silently invalidate
// every mark the first time the pane is resized.
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Served from web/public/ — the static server refuses node_modules, so these are
// copied into the bundle output instead of resolved from the package.
const CMAP_URL = '/cmaps/';
const FONT_URL = '/standard_fonts/';

export function loadDocument(path) {
  return pdfjs.getDocument({
    url: `/api/raw?path=${encodeURIComponent(path)}`,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
  }).promise;
}

/** Cap the backing store so a 300% zoom on a big page cannot allocate a huge canvas. */
export function renderScale(zoom) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return { css: zoom, device: zoom * dpr, dpr };
}

// ── coordinate mapping ───────────────────────────────────────────────────────
// viewport.convertToPdfPoint is the only conversion that respects page rotation and
// a non-zero MediaBox origin, so both directions go through the viewport rather than
// through arithmetic on width/height.

export function toPdf(viewport, xCss, yCss) {
  const [x, y] = viewport.convertToPdfPoint(xCss, yCss);
  return [round2(x), round2(y)];
}

export function toCss(viewport, xPdf, yPdf) {
  const [x, y] = viewport.convertToViewportPoint(xPdf, yPdf);
  return [x, y];
}

const round2 = (n) => Math.round(n * 100) / 100;

export function bboxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [round2(x0), round2(y0), round2(x1), round2(y1)];
}

/**
 * Text under a dragged rectangle, in reading order.
 *
 * This is the field that makes annotations useful to Monday: an ink stroke is a
 * polyline it cannot interpret, but "you highlighted 'for all real x'" is a fact it
 * can reason about. Items are kept if their midpoint falls inside the rectangle,
 * which tolerates the loose rectangles people actually drag.
 */
export function textInRect(textContent, viewport, rectCss) {
  const [rx0, ry0, rx1, ry1] = normRect(rectCss);
  const hits = [];
  for (const item of textContent.items) {
    if (!item.str?.trim()) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const x = tx[4];
    const y = tx[5];
    const w = item.width * viewport.scale;
    const h = item.height * viewport.scale;
    const cx = x + w / 2;
    const cy = y - h / 2;
    if (cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1) hits.push({ x, y, str: item.str });
  }
  hits.sort((a, b) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x));
  return hits.map((h) => h.str).join(' ').replace(/\s+/g, ' ').trim();
}

export function normRect([x0, y0, x1, y1]) {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/** Distance from a point to a mark, in PDF points — used by the eraser. */
export function distanceTo(mark, x, y) {
  if (mark.type === 'ink') {
    let best = Infinity;
    for (const [px, py] of mark.paths ?? []) best = Math.min(best, Math.hypot(px - x, py - y));
    return best;
  }
  if (mark.type === 'arrow') {
    return Math.min(
      Math.hypot((mark.from?.[0] ?? 0) - x, (mark.from?.[1] ?? 0) - y),
      Math.hypot((mark.to?.[0] ?? 0) - x, (mark.to?.[1] ?? 0) - y),
    );
  }
  const b = mark.bbox;
  if (!b) return Infinity;
  const [x0, y0, x1, y1] = b;
  if (x >= x0 && x <= x1 && y >= y0 && y <= y1) return 0;
  return Math.hypot(x - clamp(x, x0, x1), y - clamp(y, y0, y1));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

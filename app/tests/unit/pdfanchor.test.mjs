// ACC-PDFA-01..05 — keeping the reader's place when the PDF pane rescales.
//
// The bug this pins: a page's height is its width times its aspect ratio, so any zoom
// step or pane resize changes every page's height while scrollTop stays the same number
// of pixels. Sitting on question 19, one zoom click landed you on question 12.
//
// The arithmetic lives in pdfMarks.js precisely so it can be checked here without a
// browser: lay pages out at one scale, anchor, lay them out again at another, apply the
// delta, and assert the same point in the document is back under the same pixel.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { anchorAt, scrollDelta } from '../../web/src/monday/pdfMarks.js';

const VIEW_H = 800;
const GAP = 16;

/** 20 letter-sized pages at a given render width, as client rects for a given scrollTop. */
function layout(cssW, scrollTop) {
  const h = cssW * (792 / 612);
  return Array.from({ length: 20 }, (_, i) => ({
    page: i + 1,
    top: i * (h + GAP) - scrollTop,   // client coords: viewport top is 0
    height: h,
  }));
}
const view = { top: 0, height: VIEW_H };
const topOfPage = (n, cssW) => (n - 1) * (cssW * (792 / 612) + GAP);

describe('pdf pane — scroll anchoring', () => {
  test('ACC-PDFA-01 the anchor names the page under the viewport centre', () => {
    const cssW = 600;
    // Put the middle of page 19 at the middle of the viewport.
    const scrollTop = topOfPage(19, cssW) + (cssW * 792 / 612) / 2 - VIEW_H / 2;
    const a = anchorAt(layout(cssW, scrollTop), view);
    assert.equal(a.page, 19);
    assert.ok(Math.abs(a.frac - 0.5) < 1e-9, `frac was ${a.frac}`);
  });

  test('ACC-PDFA-02 a zoom step keeps the same point under the viewport centre', () => {
    const before = 600;
    const after = 750;                       // one +25% step
    const scrollTop = topOfPage(19, before) + (before * 792 / 612) * 0.3 - VIEW_H / 2;
    const a = anchorAt(layout(before, scrollTop), view);
    assert.equal(a.page, 19);

    // Same scrollTop, pages now taller: this is the bug, and it is big.
    const naive = anchorAt(layout(after, scrollTop), view);
    assert.ok(naive.page <= 15, `unanchored, the centre drifts to page ${naive.page}`);

    // Apply the correction and the anchored point is back.
    const pageAfter = layout(after, scrollTop).find((p) => p.page === 19);
    const fixed = anchorAt(layout(after, scrollTop + scrollDelta(a, pageAfter, view)), view);
    assert.equal(fixed.page, 19);
    assert.ok(Math.abs(fixed.frac - a.frac) < 1e-6, `frac drifted to ${fixed.frac}`);
  });

  test('ACC-PDFA-03 it holds for zooming out too', () => {
    const before = 900;
    const after = 450;
    const scrollTop = topOfPage(7, before) + (before * 792 / 612) * 0.8 - VIEW_H / 2;
    const a = anchorAt(layout(before, scrollTop), view);
    const pageAfter = layout(after, scrollTop).find((p) => p.page === a.page);
    const fixed = anchorAt(layout(after, scrollTop + scrollDelta(a, pageAfter, view)), view);
    assert.equal(fixed.page, a.page);
    assert.ok(Math.abs(fixed.frac - a.frac) < 1e-6);
  });

  test('ACC-PDFA-04 a pane resize is the same problem and the same fix', () => {
    // No zoom click at all — just dragging the pane wider.
    const before = 520;
    const after = 880;
    const scrollTop = topOfPage(12, before) + (before * 792 / 612) * 0.25 - VIEW_H / 2;
    const a = anchorAt(layout(before, scrollTop), view);
    const pageAfter = layout(after, scrollTop).find((p) => p.page === a.page);
    const fixed = anchorAt(layout(after, scrollTop + scrollDelta(a, pageAfter, view)), view);
    assert.equal(fixed.page, 12);
    assert.ok(Math.abs(fixed.frac - a.frac) < 1e-6);
  });

  test('ACC-PDFA-05 it degrades quietly rather than throwing', () => {
    assert.equal(anchorAt([], view), null);
    assert.equal(anchorAt([{ page: 1, top: 0, height: 0 }], view), null, 'a page with no height is not an anchor');
    assert.equal(scrollDelta(null, { top: 0, height: 10 }, view), 0);
    assert.equal(scrollDelta({ page: 1, frac: 0.5 }, null, view), 0);
    // The gap between two pages still anchors, to the nearer of them.
    const pages = [{ page: 1, top: -900, height: 800 }, { page: 2, top: -84, height: 800 }];
    assert.equal(anchorAt(pages, view).page, 2);
  });
});

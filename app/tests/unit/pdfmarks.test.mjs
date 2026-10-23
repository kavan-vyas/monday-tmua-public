// PDF annotation client logic — web/src/monday/pdfMarks.js is a pure leaf
// module (no DOM, no bundler-only imports), so node exercises it directly.
// The coordinate round-trip uses the real pdf.js viewport (legacy build) over
// an in-memory two-page PDF — one portrait A4 page, one /Rotate 90 page —
// because rotation and MediaBox handling is exactly what hand-rolled
// width/height arithmetic gets wrong.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR } from '../helpers/sandbox.mjs';

const M = path.join(APP_DIR, 'web', 'src', 'monday');
let pm; // pdfMarks.js under test
let pdfjs;
before(async () => {
  pm = await import(pathToFileURL(path.join(M, 'pdfMarks.js')).href);
  pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
});

/** Smallest valid two-page PDF: A4 portrait + a rotated 500x400 page. */
function miniPdf() {
  const head = '%PDF-1.4\n';
  const bodies = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] >> endobj\n',
    '4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] /Rotate 90 >> endobj\n',
  ];
  let out = head;
  const offsets = [];
  for (const b of bodies) { offsets.push(out.length); out += b; }
  const xref = out.length;
  out += `xref\n0 5\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer << /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('coordinate round-trip — marks drawn at one zoom stay registered at another', () => {
  let pageA4;
  let pageRot;
  before(async () => {
    const doc = await pdfjs.getDocument({ data: miniPdf() }).promise;
    pageA4 = await doc.getPage(1);
    pageRot = await doc.getPage(2);
  });

  test('PDF-ANN-01 an ink path built at zoom 1.37 lands at the same page point at zoom 2.6', () => {
    const vpDraw = pageA4.getViewport({ scale: 1.37 });
    const vpView = pageA4.getViewport({ scale: 2.6 });
    const cssPts = [[100.4, 200.2], [150.9, 260.6], [201.3, 200.1]];
    const paths = cssPts.map(([x, y]) => {
      const [px, py] = vpDraw.convertToPdfPoint(x, y);
      return [Math.round(px * 100) / 100, Math.round(py * 100) / 100]; // client round2
    });
    const mark = pm.makeInk(paths, { width: 1.6 });
    assert.equal(mark.type, 'ink');
    mark.paths.forEach((p, i) => {
      const [vx, vy] = vpView.convertToViewportPoint(p[0], p[1]);
      // the same fraction of the page: css@2.6 = css@1.37 * (2.6/1.37)
      assert.ok(Math.abs(vx - cssPts[i][0] * (2.6 / 1.37)) < 0.05, `x drifted: ${vx}`);
      assert.ok(Math.abs(vy - cssPts[i][1] * (2.6 / 1.37)) < 0.05, `y drifted: ${vy}`);
    });
  });

  test('PDF-ANN-02 pdf-space y increases upwards (css top maps to page height)', () => {
    const vp = pageA4.getViewport({ scale: 2 });
    const [, top] = vp.convertToPdfPoint(0, 0);
    const [, bottom] = vp.convertToPdfPoint(0, vp.height);
    assert.ok(Math.abs(top - 841.89) < 0.01, `css top should be pdf y=841.89, got ${top}`);
    assert.ok(Math.abs(bottom) < 0.01, `css bottom should be pdf y=0, got ${bottom}`);
  });

  test('PDF-ANN-03 round-trip survives a /Rotate 90 page — viewport math, not width/height arithmetic', () => {
    const vpDraw = pageRot.getViewport({ scale: 1 });
    const vpView = pageRot.getViewport({ scale: 3 });
    // rotated: viewport is 400 wide x 500 tall
    assert.ok(Math.abs(vpDraw.width - 400) < 0.01 && Math.abs(vpDraw.height - 500) < 0.01, 'rotation applied');
    const cssPt = [120, 330];
    const pdfPt = vpDraw.convertToPdfPoint(...cssPt);
    const back = vpView.convertToViewportPoint(...pdfPt);
    assert.ok(Math.abs(back[0] - cssPt[0] * 3) < 0.01, `rotated x drifted: ${back[0]}`);
    assert.ok(Math.abs(back[1] - cssPt[1] * 3) < 0.01, `rotated y drifted: ${back[1]}`);
  });

  test('PDF-ANN-04 mark builders reject degenerate geometry the way the server would', () => {
    assert.equal(pm.makeInk([[10, 10]]), null, 'single-point ink');
    assert.equal(pm.makeArrow([50, 50], [51, 50]), null, 'a click is not an arrow');
    assert.equal(pm.makeFreetext([10, 10], '   ', [0, 0]), null, 'whitespace-only note');
    assert.equal(pm.makeHighlight([], 'text'), null, 'highlight with no quads');
    const hl = pm.makeHighlight([[90, 640, 300, 660]], 'for all real x');
    assert.deepEqual(hl.bbox, [90, 640, 300, 660]);
    assert.equal(hl.text, 'for all real x');
  });
});

describe('undo/redo ops', () => {
  test('PDF-ANN-05 add and its inverse restore the original pages map', () => {
    const mark = { id: 'a1', type: 'ink', author: 'student', paths: [[0, 0], [1, 1]] };
    const op = { op: 'add', page: 7, mark };
    const pages = pm.applyOp({}, op);
    assert.deepEqual(pages['7'], [mark]);
    const undone = pm.applyOp(pages, pm.invertOp(op));
    assert.deepEqual(undone, {}, 'page with no marks is dropped');
  });

  test('PDF-ANN-06 remove targets only the matching id and never mutates its input', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const pages = { 3: [a, b] };
    const next = pm.applyOp(pages, { op: 'remove', page: 3, mark: a });
    assert.deepEqual(next['3'], [b]);
    assert.deepEqual(pages['3'], [a, b], 'input untouched');
  });
});

describe('save payload + merge — author-scoped, so nobody wipes anybody', () => {
  const pages = {
    1: [
      { id: 'k1', type: 'ink', author: 'student', paths: [[0, 0], [1, 1]] },
      { id: 'm1', type: 'arrow', author: 'monday', from: [0, 0], to: [9, 9] },
    ],
    2: [{ id: 'k2', type: 'freetext', author: 'student', text: 'x', at: [5, 5] }],
  };

  test('PDF-ANN-07 payload carries only the student marks for the dirty pages, plus their sizes', () => {
    const p = pm.buildSavePayload('/a.pdf', pages, { 1: [595, 842], 2: [500, 400] }, ['1']);
    assert.equal(p.scope, 'author');
    assert.equal(p.author, 'student');
    assert.deepEqual(Object.keys(p.pages), ['1']);
    assert.deepEqual(p.pages['1'].map((m) => m.id), ['k1'], "monday's arrow must not ride along");
    assert.deepEqual(p.page_sizes, { 1: [595, 842] });
  });

  test('PDF-ANN-08 a page emptied by the eraser still posts, as an empty list', () => {
    const p = pm.buildSavePayload('/a.pdf', {}, {}, ['2']);
    assert.deepEqual(p.pages['2'], [], 'deletion must reach the server');
  });

  test('PDF-ANN-09 merge keeps local unsaved student marks and takes monday from the server', () => {
    const local = { 1: [{ id: 'k9', author: 'student', ts: 5 }] }; // unsaved yet
    const server = {
      1: [{ id: 'k1', author: 'student', ts: 1 }, { id: 'm2', author: 'monday', ts: 2 }],
      3: [{ id: 'm3', author: 'monday', ts: 3 }],
    };
    const merged = pm.mergeServerPages(local, server);
    assert.deepEqual(merged['1'].map((m) => m.id), ['m2', 'k9'], 'local student mark wins over stale server one; monday from server');
    assert.deepEqual(merged['3'].map((m) => m.id), ['m3'], 'monday-only pages appear');
  });
});

describe('eraser distance — segments, not just sampled vertices', () => {
  test('PDF-ANN-10 midpoint of a long ink segment is distance ~0', () => {
    const m = { type: 'ink', paths: [[0, 0], [100, 0]] };
    assert.ok(pm.markDistance(m, 50, 0.5) < 1, 'a fast stroke leaves sparse points; the line itself must be hittable');
    assert.ok(pm.markDistance(m, 50, 20) > 19, 'but not from far away');
  });

  test('PDF-ANN-11 arrow shaft is hittable along its length; bbox marks from inside', () => {
    const a = { type: 'arrow', from: [0, 0], to: [60, 80] };
    assert.ok(pm.markDistance(a, 30, 40) < 0.01, 'point on the shaft');
    const h = { type: 'highlight', bbox: [10, 10, 50, 30] };
    assert.equal(pm.markDistance(h, 20, 20), 0, 'inside the box');
    assert.ok(Math.abs(pm.markDistance(h, 60, 20) - 10) < 0.01, '10pt right of the box');
  });
});

describe('autosave — debounce, flush, failure recovery', () => {
  function harness(delay = 25) {
    const posts = [];
    const beacons = [];
    const states = [];
    let failNext = false;
    const saver = pm.makeAutosaver({
      getPayload: (dirtyPages) => ({ pages: [...dirtyPages].sort() }),
      post: async (payload) => {
        if (failNext) { failNext = false; throw new Error('down'); }
        posts.push(payload);
      },
      beacon: (payload) => { beacons.push(payload); return true; },
      delay,
      onState: (s) => states.push(s),
    });
    return { saver, posts, beacons, states, fail: () => { failNext = true; } };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  test('PDF-ANN-12 rapid strokes on two pages coalesce into one debounced post', async () => {
    const h = harness();
    h.saver.markDirty(1);
    h.saver.markDirty(2);
    h.saver.markDirty(1);
    assert.equal(h.posts.length, 0, 'nothing sent inside the debounce window');
    await sleep(70);
    assert.equal(h.posts.length, 1);
    assert.deepEqual(h.posts[0].pages, ['1', '2']);
    assert.equal(h.states.at(-1), 'saved');
    h.saver.dispose();
  });

  test('PDF-ANN-13 flush sends immediately via beacon and cancels the pending timer', async () => {
    const h = harness();
    h.saver.markDirty(4);
    assert.equal(h.saver.flush(), true);
    assert.deepEqual(h.beacons[0].pages, ['4']);
    await sleep(70);
    assert.equal(h.posts.length, 0, 'the debounced post must not fire after a flush');
    assert.equal(h.saver.flush(), true, 'flush with nothing dirty is a no-op');
    assert.equal(h.beacons.length, 1);
    h.saver.dispose();
  });

  test('PDF-ANN-14 a failed post re-dirties its pages and retries until the server is back', async () => {
    const h = harness(15);
    h.fail();
    h.saver.markDirty(6);
    await sleep(40);
    assert.equal(h.posts.length, 0, 'first attempt failed');
    assert.equal(h.saver.isDirty(), true, 'page 6 still owed');
    assert.equal(h.states.includes('error'), true);
    await sleep(80); // backed-off retry at delay*4
    assert.equal(h.posts.length, 1, 'retry landed');
    assert.deepEqual(h.posts[0].pages, ['6']);
    h.saver.dispose();
  });

  test('PDF-ANN-15 a stroke landing during an in-flight save is not lost', async () => {
    const h = harness(15);
    h.saver.markDirty(1);
    await sleep(40);
    h.saver.markDirty(2);
    await sleep(40);
    assert.equal(h.posts.length, 2);
    assert.deepEqual(h.posts[1].pages, ['2']);
    h.saver.dispose();
  });
});

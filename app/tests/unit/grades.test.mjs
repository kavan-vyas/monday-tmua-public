// GRADES-* — the private raw-mark → TMUA-grade converter (Monday's GradesTab).
//
// gradeTable.js is plain ESM (no JSX), so it is imported and exercised directly.
// GradesTab.jsx is checked at source level, same approach as ui.test.mjs uses for
// App.jsx: there is no DOM here and the brief forbids adding a test-renderer
// dependency, so "no fetch(" is a grep, not a render assertion.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR } from '../helpers/sandbox.mjs';

const M = path.join(APP_DIR, 'web', 'src', 'monday');
const read = (p) => fs.readFileSync(p, 'utf8');

let T;
before(async () => { T = await import(pathToFileURL(path.join(M, 'gradeTable.js')).href); });

describe('gradeTable.js — the table itself, verbatim', () => {
  test('GRADES-01 exports exactly 41 entries (marks 0 through 40)', () => {
    assert.equal(T.GRADE_TABLE.length, 41, 'GRADES-01 one row per mark, 0-40 inclusive');
  });

  test('GRADES-02 40, 39, 38 all read 9.0', () => {
    assert.equal(T.gradeForMark(40), '9.0', 'GRADES-02 mark 40');
    assert.equal(T.gradeForMark(39), '9.0', 'GRADES-02 mark 39');
    assert.equal(T.gradeForMark(38), '9.0', 'GRADES-02 mark 38');
  });

  test('GRADES-03 mark 20 reads 3.8–4.1', () => {
    assert.equal(T.gradeForMark(20), '3.8–4.1', 'GRADES-03');
  });

  test('GRADES-04 the 12/13 oddity is preserved verbatim: both read 2.0–2.2', () => {
    assert.equal(T.gradeForMark(13), '2.0–2.2', 'GRADES-04 mark 13');
    assert.equal(T.gradeForMark(12), '2.0–2.2', 'GRADES-04 mark 12 — same band as 13, not a bug to fix here');
  });

  test('GRADES-05 mark 0 reads 1.0', () => {
    assert.equal(T.gradeForMark(0), '1.0', 'GRADES-05');
  });

  test('GRADES-06 every mark 0-40 is present exactly once', () => {
    const marks = T.GRADE_TABLE.map(([m]) => m).sort((a, b) => a - b);
    assert.deepEqual(marks, Array.from({ length: 41 }, (_, i) => i), 'GRADES-06');
  });
});

describe('gradeTable.js — derived helpers', () => {
  test('GRADES-07 marksToNextBand(38) is 0 — already the top band', () => {
    assert.equal(T.marksToNextBand(38), 0, 'GRADES-07');
  });

  test('GRADES-08 marksToNextBand(12) is 2 — 13 shares the band, 14 is the next one up', () => {
    assert.equal(T.marksToNextBand(12), 2, 'GRADES-08 the 12/13 plateau means it takes 2 marks, not 1, to move');
  });

  test('GRADES-09 minMarkForGrade(9.0) is 38', () => {
    assert.equal(T.minMarkForGrade(9.0), 38, 'GRADES-09');
  });
});

describe('GradesTab.jsx — source-level checks', () => {
  let src;
  before(() => { src = read(path.join(M, 'GradesTab.jsx')); });

  test('GRADES-10 no fetch( anywhere in the source — provably client-only', () => {
    assert.ok(!src.includes('fetch('), 'GRADES-10 GradesTab must not call fetch(');
  });

  test('GRADES-11 persists the entered mark to the monday-grades-mark localStorage key', () => {
    assert.match(src, /localStorage\.setItem\(\s*LS_KEY|monday-grades-mark/, 'GRADES-11');
    assert.match(src, /monday-grades-mark/, 'GRADES-11 exact key name present in source');
  });

  test('GRADES-12 imports the table from gradeTable.js rather than redeclaring it', () => {
    assert.match(src, /from\s+['"]\.\/gradeTable\.js['"]/, 'GRADES-12');
  });
});

describe('VideoTab.jsx — source-level checks', () => {
  let src;
  before(() => { src = read(path.join(M, 'VideoTab.jsx')); });

  test('GRADES-13 detects native mode via window.webkit?.messageHandlers?.videoPane', () => {
    assert.match(src, /webkit[\s\S]{0,40}messageHandlers[\s\S]{0,40}videoPane/, 'GRADES-13');
  });

  test('GRADES-14 embeds via youtube-nocookie.com', () => {
    assert.match(src, /youtube-nocookie\.com\/embed\//, 'GRADES-14');
  });
});

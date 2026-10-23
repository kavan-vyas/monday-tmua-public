// ACC-PIDX-01..09 — the question→page index that replaced per-click PDF searching.
//
// The claim under test is that a question opens AT the question. Each rule here exists
// because a real paper broke the naive version: a fraction denominator that reads as a
// question number, a page footer that reads as one, a table of contents that reads as
// twenty of them, and a maths ellipsis that reads as a table of contents.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { indexPages, indexPagesText } from '../../scripts/build-page-index.mjs';
import { locate } from '../../server/pageindex.js';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

/** Boxed lines, the shape linesOf() returns: [[{x, text}, …], …]. */
const boxed = (pages) => pages.map((lines) => lines.map(([x, text]) => ({ x, text })));

describe('page index — reading question numbers off a paper', () => {
  test('ACC-PIDX-01 a question per page, numbers in the left column', () => {
    const pages = boxed([
      [[50, 'Mock paper'], [50, 'Instructions']],
      [[57, '1'], [90, 'Find the value of x.']],
      [[57, '2'], [90, 'Find the other value.']],
    ]);
    assert.deepEqual(indexPages(pages, { count: 2 }), { 1: 2, 2: 3 });
  });

  test('ACC-PIDX-02 a fraction denominator is not question 2', () => {
    // Chen's option lists stack fractions, so a bare "2" appears mid-question, indented
    // past the number column. Without the column rule it stole the next question.
    const pages = boxed([
      [[57, '1'], [90, 'Which graph is it?'], [120, 'x + 1'], [124, '2'], [90, 'B something']],
      [[57, '2'], [90, 'The real question two.']],
    ]);
    assert.deepEqual(indexPages(pages, { count: 2 }), { 1: 1, 2: 2 });
  });

  test('ACC-PIDX-03 numbers must arrive in order', () => {
    // "7" sitting in the number column inside question 2 must not claim to be question 7:
    // the scan is looking for 3 at that moment and will not take anything else.
    const pages = boxed([
      [[57, '1'], [90, 'first']],
      [[57, '2'], [57, '7 of the following are true']],
      [[57, '3'], [90, 'third']],
    ]);
    const found = indexPages(pages, { count: 7 });
    assert.deepEqual({ 1: found[1], 2: found[2], 3: found[3] }, { 1: 1, 2: 2, 3: 3 });
    assert.equal(found[7], undefined, 'the stray 7 was taken as question 7');
  });

  test('ACC-PIDX-04 a table of contents does not become the whole index', () => {
    const pages = boxed([
      [[57, 'Question 1 . . . . . . . . . . 3'], [57, 'Question 2 . . . . . . . . . . 7']],
      [[57, '1'], [90, 'the actual first question']],
      [[57, '2'], [90, 'the actual second question']],
    ]);
    assert.deepEqual(indexPages(pages, { count: 2 }), { 1: 2, 2: 3 });
  });

  test('ACC-PIDX-05 a maths ellipsis is not a table of contents', () => {
    // Tyler's question 18 reads "cos^2 0 + cos^2 2 + . . . + cos^2 90" on the same line as
    // its number, and a contents rule that matched bare dots threw the question away.
    const pages = boxed([
      [[57, '1 Find cos 2 0 + cos 2 2 + . . . + cos 2 90']],
      [[57, '2'], [90, 'next']],
    ]);
    assert.deepEqual(indexPages(pages, { count: 2 }), { 1: 1, 2: 2 });
  });

  test('ACC-PIDX-06 the text fallback ignores a page footer', () => {
    // No boxes available: a centred page number is a bare number with nothing under it.
    const pages = [
      '   1   Find the value of x.\n\n   A  one\n   B  two\n\n                 2\n',
      '   2   The real question two.\n',
    ];
    assert.deepEqual(indexPagesText(pages, { count: 2 }), { 1: 1, 2: 2 });
  });
});

describe('page index — resolving a reference to a paper', () => {
  test('ACC-PIDX-07 registry papers resolve by their canonical prefix', () => {
    assert.deepEqual(locate('HER-1-P1-Q07'), { paperId: 'her_s1_p1', qnum: 7 });
    assert.deepEqual(locate('TYLER-D-P2-Q09'), { paperId: 'tyler_d_p2', qnum: 9 });
    assert.deepEqual(locate('JC-25-P1-Q11'), { paperId: 'jc_25_p1', qnum: 11 });
    assert.deepEqual(locate('ROSIE-A-P1-Q02'), { paperId: 'rosie_a_p1', qnum: 2 });
  });

  test('ACC-PIDX-08 official papers resolve by shape, including practice and specimen', () => {
    assert.deepEqual(locate('TMUA-2018-P2-Q10'), { paperId: 'tmua_2018_p2', qnum: 10 });
    assert.deepEqual(locate('TMUA-PRAC-P1-Q11'), { paperId: 'tmua_prac_p1', qnum: 11 });
    assert.deepEqual(locate('TMUA-SPEC-P2-Q20'), { paperId: 'tmua_spec_p2', qnum: 20 });
  });

  test('ACC-PIDX-09 MAT and nonsense resolve to nothing, so the search still owns them', () => {
    assert.equal(locate('MAT-2017-H'), null);
    assert.equal(locate('TMUA-????-P1-Q01'), null);
    assert.equal(locate(''), null);
    assert.equal(locate(null), null);
  });
});

describe('page index — the lookup the server actually calls', () => {
  test('ACC-PIDX-10 pageFor reads the index, and says nothing when there is none', async () => {
    const sbx = makeSandbox({ tag: 'pidx', tutorData: defaultTutorData() });
    const dir = path.join(sbx.tutorData, 'exams', 'pageindex');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'her_s1_p1.json'), JSON.stringify({
      paper_id: 'her_s1_p1', qp: { 7: 8 }, ms: { 7: 12 }, source: { qp: 'scanned', ms: 'answer-key' },
    }));
    const { pageFor } = await sbx.imp('pageindex.js');

    assert.equal(pageFor('Heracles S1 P1 Q7', 'TMUA', 'qp').page, 8);
    assert.equal(pageFor('Heracles S1 P1 Q7', 'TMUA', 'ms').page, 12);
    assert.match(pageFor('Heracles S1 P1 Q7', 'TMUA', 'ms').source, /answer-key/);
    // A question the index does not cover, and a paper with no index at all.
    assert.equal(pageFor('Heracles S1 P1 Q8', 'TMUA', 'qp'), null);
    assert.equal(pageFor('2018 P2 Q10', 'TMUA', 'qp'), null);
    sbx.dispose();
  });
});

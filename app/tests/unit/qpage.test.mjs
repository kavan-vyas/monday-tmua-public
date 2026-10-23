// ACC-QPAGE-01..07 — finding the page a question is on.
//
// Every collection is typeset by someone different, so this is a stack of heuristics
// rather than a rule. The cases below are the real shapes, reduced: a MAT paper with two
// lettered parts to a page, a TMUA official whose digits arrive as Greek numerals from a
// symbol font, a solutions PDF with a contents page that lists every question, and a
// Tyler mock that drags page furniture onto the heading's line.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findPage, parseRef, normalisePage } from '../../server/qpage.js';

describe('question page finder', () => {
  test('ACC-QPAGE-01 a page that opens with the question wins', () => {
    const pages = ['cover', 'blank', '1. First question', '2. Second question', '3. Third'];
    assert.equal(findPage(pages, { qnum: 2 }), 4);
  });

  test('ACC-QPAGE-02 Greek numerals from a symbol font are read as digits', () => {
    // What pdftotext actually returns for the official papers.
    assert.match(normalisePage('ͳ'), /1/);
    const pages = ['cover', 'BLANK PAGE', 'ͳ the first question', 'ʹ the second'];
    assert.equal(findPage(pages, { qnum: 2 }), 4);
  });

  test('ACC-QPAGE-03 a contents page is not mistaken for the question', () => {
    const contents = 'Question 1 .. 4  Question 2 .. 5  Question 3 .. 6  Question 19 .. 24';
    const pages = ['cover', contents, 'Question 1 solution', 'Question 2 solution', 'Question 19 solution'];
    assert.equal(findPage(pages, { qnum: 19 }), 5);
  });

  test('ACC-QPAGE-04 a heading dragged mid-line by page furniture is still found', () => {
    // Tyler: the extractor puts the page's running header on the heading's own line.
    const pages = ['cover', '       7      6\n4. What is the sum of all real solutions', '7. A sequence'];
    assert.equal(findPage(pages, { qnum: 4 }), 2);
  });

  test('ACC-QPAGE-05 MAT part letters, including the one that shares a page', () => {
    const pages = ['cover', 'instructions', 'A. first', 'C. third', 'E. fifth', 'G. seventh', 'I. ninth'];
    assert.equal(findPage(pages, { part: 'A' }), 3);
    assert.equal(findPage(pages, { part: 'G' }), 6);
    // J is printed under I and never starts a line, so it resolves to I's page.
    assert.equal(findPage(pages, { part: 'J' }), 7);
  });

  test('ACC-QPAGE-06 an unfindable question is interpolated from the ones that were found', () => {
    // Question 3's heading is missing entirely; 1, 2, 4 and 5 pin the spacing.
    const pages = ['cover', '1. one', '2. two', 'a page whose heading did not survive', '4. four', '5. five'];
    assert.equal(findPage(pages, { qnum: 3, total: 5 }), 4);
  });

  test('ACC-QPAGE-07 refs parse, and an unplaceable question says so rather than guessing', () => {
    assert.deepEqual(parseRef('2007 Q1J', 'MAT'), { part: 'J', qnum: null });
    assert.deepEqual(parseRef('2018 P2 Q14', 'TMUA'), { part: null, qnum: 14 });
    assert.deepEqual(parseRef('Tyler SA P1 Q20', 'TMUA'), { part: null, qnum: 20 });
    assert.deepEqual(parseRef('Chen Q11', 'OTHER'), { part: null, qnum: 11 });
    assert.equal(findPage([], { qnum: 3 }), null);
    assert.equal(findPage(['nothing here at all'], { qnum: 3 }), null, 'no headings at all means no answer');
  });
});

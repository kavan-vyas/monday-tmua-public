// ACC-BRD-01..09 — the improvement board behind the published dashboard.
//
// The headline is "improved": every question logged, minus the wrong (or flagged)
// ones not yet reworked. Rework the whole pile and it must read exactly 100%.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeBoard, classify, paperOf, weekOf } from '../../server/board.js';

const TODAY = '2026-09-29';
const q = (id, over = {}) => ({ id, exam: 'TMUA-MOCK', topic: 'algebra', canonical_id: id, first_date: '2026-09-20', ever_wrong: false, correct: true, status: 'solid', attempts: 1, ...over });
const wrong = (id, over = {}) => q(id, { ever_wrong: true, correct: false, status: 'open', ...over });
const item = (cid, over = {}) => ({ cid, ref: cid, exam: 'TMUA', topic: 'algebra', status: 'open', tier: 1, created: '2026-09-20', due: '2026-09-21', history: [], ...over });
const board = (questions, backlog = [], extra = {}) => computeBoard({ questions, backlog, today: TODAY, examDate: '2026-10-12', ...extra });

describe('the improved percentage', () => {
  test('ACC-BRD-01 only unreworked wrongs hold it below 100%', () => {
    const b = board([q('A Q1'), q('A Q2'), wrong('A Q3'), wrong('A Q4')], [item('A Q3'), item('A Q4')]);
    assert.equal(b.headline.total, 4);
    assert.equal(b.headline.todo, 2);
    assert.equal(b.headline.pct, 50);
  });

  test('ACC-BRD-02 reworking everything reads exactly 100%, whatever the first-time score', () => {
    const pass = [{ date: '2026-09-25', result: 'pass' }];
    const b = board([wrong('A Q1'), wrong('A Q2'), q('A Q3')], [item('A Q1', { history: pass }), item('A Q2', { history: [{ date: '2026-09-26', result: 'fail' }] })]);
    assert.equal(b.headline.pct, 100, 'a failed rework is still a review');
    assert.equal(b.headline.todo, 0);
    assert.ok(b.stats.first_time_pct < 50, 'first-time accuracy stays what it was');
    assert.equal(b.questions.find((r) => r.id === 'A Q2').state, 'retry');
  });

  test('ACC-BRD-03 a rung above the first counts as reworked even with no history row', () => {
    // Early migrations promoted items without writing history; a 21-day rung is only
    // reachable by right reworks, so it must not read as untouched.
    const c = classify(wrong('A Q1'), item('A Q1', { tier: 21, due: '2026-09-17' }), null);
    assert.equal(c.state, 'reworked');
    assert.equal(c.reviewedOn, '2026-08-27');
  });

  test('ACC-BRD-04 a closed item, a resolved row and a reviewed queue entry all count', () => {
    assert.equal(classify(wrong('A'), item('A', { status: 'done' }), null).state, 'reworked');
    assert.equal(classify(wrong('A', { status: 'resolved', correct: true }), null, null).state, 'reworked');
    assert.equal(classify(wrong('A'), null, { times_reviewed: 1, review_date: '2026-09-22' }).state, 'reworked');
    assert.equal(classify(wrong('A'), null, { times_reviewed: 0 }).state, 'todo');
  });

  test('ACC-BRD-05 a flagged-right answer needs review only if it went into the backlog', () => {
    assert.equal(classify(q('A', { status: 'shaky' }), item('A'), null).state, 'todo');
    assert.equal(classify(q('A', { status: 'shaky' }), null, null).state, 'clean');
  });

  test('ACC-BRD-06 a backlog item with no question row still counts, once', () => {
    const b = board([wrong('A Q1')], [item('A Q1'), item('Z Q9', { ref: 'Z Q9' })]);
    assert.equal(b.headline.total, 2);
    assert.equal(b.headline.todo, 2);
  });
});

describe('the timeline', () => {
  test('ACC-BRD-07 the curve dips on a new wrong and climbs back on its rework', () => {
    const b = board(
      [q('A Q1', { first_date: '2026-09-20' }), wrong('A Q2', { first_date: '2026-09-22' })],
      [item('A Q2', { history: [{ date: '2026-09-25', result: 'pass' }] })],
    );
    const at = (d) => b.series.find((s) => s.date === d).pct;
    assert.equal(at('2026-09-21'), 100);
    assert.equal(at('2026-09-23'), 50);
    assert.equal(at('2026-09-26'), 100);
    assert.equal(b.series.at(-1).date, TODAY);
  });

  test('ACC-BRD-08 weeks start on Monday and papers group by their own id scheme', () => {
    assert.equal(weekOf('2026-09-29'), '2026-09-28');
    assert.equal(weekOf('2026-09-27'), '2026-09-21');
    assert.deepEqual(paperOf('Euclid S1 P2 Q17'), { paper: 'Euclid S1 P2', q: 'Q17', family: 'MOCK' });
    assert.deepEqual(paperOf('2017 P1 Q3'), { paper: 'TMUA 2017 P1', q: 'Q3', family: 'TMUA' });
    assert.deepEqual(paperOf('TMUA 2016P1 Q11'), { paper: 'TMUA 2016 P1', q: 'Q11', family: 'TMUA' });
    assert.deepEqual(paperOf('MAT 2012J'), { paper: 'MAT 2012', q: 'J', family: 'MAT' });
  });

  test('ACC-BRD-09 the finish line: pace needed vs pace kept', () => {
    const hist = [{ date: '2026-09-28', result: 'pass' }];
    const b = board(
      [wrong('A Q1'), wrong('A Q2'), wrong('A Q3')],
      [item('A Q1', { history: hist }), item('A Q2'), item('A Q3')],
    );
    assert.equal(b.next.days_left, 13);
    assert.equal(b.next.need_per_day, Math.round((2 / 13) * 10) / 10);
    assert.equal(b.stats.reworks_14d, 1);
    assert.equal(b.headline.per_rework, 33.33);
  });
});

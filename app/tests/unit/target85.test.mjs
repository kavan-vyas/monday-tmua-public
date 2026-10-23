// ACC-T85-01..03 — the 8.5+ page: sittings derived from the ledger, plan ticks persist.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

const rows = (year, paper, correct, date, timed = true) => Array.from({ length: 20 }, (_, i) => ({
  paper: 'TMUA', qid: `${year} ${paper} Q${i + 1}`, correct: i < correct, timed, date,
}));

async function box(tag, attempted) {
  const data = defaultTutorData();
  data['memory/session_memory.json'] = { ...data['memory/session_memory.json'], exam_date: '2026-10-12', questions_attempted: attempted };
  data['backlog.json'] = { items: [
    { id: 'a', ref: '2013 Q1J', exam: 'MAT', bucket: 'slipped', due: '2026-10-01', status: 'open' },
    { id: 'b', ref: '2022 P2 Q9', exam: 'TMUA', bucket: 'didnt_know', due: '2026-10-07', status: 'open' },
    { id: 'c', ref: '2022 P1 Q8', exam: 'TMUA', bucket: 'slipped', due: '2026-10-07', status: 'open' },
    { id: 'd', ref: '2021 P1 Q2', exam: 'TMUA', bucket: 'slipped', due: '2026-10-01', status: 'done' },
  ] };
  const b = makeSandbox({ tag, tutorData: data });
  return { b, T: await b.imp('target.js') };
}

describe('8.5+ page', () => {
  test('ACC-T85-01 full sittings pair P1+P2 by year; untimed and partial papers are ignored', async () => {
    const { b, T } = await box('t851', [
      ...rows('2017', 'P1', 14, '2026-08-07'), ...rows('2017', 'P2', 15, '2026-08-09'),
      ...rows('2022', 'P1', 17, '2026-10-05'), ...rows('2022', 'P2', 15, '2026-10-06'),
      ...rows('2019', 'P1', 20, '2026-09-01', false),
      ...rows('2020', 'P2', 13, '2026-09-17').slice(0, 10),
    ]);
    const t = T.computeTarget(Date.parse('2026-10-06T10:00:00Z'));
    assert.deepEqual(t.full.map((s) => [s.year, s.total]), [['2017', 29], ['2022', 32]]);
    assert.equal(t.target.mark, 35);
    assert.equal(t.gap, 3);
    assert.equal(t.daysLeft, 6);
    assert.equal(t.latest.grade, '7.3–7.5');
    assert.equal(t.papers.length, 4);
    b.dispose();
  });

  test('ACC-T85-02 rework priority: official TMUA first, slips before didn\'t-know; done items excluded', async () => {
    const { b, T } = await box('t852', []);
    const t = T.computeTarget(Date.parse('2026-10-06T10:00:00Z'));
    assert.deepEqual(t.backlog.priority.map((i) => i.ref), ['2022 P1 Q8', '2022 P2 Q9', '2013 Q1J']);
    assert.equal(t.backlog.open, 3);
    assert.equal(t.backlog.official, 2);
    assert.equal(t.backlog.due, 1);
    b.dispose();
  });

  test('ACC-T85-03 the plan is seeded once; ticks, adds and removes persist', async () => {
    const { b, T } = await box('t853', []);
    const p = T.readPlan('2026-10-06');
    assert.ok(p.tasks.length >= 5);
    assert.equal(p.tasks.at(-1).day, '2026-10-12');
    const id = p.tasks[0].id;
    T.updateTask({ id, done: true });
    T.updateTask({ text: 'extra drill', day: '2026-10-08' });
    T.updateTask({ id: p.tasks[1].id, remove: true });
    const again = b.readJson('target85.json');
    assert.equal(again.tasks.find((t) => t.id === id).done, true);
    assert.ok(again.tasks.some((t) => t.text === 'extra drill'));
    assert.equal(again.tasks.length, p.tasks.length);
    assert.equal(T.updateTask({ id: 'nope', done: true }).error, 'no such task');
    b.dispose();
  });
});

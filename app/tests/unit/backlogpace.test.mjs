// ACC-PACE-01..14 — timing as a second axis on the backlog.
//
// The claim under test is not "the arithmetic is right". It is that a continuous axis can
// steer a pass/fail system without corrupting it: an attempt nobody timed must stay
// untimed rather than quietly becoming a perfect 0, and the gate must only ever act on a
// measurement that actually exists. The gate went live once the exam simulator started
// producing real timed attempts; §P4 asserts the live contract.
//
// Every write lands in a temp fixture tree; nothing touches tutor_data/backlog.json.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

let sbx, B;
before(async () => { sbx = makeSandbox({ tag: 'pace' }); B = await sbx.imp('backlog.js'); });
after(() => sbx.dispose());

// A fresh sandbox per group of assertions that writes, so one test's history cannot
// leak into another's medians.
async function box(tag, items = []) {
  const b = makeSandbox({ tag, tutorData: { ...defaultTutorData(), 'backlog.json': { items } } });
  return { b, B: await b.imp('backlog.js') };
}
const iso = (d) => `${d}T09:00:00.000Z`;
// A history entry as completeItem writes one, for the read-only stats tests.
const hist = (date, seconds, budget, result = 'pass') => ({
  date, at: iso(date), tier: 1, result, note: '',
  due_before: date, status_before: 'open', bucket_before: 'didnt_know',
  seconds, budget, pace: null, pace_gate: 'pass',
});
const item = (o) => ({
  id: o.id, created: '2026-01-01', exam: o.exam ?? 'TMUA', ref: o.ref ?? o.id,
  topic: o.topic ?? 'algebra', bucket: o.bucket ?? 'didnt_know', tier: o.tier ?? 1,
  due: '2026-01-02', detail: '', correction: '', status: o.status ?? 'open',
  history: o.history ?? [], ...(o.insight ? { insight: o.insight } : {}),
});

describe('§P1 budgetFor — the standard a question is measured against', () => {
  // difficulty 2 is the scale's unit point (0.7 + 0.15*2 = 1.0), so it reads the raw
  // per-paper base straight out and is the only difficulty that can check it.
  test('ACC-PACE-01 the per-paper base is the paper\'s own pace, not one number for everything', () => {
    const d2 = { insight: { difficulty: 2 }, tier: 1 };
    assert.equal(B.budgetFor({ ...d2, exam: 'TMUA' }), 225, 'TMUA 75min / 20Q');
    assert.equal(B.budgetFor({ ...d2, exam: 'MAT' }), 600);
    assert.equal(B.budgetFor({ ...d2, exam: 'STEP' }), 1800);
    assert.equal(B.budgetFor({ ...d2, exam: 'OTHER' }), 225);
    assert.equal(B.budgetFor({ ...d2, exam: 'NONSENSE' }), 225, 'unknown board falls back to OTHER');
  });

  test('ACC-PACE-02 difficulty scales the budget monotonically across the whole 1-5 rubric', () => {
    const at = (n) => B.budgetFor({ exam: 'TMUA', tier: 1, insight: { difficulty: n } });
    assert.equal(at(1), Math.round(225 * 0.85));
    assert.equal(at(2), 225, 'difficulty 2 is exactly exam pace');
    assert.equal(at(5), Math.round(225 * 1.45));
    for (let n = 2; n <= 5; n += 1) assert.ok(at(n) > at(n - 1), `difficulty ${n} must allow more than ${n - 1}`);
  });

  test('ACC-PACE-03 a missing or unusable difficulty defaults to 3, never to NaN', () => {
    // null is the one that bites: Number(null) is 0 and 0 is finite, so an unguarded
    // fallback scores it as a 0/5 question and quietly halves the budget.
    for (const ins of [undefined, {}, { difficulty: null }, { difficulty: 0 }, { difficulty: 'hard' }]) {
      const v = B.budgetFor({ exam: 'TMUA', tier: 1, insight: ins });
      assert.ok(Number.isFinite(v) && v > 0, `insight ${JSON.stringify(ins)} gave ${v}`);
      assert.equal(v, 259, 'the rubric midpoint, 225 * 1.15');
    }
    assert.equal(B.budgetFor(null), 259, 'no item at all still yields a usable budget');
  });

  test('ACC-PACE-04 the tier squeeze tightens as the interval lengthens — a third sighting must be faster', () => {
    const at = (tier) => B.budgetFor({ exam: 'TMUA', tier, insight: { difficulty: 2 } });
    assert.equal(at(1), 225);
    assert.equal(at(7), Math.round(225 * 0.9));
    assert.equal(at(21), Math.round(225 * 0.8));
    assert.ok(at(21) < at(7) && at(7) < at(1), 'the standard must rise, not sit still');
  });
});

describe('§P2 paceBand — grading the band, not thresholding it', () => {
  test('ACC-PACE-05 each band covers its documented range', () => {
    assert.equal(B.paceBand(100, 225), 'clean');
    assert.equal(B.paceBand(225, 225), 'clean', 'exactly on budget is not yet slow');
    assert.equal(B.paceBand(300, 225), 'slow');
    assert.equal(B.paceBand(400, 225), 'timing_fail');
    assert.equal(B.paceBand(1000, 225), 'abandoned');
  });

  test('ACC-PACE-06 every boundary is exclusive — the ratio must EXCEED the threshold to escalate', () => {
    const b = 200;
    assert.equal(B.paceBand(b * B.PACE_SLOW, b), 'clean');
    assert.equal(B.paceBand(b * B.PACE_SLOW + 1, b), 'slow');
    assert.equal(B.paceBand(b * B.PACE_FAIL, b), 'slow');
    assert.equal(B.paceBand(b * B.PACE_FAIL + 1, b), 'timing_fail');
    assert.equal(B.paceBand(b * B.PACE_ABANDONED, b), 'timing_fail');
    assert.equal(B.paceBand(b * B.PACE_ABANDONED + 1, b), 'abandoned');
  });

  test('ACC-PACE-07 an unmeasured attempt has no band — null in, null out, and 0 is not a measurement', () => {
    for (const s of [null, undefined, NaN, 0, -5, 'six']) {
      assert.equal(B.paceBand(s, 225), null, `seconds ${String(s)} must not produce a band`);
    }
    assert.equal(B.paceBand(120, 0), null, 'no budget means nothing to grade against');
    assert.equal(B.paceBand(120, null), null);
  });
});

describe('§P3 completeItem — a null attempt stays null', () => {
  test('ACC-PACE-08 an untimed rework records seconds: null and never 0', async () => {
    const { b, B: M } = await box('pace-null');
    const it = M.addItem({ exam: 'TMUA', ref: 'X1', topic: 'logs' });
    M.completeItem(it.id, 'pass');
    const h = b.readJson('backlog.json').items[0].history.at(-1);
    assert.equal(h.seconds, null, 'ACC-PACE-08 a missing measurement must stay missing');
    assert.notEqual(h.seconds, 0, 'a 0 would read as a flawless instant answer');
    assert.equal(h.pace, null, 'no seconds, no band');
    assert.equal(b.readJson('backlog.json').items[0].time_seconds, undefined,
      'the lifetime roll-up is not opened by an untimed attempt either');
    b.dispose();
  });

  test('ACC-PACE-09 junk seconds are rejected rather than coerced', async () => {
    const { b, B: M } = await box('pace-junk');
    for (const bad of [0, -30, 'abc', NaN, undefined]) {
      const it = M.addItem({ exam: 'TMUA', ref: `J${String(bad)}`, topic: 'logs' });
      M.completeItem(it.id, 'pass', '', bad);
      const h = b.readJson('backlog.json').items.find((x) => x.id === it.id).history.at(-1);
      assert.equal(h.seconds, null, `ACC-PACE-09 seconds ${String(bad)} must land as null`);
    }
    b.dispose();
  });

  test('ACC-PACE-10 a timed rework stores this attempt, the budget it was graded on, and the band', async () => {
    const { b, B: M } = await box('pace-timed');
    const it = M.addItem({ exam: 'TMUA', ref: 'X2', topic: 'logs' });

    // Inside budget at tier 1, so it promotes — which is what makes the next assertion
    // meaningful: the history row must remember the budget it was GRADED against, not the
    // tighter one the item walked away with.
    M.completeItem(it.id, 'pass', '', 100);
    let row = b.readJson('backlog.json').items[0];
    let h = row.history.at(-1);
    assert.equal(h.seconds, 100);
    assert.equal(h.budget, 259, 'graded against the tier-1 budget it had going in, not the tier-7 one it left with');
    assert.equal(h.pace, 'clean');
    assert.equal(row.tier, 7);
    assert.equal(M.budgetFor(row), Math.round(259 * 0.9), 'which is not the budget it now carries at tier 7');

    // Same question again, now on the tier-7 budget, and this time well over it.
    M.completeItem(it.id, 'pass', '', 300);
    row = b.readJson('backlog.json').items[0];
    h = row.history.at(-1);
    assert.equal(h.budget, Math.round(259 * 0.9), 'the second attempt is graded on the squeezed budget');
    assert.equal(h.pace, 'slow');
    assert.equal(row.time_seconds, 400, 'the lifetime roll-up accumulates across sittings');
    b.dispose();
  });
});

describe('§P4 the gate is live — pace steers the schedule', () => {
  // The axis shipped in shadow mode because there was no real timed history to calibrate
  // the budgets against. The exam simulator produces twenty measured attempts per sitting,
  // so the gate is now on and these two criteria assert the new contract rather than the
  // old one. Both remain the tests that catch the constant being flipped by accident.
  test('ACC-PACE-11 ENFORCE_PACE is on, so the recorded band now steers the queue', () => {
    assert.equal(B.ENFORCE_PACE, true, 'ACC-PACE-11 the gate ships live');
  });

  test('ACC-PACE-12 a slow pass holds its tier and comes back; a fast pass promotes', async () => {
    const { b, B: M } = await box('pace-live');
    // The same question answered correctly twice: once inside budget, once far outside it.
    // Right-but-too-slow is the exact state the timing axis exists to catch, so the two
    // rows must NOT end up in the same place any more.
    const fast = M.addItem({ exam: 'TMUA', ref: 'F1', topic: 'logs' });
    const slow = M.addItem({ exam: 'TMUA', ref: 'S1', topic: 'logs' });
    M.completeItem(fast.id, 'pass', '', 60);
    M.completeItem(slow.id, 'pass', '', 900);

    const [f, s] = b.readJson('backlog.json').items;
    assert.equal(f.tier, 7, 'ACC-PACE-12 a clean pass still promotes 1 → 7');
    assert.equal(s.tier, 1, 'a slow pass holds its tier rather than losing it');
    assert.equal(s.bucket, 'timing', 'and is rebucketed as a timing problem, not a knowledge one');
    assert.notEqual(f.due, s.due, 'the two must not come back on the same day');
    // Held, not demoted: the method is there. Two days, not one — re-teaching something he
    // already knows tomorrow would waste the slot.
    assert.equal(s.status, 'open');
    b.dispose();
  });

  test('ACC-PACE-12b an untimed pass is unaffected — silence is not slowness', async () => {
    const { b, B: M } = await box('pace-untimed');
    const it = M.addItem({ exam: 'TMUA', ref: 'U9', topic: 'logs' });
    M.completeItem(it.id, 'pass', '');            // no seconds recorded at all
    const row = b.readJson('backlog.json').items[0];
    assert.equal(row.tier, 7, 'an attempt nobody timed must still promote');
    assert.equal(row.bucket, 'didnt_know', 'and must not be rewritten as a timing problem');
    b.dispose();
  });

  test('ACC-PACE-13 the gate\'s verdict is still recorded, so flipping one constant is the whole change', async () => {
    const { b, B: M } = await box('pace-gate');
    const it = M.addItem({ exam: 'TMUA', ref: 'G1', topic: 'logs' });
    M.completeItem(it.id, 'pass', '', 900);
    assert.equal(b.readJson('backlog.json').items[0].history.at(-1).pace_gate, 'slow',
      'ACC-PACE-13 a correct-but-slow attempt grades as slow even while unenforced');
    assert.equal(M.paceOutcome('fail', 'clean'), 'fail', 'wrong is wrong however fast');
    assert.equal(M.paceOutcome('pass', null), 'pass', 'an untimed pass is a pass — silence is not slowness');
    assert.equal(M.paceOutcome('pass', 'abandoned'), 'slow', 'walked away is over budget, not a fail');
    b.dispose();
  });

  test('ACC-PACE-14 undo restores tier, due, status AND bucket, so it stays correct once the gate is on', async () => {
    const { b, B: M } = await box('pace-undo');
    const it = M.addItem({ exam: 'TMUA', ref: 'U1', topic: 'logs' });
    const before = b.readJson('backlog.json').items[0];
    M.completeItem(it.id, 'pass', '', 900);
    M.undoItem(it.id);
    const after = b.readJson('backlog.json').items[0];
    assert.equal(after.tier, before.tier, 'ACC-PACE-14 tier');
    assert.equal(after.due, before.due, 'ACC-PACE-14 due');
    assert.equal(after.status, before.status, 'ACC-PACE-14 status');
    assert.equal(after.bucket, before.bucket, 'ACC-PACE-14 bucket — the one field the gate rewrites');
    assert.equal(after.history.length, 0, 'the record must not claim work that was taken back');
    b.dispose();
  });
});

describe('§P5 paceStats — small-n statistics that do not lie', () => {
  const ITEMS = [
    item({ id: 'a', topic: 'logs', insight: { trap: ['sign_error', 'missed_case'] }, history: [
      hist('2026-01-01', 200, 200), hist('2026-01-02', 400, 200), hist('2026-01-03', 300, 200),
      hist('2026-01-04', null, 200), // untimed: skipped, not counted as 0
    ] }),
    item({ id: 'b', topic: 'logs', bucket: 'slipped', insight: { trap: ['sign_error'] }, history: [
      hist('2026-01-05', 100, 200), hist('2026-01-06', 5000, 200), // 25x — walked away
    ] }),
    item({ id: 'c', exam: 'MAT', topic: 'calculus', history: [hist('2026-01-07', 600, 600)] }),
  ];

  test('ACC-PACE-15 untimed attempts are skipped entirely, never coerced into the distribution', async () => {
    const { b, B: M } = await box('pace-stats-null', ITEMS);
    const logs = M.paceStats({ groupBy: 'topic' }).find((g) => g.key === 'logs');
    assert.equal(logs.n, 4, 'ACC-PACE-15 four timed attempts, not five');
    assert.equal(logs.median, 250, 'a 0 for the untimed entry would have dragged the median to 200');
    b.dispose();
  });

  test('ACC-PACE-16 attempts past 4x budget leave the median and are reported on their own', async () => {
    const { b, B: M } = await box('pace-stats-aband', ITEMS);
    const logs = M.paceStats({ groupBy: 'topic' }).find((g) => g.key === 'logs');
    assert.equal(logs.abandoned, 1, 'ACC-PACE-16 the 25x sitting must be counted, not silently dropped');
    assert.ok(logs.median < 5000, 'and it must not be inside the median');
    assert.equal(logs.p75, 300, 'nor inside p75 — nearest rank over the four graded attempts');
    assert.equal(logs.over_budget_rate, 0.5, '2 of the 4 graded attempts ran over');
    b.dispose();
  });

  test('ACC-PACE-17 a median RATIO comes back too, because seconds do not compare across boards', async () => {
    const { b, B: M } = await box('pace-stats-ratio', ITEMS);
    const byExam = M.paceStats({ groupBy: 'exam' });
    const mat = byExam.find((g) => g.key === 'MAT');
    const tmua = byExam.find((g) => g.key === 'TMUA');
    assert.equal(mat.median, 600);
    assert.equal(mat.median_ratio, 1, 'a 10-minute MAT question that was budgeted 10 minutes is on pace');
    assert.ok(mat.median > tmua.median && mat.median_ratio < tmua.median_ratio,
      'ACC-PACE-17 raw seconds and ratio must rank the two boards differently — that is the point of the ratio');
    b.dispose();
  });

  test('ACC-PACE-18 groupBy covers topic / exam / bucket / trap, and a trap-tagged attempt counts to every tag', async () => {
    const { b, B: M } = await box('pace-stats-group', ITEMS);
    assert.deepEqual(M.paceStats({ groupBy: 'topic' }).map((g) => g.key).sort(), ['calculus', 'logs']);
    assert.deepEqual(M.paceStats({ groupBy: 'exam' }).map((g) => g.key).sort(), ['MAT', 'TMUA']);
    assert.deepEqual(M.paceStats({ groupBy: 'bucket' }).map((g) => g.key).sort(), ['didnt_know', 'slipped']);
    const traps = M.paceStats({ groupBy: 'trap' });
    assert.equal(traps.find((g) => g.key === 'sign_error').n, 4, 'both items carry sign_error');
    assert.equal(traps.find((g) => g.key === 'missed_case').n, 3, 'only item a carries missed_case');
    assert.ok(!traps.some((g) => g.key === undefined), 'an untagged item must contribute to nothing');
    b.dispose();
  });

  test('ACC-PACE-19 the exam filter narrows the population', async () => {
    const { b, B: M } = await box('pace-stats-exam', ITEMS);
    assert.deepEqual(M.paceStats({ groupBy: 'topic', exam: 'MAT' }).map((g) => g.key), ['calculus']);
    assert.deepEqual(M.paceStats({ groupBy: 'topic', exam: 'tmua' }).map((g) => g.key), ['logs']);
    b.dispose();
  });

  test('ACC-PACE-20 trend is null below four attempts and signed once there are enough', async () => {
    const { b, B: M } = await box('pace-trend', [
      item({ id: 't1', topic: 'thin', history: [hist('2026-02-01', 200, 200), hist('2026-02-02', 400, 200), hist('2026-02-03', 300, 200)] }),
      item({ id: 't2', topic: 'faster', history: [
        hist('2026-02-01', 400, 200), hist('2026-02-02', 380, 200),
        hist('2026-02-03', 220, 200), hist('2026-02-04', 200, 200),
      ] }),
    ]);
    const g = M.paceStats({ groupBy: 'topic' });
    assert.equal(g.find((x) => x.key === 'thin').trend, null, 'ACC-PACE-20 n=3 is a line through noise');
    const faster = g.find((x) => x.key === 'faster').trend;
    assert.ok(faster < 0, `ACC-PACE-20 getting faster must read negative, got ${faster}`);
    b.dispose();
  });

  test('ACC-PACE-21 a history with no timed attempt at all yields no groups rather than a fake zero', async () => {
    const { b, B: M } = await box('pace-empty', [
      item({ id: 'z', topic: 'logs', history: [{ date: '2026-01-01', tier: 1, result: 'pass', note: '' }] }),
    ]);
    assert.deepEqual(M.paceStats({ groupBy: 'topic' }), []);
    b.dispose();
  });
});

describe('§P6 the slow view', () => {
  test('ACC-PACE-22 "slow" is right-but-not-fast: a passed attempt over budget, or a timing bucket', async () => {
    const { b, B: M } = await box('pace-slow', [
      item({ id: 'ok', ref: 'OK', history: [hist('2026-01-01', 100, 225)] }),
      item({ id: 'over', ref: 'OVER', history: [hist('2026-01-01', 400, 225)] }),
      item({ id: 'wrong', ref: 'WRONG', history: [hist('2026-01-01', 400, 225, 'fail')] }),
      item({ id: 'bucket', ref: 'BUCKET', bucket: 'timing', history: [] }),
      item({ id: 'untimed', ref: 'UNTIMED', history: [{ date: '2026-01-01', tier: 1, result: 'pass' }] }),
    ]);
    const refs = M.listItems({ slowOnly: true }).map((x) => x.ref).sort();
    assert.deepEqual(refs, ['BUCKET', 'OVER'],
      'ACC-PACE-22 a wrong answer belongs in the fail queue, and an untimed one is not evidence of anything');
    b.dispose();
  });

  test('ACC-PACE-23 lastPace reads the last TIMED attempt, not merely the last one', async () => {
    const { b, B: M } = await box('pace-last', [
      item({ id: 'm', history: [hist('2026-01-01', 450, 225), { date: '2026-01-02', tier: 1, result: 'pass' }] }),
    ]);
    const p = M.lastPace(b.readJson('backlog.json').items[0]);
    assert.equal(p.seconds, 450, 'ACC-PACE-23 an untimed rework on top must not blank the number underneath');
    assert.equal(p.band, 'timing_fail');
    assert.equal(p.ratio, 2);
    assert.equal(M.lastPace(item({ id: 'n', history: [] })), null);
    b.dispose();
  });
});

describe('§P7 MAT does not cycle', () => {
  // MAT Q1 is a bank of 240 distinct parts, not a deck: once one has been reworked cold,
  // the next unseen part is worth more than seeing that one again in three weeks. TMUA
  // and the mocks keep cycling, because there the same twenty questions are the exam.
  test('ACC-PACE-25 a passed MAT question closes instead of promoting to 7d', async () => {
    const { b, B: M } = await box('nocycle-mat');
    const it = M.addItem({ exam: 'MAT', ref: '2011 Q1G', topic: 'algebra' });
    M.completeItem(it.id, 'pass', '');
    const row = b.readJson('backlog.json').items[0];
    assert.equal(row.status, 'done', 'ACC-PACE-25 a MAT question is finished when it is reworked');
    assert.equal(row.due, null);
    assert.ok(row.closed, 'and it records when it closed');
    b.dispose();
  });

  test('ACC-PACE-26 a failed MAT question still comes back tomorrow', async () => {
    const { b, B: M } = await box('nocycle-fail');
    const it = M.addItem({ exam: 'MAT', ref: '2011 Q1H', topic: 'algebra' });
    M.completeItem(it.id, 'fail', '');
    const row = b.readJson('backlog.json').items[0];
    assert.equal(row.status, 'open', 'ACC-PACE-26 not knowing it is not the same as finishing it');
    assert.equal(row.tier, 1);
    b.dispose();
  });

  test('ACC-PACE-27 TMUA and the mocks still climb 1 -> 7 -> 21', async () => {
    const { b, B: M } = await box('nocycle-tmua');
    const t = M.addItem({ exam: 'TMUA', ref: '2018 P2 Q14', topic: 'logs' });
    M.completeItem(t.id, 'pass', '', 60);
    assert.equal(b.readJson('backlog.json').items[0].tier, 7, 'ACC-PACE-27 TMUA must keep cycling');
    assert.equal(b.readJson('backlog.json').items[0].status, 'open');
    b.dispose();
  });

  test('ACC-PACE-28 undo reopens a MAT question that was closed by a pass', async () => {
    const { b, B: M } = await box('nocycle-undo');
    const it = M.addItem({ exam: 'MAT', ref: '2009 Q1A', topic: 'algebra' });
    M.completeItem(it.id, 'pass', '');
    M.undoItem(it.id);
    const row = b.readJson('backlog.json').items[0];
    assert.equal(row.status, 'open', 'ACC-PACE-28 a misclick must be recoverable');
    assert.equal(row.tier, 1);
    b.dispose();
  });
});

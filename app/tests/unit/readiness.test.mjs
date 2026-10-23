// ACC-READY-01..14 — readiness = coverage x accuracy x recency-decay, per §B2.
// Each factor is isolated by building a purpose-made fixture tree per case.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';
import { assertReadiness } from '../helpers/assertions.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-08-22T12:00:00Z');
const boxes = [];
after(() => boxes.forEach((b) => b.dispose()));

/**
 * A tree with one topic under full control.
 * @param {{attempted, correct, available, daysSinceSeen}} t
 */
async function readinessFor(t, extraTopics = {}) {
  const iso = (d) => new Date(NOW - d * DAY).toISOString().slice(0, 10);
  const stats = { [t.topic ?? 'algebra']: { attempted: t.attempted, correct: t.correct }, ...extraTopics };
  const attempts = t.daysSinceSeen == null ? [] : [{ id: 'x', topic: t.topic ?? 'algebra', date: iso(t.daysSinceSeen) }];
  const box = makeSandbox({
    tag: 'rdy',
    tutorData: defaultTutorData({
      'memory/session_memory.json': {
        schema_version: 3, session_number: 1,
        topic_stats: stats, questions_attempted: attempts, sessions: [], review_queue: [], misconceptions: [],
      },
      'activity_log.json': { entries: [] },
      'reference/mat_full_tag_index.json': { questions: [] },
      'reference/tmua_full_tag_index.json': {
        questions: Array.from({ length: t.available }, (_, i) => ({ id: `q${i}`, topic: t.topic ?? 'algebra' })),
      },
    }),
  });
  boxes.push(box);
  const m = await box.imp('readiness.js');
  m.resetReadinessCache();
  const r = await m.computeReadiness({ now: NOW, examDate: '2026-10-01' });
  return { r, m, box, topic: r.topics.find((x) => x.topic === (t.topic ?? 'algebra')) };
}

const BASE = { topic: 'algebra', attempted: 12, correct: 9, available: 40, daysSinceSeen: 1 };

describe('§B2 readiness', () => {
  test('ACC-READY-01 every per-topic score is on 0-100', async () => {
    const { r } = await readinessFor(BASE);
    for (const t of r.topics) {
      assert.ok(t.score >= 0 && t.score <= 100, `ACC-READY-01 ${t.topic} scored ${t.score}`);
    }
  });

  test('ACC-READY-03/04 coverage and accuracy inputs are reported per topic', async () => {
    const { topic } = await readinessFor(BASE);
    assert.equal(topic.attempted, 12, 'ACC-READY-03 attempted');
    assert.equal(topic.available, 40, 'ACC-READY-03 available comes from the tag index');
    assert.equal(Math.round(topic.accuracy * 100), 75, 'ACC-READY-04 accuracy comes from topic_stats');
  });

  test('ACC-READY-06 higher accuracy scores higher, all else equal', async () => {
    const low = await readinessFor({ ...BASE, correct: 3 });
    const high = await readinessFor({ ...BASE, correct: 12 });
    assert.ok(high.topic.score > low.topic.score,
      `ACC-READY-06 accuracy 100% scored ${high.topic.score}, accuracy 25% scored ${low.topic.score}`);
  });

  test('ACC-READY-07 higher coverage scores higher, all else equal', async () => {
    // Same accuracy (75%), different number of attempts against the same pool.
    const thin = await readinessFor({ ...BASE, attempted: 4, correct: 3 });
    const thick = await readinessFor({ ...BASE, attempted: 12, correct: 9 });
    assert.ok(thick.topic.score > thin.topic.score,
      `ACC-READY-07 12 attempts scored ${thick.topic.score}, 4 attempts scored ${thin.topic.score}`);
  });

  test('ACC-READY-08 more recent contact scores higher, all else equal', async () => {
    const fresh = await readinessFor({ ...BASE, daysSinceSeen: 1 });
    const stale = await readinessFor({ ...BASE, daysSinceSeen: 120 });
    assert.ok(fresh.topic.score > stale.topic.score,
      `ACC-READY-08 seen yesterday scored ${fresh.topic.score}, seen 120 days ago scored ${stale.topic.score}`);
  });

  test('ACC-READY-02 all three factors materially participate', async () => {
    const base = await readinessFor(BASE);
    const noAcc = await readinessFor({ ...BASE, correct: 2 });
    const noCov = await readinessFor({ ...BASE, attempted: 2, correct: 1.5 });
    const noRec = await readinessFor({ ...BASE, daysSinceSeen: 200 });
    assert.notEqual(noAcc.topic.score, base.topic.score, 'ACC-READY-02 accuracy factor');
    assert.notEqual(noCov.topic.score, base.topic.score, 'ACC-READY-02 coverage factor');
    assert.notEqual(noRec.topic.score, base.topic.score, 'ACC-READY-02 recency factor');
  });

  test('ACC-READY-05 decay is toward a floor, monotonic, and never reaches zero', async () => {
    const scores = [];
    for (const d of [1, 21, 40, 90, 200, 400, 2000]) {
      const { topic } = await readinessFor({ ...BASE, daysSinceSeen: d });
      scores.push([d, topic.score]);
    }
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i][1] <= scores[i - 1][1],
        `ACC-READY-05 not monotonic: ${scores[i - 1]} then ${scores[i]}`);
    }
    const [, last] = scores[scores.length - 1];
    assert.ok(last > 0, `ACC-READY-05 decayed to ${last} — must approach a floor, not zero`);
    // Grace: the spec says "untouched 21 days decays", so 21 days must not have decayed yet.
    assert.equal(scores[0][1], scores[1][1],
      'ACC-READY-05 decay must start at 21 days, not before');
  });

  test('ACC-READY-09 overall is on 0-100', async () => {
    const { r } = await readinessFor(BASE);
    assert.ok(r.overall >= 0 && r.overall <= 100, `ACC-READY-09 overall=${r.overall}`);
  });

  test('ACC-READY-10 projected is on the TMUA 1-9 scale against a 9.0 target', async () => {
    const { r, m } = await readinessFor(BASE);
    assert.equal(m.TARGET_SCORE, 9.0, 'ACC-READY-10 the target is 9.0');
    assert.ok(r.projected <= 9.0, `ACC-READY-10 projected=${r.projected} exceeds the 9.0 TMUA ceiling`);
    assert.ok(r.projected >= 1.0, `ACC-READY-10 projected=${r.projected} below the 1.0 TMUA floor`);
  });

  test('ACC-READY-11 weakest is ascending by score', async () => {
    const { r } = await readinessFor(BASE, { logs: { attempted: 10, correct: 2 }, trig: { attempted: 8, correct: 7 } });
    assertReadiness(r);
    for (let i = 1; i < r.weakest.length; i++) {
      assert.ok(r.weakest[i].score >= r.weakest[i - 1].score,
        `ACC-READY-11 weakest not ascending: ${JSON.stringify(r.weakest)}`);
    }
  });

  test('ACC-READY-12 a days-to-exam countdown accompanies the aggregate', async () => {
    const { r } = await readinessFor(BASE);
    assert.equal(typeof r.daysToExam, 'number', 'ACC-READY-12');
    assert.ok(r.daysToExam >= 0, 'ACC-READY-12 non-negative');
  });

  test('ACC-READY-13 computeReadiness is read-only — it writes nothing', async () => {
    const box = makeSandbox({ tag: 'rdy-ro' });
    boxes.push(box);
    const before = box.read('memory/session_memory.json');
    const m = await box.imp('readiness.js');
    m.resetReadinessCache();
    await m.computeReadiness({ now: NOW, examDate: '2026-10-01' });
    assert.equal(box.read('memory/session_memory.json'), before,
      'ACC-READY-13 session_memory.json was modified by a read path');
  });

  test('ACC-READY-14 resolves rather than throwing when the data files are missing', async () => {
    const box = makeSandbox({ tag: 'rdy-empty', tutorData: {} });
    boxes.push(box);
    const m = await box.imp('readiness.js');
    m.resetReadinessCache();
    let r;
    await assert.doesNotReject(async () => { r = await m.computeReadiness({ now: NOW }); }, 'ACC-READY-14');
    assertReadiness(r, 'empty-tree readiness');
  });
});

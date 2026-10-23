// ACC-FLOW-01..08 — the JZ paper flow: progress that survives a reload, and a Finish that
// writes the record exactly once.
//
// Every write lands in a temp fixture tree; nothing touches the real tutor_data.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

async function box(tag) {
  const data = defaultTutorData();
  data['backlog.json'] = { items: [] };
  data['activity_log.json'] = { entries: [] };
  const b = makeSandbox({ tag, tutorData: data });
  return { b, F: await b.imp('paperflow.js') };
}

describe('paper flow — progress', () => {
  test('ACC-FLOW-01 a fresh paper has 20 unmarked questions and is not written until saved', async () => {
    const { b, F } = await box('flow1');
    const st = F.getState('jz_a_p1');
    assert.equal(Object.keys(st.questions).length, 20);
    assert.equal(st.durationSec, 120 * 60, 'JZ papers default to the long sitting');
    assert.throws(() => b.read('paperflow/jz_a_p1.json'));
    b.dispose();
  });

  test('ACC-FLOW-02 saves merge, only known fields are accepted, and a reload resumes', async () => {
    const { b, F } = await box('flow2');
    F.saveState('jz_a_p1', { current: 3, questions: { 2: { mark: 'n', comment: 'sign slip', seconds: 200, bucket: 'slipped', evil: 1 } } });
    F.saveState('jz_a_p1', { questions: { 2: { comment: 'sign slip, twice' }, 5: { mark: 'x' } } });
    const st = F.getState('jz_a_p1');
    assert.equal(st.current, 3);
    assert.deepEqual(st.questions['2'], { mark: 'n', comment: 'sign slip, twice', bucket: 'slipped', seconds: 200, revealed: false });
    assert.equal(st.questions['5'].mark, null, 'an unknown mark is refused');
    b.dispose();
  });

  test('ACC-FLOW-03 an unknown paper is a 404, not a crash', async () => {
    const { b, F } = await box('flow3');
    assert.throws(() => F.getState('nope_p9'), (e) => e.status === 404);
    b.dispose();
  });
});

describe('paper flow — finish writes the record once', () => {
  test('ACC-FLOW-04 ledger rows: y correct, m correct+shaky, n wrong; totals recounted from rows', async () => {
    const { b, F } = await box('flow4');
    const before = b.readJson('memory/session_memory.json').questions_attempted.length;
    F.saveState('jz_a_p1', { questions: { 1: { mark: 'y', seconds: 100 }, 2: { mark: 'm', seconds: 300 }, 3: { mark: 'n', comment: 'no idea', seconds: 400 } } });
    F.finishFlow('jz_a_p1');
    const mem = b.readJson('memory/session_memory.json');
    const rows = mem.questions_attempted.slice(before);
    assert.deepEqual(rows.map((r) => [r.qid, r.correct, r.shaky]), [
      ['JZ SA P1 Q1', true, false], ['JZ SA P1 Q2', true, true], ['JZ SA P1 Q3', false, false]]);
    assert.equal(rows[2].note, 'no idea');
    assert.equal(rows[1].time_seconds, 300);
    assert.equal(mem.total_questions_attempted, mem.questions_attempted.length);
    assert.equal(mem.total_correct, mem.questions_attempted.filter((r) => r.correct === true).length);
    b.dispose();
  });

  test('ACC-FLOW-05 every n and m becomes a backlog item with the comment and seconds', async () => {
    const { b, F } = await box('flow5');
    F.saveState('jz_b_p2', { questions: { 4: { mark: 'n', comment: 'quantifier order', seconds: 360 }, 9: { mark: 'm', seconds: 120 }, 10: { mark: 'y' } } });
    const r = F.finishFlow('jz_b_p2');
    const items = b.readJson('backlog.json').items;
    assert.equal(items.length, 2);
    const q4 = items.find((i) => i.ref === 'JZ SB P2 Q4');
    assert.equal(q4.cid, 'JZ-B-P2-Q04');
    assert.equal(q4.bucket, 'didnt_know');
    assert.equal(q4.detail, 'quantifier order');
    assert.equal(q4.time_seconds, 360);
    assert.equal(items.find((i) => i.ref === 'JZ SB P2 Q9').bucket, 'slipped');
    assert.deepEqual(r.tally, { y: 1, m: 1, n: 1 });
    b.dispose();
  });

  test('ACC-FLOW-06 a second Finish changes nothing', async () => {
    const { b, F } = await box('flow6');
    F.saveState('jz_a_p1', { questions: { 1: { mark: 'n' } } });
    F.finishFlow('jz_a_p1');
    const snap = [b.read('memory/session_memory.json'), b.read('backlog.json'), b.read('activity_log.json')];
    const again = F.finishFlow('jz_a_p1');
    assert.equal(again.already, true);
    assert.deepEqual([b.read('memory/session_memory.json'), b.read('backlog.json'), b.read('activity_log.json')], snap);
    assert.throws(() => F.saveState('jz_a_p1', { current: 2 }), (e) => e.status === 409);
    b.dispose();
  });

  test('ACC-FLOW-07 nothing marked is refused', async () => {
    const { b, F } = await box('flow7');
    assert.throws(() => F.finishFlow('jz_a_p1'), (e) => e.status === 400);
    b.dispose();
  });
});

describe('paper flow — the review video', () => {
  test('ACC-FLOW-08 prefers R2Drew2 and the right set/paper, caches, and survives a failed search', async () => {
    const { b, F } = await box('flow8');
    let calls = 0;
    const run = async () => { calls += 1; return 'aaaaaaaaaaa|TMUA - JZMaths Mock B Paper 1|Someone\nPPQtXbXqwT4|TMUA - JZMaths Mock A Paper 1|R2Drew2\n'; };
    const v = await F.findVideo('jz_a_p1', { run });
    assert.equal(v.id, 'PPQtXbXqwT4');
    await F.findVideo('jz_a_p1', { run });
    assert.equal(calls, 1, 'the second call is served from the cache');
    // the right set but the wrong paper is NOT accepted; the second query finds the real one
    const queries = [];
    const v2 = await F.findVideo('jz_c_p2', { run: async (q) => { queries.push(q); return queries.length === 1
      ? 'sYml8GYZZfk|TMUA - JZMaths Set C Paper 1|R2Drew2\n' : 'K804e1RqMFA|TMUA - JZMaths Set C Paper 2|R2Drew2\n'; } });
    assert.equal(v2.id, 'K804e1RqMFA');
    assert.equal(queries.length, 2);
    const miss = await F.findVideo('jz_d_p2', { run: async () => { throw new Error('offline'); } });
    assert.equal(miss.id, null);
    assert.match(miss.query, /JZ set D paper 2/);
    b.dispose();
  });
});

describe('paper flow — picking it up later', () => {
  test('ACC-FLOW-09 the list says which paper is in progress, where, and when it was last touched', async () => {
    const { b, F } = await box('flow9');
    assert.equal(F.listFlows().find((p) => p.id === 'jz_c_p1').status, 'new');
    F.saveState('jz_c_p1', { current: 7, questions: { 6: { mark: 'y', seconds: 90 } } });
    const row = F.listFlows().find((p) => p.id === 'jz_c_p1');
    assert.equal(row.status, 'active');
    assert.equal(row.current, 7);
    assert.equal(row.started, true);
    assert.ok(row.updated);
    b.dispose();
  });
});

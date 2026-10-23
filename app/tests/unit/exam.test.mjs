// ACC-EXAM-01..24 — the computer-based test exam simulator's server side.
//
// The claim under test is not "it scores 17 out of 20". It is that the sitting is a
// RECORD: the answer key never reaches the browser before the sitting ends, a reload or a
// crash cannot cost the student time or answers, an untranscribed paper is refused rather
// than half-delivered, and finishing writes exactly one activity row and one backlog item
// per question that earned one — no matter how many times finish is called.
//
// Every write lands in a temp fixture tree; nothing here touches the real tutor_data.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

const QUESTIONS = (n = 20) => ({
  schema_version: 1,
  paper_id: 'her_s1_p1',
  set: 'A',
  paper: 1,
  source: 'Heracles Set 1 Paper 1',
  pdf: '/nonexistent/Heracles Set 1 Paper 1 QP.pdf',
  transcribed: 'full',
  questions: Array.from({ length: n }, (_, i) => ({
    qnum: i + 1,
    id: `HER_S1_P1_Q${String(i + 1).padStart(2, '0')}`,
    cid: `HER-1-P1-Q${String(i + 1).padStart(2, '0')}`,
    pdf_page: i + 2,
    stem: `Question ${i + 1} stem with $x^2$.`,
    display: null,
    options: [
      { letter: 'A', latex: '$1$' },
      { letter: 'B', latex: '$2$' },
      { letter: 'C', latex: '$3$' },
    ],
    figure: null,
    classification: null,
  })),
});

const ANSWERS = {
  schema_version: 1,
  paper_id: 'her_s1_p1',
  ms_pdf: '/nonexistent/Heracles Set 1 Paper 1 MS.pdf',
  questions: Array.from({ length: 20 }, (_, i) => ({
    qnum: i + 1,
    answer: 'A',
    jz_tags: ['General Algebra'],
    jz_difficulty: 5,
    solution: { type: 'pdf_page', path: '/nonexistent/ms.pdf', pages: [i + 3, i + 4] },
  })),
};

async function box(tag, { questions = QUESTIONS(), answers = ANSWERS } = {}) {
  const tutorData = defaultTutorData();
  if (questions) tutorData['exams/questions/her_s1_p1.json'] = questions;
  if (answers) tutorData['exams/answers/her_s1_p1.json'] = answers;
  const sbx = makeSandbox({ tag, tutorData });
  return { sbx, E: await sbx.imp('exam.js') };
}

// A full sitting's worth of events, so the derived per-question numbers have something real
// to be derived from.
function playthrough(E, id, order, { wrong = [], blank = [], flagged = [], changed = [] } = {}) {
  let t = 0;
  const ev = [];
  for (const n of order) {
    ev.push({ t, type: 'question_enter', qnum: n });
    t += 30000;
    if (!blank.includes(n)) {
      const pick = wrong.includes(n) ? 'B' : 'A';
      if (changed.includes(n)) ev.push({ t: t - 5000, type: 'option_select', qnum: n, letter: 'C', prev: null });
      ev.push({ t, type: 'option_select', qnum: n, letter: pick, prev: changed.includes(n) ? 'C' : null });
      E.recordAnswer({ sittingId: id, qnum: n, choice: pick, flagged: flagged.includes(n) });
    } else if (flagged.includes(n)) {
      E.recordAnswer({ sittingId: id, qnum: n, choice: null, flagged: true });
    }
    ev.push({ t, type: 'question_leave', qnum: n, dwell_ms: 30000 });
  }
  E.appendEvents(id, ev);
  return t;
}

describe('exam simulator — papers registry', () => {
  test('ACC-EXAM-01 every registry paper is always listed, transcribed or not', async () => {
    const { sbx, E } = await box('papers');
    const { PAPERS: MOCKS, OFFICIAL_PAPERS } = await import('../../server/papers.js');
    // Official papers are listed first, then the mock registry in its own order.
    const PAPERS = [...OFFICIAL_PAPERS, ...MOCKS];
    const papers = E.listPapers();
    // Against the registry, not a hard-coded count: adding a paper is a one-line change to
    // papers.js and must not also be a test edit.
    assert.equal(papers.length, PAPERS.length);
    assert.deepEqual(papers.map((p) => p.id), PAPERS.map((p) => p.id));
    assert.deepEqual(papers.map((p) => p.id).slice(OFFICIAL_PAPERS.length, OFFICIAL_PAPERS.length + 3),
      ['tyler_a_p1', 'tyler_a_p2', 'tyler_b_p1']);
    // Every collection reaches the setup screen, each carrying the label it groups under.
    // Derived from the registry rather than listed: a new collection is a papers.js edit,
    // and what this holds is that listPapers() drops none of them and keeps their order.
    assert.deepEqual([...new Set(papers.map((p) => p.collection))],
      [...new Set(PAPERS.map((p) => p.collection))]);
    assert.ok(['tyler', 'chen', 'heracles', 'euclid', 'af', 'rosie']
      .every((c) => papers.some((p) => p.collection === c)), 'a known collection vanished');
    assert.equal(papers.find((p) => p.id === 'tyler_c_p1').collection_title, 'Tyler Tutoring');
    assert.equal(papers.find((p) => p.id === 'jc_25_p1').collection_title, 'James Chen');
    assert.equal(papers.find((p) => p.id === 'her_s3_p2').collection_title, 'Heracles');
    assert.equal(papers.find((p) => p.id === 'euc_r2drew_p1').collection_title, 'Euclid');
    sbx.dispose();
  });

  test('ACC-EXAM-02 transcribed is derived from the question count, not the file\'s own claim', async () => {
    const half = QUESTIONS(9);
    half.transcribed = 'full';           // the file lies
    const { sbx, E } = await box('derive', { questions: half });
    const p = E.listPapers().find((x) => x.id === 'her_s1_p1');
    assert.equal(p.transcribed, 'partial');
    assert.equal(p.questions, 9);
    sbx.dispose();
  });

  test('ACC-EXAM-03 has_answers reflects the answer file', async () => {
    const withKey = await box('key-yes');
    assert.equal(withKey.E.listPapers().find((p) => p.id === 'her_s1_p1').has_answers, true);
    withKey.sbx.dispose();
    const without = await box('key-no', { answers: null });
    assert.equal(without.E.listPapers().find((p) => p.id === 'her_s1_p1').has_answers, false);
    without.sbx.dispose();
  });
});

describe('exam simulator — starting a sitting', () => {
  test('ACC-EXAM-04 an untranscribed paper is refused, not half-delivered', async () => {
    const { sbx, E } = await box('untranscribed', { questions: null });
    await assert.rejects(() => E.createSitting({ paperId: 'her_s1_p1', timing: 'real' }), /transcribed/i);
    sbx.dispose();
  });

  test('ACC-EXAM-05 an unknown paper id is refused', async () => {
    const { sbx, E } = await box('unknown');
    await assert.rejects(() => E.createSitting({ paperId: '../../etc/passwd', timing: 'real' }), /unknown paper/i);
    sbx.dispose();
  });

  test('ACC-EXAM-06 timing: real is 75 minutes, long is 120, untimed is null', async () => {
    const { sbx, E } = await box('timing');
    assert.equal(E.durationFor('real', false), 4500);
    assert.equal(E.durationFor('long', false), 7200);
    assert.equal(E.durationFor('untimed', false), null);
    sbx.dispose();
  });

  test('ACC-EXAM-07 25% extra time extends a timed sitting and cannot extend an untimed one', async () => {
    const { sbx, E } = await box('extra');
    assert.equal(E.durationFor('real', true), Math.round(4500 * 1.25));
    assert.equal(E.durationFor('untimed', true), null);
    sbx.dispose();
  });

  test('ACC-EXAM-08 THE ANSWER KEY IS NOT IN THE SITTING PAYLOAD', async () => {
    const { sbx, E } = await box('no-leak');
    const created = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    const blob = JSON.stringify(created);
    assert.equal(blob.includes('correctAnswer'), false);
    assert.equal(blob.includes('jz_difficulty'), false);
    for (const q of created.questions) {
      assert.equal('answer' in q, false, `question ${q.qnum} carries an answer field`);
    }
    // and the same for the resume payload, which is a separate code path
    const resumed = E.sittingPayload(created.sittingId);
    assert.equal(JSON.stringify(resumed.questions).includes('correctAnswer'), false);
    sbx.dispose();
  });

  test('ACC-EXAM-09 shuffle reorders without losing or duplicating a question', async () => {
    const { sbx, E } = await box('shuffle');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real', shuffle: true });
    const order = E.readSitting(s.sittingId).order;
    assert.equal(order.length, 20);
    assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    sbx.dispose();
  });

  test('ACC-EXAM-10 the event log exists from the first instant', async () => {
    const { sbx, E } = await box('log-start');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    const lines = fs.readFileSync(E.eventsFile(s.sittingId), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[0]).type, 'sitting_start');
    sbx.dispose();
  });

  test('ACC-EXAM-11 starting a sitting puts the app into EXAM mode', async () => {
    const { sbx, E } = await box('mode');
    let mode = null;
    await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' }, { setMode: async (m) => { mode = m; } });
    assert.equal(mode, 'EXAM');
    sbx.dispose();
  });

  test('ACC-EXAM-12 a mode hook that throws does not lose the sitting', async () => {
    const { sbx, E } = await box('mode-throws');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' },
      { setMode: async () => { throw new Error('mode server is down'); } });
    assert.ok(E.readSitting(s.sittingId));
    sbx.dispose();
  });
});

describe('exam simulator — answers and telemetry', () => {
  test('ACC-EXAM-13 an answer write survives a reload', async () => {
    const { sbx, E } = await box('persist');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    E.recordAnswer({ sittingId: s.sittingId, qnum: 4, choice: 'B', flagged: true });
    const back = E.sittingPayload(s.sittingId);
    assert.equal(back.sitting.answers[4], 'B');
    assert.equal(back.sitting.flags[4], true);
    assert.equal(back.sitting.seen[4], true);
    sbx.dispose();
  });

  test('ACC-EXAM-14 an answer can be cleared', async () => {
    const { sbx, E } = await box('clear');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    E.recordAnswer({ sittingId: s.sittingId, qnum: 2, choice: 'A' });
    E.recordAnswer({ sittingId: s.sittingId, qnum: 2, choice: null });
    assert.equal(E.sittingPayload(s.sittingId).sitting.answers[2] ?? null, null);
    sbx.dispose();
  });

  test('ACC-EXAM-15 events append and replay in order', async () => {
    const { sbx, E } = await box('events');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    E.appendEvents(s.sittingId, [{ t: 10, type: 'flag_set', qnum: 1 }, { t: 20, type: 'flag_clear', qnum: 1 }]);
    E.appendEvents(s.sittingId, [{ t: 30, type: 'navigator_open', qnum: 1 }]);
    const types = E.replayEvents(s.sittingId).map((e) => e.type);
    assert.deepEqual(types, ['sitting_start', 'flag_set', 'flag_clear', 'navigator_open']);
    sbx.dispose();
  });

  test('ACC-EXAM-16 a torn last line does not destroy the log', async () => {
    const { sbx, E } = await box('torn');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    E.appendEvents(s.sittingId, [{ t: 1, type: 'click' }]);
    fs.appendFileSync(E.eventsFile(s.sittingId), '{"t":2,"type":"cli');   // killed mid-write
    const ev = E.replayEvents(s.sittingId);
    assert.ok(ev.length >= 2);
    assert.equal(ev.at(-1).type, 'click');
    sbx.dispose();
  });

  test('ACC-EXAM-17 a bad sitting id never reaches the filesystem', async () => {
    const { sbx, E } = await box('traversal');
    assert.throws(() => E.readSitting('../../../etc/passwd'), /bad sitting id/i);
    assert.throws(() => E.eventsFile('a/b'), /bad sitting id/i);
    sbx.dispose();
  });

  test('ACC-EXAM-18 break spans pause the clock', async () => {
    const { sbx, E } = await box('breaks');
    const closed = E.breakSpans([
      { t: 1000, type: 'break_start' },
      { t: 61000, type: 'break_end' },
      { t: 90000, type: 'break_start' },
      { t: 120000, type: 'break_end' },
    ]);
    assert.equal(closed.pausedMs, 90000);
    assert.equal(closed.breaksUsed, 2);
    assert.equal(closed.openAt, null);

    // A break still running when the page died must still count, or a student could park
    // on the break screen and come back to a full clock.
    const open = E.breakSpans([{ t: 1000, type: 'break_start' }]);
    assert.equal(open.breaksUsed, 1);
    assert.equal(open.openAt, 1000);
    sbx.dispose();
  });
});

describe('exam simulator — scoring and results', () => {
  test('ACC-EXAM-19 results are refused while the sitting is still running', async () => {
    const { sbx, E } = await box('too-early');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    assert.throws(() => E.results(s.sittingId), /still running/i);
    sbx.dispose();
  });

  test('ACC-EXAM-20 scoring, grade conversion and per-question derivation', async () => {
    const { sbx, E } = await box('score');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    const order = E.readSitting(s.sittingId).order;
    playthrough(E, s.sittingId, order, { wrong: [7, 13], blank: [19], changed: [4] });
    const out = await E.finishSitting({ sittingId: s.sittingId, reason: 'submitted' });
    const r = out.results ?? out;

    assert.equal(r.score.raw, 17);
    assert.equal(r.score.outOf, 20);
    assert.equal(r.score.answered, 19);
    assert.equal(r.score.percent, 85);
    // 17/20 doubles to 34/40, which the private conversion table calls 8.1–8.3.
    assert.equal(r.score.equivalentRaw40, 34);
    assert.equal(r.score.gradeLabel, '8.1–8.3');

    const q7 = r.questions.find((q) => q.qnum === 7);
    assert.equal(q7.correct, false);
    assert.equal(q7.yourAnswer, 'B');
    assert.equal(q7.correctAnswer, 'A');
    assert.equal(q7.solution.pages.length, 2, 'a multi-page worked solution keeps every page');
    assert.equal(r.questions.find((q) => q.qnum === 4).changes, 1);
    assert.equal(r.questions.find((q) => q.qnum === 19).yourAnswer, null);
    sbx.dispose();
  });

  test('ACC-EXAM-21 an unmarked paper still produces a full record, and invents no answers', async () => {
    const { sbx, E } = await box('unmarked', { answers: null });
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    const order = E.readSitting(s.sittingId).order;
    playthrough(E, s.sittingId, order, {});
    const out = await E.finishSitting({ sittingId: s.sittingId, reason: 'submitted' });
    const r = out.results ?? out;
    assert.equal(r.score.raw, null);
    assert.equal(r.score.gradeLabel, null);
    assert.equal(r.score.answered, 20);
    assert.ok(r.questions.every((q) => q.correctAnswer === null && q.correct === null));
    sbx.dispose();
  });
});

describe('exam simulator — finishing', () => {
  test('ACC-EXAM-22 finishing writes one activity row and NOTHING into the backlog', async () => {
    const { sbx, E } = await box('finish');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    const order = E.readSitting(s.sittingId).order;
    playthrough(E, s.sittingId, order, { wrong: [3, 8], flagged: [11] });
    await E.finishSitting({ sittingId: s.sittingId, reason: 'submitted' });

    const log = JSON.parse(sbx.read('activity_log.json'));
    assert.equal(log.entries.length, 1);
    assert.match(log.entries[0].detail, /Set 1 Paper 1/);
    // A multi-question summary carries no `correct` field — the file's own convention.
    assert.equal('correct' in log.entries[0], false);

    // These are JZ mocks: harder than the real test by design, with routine material
    // stripped out. Missing them is the expected experience, not a catalogue of gaps, and
    // twenty tier-1 items per sitting buried the questions that came off real papers.
    const backlog = JSON.parse(sbx.read('backlog.json'));
    assert.deepEqual(backlog.items, [], 'ACC-EXAM-22 a sitting must not seed the backlog');
    sbx.dispose();
  });

  test('ACC-EXAM-23 finishing twice does not double the record', async () => {
    const { sbx, E } = await box('idempotent');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    playthrough(E, s.sittingId, E.readSitting(s.sittingId).order, { wrong: [5] });
    await E.finishSitting({ sittingId: s.sittingId, reason: 'submitted' });
    await E.finishSitting({ sittingId: s.sittingId, reason: 'submitted' });
    assert.equal(JSON.parse(sbx.read('activity_log.json')).entries.length, 1);
    assert.equal(JSON.parse(sbx.read('backlog.json')).items.length, 0);
    sbx.dispose();
  });

  test('ACC-EXAM-24 the sitting itself keeps the per-question clock', async () => {
    // The timings do not go to the backlog any more, so the sitting record is now the
    // only place they live — losing them would make a timed paper unreadable afterwards.
    const { sbx, E } = await box('pace');
    const s = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    playthrough(E, s.sittingId, E.readSitting(s.sittingId).order, { wrong: [6] });
    await E.finishSitting({ sittingId: s.sittingId, reason: 'submitted' });
    const q6 = E.readSitting(s.sittingId).summary.questions.find((q) => q.qnum === 6);
    assert.ok(q6.timeSec > 0, 'ACC-EXAM-24 a wrong answer under the clock records how long it took');
    assert.equal(q6.correct, false);
    const report = E.sittingReport(s.sittingId);
    assert.match(report, /Q 6|Q06|Q6/, 'and the report Monday reads names it');
    sbx.dispose();
  });
});

describe('exam simulator — question identity', () => {
  test('ACC-EXAM-25 every reference resolves to its own canonical id', async () => {
    const { sbx } = await box('canon');
    const { canonicalId, canonicalFromIndexId } = await sbx.imp('canonical.js');
    // Both spellings of the collection, and both the index-id and human forms of a ref.
    assert.equal(canonicalId('TMUA', 'Heracles Set 1 Paper 1 Q01'), 'HER-1-P1-Q01');
    assert.equal(canonicalId('TMUA', 'Hercules S1 P1 Q7'), 'HER-1-P1-Q07');
    assert.equal(canonicalId('TMUA', 'heracles s3 p2 q13'), 'HER-3-P2-Q13');
    assert.equal(canonicalFromIndexId('HER_S2_P1_Q09'), 'HER-2-P1-Q09');
    // Distinct papers must never collapse onto one id.
    const ids = new Set();
    for (const set of [1, 2, 3]) {
      for (const paper of [1, 2]) {
        for (const q of [1, 20, 7, 13]) ids.add(canonicalId('TMUA', `Heracles S${set} P${paper} Q${String(q).padStart(2, '0')}`));
      }
    }
    assert.equal(ids.size, 24);
    sbx.dispose();
  });
});

describe('practice pause — start a paper at school, finish it later', () => {
  test('ACC-EXAM-PAUSE-01 paused time never counts, and an open pause freezes the clock', async () => {
    const { sbx, E } = await box('pause1');
    const { sittingId } = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    const t0 = Date.parse(E.readSitting(sittingId).startedAt);
    const min = 60000;
    E.pauseSitting(sittingId, t0 + 10 * min);
    E.pauseSitting(sittingId, t0 + 12 * min);          // idempotent: still one open pause
    const s = E.readSitting(sittingId);
    assert.equal(s.pauses.length, 1);
    // three hours later, still paused: the clock reads the 10 minutes before the pause
    let c = E.clockFor(E.readSitting(sittingId), [], t0 + 190 * min);
    assert.equal(c.elapsedSec, 10 * 60);
    assert.equal(c.paused, true);
    E.resumeSitting(sittingId, t0 + 190 * min);
    c = E.clockFor(E.readSitting(sittingId), [], t0 + 195 * min);
    assert.equal(c.elapsedSec, 15 * 60, '10 before + 5 after; the 3-hour gap is excluded');
    assert.equal(c.paused, false);
    assert.equal(E.sittingPayload(sittingId, t0 + 195 * min).sitting.paused, false);
    sbx.dispose();
  });

  test('ACC-EXAM-PAUSE-03 a pause taken on a question is not billed to that question', async () => {
    const { sbx, E } = await box('pause3');
    const { sittingId } = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    const s = E.readSitting(sittingId);
    const t0 = Date.parse(s.startedAt);
    const min = 60000;
    const at = (ms) => new Date(t0 + ms).toISOString();
    // 2 min on Q1, then 50 min on Q2 of which 45 were a break
    s.pauses = [{ start: at(4 * min), end: at(49 * min) }];
    const evs = [
      { t: 2 * min, type: 'question_leave', qnum: s.order[0], dwell_ms: 2 * min, at: at(2 * min) },
      { t: 52 * min, type: 'question_leave', qnum: s.order[1], dwell_ms: 50 * min, at: at(52 * min) },
    ];
    const d = E.deriveQuestions(evs, s, 7 * 60);
    assert.equal(d.get(s.order[0]).timeSec, 120);
    assert.equal(d.get(s.order[1]).timeSec, 5 * 60);
    sbx.dispose();
  });

  test('ACC-EXAM-PAUSE-02 unfinished sittings are listed with their time left', async () => {
    const { sbx, E } = await box('pause2');
    const { sittingId } = await E.createSitting({ paperId: 'her_s1_p1', timing: 'real' });
    E.pauseSitting(sittingId);
    const row = E.listSittings().find((x) => x.id === sittingId);
    assert.equal(row.status, 'active');
    assert.equal(row.paused, true);
    assert.ok(row.elapsedSec >= 0 && row.elapsedSec < 5);
    sbx.dispose();
  });
});

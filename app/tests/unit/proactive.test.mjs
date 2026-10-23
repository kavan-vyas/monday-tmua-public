// ACC-PROACTIVE-01..20 — the seven triggers, their switches, EXAM suppression
// and the 10-minute global floor, from §B2's proactive.js table.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';
import { TRIGGER_IDS } from '../helpers/assertions.mjs';

const MIN = 60000;
const DAY = 86400000;
const NOW = Date.parse('2026-08-22T14:00:00');
const boxes = [];
after(() => boxes.forEach((b) => b.dispose()));

/** A proactive instance over a fresh fixture tree, with emit/queueInstruction spies. */
async function rig({ tutorData, toggles, state = {} } = {}) {
  const box = makeSandbox({ tag: 'pro', tutorData: tutorData ?? defaultTutorData() });
  boxes.push(box);
  const m = await box.imp('proactive.js');
  const emitted = [];
  const queued = [];
  let st = {
    mode: 'DRILL', proactiveEnabled: true, sessionActive: true,
    lastUserMessageAt: NOW - 30000, sessionElapsedMs: 5 * MIN,
    sessionAccuracy: { correct: 2, total: 3 }, daysToExam: 200,
    readiness: { overall: 60, projected: 6.3, target: 9 }, examDate: '2026-10-01',
    gates: { proactiveEnabled: true }, ...state,
  };
  const p = m.createProactive({
    emit: (e) => emitted.push(e),
    queueInstruction: (s) => queued.push(s),
    getState: () => st,
    toggles,
    now: () => NOW,
  });
  return { m, p, emitted, queued, box, setState: (patch) => { st = { ...st, ...patch }; } };
}

describe('§B2 proactive triggers', () => {
  test('ACC-PROACTIVE-01 exactly the seven triggers', async () => {
    const { m } = await rig();
    const ids = m.TRIGGERS.map((t) => t.id);
    assert.deepEqual([...ids].sort(), [...TRIGGER_IDS].sort(), 'ACC-PROACTIVE-01');
    assert.equal(ids.length, 7, 'ACC-PROACTIVE-01 no extras');
  });

  test('ACC-PROACTIVE-18 TRIGGERS is exposed on the instance too', async () => {
    const { p } = await rig();
    assert.equal(p.TRIGGERS.length, 7, 'ACC-PROACTIVE-18');
  });

  test('ACC-PROACTIVE-03/04 defaults: six on, late_night off', async () => {
    const { m } = await rig();
    const byId = Object.fromEntries(m.TRIGGERS.map((t) => [t.id, t.enabled]));
    for (const id of TRIGGER_IDS) {
      const want = id === 'late_night' ? false : true;
      assert.equal(byId[id], want, `ACC-PROACTIVE-03 ${id} default should be ${want}`);
    }
    assert.equal(m.DEFAULT_TOGGLES.late_night, false, 'ACC-PROACTIVE-04 late_night is off by default');
  });

  test('ACC-PROACTIVE-04 late_night stays silent at 23:30 unless switched on', async () => {
    const at = Date.parse('2026-08-22T23:30:00');
    const { p, emitted } = await rig();
    assert.equal(p.tick({ at, force: 'late_night' }).fired, null,
      'ACC-PROACTIVE-04 late_night fired while off by default');
    assert.equal(emitted.length, 0, 'ACC-PROACTIVE-04 nothing emitted');
  });

  test('ACC-PROACTIVE-10 late_night fires past 23:00 once switched on', async () => {
    const at = Date.parse('2026-08-22T23:30:00');
    const { p, emitted } = await rig({ toggles: { late_night: true } });
    assert.equal(p.tick({ at, force: 'late_night' }).fired, 'late_night', 'ACC-PROACTIVE-10');
    assert.equal(emitted.length, 1, 'ACC-PROACTIVE-10 emitted');
  });

  test('ACC-PROACTIVE-10 late_night does not fire at 22:00 even when on', async () => {
    const at = Date.parse('2026-08-22T22:00:00');
    const { p } = await rig({ toggles: { late_night: true } });
    assert.equal(p.tick({ at, force: 'late_night' }).fired, null, 'ACC-PROACTIVE-10 boundary');
  });

  test('ACC-PROACTIVE-04 idle_nudge fires only after 6 minutes of silence', async () => {
    const early = await rig({ state: { lastUserMessageAt: NOW - 5 * MIN } });
    assert.equal(early.p.tick({ at: NOW, force: 'idle_nudge' }).fired, null,
      'ACC-PROACTIVE-04 must not fire at 5 minutes');
    const late = await rig({ state: { lastUserMessageAt: NOW - 7 * MIN } });
    assert.equal(late.p.tick({ at: NOW, force: 'idle_nudge' }).fired, 'idle_nudge',
      'ACC-PROACTIVE-04 must fire at 7 minutes');
  });

  test('ACC-PROACTIVE-05 repeat_mistake needs the same misconception twice inside 14 days', async () => {
    const iso = (d) => new Date(NOW - d * DAY).toISOString().slice(0, 10);
    const mis = 'treats log of a sum as the sum of the logs';
    const withDates = (a, b) => defaultTutorData({
      'memory/session_memory.json': {
        schema_version: 3, session_number: 1, topic_stats: {},
        questions_attempted: [
          { id: 'q1', topic: 'logs', date: iso(a), misconception: mis },
          { id: 'q2', topic: 'logs', date: iso(b), misconception: mis },
        ],
        sessions: [], review_queue: [], misconceptions: [],
      },
    });
    const inside = await rig({ tutorData: withDates(2, 5) });
    assert.equal(inside.p.tick({ at: NOW, force: 'repeat_mistake' }).fired, 'repeat_mistake',
      'ACC-PROACTIVE-05 twice within 14 days must fire');

    const outside = await rig({ tutorData: withDates(2, 60) });
    assert.equal(outside.p.tick({ at: NOW, force: 'repeat_mistake' }).fired, null,
      'ACC-PROACTIVE-05 the second occurrence outside the 14-day window must not fire');

    const once = await rig({
      tutorData: defaultTutorData({
        'memory/session_memory.json': {
          schema_version: 3, session_number: 1, topic_stats: {},
          questions_attempted: [{ id: 'q1', topic: 'logs', date: iso(2), misconception: mis }],
          sessions: [], review_queue: [], misconceptions: [],
        },
      }),
    });
    assert.equal(once.p.tick({ at: NOW, force: 'repeat_mistake' }).fired, null,
      'ACC-PROACTIVE-05 a single occurrence must not fire');
  });

  test('ACC-PROACTIVE-06 avoided_topic needs accuracy < 60% AND untouched 21 days', async () => {
    const iso = (d) => new Date(NOW - d * DAY).toISOString().slice(0, 10);
    const tree = (correct, attempted, daysAgo) => defaultTutorData({
      'memory/session_memory.json': {
        schema_version: 3, session_number: 1,
        topic_stats: { logs: { attempted, correct } },
        questions_attempted: [{ id: 'q1', topic: 'logs', date: iso(daysAgo) }],
        sessions: [], review_queue: [], misconceptions: [],
      },
    });
    const both = await rig({ tutorData: tree(4, 10, 40) });            // 40%, 40 days
    assert.equal(both.p.tick({ at: NOW, force: 'avoided_topic' }).fired, 'avoided_topic',
      'ACC-PROACTIVE-06 both conditions must fire');

    const accurate = await rig({ tutorData: tree(9, 10, 40) });        // 90%, 40 days
    assert.equal(accurate.p.tick({ at: NOW, force: 'avoided_topic' }).fired, null,
      'ACC-PROACTIVE-06 stale but accurate must NOT fire');

    const recent = await rig({ tutorData: tree(4, 10, 3) });           // 40%, 3 days
    assert.equal(recent.p.tick({ at: NOW, force: 'avoided_topic' }).fired, null,
      'ACC-PROACTIVE-06 weak but recent must NOT fire');
  });

  test('ACC-PROACTIVE-08 session_debrief fires past 40 minutes, not before', async () => {
    const early = await rig({ state: { sessionElapsedMs: 30 * MIN } });
    assert.equal(early.p.tick({ at: NOW, force: 'session_debrief' }).fired, null,
      'ACC-PROACTIVE-08 must not fire at 30 minutes');
    const late = await rig({ state: { sessionElapsedMs: 45 * MIN } });
    assert.equal(late.p.tick({ at: NOW, force: 'session_debrief' }).fired, 'session_debrief',
      'ACC-PROACTIVE-08 must fire at 45 minutes');
  });

  test('ACC-PROACTIVE-09 exam_milestone fires at exactly 90/60/30/14/7/1 and nowhere else', async () => {
    for (const d of [90, 60, 30, 14, 7, 1]) {
      const { p } = await rig({ state: { daysToExam: d } });
      assert.equal(p.tick({ at: NOW, force: 'exam_milestone' }).fired, 'exam_milestone',
        `ACC-PROACTIVE-09 milestone ${d} should fire`);
    }
    for (const d of [91, 89, 45, 31, 15, 8, 2, 0]) {
      const { p } = await rig({ state: { daysToExam: d } });
      assert.equal(p.tick({ at: NOW, force: 'exam_milestone' }).fired, null,
        `ACC-PROACTIVE-09 non-milestone ${d} must NOT fire`);
    }
  });

  test('ACC-PROACTIVE-07 backlog_due fires off the backlog file', async () => {
    const due = defaultTutorData({
      'backlog.json': {
        items: [{ id: 'b1', ref: 'Q4', exam: 'TMUA 2019 P1', topic: 'logs', due: '2026-08-01', done: false }],
      },
    });
    const { p } = await rig({ tutorData: due });
    // dryRun so the macOS notification carried over from backlog.js is not fired.
    const r = p.tick({ at: NOW, force: 'backlog_due', dryRun: true });
    assert.equal(r.wouldFire, 'backlog_due', 'ACC-PROACTIVE-07 due item should trigger');

    const empty = await rig();
    assert.equal(empty.p.tick({ at: NOW, force: 'backlog_due', dryRun: true }).wouldFire, undefined,
      'ACC-PROACTIVE-07 nothing due must not trigger');
  });
});

describe('§B2 proactive switches, EXAM suppression and rate limit', () => {
  test('ACC-PROACTIVE-02/20 nothing fires when its own switch is off', async () => {
    const allOff = Object.fromEntries(TRIGGER_IDS.map((id) => [id, false]));
    const { p, emitted, queued } = await rig({
      toggles: allOff,
      state: { lastUserMessageAt: NOW - 30 * MIN, sessionElapsedMs: 120 * MIN, daysToExam: 30 },
    });
    for (const id of TRIGGER_IDS) {
      assert.equal(p.tick({ at: NOW, force: id }).fired, null,
        `ACC-PROACTIVE-02 ${id} fired with its switch off`);
    }
    assert.equal(p.tick({ at: NOW }).fired, null, 'ACC-PROACTIVE-20 a plain tick with all off is silent');
    assert.equal(emitted.length, 0, 'ACC-PROACTIVE-20 nothing emitted');
    assert.equal(queued.length, 0, 'ACC-PROACTIVE-20 nothing queued');
  });

  test('ACC-PROACTIVE-11/12 EXAM suppresses every trigger, switches on, conditions met', async () => {
    const { p, emitted, queued } = await rig({
      state: {
        mode: 'EXAM', gates: { proactiveEnabled: false },
        lastUserMessageAt: NOW - 30 * MIN, sessionElapsedMs: 120 * MIN, daysToExam: 7,
      },
      toggles: Object.fromEntries(TRIGGER_IDS.map((id) => [id, true])),
    });
    for (const id of TRIGGER_IDS) {
      const r = p.tick({ at: NOW, force: id });
      assert.equal(r.fired, null, `ACC-PROACTIVE-11 ${id} fired in EXAM mode`);
    }
    assert.equal(emitted.length, 0, 'ACC-PROACTIVE-11 nothing emitted in EXAM');
    assert.equal(queued.length, 0, 'ACC-PROACTIVE-11 nothing queued in EXAM');
  });

  test('ACC-PROACTIVE-13 the global limit is one interruption per 10 minutes', async () => {
    const { p, emitted } = await rig({
      toggles: { late_night: true },
      state: { daysToExam: 30 },
    });
    // First fire (a template trigger, so it lands on emit).
    const first = p.tick({ at: NOW });
    assert.ok(first.fired, 'setup: the first interruption fires');
    const emissionsAfterFirst = emitted.length;

    // Nine minutes later, with several other conditions still wide open.
    const second = p.tick({ at: NOW + 9 * MIN });
    assert.equal(second.fired, null,
      `ACC-PROACTIVE-13 a second interruption 9 minutes after ${first.fired} must be suppressed (got ${second.fired})`);
    assert.equal(emitted.length, emissionsAfterFirst, 'ACC-PROACTIVE-13 no further emission inside the floor');
  });

  test('ACC-PROACTIVE-14 a further interruption is allowed after 10 minutes', async () => {
    const { p } = await rig({
      state: { daysToExam: 30, lastUserMessageAt: NOW - 30 * MIN },
    });
    assert.ok(p.tick({ at: NOW }).fired, 'setup: something fires first');
    const later = p.tick({ at: NOW + 11 * MIN });
    assert.ok(later.fired, `ACC-PROACTIVE-14 nothing fired after the 10-minute floor expired (${later.reason})`);
  });

  test('ACC-PROACTIVE-15 cheap triggers emit a templated line and cost no model turn', async () => {
    const { p, emitted, queued } = await rig({ state: { daysToExam: 60 } });
    const r = p.tick({ at: NOW, force: 'exam_milestone' });
    assert.equal(r.fired, 'exam_milestone', 'setup');
    assert.equal(queued.length, 0,
      'ACC-PROACTIVE-15 a template trigger must NOT push a hidden instruction (that is a model turn)');
    assert.equal(emitted.length, 1, 'ACC-PROACTIVE-15 it goes out on emit');
    assert.equal(typeof emitted[0].text, 'string', 'ACC-PROACTIVE-15 with a templated line');
    assert.ok(emitted[0].text.length > 0, 'ACC-PROACTIVE-15 non-empty');
  });

  test('ACC-PROACTIVE-16 diagnostic triggers push a hidden instruction instead', async () => {
    const { p, emitted, queued } = await rig({ state: { lastUserMessageAt: NOW - 8 * MIN } });
    const r = p.tick({ at: NOW, force: 'idle_nudge' });
    assert.equal(r.fired, 'idle_nudge', 'setup');
    assert.equal(queued.length, 1, 'ACC-PROACTIVE-16 a diagnostic trigger queues an instruction');
    assert.equal(emitted.length, 0, 'ACC-PROACTIVE-16 and does not emit a canned line');
    assert.ok(queued[0].includes('idle_nudge'), 'ACC-PROACTIVE-16 the instruction names its trigger');
  });

  test('ACC-PROACTIVE-17 setToggles takes effect on the next tick', async () => {
    const at = Date.parse('2026-08-22T23:30:00');
    const { p } = await rig();
    assert.equal(p.tick({ at, force: 'late_night' }).fired, null, 'off to begin with');
    p.setToggles({ late_night: true });
    assert.equal(p.tick({ at, force: 'late_night' }).fired, 'late_night', 'ACC-PROACTIVE-17 on after setToggles');
    p.setToggles({ late_night: false });
    assert.equal(p.tick({ at: at + 60 * MIN, force: 'late_night' }).fired, null,
      'ACC-PROACTIVE-17 off again after setToggles');
  });

  test('ACC-PROACTIVE-19 the emitted event matches the {trigger, text, severity} payload', async () => {
    const { p, emitted } = await rig({ state: { daysToExam: 90 } });
    p.tick({ at: NOW, force: 'exam_milestone' });
    const e = emitted[0];
    assert.ok(e, 'ACC-PROACTIVE-19 an event was emitted');
    assert.equal(e.trigger, 'exam_milestone', 'ACC-PROACTIVE-19 trigger');
    assert.equal(typeof e.text, 'string', 'ACC-PROACTIVE-19 text');
    assert.ok(TRIGGER_IDS.includes(e.trigger), 'ACC-WS-05 trigger is one of the seven');
    assert.ok(e.severity != null, 'ACC-PROACTIVE-19 severity present');
    assert.equal(typeof e.severity, 'string', 'ACC-PROACTIVE-19 severity type');
  });
});

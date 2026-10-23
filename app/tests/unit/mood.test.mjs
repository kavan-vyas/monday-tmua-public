// ACC-STATE-* and ACC-MOOD-* — the mood engine against §C1 and §B2.
// Conditions are forced through computeState's documented `snapshot` override hook,
// so nothing here depends on what happens to be on disk.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { assertMondayState, MOODS, PRECEDENCE } from '../helpers/assertions.mjs';

let sbx, mood;
const AT = Date.parse('2026-08-22T09:12:00');           // a Saturday morning, well clear of 22:30
const MIN = 60000;
const CONFIG = { examDate: '2026-10-01', mode: 'DRILL' };

/** A snapshot that satisfies NO mood condition — the `focused` baseline. */
const CALM = {
  sessionStartedAt: AT - 5 * MIN,
  sessionElapsedMs: 5 * MIN,
  hour: 9.2,
  streak: 0,
  beaten: 0,
  elegant: false,
  lastUserText: 'How do I integrate x squared?',
  daysToExam: 200,
  backlogDue: 0,
  sessionAccuracy: { correct: 1, total: 2 },
  lesson: 14,
  lastSessionDate: '2026-08-20',
  noRecord: true,
};

const onTrack = { overall: 88, projected: 8.8, target: 9, trajectory: 8.2, onTrack: true, weakest: [], examDate: '2026-10-01' };
const behind = { overall: 30, projected: 3.6, target: 9, trajectory: 8.6, onTrack: false, weakest: [], examDate: '2026-10-01' };

before(async () => {
  sbx = makeSandbox({ tag: 'mood' });
  mood = await sbx.imp('mood.js');
});
after(() => sbx.dispose());
beforeEach(() => mood.resetMoodMemory());

/** One-shot compute with hysteresis disabled, so a case cannot leak into the next. */
const at = (snapshot, opts = {}) => mood.computeState({
  chat: opts.chat ?? null, config: { ...CONFIG, ...(opts.config ?? {}) },
  now: opts.now ?? AT, advance: false,
  snapshot: { ...CALM, readiness: onTrack, ...snapshot },
});

describe('§C1 MondayState shape', () => {
  test('ACC-STATE-01..11 every documented field is present with its documented type', () => {
    assertMondayState(at({}));
  });

  test('ACC-STATE-07 streak is signed — negative for a wrong run', () => {
    assert.equal(at({ streak: -3 }).streak, -3, 'ACC-STATE-07');
    assert.equal(at({ streak: 6 }).streak, 6, 'ACC-STATE-07');
  });

  test('ACC-STATE-10 lastSessionDate is string|null, never undefined', () => {
    const s = at({ lastSessionDate: null });
    assert.equal(s.lastSessionDate, null, 'ACC-STATE-10');
    assert.notEqual(typeof s.lastSessionDate, 'undefined', 'ACC-STATE-10');
  });

  test('ACC-STATE-12 same inputs and same `now` give the same answer', () => {
    const a = at({});
    const b = at({});
    assert.equal(a.mood, b.mood, 'ACC-STATE-12 mood');
    assert.equal(a.mode, b.mode, 'ACC-STATE-12 mode');
    assert.equal(a.daysToExam, b.daysToExam, 'ACC-STATE-12 daysToExam');
  });

  test('ACC-STATE-13 tolerates a minimal call with no chat', () => {
    assert.doesNotThrow(() => mood.computeState({ config: CONFIG, now: AT, advance: false, snapshot: { noRecord: true } }),
      'ACC-STATE-13');
  });
});

describe('§B2 mood triggers', () => {
  test('ACC-MOOD-01 exactly the six moods are reachable and MOOD_COLORS covers them', () => {
    assert.deepEqual(Object.keys(mood.MOOD_COLORS).sort(), [...MOODS].sort(), 'ACC-MOOD-01/18');
  });

  test('ACC-MOOD-02 focused is the default when nothing else fires', () => {
    assert.equal(at({}).mood, 'focused', 'ACC-MOOD-02');
  });

  test('ACC-MOOD-03 sharp on a correct streak over already-beaten material', () => {
    // The spec's own worked example: streak +6, all difficulty <= 2 -> sharp.
    assert.equal(at({ streak: 6, beaten: 1 }).mood, 'sharp', 'ACC-MOOD-03');
  });

  test('ACC-MOOD-04 gentle on three wrong in a row', () => {
    const s = at({ streak: -3 });
    assert.equal(s.mood, 'gentle', 'ACC-MOOD-04');
  });

  test('ACC-MOOD-05 gentle once the session is past 90 minutes', () => {
    assert.equal(at({ sessionElapsedMs: 91 * MIN }).mood, 'gentle', 'ACC-MOOD-05');
    assert.equal(at({ sessionElapsedMs: 60 * MIN }).mood, 'focused',
      'ACC-MOOD-05 must NOT fire below 90 minutes');
  });

  test('ACC-MOOD-06 gentle after 22:30', () => {
    assert.equal(at({ hour: 22.6 }).mood, 'gentle', 'ACC-MOOD-06 at 22:36');
    assert.equal(at({ hour: 22.0 }).mood, 'focused', 'ACC-MOOD-06 must not fire at 22:00');
  });

  test('ACC-MOOD-07 clinical in EXAM mode', () => {
    assert.equal(at({}, { config: { mode: 'EXAM' } }).mood, 'clinical', 'ACC-MOOD-07');
  });

  test('ACC-MOOD-08 wry on off-topic input and on banter', () => {
    assert.equal(at({ lastUserText: 'what did you think of the football last night' }).mood, 'wry',
      'ACC-MOOD-08 off-topic');
    assert.equal(at({ elegant: true }).mood, 'wry', 'ACC-MOOD-08 elegant method');
  });

  test('ACC-MOOD-09 grave needs BOTH under 30 days AND readiness off trajectory', () => {
    assert.equal(at({ daysToExam: 20, readiness: behind }).mood, 'grave',
      'ACC-MOOD-09 both conditions');
    assert.equal(at({ daysToExam: 20, readiness: onTrack }).mood, 'focused',
      'ACC-MOOD-09 inside 30 days but on track must NOT be grave');
    assert.equal(at({ daysToExam: 120, readiness: behind }).mood, 'focused',
      'ACC-MOOD-09 behind but far out must NOT be grave');
  });

  test('ACC-MOOD-17 the reason names the condition that actually fired', () => {
    assert.match(at({ streak: -3 }).reason, /3|wrong/i, 'ACC-MOOD-17 gentle-by-streak reason');
    assert.match(at({ sessionElapsedMs: 100 * MIN }).reason, /minute/i, 'ACC-MOOD-17 gentle-by-length reason');
    assert.match(at({ streak: 6, beaten: 1 }).reason, /6|row/i, 'ACC-MOOD-17 sharp reason');
    assert.match(at({}, { config: { mode: 'EXAM' } }).reason, /EXAM/i, 'ACC-MOOD-17 clinical reason');
  });
});

describe('§B2 precedence — clinical > grave > gentle > sharp > wry > focused', () => {
  const rank = (m) => PRECEDENCE.indexOf(m);

  test('ACC-MOOD-11 EXAM plus three wrong in a row is clinical, not gentle', () => {
    assert.equal(at({ streak: -3 }, { config: { mode: 'EXAM' } }).mood, 'clinical', 'ACC-MOOD-11');
  });

  test('ACC-MOOD-12 grave beats sharp', () => {
    assert.equal(at({ streak: 6, beaten: 1, daysToExam: 10, readiness: behind }).mood, 'grave', 'ACC-MOOD-12');
  });

  test('ACC-MOOD-13 gentle beats sharp', () => {
    // A long session and a hot streak at once: the fatigue reading wins.
    assert.equal(at({ streak: 6, beaten: 1, sessionElapsedMs: 100 * MIN }).mood, 'gentle', 'ACC-MOOD-13');
  });

  test('ACC-MOOD-14 sharp beats wry', () => {
    assert.equal(at({ streak: 6, beaten: 1, elegant: true }).mood, 'sharp', 'ACC-MOOD-14');
  });

  test('ACC-MOOD-10 every pair of simultaneous conditions resolves to the higher-precedence mood', () => {
    const conds = {
      clinical: [{}, { config: { mode: 'EXAM' } }],
      grave: [{ daysToExam: 10, readiness: behind }, {}],
      gentle: [{ sessionElapsedMs: 100 * MIN }, {}],
      sharp: [{ streak: 6, beaten: 1 }, {}],
      wry: [{ elegant: true }, {}],
    };
    for (const [a, [sa, oa]] of Object.entries(conds)) {
      for (const [b, [sb, ob]] of Object.entries(conds)) {
        if (a === b) continue;
        const winner = rank(a) < rank(b) ? a : b;
        const got = at({ ...sa, ...sb }, { config: { ...(oa.config ?? {}), ...(ob.config ?? {}) } }).mood;
        assert.equal(got, winner, `ACC-MOOD-10 ${a}+${b} should resolve to ${winner}, got ${got}`);
      }
    }
  });
});

describe('§B2 hysteresis — a mood holds >= 2 turns', () => {
  const chat = { id: 'hyst-1', createdAt: AT - 10 * MIN, transcript: [] };
  const turn = (snapshot, opts = {}) => mood.computeState({
    chat, config: { ...CONFIG, ...(opts.config ?? {}) }, now: AT, advance: true,
    snapshot: { ...CALM, readiness: onTrack, ...snapshot },
  });

  test('ACC-MOOD-15 a mood is not replaced on the very next turn by a weaker one', () => {
    const t1 = turn({ streak: -3 });
    assert.equal(t1.mood, 'gentle', 'turn 1 sets gentle');
    const t2 = turn({ streak: 0 });
    assert.equal(t2.reason, t1.reason, 'ACC-MOOD-15 the held reason travels with the held mood');
    assert.equal(t2.mood, 'gentle',
      'ACC-MOOD-15 gentle must hold into turn 2 even though the condition has cleared');
  });

  test('ACC-MOOD-15 the hold does not last for ever — it releases after the minimum', () => {
    turn({ streak: -3 });
    turn({ streak: 0 });
    const t3 = turn({ streak: 0 });
    assert.equal(t3.mood, 'focused',
      'ACC-MOOD-15 after the >=2-turn hold, a cleared condition must be allowed to release');
  });

  test('ACC-MOOD-16 a strictly higher-precedence mood overrides the hold immediately', () => {
    assert.equal(turn({ streak: 6, beaten: 1 }).mood, 'sharp', 'turn 1 sets sharp');
    assert.equal(turn({ streak: 6, beaten: 1 }, { config: { mode: 'EXAM' } }).mood, 'clinical',
      'ACC-MOOD-16 EXAM must flip to clinical on the very next turn');
  });

  test('ACC-MOOD-16 gentle overrides a held sharp immediately', () => {
    assert.equal(turn({ streak: 6, beaten: 1 }).mood, 'sharp', 'turn 1 sets sharp');
    assert.equal(turn({ streak: -3 }).mood, 'gentle',
      'ACC-MOOD-16 gentle is higher precedence than sharp and must not be held off');
  });
});

describe('§B2 mood is per-turn, not frozen into the prompt', () => {
  test('ACC-MOOD-40 the system prompt carries no mood value', async () => {
    const { buildSystemPrompt } = await sbx.imp('prompt.js');
    const p = buildSystemPrompt();
    for (const m of MOODS) {
      assert.ok(!new RegExp(`mood\\s*[:=]\\s*['"\`]?${m}`, 'i').test(p),
        `ACC-MOOD-40 the frozen system prompt names a concrete mood (${m})`);
    }
  });
});

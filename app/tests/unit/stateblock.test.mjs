// ACC-MOOD-30..39 — the <monday-state> preamble format, from §B2's worked example.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/sandbox.mjs';

let sbx, mood;
before(async () => { sbx = makeSandbox({ tag: 'blk' }); mood = await sbx.imp('mood.js'); });
after(() => sbx.dispose());

const STATE = {
  mood: 'sharp',
  reason: '6 correct in a row, all difficulty <= 2',
  mode: 'DRILL',
  lesson: 14,
  sessionElapsedMs: 34 * 60000,
  daysToExam: 55,
  streak: 6,
  sessionAccuracy: { correct: 6, total: 6 },
  rolling20: 71,
  backlogDue: 3,
  lastSessionDate: '2026-08-19',
  readiness: {
    overall: 68, projected: 6.8, target: 9, trajectory: 8.2, onTrack: false,
    weakest: [{ topic: 'sequences_and_series', score: 41 }, { topic: 'logarithms', score: 52 }],
    examDate: '2026-10-15',
  },
  at: Date.parse('2026-08-21T09:12:00'),
};

describe('§B2 <monday-state> block', () => {
  const block = () => mood.renderStateBlock(STATE);

  test('ACC-MOOD-30 opens and closes with the monday-state tags', () => {
    const b = block();
    assert.ok(b.startsWith('<monday-state>'), 'ACC-MOOD-30 opening tag');
    assert.ok(b.trimEnd().endsWith('</monday-state>'), 'ACC-MOOD-30 closing tag');
  });

  test('ACC-MOOD-31 carries the mood and a parenthesised (why: ...) reason', () => {
    const b = block();
    assert.match(b, /^mood:\s+sharp\s+\(why: .+\)$/m, 'ACC-MOOD-31');
    assert.ok(b.includes(STATE.reason), 'ACC-MOOD-31 the real reason string appears verbatim');
  });

  test('ACC-MOOD-32 carries the mode', () => {
    assert.match(block(), /^mode:\s+DRILL$/m, 'ACC-MOOD-32');
  });

  test('ACC-MOOD-33 reports lesson, session elapsed and local time', () => {
    const b = block();
    assert.match(b, /lesson:\s*14/, 'ACC-MOOD-33 lesson');
    assert.match(b, /session elapsed:\s*34m/, 'ACC-MOOD-33 session elapsed');
    assert.match(b, /local time:\s*\d{2}:\d{2}/, 'ACC-MOOD-33 local time');
  });

  test('ACC-MOOD-34 reports the exam date beside the days-out count', () => {
    const b = block();
    assert.match(b, /exam:\s*\d{4}-\d{2}-\d{2}\s+55 days out/, 'ACC-MOOD-34');
    // The two must agree: printing one date beside a count derived from another is a lie.
    assert.ok(b.includes(STATE.readiness.examDate),
      `ACC-MOOD-34 the block prints an exam date other than the state's (${STATE.readiness.examDate})`);
  });

  test('ACC-MOOD-35 reports a signed streak and the session accuracy', () => {
    const b = block();
    assert.match(b, /streak:\s*\+6/, 'ACC-MOOD-35 signed streak');
    assert.match(b, /session accuracy:\s*6\/6/, 'ACC-MOOD-35 accuracy');
  });

  test('ACC-MOOD-35 a negative streak keeps its sign', () => {
    assert.match(mood.renderStateBlock({ ...STATE, streak: -3 }), /streak:\s*-3/, 'ACC-MOOD-35');
  });

  test('ACC-MOOD-36 reports backlog due and last session', () => {
    const b = block();
    assert.match(b, /backlog due:\s*3/, 'ACC-MOOD-36 backlog');
    assert.match(b, /last session:\s*2026-08-19/, 'ACC-MOOD-36 last session');
  });

  test('ACC-MOOD-37 reports readiness as N/100 with the weakest topics', () => {
    const b = block();
    assert.match(b, /readiness:\s*68\/100/, 'ACC-MOOD-37 N/100');
    assert.match(b, /weakest:/, 'ACC-MOOD-37 weakest list');
    assert.match(b, /41/, 'ACC-MOOD-37 weakest scores');
  });

  test('ACC-MOOD-38 stays inside the ~120-token budget', () => {
    const b = block();
    assert.ok(b.length <= 900, `ACC-MOOD-38 block is ${b.length} chars, budget is ~900 (~120 tokens)`);
  });

  test('ACC-MOOD-39 every printed value is the state\'s own value, not a placeholder', () => {
    const b = mood.renderStateBlock({ ...STATE, lesson: 99, backlogDue: 7, streak: -2, daysToExam: 3 });
    assert.match(b, /lesson:\s*99/, 'ACC-MOOD-39 lesson tracks the state');
    assert.match(b, /backlog due:\s*7/, 'ACC-MOOD-39 backlog tracks the state');
    assert.match(b, /streak:\s*-2/, 'ACC-MOOD-39 streak tracks the state');
    assert.match(b, /3 days out/, 'ACC-MOOD-39 countdown tracks the state');
  });

  test('ACC-MOOD-30 renders without throwing on a bare/partial state', () => {
    assert.doesNotThrow(() => mood.renderStateBlock({}), 'ACC-MOOD-30 partial state');
    assert.doesNotThrow(() => mood.renderStateBlock(undefined), 'ACC-MOOD-30 no state');
  });
});

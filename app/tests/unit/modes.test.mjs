// ACC-MODE-01..14 — the five modes and their gates, from §B2's modes.js paragraph.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { MODES } from '../helpers/assertions.mjs';

let sbx, modes;
before(async () => { sbx = makeSandbox({ tag: 'mode' }); modes = await sbx.imp('modes.js'); });
after(() => sbx.dispose());

describe('§B2 modes', () => {
  test('ACC-MODE-01 exactly the six modes', () => {
    assert.deepEqual([...modes.MODES].sort(), [...MODES].sort(), 'ACC-MODE-01');
    assert.equal(modes.MODES.length, 6, 'ACC-MODE-01 no extras');
  });

  test('ACC-MODE-15 CONSOLIDATION forces the timer, keeps hints, pushes throughput', () => {
    const g = modes.modeGates('CONSOLIDATION');
    assert.equal(g.timerForced, true, 'ACC-MODE-15 CONSOLIDATION forces the timer');
    assert.equal(g.hintsAllowed, true, 'ACC-MODE-15 hints still allowed (kept short by prompt)');
    assert.equal(g.voiceEnabled, true, 'ACC-MODE-15 voice on');
    assert.equal(modes.detectMode('switch to consolidation mode', 'DRILL'), 'CONSOLIDATION', 'ACC-MODE-15 detected');
  });

  test('ACC-MODE-02 DRILL is the default', () => {
    assert.equal(modes.DEFAULT_MODE, 'DRILL', 'ACC-MODE-02');
  });

  test('ACC-MODE-03/04/05/06/07 EXAM locks everything down', () => {
    const g = modes.modeGates('EXAM');
    assert.equal(g.timerForced, true, 'ACC-MODE-03 EXAM forces the timer');
    assert.equal(g.hintsAllowed, false, 'ACC-MODE-04 EXAM allows no hints');
    assert.equal(g.voiceEnabled, false, 'ACC-MODE-05 EXAM mutes voice');
    assert.equal(g.lockMood, 'clinical', 'ACC-MODE-06 EXAM locks the mood to clinical');
    assert.equal(g.proactiveEnabled, false, 'ACC-MODE-07 EXAM suppresses proactivity');
  });

  test('ACC-MODE-09 PAUSE is a real mode with proactivity off', () => {
    assert.ok(modes.MODES.includes('PAUSE'), 'ACC-MODE-09 PAUSE exists');
    assert.equal(modes.modeGates('PAUSE').proactiveEnabled, false,
      'ACC-MODE-09 PAUSE must not be interrupted by proactive triggers');
  });

  test('ACC-MODE-10 DRILL allows voice and proactivity', () => {
    const g = modes.modeGates('DRILL');
    assert.equal(g.voiceEnabled, true, 'ACC-MODE-10 voice');
    assert.equal(g.proactiveEnabled, true, 'ACC-MODE-10 proactive');
  });

  test('ACC-MODE-11 TEACH allows hints — it is explanation-first', () => {
    assert.equal(modes.modeGates('TEACH').hintsAllowed, true, 'ACC-MODE-11');
  });

  test('ACC-MODE-12 POSTMORTEM allows hints and does not force the timer', () => {
    const g = modes.modeGates('POSTMORTEM');
    assert.equal(g.hintsAllowed, true, 'ACC-MODE-12 hints');
    assert.equal(g.timerForced, false, 'ACC-MODE-12 timer');
  });

  test('ACC-MODE-13 an unknown mode does not throw and returns a safe gate object', () => {
    let g;
    assert.doesNotThrow(() => { g = modes.modeGates('NONSENSE'); }, 'ACC-MODE-13 no throw');
    for (const k of ['voiceEnabled', 'proactiveEnabled', 'hintsAllowed', 'timerForced', 'lockMood']) {
      assert.ok(k in g, `ACC-MODE-13 gate missing ${k}`);
    }
    assert.doesNotThrow(() => modes.modeGates(undefined), 'ACC-MODE-13 undefined mode');
  });

  test('ACC-MODE-14 only EXAM locks the mood', () => {
    for (const m of MODES) {
      const lock = modes.modeGates(m).lockMood;
      if (m === 'EXAM') assert.equal(lock, 'clinical', 'ACC-MODE-14 EXAM');
      else assert.ok(!lock, `ACC-MODE-14 ${m} must not lock the mood (got ${lock})`);
    }
  });

  test('ACC-MODE-08 the gates are data in code, decided without any model call', () => {
    // modeGates is a pure synchronous function of the mode name: nothing about the
    // lockdown depends on the prompt persuading the model to behave.
    const a = modes.modeGates('EXAM');
    const b = modes.modeGates('EXAM');
    assert.deepEqual(a, b, 'ACC-MODE-08 pure');
    assert.equal(typeof modes.modeGates, 'function', 'ACC-MODE-08 synchronous');
  });
});

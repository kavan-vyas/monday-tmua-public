// ACC-C2-01..16 — §C2 exported module surface.
// Every expected symbol name and arity is taken from plangamma.md §C2.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { MOODS, MODES } from '../helpers/assertions.mjs';

let sbx;
before(() => { sbx = makeSandbox({ tag: 'c2' }); });
after(() => sbx.dispose());

describe('§C2 module interfaces', () => {
  test('ACC-C2-01/02/03 mood.js exports computeState, renderStateBlock, MOOD_COLORS', async () => {
    const m = await sbx.imp('mood.js');
    assert.equal(typeof m.computeState, 'function', 'ACC-C2-01');
    assert.equal(typeof m.renderStateBlock, 'function', 'ACC-C2-02');
    assert.equal(typeof m.renderStateBlock({}), 'string', 'ACC-C2-02 returns string');

    assert.equal(typeof m.MOOD_COLORS, 'object', 'ACC-C2-03 MOOD_COLORS present');
    for (const mood of MOODS) {
      const c = m.MOOD_COLORS[mood];
      assert.ok(c, `ACC-C2-03 MOOD_COLORS.${mood} missing`);
      assert.equal(typeof c.light, 'string', `ACC-C2-03 MOOD_COLORS.${mood}.light`);
      assert.equal(typeof c.dark, 'string', `ACC-C2-03 MOOD_COLORS.${mood}.dark`);
    }
  });

  test('ACC-C2-04/05/06 modes.js exports MODES and modeGates', async () => {
    const m = await sbx.imp('modes.js');
    assert.ok(Array.isArray(m.MODES), 'ACC-C2-04 MODES is an array');
    assert.deepEqual([...m.MODES].sort(), [...MODES].sort(), 'ACC-C2-04 the five modes');

    assert.equal(typeof m.modeGates, 'function', 'ACC-C2-05');
    for (const mode of MODES) {
      const g = m.modeGates(mode);
      for (const k of ['voiceEnabled', 'proactiveEnabled', 'hintsAllowed', 'timerForced', 'lockMood']) {
        assert.ok(k in g, `ACC-C2-05 ${mode} gate missing ${k}`);
      }
      for (const k of ['voiceEnabled', 'proactiveEnabled', 'hintsAllowed', 'timerForced']) {
        assert.equal(typeof g[k], 'boolean', `ACC-C2-06 ${mode}.${k} must be boolean`);
      }
      assert.ok(g.lockMood == null || MOODS.includes(g.lockMood),
        `ACC-C2-06 ${mode}.lockMood must be a mood or falsy, got ${g.lockMood}`);
    }
  });

  test('ACC-C2-07 readiness.js exports async computeReadiness with the topics array', async () => {
    const m = await sbx.imp('readiness.js');
    assert.equal(typeof m.computeReadiness, 'function', 'ACC-C2-07');
    const p = m.computeReadiness();
    assert.ok(p instanceof Promise, 'ACC-C2-07 computeReadiness must be async');
    const r = await p;
    for (const k of ['overall', 'projected', 'weakest', 'topics']) {
      assert.ok(k in r, `ACC-C2-07 readiness.${k} missing`);
    }
    assert.ok(Array.isArray(r.topics) && r.topics.length > 0, 'ACC-C2-07 topics[]');
    for (const t of r.topics) {
      for (const k of ['topic', 'score', 'attempted', 'available', 'accuracy', 'lastSeen']) {
        assert.ok(k in t, `ACC-C2-07 topics[].${k} missing on ${t.topic}`);
      }
    }
  });

  test('ACC-C2-08/09/10/11 mondaymem.js exports the four handlers', async () => {
    const m = await sbx.imp('mondaymem.js');
    assert.equal(typeof m.mondayRecall, 'function', 'ACC-C2-08');
    assert.equal(typeof m.mondayNote, 'function', 'ACC-C2-09');
    assert.equal(typeof m.mondaySelf, 'function', 'ACC-C2-10');
    assert.equal(typeof m.readSelfModel, 'function', 'ACC-C2-11');

    assert.ok(m.mondayRecall({ kind: 'all' }) instanceof Promise, 'ACC-C2-08 async');
    assert.ok(m.mondaySelf() instanceof Promise, 'ACC-C2-10 async');
    assert.equal(typeof m.readSelfModel(), 'string', 'ACC-C2-11 returns string');
  });

  test('ACC-C2-12/13 prompt.js buildSystemPrompt takes no persona argument', async () => {
    const m = await sbx.imp('prompt.js');
    assert.equal(typeof m.buildSystemPrompt, 'function', 'ACC-C2-12');
    assert.equal(m.buildSystemPrompt.length, 0,
      `ACC-C2-12 buildSystemPrompt must take no argument, arity is ${m.buildSystemPrompt.length}`);
    assert.equal(typeof m.buildSystemPrompt(), 'string', 'ACC-C2-12 returns string');

    for (const gone of ['PERSONAS', 'PERSONA_BLOCKS', 'DEFAULT_PERSONA']) {
      assert.equal(m[gone], undefined, `ACC-C2-13 prompt.js still exports ${gone}`);
    }
  });

  test('ACC-C2-14 buildSystemPrompt folds in the self model and the master prompt', async () => {
    const m = await sbx.imp('prompt.js');
    const out = m.buildSystemPrompt();
    assert.ok(out.includes('I am the assistant that runs this tutor.'),
      'ACC-C2-14 self_model.md content missing from the system prompt');
    assert.ok(out.includes('MASTER PROMPT FIXTURE'),
      'ACC-C2-14 master prompt content missing from the system prompt');
  });

  test('ACC-C2-15 proactive.js createProactive returns tick/setToggles/TRIGGERS', async () => {
    const m = await sbx.imp('proactive.js');
    assert.equal(typeof m.createProactive, 'function', 'ACC-C2-15');
    const p = m.createProactive({ emit() {}, queueInstruction() {}, getState: () => ({}) });
    assert.equal(typeof p.tick, 'function', 'ACC-C2-15 tick');
    assert.equal(typeof p.setToggles, 'function', 'ACC-C2-15 setToggles');
    assert.ok(p.TRIGGERS, 'ACC-C2-15 TRIGGERS');
  });

  test('ACC-C2-16 voice.js exports the six lifecycle functions', async () => {
    const v = await sbx.imp('voice.js');
    for (const [name, kind] of [
      ['startVoice', 'function'], ['speak', 'function'], ['cancelSpeech', 'function'],
      ['warmLineBank', 'function'], ['voiceReady', 'function'], ['stopVoice', 'function'],
    ]) {
      assert.equal(typeof v[name], kind, `ACC-C2-16 voice.js must export ${name}`);
    }
    assert.equal(typeof v.voiceReady(), 'boolean', 'ACC-C2-16 voiceReady() returns boolean');
  });
});

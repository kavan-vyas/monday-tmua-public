// ACC-SET-01..20 — the settings config contract.
//
// mergeConfig() is the ONLY door into `config`, and everything past it — the
// voice worker, the proactive rate limit, the readiness target, the shell's own
// appearance — trusts what it finds there. So this file is about one question:
// can a client put something in that config that the server did not agree to?
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { TRIGGER_IDS, MOODS } from '../helpers/assertions.mjs';

const boxes = [];
after(() => boxes.forEach((b) => b.dispose()));

let S;
const box = makeSandbox({ tag: 'set-cfg' });
boxes.push(box);
S = await box.imp('session.js');

const { mergeConfig, DEFAULT_CONFIG } = S;
/** A patch applied to a pristine default config. */
const patch = (p) => mergeConfig(DEFAULT_CONFIG, p);

describe('the shape of a config', () => {
  test('ACC-SET-01 the default config carries every settings block', () => {
    for (const k of ['model', 'effort', 'mode', 'voice', 'speech', 'proactive',
      'proactiveEnabled', 'proactiveRateLimitMin', 'examDate', 'targetScore', 'appearance']) {
      assert.ok(k in DEFAULT_CONFIG, `ACC-SET-01 DEFAULT_CONFIG is missing ${k}`);
    }
  });

  test('ACC-SET-02 config.voice stays exactly { enabled, volume } — §C4 fixes that block', () => {
    assert.deepEqual(Object.keys(patch({}).voice).sort(), ['enabled', 'volume'],
      'ACC-SET-02 a new knob was added to config.voice; the prosody settings belong in config.speech');
  });

  test('ACC-SET-03 config.speech carries a rate, a long-form gate and one prosody entry per mood', () => {
    const sp = patch({}).speech;
    assert.equal(sp.rate, 1, 'ACC-SET-03 default rate is the untouched preset');
    assert.equal(sp.longForm, true, 'ACC-SET-03 long explanations are spoken by default');
    assert.equal(typeof sp.maxChars, 'number', 'ACC-SET-03 maxChars');
    assert.deepEqual(Object.keys(sp.prosody).sort(), [...MOODS].sort(),
      'ACC-SET-03 prosody must have exactly one entry per mood');
    for (const m of MOODS) {
      assert.deepEqual(sp.prosody[m], { rate: 1, pause: 1 },
        `ACC-SET-03 ${m} must default to the tts/prosody.py preset, unscaled`);
    }
  });
});

describe('nothing from the client is trusted', () => {
  test('ACC-SET-04 a key the client invents is dropped', () => {
    const c = patch({ evil: 'payload', __proto__: { x: 1 }, tokens: 'x'.repeat(1000) });
    assert.ok(!('evil' in c), 'ACC-SET-04 an unknown patch key was stored');
    assert.ok(!('tokens' in c), 'ACC-SET-04 the config can be used as client scratch storage');
  });

  test('ACC-SET-05 a key already in the stored state is carried — §C4 loses nothing but persona', () => {
    const stored = { ...DEFAULT_CONFIG, somethingFromAFutureBuild: 42, persona: 'bubbly' };
    const c = mergeConfig(stored, {});
    assert.equal(c.somethingFromAFutureBuild, 42, 'ACC-SET-05 a stored unknown key was dropped');
    assert.ok(!('persona' in c), 'ACC-SET-05 persona is the one key the migration destroys');
  });

  test('ACC-SET-06 an unknown model or effort cannot be smuggled into the SDK options', () => {
    assert.equal(patch({ model: 'gpt-4' }).model, DEFAULT_CONFIG.model, 'ACC-SET-06 model');
    assert.equal(patch({ effort: 'infinite' }).effort, DEFAULT_CONFIG.effort, 'ACC-SET-06 effort');
    assert.equal(patch({ model: 'opus' }).model, 'opus', 'ACC-SET-06 a real model still works');
  });

  test('ACC-SET-07 an unknown mode falls back rather than unlocking anything', () => {
    assert.equal(patch({ mode: 'GODMODE' }).mode, DEFAULT_CONFIG.mode, 'ACC-SET-07');
    assert.equal(patch({ mode: 'exam' }).mode, 'EXAM', 'ACC-SET-07 case is normalised, not rejected');
  });

  test('ACC-SET-08 only the seven known proactive triggers can exist', () => {
    const c = patch({ proactive: { made_up_trigger: true, idle_nudge: false } });
    assert.deepEqual(Object.keys(c.proactive).sort(), [...TRIGGER_IDS].sort(),
      'ACC-SET-08 a client invented an eighth trigger');
    assert.equal(c.proactive.idle_nudge, false, 'ACC-SET-08 a real switch still writes');
  });

  test('ACC-SET-09 only the six real moods can carry prosody', () => {
    const c = patch({ speech: { prosody: { seductive: { rate: 2 }, sharp: { rate: 1.2 } } } });
    assert.ok(!('seductive' in c.speech.prosody), 'ACC-SET-09 an invented mood was stored');
    assert.equal(c.speech.prosody.sharp.rate, 1.2, 'ACC-SET-09 a real mood still writes');
  });

  test('ACC-SET-10 a switch that is not a boolean is not a switch', () => {
    assert.equal(patch({ voice: { enabled: 'yes' } }).voice.enabled, DEFAULT_CONFIG.voice.enabled,
      'ACC-SET-10 a truthy string was accepted as a boolean');
    assert.equal(patch({ proactiveEnabled: 1 }).proactiveEnabled, true,
      'ACC-SET-10 proactiveEnabled must keep its stored value, not coerce');
    assert.equal(patch({ proactiveEnabled: false }).proactiveEnabled, false, 'ACC-SET-10 a real false works');
  });
});

describe('every number is clamped to its own range', () => {
  const cases = [
    ['voice.volume', (v) => patch({ voice: { volume: v } }).voice.volume, [[5, 1], [-3, 0], [0.35, 0.35]]],
    ['speech.rate', (v) => patch({ speech: { rate: v } }).speech.rate, [[99, 1.4], [0.01, 0.6], [1.15, 1.15]]],
    ['speech.maxChars', (v) => patch({ speech: { maxChars: v } }).speech.maxChars, [[1e9, 4000], [1, 80], [900.6, 901]]],
    ['proactiveRateLimitMin', (v) => patch({ proactiveRateLimitMin: v }).proactiveRateLimitMin, [[0, 1], [10000, 240], [25, 25]]],
    ['targetScore', (v) => patch({ targetScore: v }).targetScore, [[50, 9], [-1, 1], [7.5, 7.5]]],
  ];
  for (const [name, get, table] of cases) {
    test(`ACC-SET-11 ${name} is clamped, not stored as sent`, () => {
      for (const [sent, want] of table) {
        assert.equal(get(sent), want, `ACC-SET-11 ${name}: ${sent} should clamp to ${want}`);
      }
    });
  }

  test('ACC-SET-12 a non-numeric value keeps what was already stored', () => {
    const stored = patch({ voice: { volume: 0.4 }, targetScore: 7 });
    const after = mergeConfig(stored, { voice: { volume: 'loud' }, targetScore: null });
    assert.equal(after.voice.volume, 0.4,
      'ACC-SET-12 a malformed write reset a real setting — it must fall back to the stored value first');
    assert.equal(after.targetScore, 7, 'ACC-SET-12 targetScore');
  });

  test('ACC-SET-13 numbers are snapped to the slider step, so a round trip is stable', () => {
    const once = patch({ voice: { volume: 0.30000000000000004 }, targetScore: 8.25 });
    const twice = mergeConfig(once, {});
    assert.deepEqual(twice, once, 'ACC-SET-13 re-merging a stored config changed it');
    assert.equal(once.targetScore, 8.3, 'ACC-SET-13 targetScore snapped to 0.1');
  });
});

describe('the exam date is a date', () => {
  const bad = ['', 'tomorrow', '2026-13-01', '2026-02-30', '12/10/2026', '2026-10-12T09:00:00Z', null, 42];
  test('ACC-SET-14 a string that is not a real YYYY-MM-DD date is refused', () => {
    for (const v of bad) {
      assert.equal(patch({ examDate: v }).examDate, DEFAULT_CONFIG.examDate,
        `ACC-SET-14 "${v}" was accepted as an exam date`);
    }
  });
  test('ACC-SET-15 a real date is kept exactly', () => {
    assert.equal(patch({ examDate: '2027-01-09' }).examDate, '2027-01-09', 'ACC-SET-15');
    assert.equal(patch({ examDate: '2026-02-29' }).examDate, DEFAULT_CONFIG.examDate,
      'ACC-SET-15 2026 is not a leap year — that date does not exist');
  });
});

describe('appearance', () => {
  test('ACC-SET-16 theme, density and font size are enums', () => {
    const c = patch({ appearance: { theme: 'neon', density: 'compact', fontSize: '400px' } });
    assert.equal(c.appearance.theme, 'system', 'ACC-SET-16 an unknown theme was stored');
    assert.equal(c.appearance.density, 'compact', 'ACC-SET-16 a real density was rejected');
    assert.equal(c.appearance.fontSize, 'normal', 'ACC-SET-16 an unknown font size was stored');
  });
  test('ACC-SET-17 a sparse appearance patch cannot clear its siblings', () => {
    const stored = patch({ appearance: { theme: 'dark', density: 'compact', fontSize: 'large' } });
    const after = mergeConfig(stored, { appearance: { theme: 'light' } });
    assert.deepEqual(after.appearance, { theme: 'light', density: 'compact', fontSize: 'large' },
      'ACC-SET-17 setting the theme wiped the density and font size');
  });
});

describe('sparse patches', () => {
  test('ACC-SET-18 changing one prosody number leaves the other five moods alone', () => {
    const stored = patch({ speech: { prosody: { gentle: { rate: 0.8, pause: 1.6 } } } });
    const after = mergeConfig(stored, { speech: { prosody: { sharp: { rate: 1.3 } } } });
    assert.deepEqual(after.speech.prosody.gentle, { rate: 0.8, pause: 1.6 },
      'ACC-SET-18 a sparse prosody patch cleared another mood');
    assert.equal(after.speech.prosody.sharp.rate, 1.3, 'ACC-SET-18 the new value landed');
    assert.equal(after.speech.prosody.sharp.pause, 1, 'ACC-SET-18 the untouched half kept its default');
  });

  test('ACC-SET-19 muting the voice does not disturb the prosody settings', () => {
    const stored = patch({ speech: { rate: 1.25, longForm: false } });
    const after = mergeConfig(stored, { voice: { enabled: false } });
    assert.equal(after.speech.rate, 1.25, 'ACC-SET-19 rate');
    assert.equal(after.speech.longForm, false, 'ACC-SET-19 longForm');
    assert.equal(after.voice.enabled, false, 'ACC-SET-19 the mute landed');
  });

  test('ACC-SET-20 a trigger added to the code later arrives with its default', () => {
    const old = { ...DEFAULT_CONFIG, proactive: { idle_nudge: false } };
    const after = mergeConfig(old, {});
    assert.equal(after.proactive.idle_nudge, false, 'ACC-SET-20 the stored switch survived');
    assert.equal(Object.keys(after.proactive).length, TRIGGER_IDS.length,
      'ACC-SET-20 the missing triggers were not filled in from the defaults');
  });
});

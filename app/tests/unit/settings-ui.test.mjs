// ACC-SETU-01..16 — the settings surface, checked at source level.
//
// Same constraint the existing UI suite works under: there is no DOM here and
// the brief forbids adding a test renderer, so the JSX is asserted as source and
// the plain-JS constants are imported and exercised for real. These catch the
// failures that source can actually prove: a control that is drawn but never
// written through, a client default that has drifted from the server's, a
// hard-coded colour, and a pane that is not registered as a pane.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR, makeSandbox } from '../helpers/sandbox.mjs';
import { MOODS, MODES, TRIGGER_IDS } from '../helpers/assertions.mjs';

const SRC = path.join(APP_DIR, 'web', 'src');
const M = path.join(SRC, 'monday');
const read = (p) => fs.readFileSync(p, 'utf8');

let C;      // web/src/monday/constants.js
let S;      // server/session.js, through a sandbox
const boxes = [];
before(async () => {
  C = await import(pathToFileURL(path.join(M, 'constants.js')).href);
  const box = makeSandbox({ tag: 'set-ui' });
  boxes.push(box);
  S = await box.imp('session.js');
});

const PANE = () => read(path.join(M, 'SettingsPane.jsx'));
const POP = () => read(path.join(M, 'Settings.jsx'));
const APP = () => read(path.join(SRC, 'App.jsx'));
const CSS = () => read(path.join(SRC, 'app.css'));

describe('§settings — the pane is a real pane', () => {
  test('ACC-SETU-01 SettingsPane.jsx exists and is a tab type', () => {
    assert.ok(fs.existsSync(path.join(M, 'SettingsPane.jsx')), 'ACC-SETU-01 the component');
    const app = APP();
    assert.match(app, /TITLES\s*=\s*\{[^}]*settings:\s*'Settings'/, 'ACC-SETU-01 TITLES has no settings entry');
    assert.match(app, /case 'settings':\s*return \(?\s*<SettingsPane/, 'ACC-SETU-01 renderTab does not render it');
    assert.match(app, /type:\s*'settings'/, 'ACC-SETU-01 the ⌘T launcher cannot open it');
  });

  test('ACC-SETU-02 the header opens the pane, not only the popover', () => {
    assert.match(APP(), /openTab\('settings'/, 'ACC-SETU-02 nothing in the header opens the settings pane');
  });

  test('ACC-SETU-03 the compact popover survives and routes to the pane', () => {
    const p = POP();
    assert.match(p, /voice/i, 'ACC-SETU-03 voice master');
    assert.match(p, /proactiveEnabled/, 'ACC-SETU-03 proactivity master');
    assert.match(p, /volume/i, 'ACC-SETU-03 volume');
    assert.match(p, /onOpenPane/, 'ACC-SETU-03 the popover offers no route to the full pane');
  });
});

describe('§settings — every section is present and every control is written through', () => {
  test('ACC-SETU-04 all seven sections exist', () => {
    const src = PANE();
    for (const id of ['voice', 'model', 'modes', 'proactivity', 'appearance', 'study', 'data']) {
      assert.match(src, new RegExp(`id="${id}"`), `ACC-SETU-04 no ${id} section`);
    }
  });

  test('ACC-SETU-05 every config key the server models has a control', () => {
    const src = PANE();
    const wired = [
      // Single-field patches, NOT `{ ...voice, enabled }`. Two controls write voice
      // (header mute and this pane); spreading a stale copy let one clobber the other
      // and silently switched voice off. The server deep-merges via mergeVoice, so a
      // one-key patch is both correct and race-free.
      [/voice:\s*\{\s*enabled/, 'voice.enabled'],
      [/voice:\s*\{\s*volume/, 'voice.volume'],
      [/patchSpeech\(\{ rate:/, 'speech.rate'],
      [/patchSpeech\(\{ longForm:/, 'speech.longForm'],
      [/patchSpeech\(\{ maxChars:/, 'speech.maxChars'],
      [/patchProsody\(m, \{ rate:/, 'speech.prosody[mood].rate'],
      [/patchProsody\(m, \{ pause:/, 'speech.prosody[mood].pause'],
      [/onPatch\(\{ model: v \}\)/, 'model'],
      [/onPatch\(\{ effort: v \}\)/, 'effort'],
      [/onPatch\(\{ proactiveEnabled: v \}\)/, 'proactiveEnabled'],
      [/onPatch\(\{ proactiveRateLimitMin: v \}\)/, 'proactiveRateLimitMin'],
      [/onPatch\(\{ proactive: \{ \.\.\.proactive, \[key\]: v \} \}\)/, 'proactive[trigger]'],
      [/appearance: \{ \.\.\.ap, theme: v \}/, 'appearance.theme'],
      [/appearance: \{ \.\.\.ap, density: v \}/, 'appearance.density'],
      [/appearance: \{ \.\.\.ap, fontSize: v \}/, 'appearance.fontSize'],
      [/onPatch\(\{ targetScore: v \}\)/, 'targetScore'],
      [/onMode\(m\)/, 'mode'],
    ];
    for (const [re, what] of wired) {
      assert.match(src, re, `ACC-SETU-05 ${what} has no write-through — the control would look right and do nothing`);
    }
  });

  test('ACC-SETU-06 the endpoints the pane needs are all called', () => {
    const src = PANE();
    for (const ep of ['/api/config', '/api/speak', '/api/exam-date', '/api/data-stats', '/api/voice-cache/clear']) {
      assert.ok(src.includes(ep), `ACC-SETU-06 ${ep} is never called`);
    }
  });

  test('ACC-SETU-07 there is a test-voice button per mood, and it uses POST /api/speak', () => {
    const src = PANE();
    assert.match(src, /testVoice\(mood\)/, 'ACC-SETU-07 no test-voice function');
    assert.match(src, /onClick=\{\(\) => testVoice\(m\)\}/, 'ACC-SETU-07 the per-mood Test button is not wired');
    assert.match(src, /'\/api\/speak'[\s\S]{0,200}method: 'POST'/, 'ACC-SETU-07 it does not POST /api/speak');
  });

  test('ACC-SETU-08 the exam date writes the record, and never a second copy of it', () => {
    const src = PANE();
    assert.match(src, /'\/api\/exam-date'[\s\S]{0,120}method: 'POST'/, 'ACC-SETU-08 no write');
    assert.ok(!/examDate:\s*examDraft/.test(src),
      'ACC-SETU-08 the pane writes config.examDate directly — the record is the single source of truth');
  });

  test('ACC-SETU-09 every row carries a one-line explanation', () => {
    const src = PANE();
    // Row/SwitchRow/SliderRow all take `hint`; a row rendered without one is a
    // control the reader has to guess at.
    const rows = src.match(/<(SwitchRow|SliderRow|Row)\b[\s\S]*?(?:\/>|>)/g) ?? [];
    assert.ok(rows.length >= 15, `ACC-SETU-09 only found ${rows.length} rows`);
    const missing = rows.filter((r) => !/\bhint=/.test(r));
    assert.deepEqual(missing, [], `ACC-SETU-09 ${missing.length} rows have no hint`);
  });
});

describe('§settings — it agrees with the server', () => {
  test('ACC-SETU-10 the client defaults match the server defaults exactly', () => {
    assert.deepEqual(C.DEFAULT_VOICE, S.DEFAULT_VOICE, 'ACC-SETU-10 voice');
    assert.deepEqual(C.DEFAULT_SPEECH, S.DEFAULT_SPEECH, 'ACC-SETU-10 speech');
    assert.deepEqual(C.DEFAULT_APPEARANCE, S.DEFAULT_APPEARANCE, 'ACC-SETU-10 appearance');
    assert.equal(C.DEFAULT_RATE_LIMIT_MIN, S.DEFAULT_CONFIG.proactiveRateLimitMin, 'ACC-SETU-10 rate limit');
  });

  test('ACC-SETU-11 the slider ranges match the ranges the server clamps to', () => {
    assert.deepEqual(C.SPEECH_RANGE.rate, S.VOICE_LIMITS.rate, 'ACC-SETU-11 rate');
    assert.deepEqual(C.SPEECH_RANGE.pause, S.VOICE_LIMITS.pause, 'ACC-SETU-11 pause');
    assert.deepEqual(C.SPEECH_RANGE.maxChars, S.VOICE_LIMITS.maxChars, 'ACC-SETU-11 maxChars');
    assert.deepEqual(C.RATE_LIMIT_RANGE, S.PROACTIVE_RATE_LIMIT_MIN, 'ACC-SETU-11 rate limit');
  });

  test('ACC-SETU-12 the enums match', () => {
    assert.deepEqual(C.THEMES.map(([k]) => k), S.THEMES, 'ACC-SETU-12 themes');
    assert.deepEqual(C.DENSITIES.map(([k]) => k), S.DENSITIES, 'ACC-SETU-12 densities');
    assert.deepEqual(C.FONT_SIZES.map(([k]) => k), S.FONT_SIZES, 'ACC-SETU-12 font sizes');
    assert.deepEqual([...C.MODELS.map(([k]) => k)].sort(), [...S.MODELS].sort(), 'ACC-SETU-12 models');
    assert.deepEqual([...C.EFFORTS.map(([k]) => k)].sort(), [...S.EFFORTS].sort(), 'ACC-SETU-12 efforts');
    assert.deepEqual([...C.MOODS].sort(), [...MOODS].sort(), 'ACC-SETU-12 moods');
    assert.deepEqual([...C.MODES].sort(), [...MODES].sort(), 'ACC-SETU-12 modes');
    assert.deepEqual([...C.PROACTIVE_TRIGGERS.map(([k]) => k)].sort(), [...TRIGGER_IDS].sort(), 'ACC-SETU-12 triggers');
  });

  test('ACC-SETU-13 the mode gates come from the server, not from a copy in the client', () => {
    const src = PANE();
    assert.match(src, /meta\?\.modeGates/, 'ACC-SETU-13 the pane invents its own gate table');
    assert.ok(!/voiceEnabled:\s*(true|false)/.test(src),
      'ACC-SETU-13 a gate value is hard-coded in the client — it will drift from modes.js');
  });
});

describe('§settings — the redesign holds', () => {
  test('ACC-SETU-14 no raw colour anywhere in the settings surface', () => {
    for (const [name, src] of [['SettingsPane.jsx', PANE()], ['Settings.jsx', POP()]]) {
      const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      assert.deepEqual(hexes, [], `ACC-SETU-14 ${name} hard-codes ${hexes.join(', ')} — colour comes from tokens`);
      assert.ok(!/rgb\(|hsl\(/.test(src), `ACC-SETU-14 ${name} uses a literal colour function`);
    }
  });

  test('ACC-SETU-15 the settings CSS is written entirely in tokens', () => {
    const css = CSS();
    const block = css.slice(css.indexOf('/* ═══════ settings pane'));
    assert.ok(block.length > 500, 'ACC-SETU-15 the settings pane block is missing from app.css');
    const hexes = block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(hexes, [], `ACC-SETU-15 raw hex in the settings CSS: ${hexes.join(', ')}`);
    assert.match(block, /var\(--ink-3\)/, 'ACC-SETU-15 hints must use the meta ink token');
  });

  test('ACC-SETU-16 density and font size are applied by redefining tokens, not by overrides', () => {
    const css = CSS();
    assert.match(css, /:root\[data-density='compact'\][\s\S]{0,400}--sp-6:/, 'ACC-SETU-16 density does not redefine spacing tokens');
    assert.match(css, /:root\[data-fontsize='large'\][\s\S]{0,400}--t-base:/, 'ACC-SETU-16 font size does not redefine type tokens');
    assert.match(APP(), /dataset\.density/, 'ACC-SETU-16 nothing stamps the density on the root element');
    assert.match(APP(), /dataset\.fontsize/, 'ACC-SETU-16 nothing stamps the font size on the root element');
  });

  test('ACC-SETU-17 the theme setting has three states and follows the system when told to', () => {
    assert.equal(C.resolveTheme('dark'), 'dark', 'ACC-SETU-17 explicit dark');
    assert.equal(C.resolveTheme('light'), 'light', 'ACC-SETU-17 explicit light');
    // No window.matchMedia in this process: the fallback must be a real theme,
    // not undefined, or the shell paints with no tokens at all.
    assert.ok(['light', 'dark'].includes(C.resolveTheme('system')), 'ACC-SETU-17 system must resolve to a real theme');
    assert.match(APP(), /prefers-color-scheme: dark[\s\S]{0,200}addEventListener/,
      'ACC-SETU-17 "system" does not follow the machine while the app is open');
  });

  test('ACC-SETU-19 the pane measures ITSELF, not the window', () => {
    const css = CSS();
    // The pane lives in a resizable column, so a @media rule keyed on the
    // viewport never fires at the width that matters. A 1600px window with a
    // 224px column rendered one word per line with the slider over the text.
    assert.match(css, /\.sp-tab\s*\{[^}]*container-type:\s*inline-size/,
      'ACC-SETU-19 the settings pane is not a container');
    assert.match(css, /@container settings \(max-width/,
      'ACC-SETU-19 the responsive rules are not container queries');
    // Everything before the @supports block is the primary styling; a viewport
    // media query there is the bug this test exists for. Inside @supports it is
    // the deliberate fallback for an engine with no container queries.
    const block = css.slice(css.indexOf('/* ═══════ settings pane'));
    const primary = block.slice(0, block.indexOf('@supports'));
    assert.ok(primary.length > 500, 'ACC-SETU-19 could not find the primary settings styling');
    assert.ok(!/@media \(max-width/.test(primary),
      'ACC-SETU-19 a settings rule is keyed on the viewport width outside the @supports fallback');
  });

  test('ACC-SETU-20 settings opens in the widest column, not the file sidebar', () => {
    assert.match(APP(), /type === 'settings' \? \(widest\?\.id/,
      'ACC-SETU-20 the pane lands in whichever column was last clicked');
  });

  test('ACC-SETU-18 the readiness pane reads the live target rather than the constant', () => {
    const rd = read(path.join(M, 'ReadinessTab.jsx'));
    assert.match(rd, /Number\(r\.target\)/, 'ACC-SETU-18 the pane ignores the target on the report');
    assert.match(APP(), /target: ev\.target/, 'ACC-SETU-18 App.jsx drops `target` off the readiness event');
  });
});

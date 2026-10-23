// ACC-VID-01..06 — the native video overlay, and the tab bar it hid behind.
//
// The bug: a YouTube view floating over the app as an unclickable white
// rectangle that nothing could dismiss. Three separate facts combined.
//
//   1. App.jsx mounts EVERY tab in a column and hides the inactive ones with
//      `display:none`. So switching tabs does not unmount VideoTab, and its
//      unmount cleanup — the only thing that posted `hide` — never ran.
//   2. The native `load` handler set `isHidden = false` as a side effect, so a
//      load from a tab the reader had already left put the overlay back on
//      screen with nothing left watching it.
//   3. Nothing derived visibility from the placeholder's own box, so a pane
//      that had been collapsed or hidden still reported itself as showing.
//
// Source-level assertions, in the style of ui.test.mjs: there is no DOM here
// and no WKWebView, so the contract is checked where it is written down.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '../helpers/sandbox.mjs';

const read = (p) => fs.readFileSync(path.join(APP_DIR, p), 'utf8');
const VIDEO = read('web/src/monday/VideoTab.jsx');
const SWIFT = read('scripts/TMUATutor.swift');
const CSS = read('web/src/app.css');
const APP = read('web/src/App.jsx');

describe('video overlay — visibility comes from the box, not from mounting', () => {
  test('ACC-VID-01 an inactive tab really does stay mounted, which is why this matters', () => {
    // If this ever changes to unmount inactive tabs, the cleanup path becomes
    // sufficient on its own — but until then it is not, and this test records why.
    assert.match(APP, /display:\s*col\.active === tab\.id \? 'flex' : 'none'/,
      'App.jsx no longer hides inactive tabs with display:none — re-read VideoTab');
  });

  test('ACC-VID-02 a zero-sized placeholder counts as off screen', () => {
    assert.match(VIDEO, /const onScreen = \(rect\) =>[^\n]*rect\.w > 0 && rect\.h > 0/,
      'nothing derives visibility from the placeholder box');
  });

  test('ACC-VID-03 losing the box posts hide, regaining it posts show', () => {
    assert.match(VIDEO, /action:\s*'show'[\s\S]{0,80}action:\s*'hide'/,
      'the visibility transition does not post both show and hide');
    assert.match(VIDEO, /visibleRef/, 'no latch, so the transition would post on every observation');
  });

  test('ACC-VID-04 nothing loads into a hidden panel', () => {
    // The native load handler is allowed to change what is displayed; loading
    // while hidden is how the overlay came back without a show.
    const loadEffect = VIDEO.slice(VIDEO.indexOf('// `load` whenever'));
    assert.match(loadEffect, /if \(!visibleRef\.current\) return;/,
      'the load effect fires regardless of whether the pane is on screen');
  });
});

describe('video overlay — the native side owns visibility in exactly two places', () => {
  test('ACC-VID-05 only show and hide touch isHidden in the message handler', () => {
    const handler = SWIFT.slice(SWIFT.indexOf('case "show":'), SWIFT.indexOf('private func cssRect'));
    const cases = [...handler.matchAll(/case "(\w+)":([\s\S]*?)(?=\n    case "|\n    default:)/g)];
    assert.ok(cases.length >= 4, 'expected show/rect/hide/load');
    for (const [, name, body] of cases) {
      const touches = /isHidden/.test(body);
      if (name === 'show' || name === 'hide') assert.ok(touches, `case ${name} must set isHidden`);
      else assert.ok(!touches, `case ${name} must not decide visibility — it set isHidden`);
    }
  });

  test('ACC-VID-06 the panel starts hidden', () => {
    assert.match(SWIFT, /videoWeb\.isHidden = true/, 'the overlay is not hidden at construction');
  });

  test('ACC-VID-08 a main-frame load always starts from hidden', () => {
    // The overlay outlives the React component that tracks it, so a reload
    // would otherwise preserve a stuck panel forever with nothing left to
    // dismiss it. A reload has to be the cure, not the thing that keeps it.
    const didFinish = SWIFT.slice(SWIFT.indexOf('func webView(_ w: WKWebView, didFinish'));
    const mainBranch = didFinish.slice(0, didFinish.indexOf('} else if w === videoWeb'));
    assert.match(mainBranch, /videoWeb\.isHidden = true/,
      'a finished main-frame navigation does not reset the overlay');
  });
});

describe('tab bar — a tab is never squeezed narrower than its own name', () => {
  test('ACC-VID-07 .tab does not shrink, so the bar scrolls instead', () => {
    // .tabbar is a flex row with overflow-x:auto. With the default shrink of 1,
    // every tab narrows as more are opened, and because `.tab .x` is
    // flex-shrink:0 it is the LABEL that disappears: eight tabs in one column
    // rendered as eight bare close buttons.
    const rule = CSS.slice(CSS.indexOf('.tab {'), CSS.indexOf('.tab-label'));
    assert.match(rule, /flex:\s*0 0 auto/, '.tab is still shrinkable');
    assert.match(rule, /min-width:/, '.tab has no floor on its width');
    assert.match(CSS, /\.tabbar\s*\{[^}]*overflow-x:\s*auto/, '.tabbar must be able to scroll');
  });
});

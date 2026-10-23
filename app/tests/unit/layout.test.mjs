// ACC-LAY-01..08 — column sizing for the tiling workspace.
//
// The bug: two PDFs open side by side, the left rail collapsed, and most of the
// window simply blank to the right of the last column. Measured on the real app
// over CDP: a stored size of -0.35 left **1225px of a 1600px window empty**.
//
// `flex: <n> 1 0%` with a negative or non-finite n is invalid CSS, so the
// browser discards the whole declaration — React reports no inline style at all
// — and the column falls back to `flex: 0 1 auto`, i.e. content width. It does
// not warn, and nothing downstream can distinguish it from a deliberate layout.
//
// The negative came from the resizer: two sequential `if`s meant that when both
// ends of a drag wanted to go under the minimum, the second subtracted from the
// first again and drove it below zero.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '../helpers/sandbox.mjs';
import { colSize, healLayout, clampPair, growWeights, MIN_SIZE } from '../../web/src/monday/layout.js';

const APP = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'App.jsx'), 'utf8');

describe('column sizing — a weight CSS will always accept', () => {
  test('ACC-LAY-01 every unusable value becomes a usable one', () => {
    for (const bad of [-0.35, -1, 0, NaN, Infinity, -Infinity, null, undefined, '', 'wide', {}, []]) {
      const n = colSize(bad);
      assert.ok(Number.isFinite(n) && n > 0, `colSize(${JSON.stringify(bad)}) = ${n}`);
    }
  });

  test('ACC-LAY-02 a good value is left alone, including a numeric string', () => {
    assert.equal(colSize(2.2), 2.2);
    assert.equal(colSize('1.5'), 1.5);        // JSON round-trips can stringify
    assert.equal(colSize(MIN_SIZE), MIN_SIZE);
  });

  test('ACC-LAY-03 a tiny positive weight is floored, not discarded', () => {
    // A column dragged almost shut should still grow — just barely. Rounding it
    // to zero would reintroduce the blank window by another route.
    assert.equal(colSize(1e-9), MIN_SIZE);
  });

  test('ACC-LAY-04 healing repairs sizes and touches nothing else', () => {
    const before = { columns: [
      { id: 'c1', size: -0.35, collapsed: true, active: 'a', tabs: [{ id: 'a' }] },
      { id: 'c2', size: 2, collapsed: false, active: 'b', tabs: [{ id: 'b' }, { id: 'c' }] },
    ] };
    const after = healLayout(structuredClone(before));
    assert.ok(colSize(after.columns[0].size) === after.columns[0].size, 'size not healed');
    assert.ok(after.columns[0].size > 0);
    assert.equal(after.columns[1].size, 2, 'a good size was changed');
    for (const i of [0, 1]) {
      assert.equal(after.columns[i].collapsed, before.columns[i].collapsed);
      assert.equal(after.columns[i].active, before.columns[i].active);
      assert.deepEqual(after.columns[i].tabs, before.columns[i].tabs);
    }
  });

  test('ACC-LAY-05 healing survives a layout with no columns', () => {
    assert.doesNotThrow(() => healLayout(null));
    assert.doesNotThrow(() => healLayout({}));
    assert.doesNotThrow(() => healLayout({ columns: [] }));
  });
});

describe('column sizing — the resizer cannot produce a broken weight', () => {
  test('ACC-LAY-06 no drag, however violent, drives either end non-positive', () => {
    const total = 6;
    for (const dw of [-1e6, -100, -5, -0.001, 0, 0.001, 5, 100, 1e6]) {
      for (const [l0, r0] of [[1, 1], [0.05, 5], [3, 0.2], [2.2, 1.8]]) {
        const [nl, nr] = clampPair(l0, r0, dw, total);
        assert.ok(nl > 0 && Number.isFinite(nl), `left ${nl} for dw=${dw}`);
        assert.ok(nr > 0 && Number.isFinite(nr), `right ${nr} for dw=${dw}`);
      }
    }
  });

  test('ACC-LAY-07 the pair total is conserved, so the neighbours cannot drift', () => {
    for (const dw of [-40, -1, 0, 1, 40]) {
      const [nl, nr] = clampPair(2.2, 1.8, dw, 6);
      assert.ok(Math.abs((nl + nr) - 4) < 1e-9, `pair drifted to ${nl + nr}`);
    }
  });
});

describe('column sizing — how the weight reaches the DOM', () => {
  test('ACC-LAY-08 the column uses long-hand flex, never the shorthand', () => {
    // One invalid value in a `flex` shorthand takes grow, shrink AND basis with
    // it. The long-hand properties fail independently, so a bad number can no
    // longer silently stop a column growing.
    assert.match(APP, /flexGrow: grow\[col\.id\]/, 'the column no longer renders its normalised weight');
    assert.doesNotMatch(APP, /flex: `\$\{col\.size/, 'the shorthand is back');
    assert.match(APP, /return healLayout\(l\)/, 'a stored layout is no longer healed on load');
  });
});

describe('column sizing — the open columns always fill the row', () => {
  // The bug: flex-grow values summing to less than 1 take only that fraction of
  // the free space (CSS Flexbox §9.7). His real layout after closing the chat
  // column held 0.20 + 0.55 = 0.75 across two open PDFs, and 382px of a 1600px
  // window rendered blank to the right of the last column.
  const sum = (o) => Object.values(o).reduce((s, v) => s + v, 0);

  test('ACC-LAY-09 the layout that blanked his window now sums to a full row', () => {
    const g = growWeights([
      { id: 'files', size: 0.152, collapsed: true },
      { id: 'a', size: 0.2003, collapsed: false },
      { id: 'b', size: 0.5497, collapsed: false },
    ]);
    assert.ok(!('files' in g), 'a collapsed column was given a weight');
    assert.ok(sum(g) >= 1, `open weights sum to ${sum(g)}`);
    assert.ok(Math.abs(g.b / g.a - 0.5497 / 0.2003) < 1e-9, 'the ratio between columns changed');
  });

  test('ACC-LAY-10 any mix of weights and collapse states fills the row', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 500; n++) {
      const cols = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => ({
        id: `c${i}`, size: [rnd() * 0.3, rnd() * 5, -1, NaN, null][Math.floor(rnd() * 5)], collapsed: rnd() < 0.4,
      }));
      const g = growWeights(cols);
      const open = cols.filter((c) => !c.collapsed).length;
      if (!open) { assert.deepEqual(g, {}); continue; }
      for (const v of Object.values(g)) assert.ok(Number.isFinite(v) && v > 0, `bad weight ${v}`);
      assert.ok(sum(g) >= 1 - 1e-9, `row only ${sum(g)} full`);
    }
  });
});

describe('tiling — interaction guards', () => {
  test('ACC-LAY-11 a divider drag is scaled by the open columns, not the container', () => {
    // Dividing by the whole .cols width (padding, dividers, collapsed strips
    // included) left the divider 13-18px behind the cursor on a 300px drag.
    assert.match(APP, /\/ openPx\) \* total/, 'the drag is no longer scaled by the open columns');
    assert.doesNotMatch(APP, /\/ cw\) \* total/, 'the container-width scaling is back');
    assert.match(APP, /classList\.add\('col-resizing'\)/, 'the drag no longer shields iframes');
  });

  test('ACC-LAY-12 nothing lands in, or is closed from, a collapsed column unseen', () => {
    assert.match(APP, /if \(col\?\.active && !col\.collapsed\) closeTab/, '⌘W can close a hidden tab again');
    assert.match(APP, /const openId = \(id\) => copy\.columns\.find\(\(c\) => c\.id === id && !c\.collapsed\)/,
      'a new tab can be stuffed into a collapsed column again');
  });
});

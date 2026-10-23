// ACC-CSS-01..03 — the stylesheet may only use colours the design system defines.
//
// An undefined custom property does not fail loudly: `color: var(--nope)` makes the whole
// declaration invalid and the browser drops it, so the element silently inherits. app.css
// had accumulated fourteen such names. Six were worse than silent — they carried a
// hard-coded fallback from a different palette (`var(--card, #fff)`), so a note card
// rendered white-on-white in dark mode while looking perfectly fine in light.
//
// These tests read the generated tokens and the stylesheet and insist they agree.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');
const css = fs.readFileSync(path.join(WEB, 'app.css'), 'utf8');
const tokensCss = fs.readFileSync(path.join(WEB, 'tokens.css'), 'utf8');

const defined = new Set([...tokensCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const localVars = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]);

describe('stylesheet — every colour comes from the design system', () => {
  test('ACC-CSS-01 no undefined custom property is referenced', () => {
    // "var(--sp-*)" appears in a comment explaining the scale; it is prose, not a use.
    const missing = [...new Set(used)]
      .filter((v) => !v.endsWith('-'))
      .filter((v) => !defined.has(v) && !localVars.has(v));
    assert.deepEqual(missing, [],
      `app.css references ${missing.length} variable(s) the tokens do not define: ${missing.join(', ')}`);
  });

  test('ACC-CSS-02 no var() carries a hard-coded colour fallback', () => {
    // A fallback hides the mistake in light mode and exposes it in dark: the point of the
    // token file is that one palette answers for both themes.
    const withFallback = [...css.matchAll(/var\(\s*--[a-z0-9-]+\s*,\s*(#[0-9a-f]{3,8}|rgb[a]?\([^)]*\))/gi)]
      .map((m) => m[0]);
    assert.deepEqual(withFallback, [],
      `${withFallback.length} declaration(s) fall back to a literal colour: ${withFallback.slice(0, 4).join(' | ')}`);
  });

  test('ACC-CSS-03 every colour the dark theme overrides exists in the light theme', () => {
    // Type, space and radius are emitted once, in the light block, because they do not
    // change with the theme — so the blocks are not equal by design. What must hold is
    // that the dark block only ever REDEFINES something light already defined: a colour
    // that exists only in dark would be undefined in light, and vice versa.
    const blocks = [...tokensCss.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]);
    const sets = blocks
      .map((b) => new Set([...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1])))
      .filter((s) => s.size > 20);
    assert.ok(sets.length >= 2, 'expected a light and a dark token block');
    const [light, ...darks] = sets;
    for (const d of darks) {
      const orphan = [...d].filter((v) => !light.has(v));
      assert.deepEqual(orphan, [],
        `the dark theme defines ${orphan.length} variable(s) light never does: ${orphan.join(', ')}`);
    }
  });
});

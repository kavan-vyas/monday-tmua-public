// ═══════════════ MONDAY — the single source of design truth ═══════════════
//
// Every colour, size, space and radius the app uses is declared HERE and nowhere
// else. `scripts/build-tokens.mjs` renders this into:
//
//   app/web/src/tokens.css                     (the React app, via Vite)
//   tutor_data/dashboard.html                  (inlined, between GENERATED markers)
//   tutor_data/dashboard-site/index.html       (inlined, between GENERATED markers)
//
// and `app/server/mood.js` imports MOOD from here for its MOOD_COLORS export.
// Four surfaces, one set of values, no drift. If you are about to hard-code a hex
// in a stylesheet: don't. Put it here and run `npm run tokens`.
//
// Dependency-free ESM on purpose — mood.js runs on the server and in tests.

// ── neutrals ────────────────────────────────────────────────────────────────
// Warm-tinted rather than pure grey. A maths tool is read for hours; neutral
// greys at this density go clinical and cold, and pure #000 on pure #fff is the
// single biggest cause of the "hard" feeling the old shell had.
export const NEUTRAL = {
  light: {
    bg:        '#faf9f7',  // the page
    surface:   '#ffffff',  // panes, cards, popovers
    sunken:    '#f2f0ec',  // inputs, code, wells — recedes from surface
    raised:    '#e9e6e0',  // hover on sunken
    line:      '#e4e0d9',  // default hairline
    lineStrong:'#cdc7bc',  // dividers that need to carry weight
    ink:       '#1a1815',  // body text            — 15.8:1 on surface
    ink2:      '#57534c',  // secondary text       —  7.2:1 on surface
    ink3:      '#8a847a',  // meta / placeholder   —  3.6:1, never body text
  },
  dark: {
    bg:        '#131211',
    surface:   '#1b1a18',
    sunken:    '#0e0d0c',
    raised:    '#262421',
    line:      '#2b2926',
    lineStrong:'#3d3a35',
    ink:       '#f2efe9',  // 14.9:1 on surface
    ink2:      '#b8b2a7',  //  7.6:1
    ink3:      '#847e74',  //  3.5:1
  },
};

// ── semantic hues ───────────────────────────────────────────────────────────
// One hue, one meaning. `fill` is the mark colour (bars, strokes, dots, chips);
// `ink` is the AA-safe *text* colour on the page ground — they are different
// jobs and a single value cannot do both, which is why there are two.
/**
 * `soft` is the hue at ~8-12% over the surface: the background of a tinted card, never
 * text and never a border. app.css was reaching for tints that did not exist here and
 * falling back to hard-coded indigo greys, which then ignored the theme entirely — a
 * white note card on a dark background. Defining them per theme is what makes a tinted
 * surface possible without leaving the system.
 */
export const HUE = {
  blue:   { light: { fill: '#2f7fd4', ink: '#175ea8', soft: '#eaf2fc' }, dark: { fill: '#5b9df0', ink: '#7fb5f5', soft: '#16202c' } },
  green:  { light: { fill: '#1a9c62', ink: '#12744a', soft: '#e6f5ee' }, dark: { fill: '#2ec18c', ink: '#4fd3a4', soft: '#122420' } },
  amber:  { light: { fill: '#e0a020', ink: '#8a5a00', soft: '#fbf1dc' }, dark: { fill: '#e0a72b', ink: '#f0c04a', soft: '#282013' } },
  orange: { light: { fill: '#e3701f', ink: '#b5520d', soft: '#fceee4' }, dark: { fill: '#f0854a', ink: '#f5a077', soft: '#2a1d15' } },
  red:    { light: { fill: '#d94436', ink: '#b02a1e', soft: '#fbeae8' }, dark: { fill: '#f0604a', ink: '#ff8574', soft: '#2b1917' } },
  violet: { light: { fill: '#7a5bd4', ink: '#5f42b8', soft: '#f0ecfb' }, dark: { fill: '#9b82e8', ink: '#b5a1f0', soft: '#201b2e' } },
  slate:  { light: { fill: '#7d8590', ink: '#55606b', soft: '#eff1f3' }, dark: { fill: '#99a1ab', ink: '#b0b8c2', soft: '#1c1f22' } },
  // The house gold. It has exactly one job now: identity — the mark, the
  // wordmark, and the `focused` mood. It is NOT the hover colour of every
  // button any more, which is why the other seven hues can finally mean things.
  brand:  { light: { fill: '#c8920a', ink: '#7a5c00', soft: '#f8f0d8' }, dark: { fill: '#f0c33c', ink: '#f5d066', soft: '#2a2412' } },
};

// ── moods ───────────────────────────────────────────────────────────────────
// Six moods, six hues, so mood is readable as colour alone. These values become
// MOOD_COLORS in app/server/mood.js and ship to the client on the `config` event.
//
// `on` is the text colour to place ON that fill. It is not part of the server
// contract (MOOD_COLORS stays {light,dark} strings) — the client derives it via
// moodInk(). A fill dark enough to read as a 2px stroke on paper cannot also
// carry black text, so the two are stated separately rather than fudged.
// Deliberately near-neutral. These are tinted greys, not colours: the mood should
// be findable if you go looking and invisible if you are not. Chroma is pulled far
// down and luminance sits close to the neutral line, so a mood rule reads as a
// hairline rather than a flag. Hue is the only thing separating them, which is
// enough at a glance once you know the set.
export const MOOD = {
  focused:  { light: '#9a8b6a', dark: '#b9a887', onLight: '#17150f', onDark: '#17150f' },
  sharp:    { light: '#a87c63', dark: '#c19a83', onLight: '#17150f', onDark: '#17150f' },
  gentle:   { light: '#6f8298', dark: '#91a3b8', onLight: '#17150f', onDark: '#17150f' },
  clinical: { light: '#87888c', dark: '#a3a4a8', onLight: '#17150f', onDark: '#17150f' },
  wry:      { light: '#8a7e9a', dark: '#a89bb8', onLight: '#17150f', onDark: '#17150f' },
  grave:    { light: '#9c6f68', dark: '#bb8f88', onLight: '#17150f', onDark: '#17150f' },
};

// ── modes ───────────────────────────────────────────────────────────────────
// Which hue each mode borrows. EXAM is the only one that repaints the shell.
export const MODE_HUE = {
  DRILL:      'slate',
  EXAM:       'red',
  POSTMORTEM: 'violet',
  TEACH:      'blue',
  PAUSE:      'amber',
};

// ── type ────────────────────────────────────────────────────────────────────
// IBM Plex Sans + IBM Plex Mono, self-hosted (see web/src/fonts.css). Plex Sans
// and Plex Mono are metric siblings, which is what makes mixing them look
// deliberate instead of accidental — and the dashboard and tracker already
// loaded Plex Mono, so this converges on what was there rather than inventing a
// fourth voice.
export const FONT = {
  sans: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  // Mono survives only where it earns it: numbers that must align, code, file
  // paths, IDs, timers. It is no longer the voice of the whole application.
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};

// A ~1.125 scale, dense on purpose: this is a working tool used for long
// sessions, not a marketing page. Replaces the 13 ad-hoc sizes the old sheet had.
export const SIZE = {
  '3xs': '10px',  // eyebrow labels, legal, axis ticks — one per region, max
  '2xs': '11px',  // chip text, dense meta
  xs:    '12px',  // secondary UI
  sm:    '13px',  // default control text
  base:  '14px',  // body + chat prose (up from 13 — long reading sessions)
  md:    '16px',
  lg:    '19px',
  xl:    '23px',
  '2xl': '28px',
  '3xl': '34px',
};

export const LEADING = { tight: '1.25', ui: '1.4', prose: '1.6' };
// 400/500/600/700 only. The old sheet leaned on 900 everywhere, which is why
// nothing read as emphasised — everything was.
export const WEIGHT = { normal: '400', medium: '500', semi: '600', bold: '700' };

// ── spacing ─────────────────────────────────────────────────────────────────
// 4px base. Every padding and gap in the app resolves to one of these.
export const SPACE = {
  0: '0', 1: '2px', 2: '4px', 3: '6px', 4: '8px', 5: '12px',
  6: '16px', 7: '20px', 8: '24px', 9: '32px', 10: '40px',
};

// ── shape + depth ───────────────────────────────────────────────────────────
// The old sheet forced `border-radius: 0 !important` globally and put a hard
// `3px 3px 0` offset shadow on columns, buttons, bubbles, chips, popovers and
// the timer at once. Those shadows collided, which is most of what "things are
// thrown on top of each other" actually was.
export const RADIUS = { xs: '3px', sm: '5px', md: '8px', lg: '12px', full: '999px' };

export const SHADOW = {
  light: {
    1: '0 1px 2px rgba(26,24,21,.06)',
    2: '0 2px 4px rgba(26,24,21,.06), 0 4px 12px -6px rgba(26,24,21,.14)',
    3: '0 4px 8px rgba(26,24,21,.07), 0 12px 32px -12px rgba(26,24,21,.22)',
  },
  dark: {
    1: '0 1px 2px rgba(0,0,0,.4)',
    2: '0 2px 4px rgba(0,0,0,.4), 0 4px 12px -6px rgba(0,0,0,.6)',
    3: '0 4px 8px rgba(0,0,0,.45), 0 12px 32px -12px rgba(0,0,0,.7)',
  },
};

// Motion: short and unfussy. A study tool should not perform.
export const MOTION = { fast: '90ms', base: '140ms', slow: '220ms', ease: 'cubic-bezier(.2,0,.2,1)' };

// Layout constants the transcript depends on.
export const LAYOUT = {
  gutter: '64px',   // speaker gutter in the chat transcript
  measure: '68ch',  // comfortable prose measure for Monday's answers
};

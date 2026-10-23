// ACC-UI-* — agent C's face. constants.js is plain JS and is imported and exercised;
// the JSX and static assets are checked at source level, since there is no DOM here
// and the brief forbids adding a test-renderer dependency.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR } from '../helpers/sandbox.mjs';
import { MOODS, MODES, TRIGGER_IDS, TOOL_NAMES } from '../helpers/assertions.mjs';

const WEB = path.join(APP_DIR, 'web');
const SRC = path.join(WEB, 'src');
const M = path.join(SRC, 'monday');
const read = (p) => fs.readFileSync(p, 'utf8');

let C;
before(async () => { C = await import(pathToFileURL(path.join(M, 'constants.js')).href); });

describe('§C1 branding sweep', () => {
  test('ACC-UI-01 index.html titles the app MONDAY', () => {
    assert.match(read(path.join(WEB, 'index.html')), /<title>\s*MONDAY\s*<\/title>/, 'ACC-UI-01');
  });

  test('ACC-UI-02 the header logo reads MONDAY with a mood dot beside it', () => {
    const app = read(path.join(SRC, 'App.jsx'));
    assert.match(app, /className="logo"[^>]*>\s*MONDAY/, 'ACC-UI-02 logo text');
    assert.match(app, /MondayOrb|mood-dot|moodColor/, 'ACC-UI-02 a mood-coloured mark beside it');
  });

  test('ACC-UI-03 TITLES.chat is MONDAY', () => {
    assert.match(read(path.join(SRC, 'App.jsx')), /TITLES\s*=\s*\{[^}]*chat:\s*'MONDAY'/, 'ACC-UI-03');
  });

  test('ACC-UI-04 the PERSONAS constant and the persona <select> are gone', () => {
    const app = read(path.join(SRC, 'App.jsx'));
    assert.ok(!/const\s+PERSONAS\s*=/.test(app), 'ACC-UI-04 PERSONAS constant still declared');
    assert.ok(!/value=\{persona\}|onChange=\{[^}]*persona/.test(app), 'ACC-UI-04 a persona control survives');
  });

  test('ACC-UI-05 assistant bubbles carry a MONDAY label with a mood tint', () => {
    const app = read(path.join(SRC, 'App.jsx'));
    assert.match(app, /background:\s*(moodColor\([^)]*\)|tint)[^}]*\}}\s*>\s*MONDAY/, 'ACC-UI-05');
  });

  test('ACC-UI-06 the PDF empty state reads MONDAY PUTS QUESTIONS HERE.', () => {
    assert.ok(read(path.join(SRC, 'App.jsx')).includes('MONDAY PUTS QUESTIONS HERE.'), 'ACC-UI-06');
  });

  test('ACC-UI-07 the web manifest is named Monday', () => {
    const man = JSON.parse(read(path.join(WEB, 'public', 'manifest.webmanifest')));
    assert.equal(man.name, 'Monday', 'ACC-UI-07 name');
    assert.equal(man.short_name, 'Monday', 'ACC-UI-07 short_name');
  });

  test('ACC-UI-08 the native shell is renamed', () => {
    const swift = path.join(APP_DIR, 'scripts', 'TMUATutor.swift');
    const plist = path.join(APP_DIR, '..', 'TMUA Tutor.app', 'Contents', 'Info.plist');
    if (fs.existsSync(swift)) {
      assert.match(read(swift), /Monday/i, 'ACC-UI-08 the Swift shell mentions Monday');
    }
    if (fs.existsSync(plist)) {
      const p = read(plist);
      assert.match(p, /Monday/i, 'ACC-UI-08 Info.plist carries the Monday name');
    }
  });

  test('ACC-UI-09 no persona vocabulary survives anywhere in app/web/src', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!/\.(jsx?|css|html)$/.test(f.name)) continue;
        const src = read(p);
        // A live persona control, not a comment explaining that personas were removed.
        for (const line of src.split('\n')) {
          if (/^\s*(\/\/|\*|<!--)/.test(line)) continue;
          if (/\bbubbly\b/.test(line) || /\bPERSONAS?\b/.test(line) || /persona:/.test(line)) {
            offenders.push(`${path.relative(APP_DIR, p)}: ${line.trim()}`);
          }
        }
      }
    };
    walk(SRC);
    assert.deepEqual(offenders, [], `ACC-UI-09 persona vocabulary survives:\n${offenders.join('\n')}`);
  });

  test('ACC-UI-36 the public dashboard site is untouched by the web build', () => {
    const dash = path.join(APP_DIR, '..', 'tutor_data', 'dashboard-site');
    if (!fs.existsSync(dash)) return;                       // nothing to protect
    const src = read(path.join(SRC, 'App.jsx'));
    assert.ok(!src.includes('dashboard-site'), 'ACC-UI-36 the app reaches into the dashboard site');
  });
});

describe('§C1 the orb', () => {
  const orb = () => read(path.join(M, 'MondayOrb.jsx'));

  test('ACC-UI-10..15 all five orb states are implemented', () => {
    const src = orb();
    for (const s of ['dormant', 'idle', 'thinking', 'speaking', 'alert']) {
      assert.ok(new RegExp(`['"\`]${s}['"\`]`).test(src), `ACC-UI-10 orb state "${s}" is not handled`);
    }
  });

  test('ACC-UI-12 idle breathes on a 4 s period', () => {
    const src = orb();
    assert.match(src, /4000|4 ?s/, 'ACC-UI-12 the 4 s breathing period is not expressed');
  });

  test('ACC-UI-14 speaking is driven by a real AnalyserNode, not faked', () => {
    const src = orb();
    assert.match(src, /analyser|Analyser/i, 'ACC-UI-14 no analyser reference in the orb');
    assert.ok(!/Math\.random\(\)/.test(src.split("'speaking'")[1] ?? ''),
      'ACC-UI-14 the speaking ring looks randomised rather than amplitude-driven');
  });

  test('ACC-UI-16 the orb colour follows the mood palette', () => {
    assert.match(orb(), /moodColor|MOOD_COLORS|color/, 'ACC-UI-16');
  });

  test('ACC-UI-17 brutalist: 2 px stroke and no soft glows', () => {
    const src = orb();
    assert.match(src, /lineWidth\s*=\s*2\b/, 'ACC-UI-17 the 2 px stroke');
    assert.ok(!/shadowBlur|filter:\s*blur|boxShadow/.test(src),
      'ACC-UI-17 the orb uses a glow/blur, which the brutalist brief forbids');
  });
});

describe('§C1 first-person tool captions', () => {
  test('ACC-UI-18/21 every tool registered in session.js has a caption', () => {
    const missing = TOOL_NAMES.filter((t) => !(t in C.TOOL_VOICE));
    assert.deepEqual(missing, [], `ACC-UI-18 tools with no TOOL_VOICE entry: ${missing.join(', ')}`);
    assert.ok(Object.keys(C.TOOL_VOICE).length >= 20, 'ACC-UI-18 all 20 tools covered');
  });

  test('ACC-UI-19 the four captions named in the spec are exactly right', () => {
    const cap = (name, detail) => C.TOOL_VOICE[name](detail);
    assert.equal(cap('show_pdf', '2019 Paper 1'), 'putting 2019 Paper 1 on screen', 'ACC-UI-19 show_pdf');
    assert.equal(cap('get_pdf_page', 'page 4'), 'reading page 4', 'ACC-UI-19 get_pdf_page');
    assert.equal(cap('query_tag_index', 'logarithms'), 'checking the index — logarithms', 'ACC-UI-19 query_tag_index');
    assert.equal(cap('monday_recall', 'sequences'), 'remembering how sequences went last time', 'ACC-UI-19 monday_recall');
  });

  test('ACC-UI-19 every caption is first person and never a bare tool id', () => {
    for (const name of TOOL_NAMES) {
      const out = C.TOOL_VOICE[name]('X');
      assert.equal(typeof out, 'string', `ACC-UI-19 ${name} caption is not a string`);
      assert.ok(out.length > 0, `ACC-UI-19 ${name} caption is empty`);
      assert.ok(!out.includes(name), `ACC-UI-19 ${name} caption leaks the raw tool id: "${out}"`);
      assert.ok(!/^[A-Z_]+$/.test(out), `ACC-UI-19 ${name} caption looks like an id`);
    }
  });

  test('ACC-UI-20 the old raw "gear + tool name" rendering is gone', () => {
    const app = read(path.join(SRC, 'App.jsx'));
    assert.ok(!/⚙\s*\{/.test(app), 'ACC-UI-20 the ⚙ {name} chip is still rendered');
    assert.ok(!/mcp__tutor__/.test(app.replace(/\/\/.*$/gm, '')),
      'ACC-UI-20 App.jsx still strips mcp__tutor__ by hand instead of using TOOL_VOICE');
  });

  test('ACC-UI-19 toolCaption falls back gracefully for an unknown tool', () => {
    assert.doesNotThrow(() => C.toolCaption({ name: 'not_a_tool', input: {} }), 'ACC-UI-19 fallback');
  });
});

describe('§C2 settings, modes and readiness', () => {
  test('ACC-UI-28 there is one switch per proactive trigger', () => {
    const ids = C.PROACTIVE_TRIGGERS.map((t) => (Array.isArray(t) ? t[0] : t.id));
    assert.deepEqual([...ids].sort(), [...TRIGGER_IDS].sort(), 'ACC-UI-28 the seven switches');
  });

  test('ACC-UI-28 the client defaults match the server defaults, late_night off', () => {
    assert.equal(C.DEFAULT_PROACTIVE.late_night, false, 'ACC-UI-28 late_night off');
    for (const id of TRIGGER_IDS.filter((i) => i !== 'late_night')) {
      assert.equal(C.DEFAULT_PROACTIVE[id], true, `ACC-UI-28 ${id} on`);
    }
    assert.deepEqual(C.DEFAULT_VOICE, { enabled: true, volume: 0.9 }, 'ACC-CFG-02 client voice defaults');
  });

  test('ACC-UI-28 the settings popover has master voice and proactivity switches plus volume', () => {
    const s = read(path.join(M, 'Settings.jsx'));
    assert.match(s, /voice/i, 'ACC-UI-28 voice master');
    assert.match(s, /proactiveEnabled|never interrupt|proactivity/i, 'ACC-UI-28 proactivity master');
    assert.match(s, /volume/i, 'ACC-UI-28 volume');
  });

  test('ACC-UI-29 settings write through to the server config endpoint', () => {
    const app = read(path.join(SRC, 'App.jsx'));
    const s = read(path.join(M, 'Settings.jsx'));
    assert.ok(/\/api\/config/.test(app + s), 'ACC-UI-29 no write-through to /api/config');
  });

  test('ACC-UI-31 a mode selector exists and offers the five modes', () => {
    assert.deepEqual([...C.MODES].sort(), [...MODES].sort(), 'ACC-UI-31 the five modes');
    assert.ok(fs.existsSync(path.join(M, 'ModeSelector.jsx')), 'ACC-UI-31 a mode selector component exists');
  });

  test('ACC-UI-32 EXAM has its own visual state, not just a different word', () => {
    const css = read(path.join(SRC, 'app.css'));
    const app = read(path.join(SRC, 'App.jsx'));
    const sel = read(path.join(M, 'ModeSelector.jsx'));
    assert.ok(/exam/i.test(css), 'ACC-UI-32 no EXAM styling in app.css');
    assert.ok(/exam/i.test(app + sel), 'ACC-UI-32 nothing applies an EXAM class');
  });

  test('ACC-UI-33 a READINESS pane exists with bars, the 9.0 target and the countdown', () => {
    const r = read(path.join(M, 'ReadinessTab.jsx'));
    assert.equal(C.TARGET_SCORE, 9.0, 'ACC-UI-33 the target is 9.0');
    assert.match(r, /TARGET_SCORE|9\.0/, 'ACC-UI-33 projected against the target');
    assert.match(r, /daysToExam|days/i, 'ACC-UI-33 countdown');
    assert.match(r, /score|bar|width/i, 'ACC-UI-33 per-topic bars');
  });

  test('ACC-UI-34 the mood chip popover shows the reason and a mood_history sparkline', () => {
    const src = read(path.join(M, 'StatusLine.jsx')) + read(path.join(SRC, 'App.jsx'));
    assert.match(src, /reason/, 'ACC-UI-34 the reason string');
    assert.match(src, /moodHistory|mood_history|sparkline/i, 'ACC-UI-34 the sparkline');
  });

  test('ACC-UI-35 the status line carries all seven segments', () => {
    const s = read(path.join(M, 'StatusLine.jsx'));
    for (const [what, re] of [
      ['MONDAY', /MONDAY/], ['mood', /mood/i], ['lesson L<n>', /`L\$\{|L\{|lesson/i],
      ['days to exam', /TO EXAM|daysToExam/i], ['readiness /100', /100|READY/],
      ['CTX %', /CTX/], ['timer', /clock\(|⏱|elapsed/i],
    ]) {
      assert.match(s, re, `ACC-UI-35 status line missing the ${what} segment`);
    }
  });

  test('ACC-UI-24/26/27 the audio layer persists its toggle, ducks while typing, and mutes in EXAM', () => {
    const app = read(path.join(SRC, 'App.jsx'));
    const audio = read(path.join(M, 'audio.js'));
    assert.match(app + audio, /localStorage/, 'ACC-UI-24 the speaker toggle is not persisted');
    assert.match(audio, /duck/i, 'ACC-UI-26 no mute-while-typing duck');
    assert.match(app, /EXAM/, 'ACC-UI-27 nothing in App.jsx reacts to EXAM');
    assert.ok(/mode\s*===\s*'EXAM'|EXAM'[^)]*\)\s*\?|=== 'EXAM'/.test(app),
      'ACC-UI-27 no explicit EXAM auto-mute branch');
  });

  test('ACC-UI-25 per-message replay exists', () => {
    const app = read(path.join(SRC, 'App.jsx'));
    const audio = read(path.join(M, 'audio.js'));
    assert.match(audio, /replay/i, 'ACC-UI-25 no replay in the audio queue');
    assert.match(app, /replay/i, 'ACC-UI-25 nothing calls replay from a message');
  });
});

describe('§C the client mood palette agrees with the server', () => {
  test('ACC-C2-03 the client knows all six moods', () => {
    assert.deepEqual([...C.MOODS].sort(), [...MOODS].sort(), 'ACC-C2-03 client moods');
    for (const m of MOODS) {
      assert.equal(typeof C.MOOD_COLORS[m].light, 'string', `ACC-C2-03 ${m}.light`);
      assert.equal(typeof C.MOOD_COLORS[m].dark, 'string', `ACC-C2-03 ${m}.dark`);
    }
  });

  test('ACC-UI-16 moodColor resolves per theme for every mood', () => {
    for (const m of MOODS) {
      assert.equal(C.moodColor(m, 'light'), C.MOOD_COLORS[m].light, `ACC-UI-16 ${m} light`);
      assert.equal(C.moodColor(m, 'dark'), C.MOOD_COLORS[m].dark, `ACC-UI-16 ${m} dark`);
    }
  });
});

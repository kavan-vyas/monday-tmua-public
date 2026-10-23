// ACC-SETH-01..18 — the settings endpoints, over a real socket, against the real
// index.js booted in a sandbox on a spare port. The live app owns :3941 and
// nothing here goes near it or near the real tutor_data tree.
//
// The question every one of these asks is the same: does moving the control
// actually change the thing it claims to change, all the way to disk?
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';
import { bootServer, freePort } from '../helpers/boot.mjs';
import { MODES, TRIGGER_IDS, MOODS } from '../helpers/assertions.mjs';

let box, srv, port, MEMORY;

const url = (p) => `http://127.0.0.1:${port}${p}`;
const get = (p) => fetch(url(p));
const getJson = (p) => get(p).then((r) => r.json());
const post = (p, body) =>
  fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const postJson = (p, body) => post(p, body).then(async (r) => ({ status: r.status, body: await r.json() }));

/** saveState() is debounced 400 ms; read .state.json after it has settled. */
async function persisted() {
  await new Promise((r) => setTimeout(r, 900));
  return JSON.parse(fs.readFileSync(box.stateFile, 'utf8'));
}

before(async () => {
  port = await freePort();
  box = makeSandbox({
    tag: 'set-http',
    port,
    tutorData: {
      ...defaultTutorData(),
      'memory/session_memory.json': `{
  "schema_version": "2.0",
  "student": "Fixture Student",
  "exam_date": "2026-10-12",
  "topic_stats": {
    "algebra": { "attempted": 20, "correct": 17 }
  }
}
`,
    },
  });
  MEMORY = path.join(box.tutorData, 'memory', 'session_memory.json');
  srv = await bootServer(box, port);
  port = srv.port;   // bootServer may have retried onto a different port
});
after(async () => { await srv?.stop(); box?.dispose(); });

describe('GET /api/config tells the panel everything it needs', () => {
  test('ACC-SETH-01 the live config carries every settings block', async () => {
    const d = await getJson('/api/config');
    for (const k of ['model', 'effort', 'mode', 'voice', 'speech', 'proactive',
      'proactiveEnabled', 'proactiveRateLimitMin', 'examDate', 'targetScore', 'appearance']) {
      assert.ok(k in d.config, `ACC-SETH-01 config.${k} missing from the wire`);
    }
  });

  test('ACC-SETH-02 it reports what each mode gates, from modes.js itself', async () => {
    const d = await getJson('/api/config');
    assert.deepEqual(Object.keys(d.modeGates).sort(), [...MODES].sort(), 'ACC-SETH-02 one entry per mode');
    assert.equal(d.modeGates.EXAM.voiceEnabled, false, 'ACC-SETH-02 EXAM must report itself silent');
    assert.equal(d.modeGates.EXAM.hintsAllowed, false, 'ACC-SETH-02 EXAM hints');
    assert.equal(d.modeGates.EXAM.proactiveEnabled, false, 'ACC-SETH-02 EXAM interruptions');
    assert.equal(d.modeGates.EXAM.timerForced, true, 'ACC-SETH-02 EXAM timer');
    assert.equal(d.modeGates.PAUSE.proactiveEnabled, false, 'ACC-SETH-02 PAUSE gates proactivity');
    assert.equal(d.modeGates.DRILL.videoAllowed, true, 'ACC-SETH-02 DRILL');
    for (const m of MODES) assert.equal(typeof d.modeBlurbs[m], 'string', `ACC-SETH-02 blurb for ${m}`);
  });

  test('ACC-SETH-03 it reports the live voice worker state and its prosody', async () => {
    const d = await getJson('/api/config');
    assert.equal(typeof d.voice.status, 'string', 'ACC-SETH-03 status');
    assert.equal(typeof d.voice.options.rate, 'number', 'ACC-SETH-03 rate');
    assert.deepEqual(Object.keys(d.voice.options.prosody).sort(), [...MOODS].sort(),
      'ACC-SETH-03 the panel needs one prosody entry per mood');
  });
});

describe('POST /api/config actually changes things', () => {
  test('ACC-SETH-04 a prosody write reaches both the stored config and the voice module', async () => {
    const r = await postJson('/api/config', {
      speech: { rate: 1.2, longForm: false, maxChars: 200, prosody: { sharp: { rate: 1.25, pause: 0.5 } } },
    });
    assert.equal(r.status, 200, 'ACC-SETH-04 status');
    assert.equal(r.body.config.speech.rate, 1.2, 'ACC-SETH-04 rate in the response');

    const live = await getJson('/api/config');
    assert.equal(live.voice.options.rate, 1.2, 'ACC-SETH-04 voice.js was not told about the new rate');
    assert.equal(live.voice.options.longForm, false, 'ACC-SETH-04 voice.js was not told about the long-form gate');
    assert.deepEqual(live.voice.options.prosody.sharp, { rate: 1.25, pause: 0.5 },
      'ACC-SETH-04 the per-mood prosody did not reach voice.js');

    const st = await persisted();
    assert.equal(st.config.speech.rate, 1.2, 'ACC-SETH-04 it did not survive to .state.json');
    assert.equal(st.config.speech.prosody.sharp.pause, 0.5, 'ACC-SETH-04 prosody in .state.json');
  });

  test('ACC-SETH-05 out-of-range values are clamped by the server, not stored as sent', async () => {
    const r = await postJson('/api/config', {
      speech: { rate: 99 }, voice: { volume: 42 }, proactiveRateLimitMin: 99999, targetScore: 500,
    });
    assert.equal(r.body.config.speech.rate, 1.4, 'ACC-SETH-05 rate');
    assert.equal(r.body.config.voice.volume, 1, 'ACC-SETH-05 volume');
    assert.equal(r.body.config.proactiveRateLimitMin, 240, 'ACC-SETH-05 rate limit');
    assert.equal(r.body.config.targetScore, 9, 'ACC-SETH-05 target');
  });

  test('ACC-SETH-06 a key the client invents never reaches .state.json', async () => {
    await postJson('/api/config', { pwned: 'x'.repeat(500), proactive: { made_up: true } });
    const st = await persisted();
    assert.ok(!('pwned' in st.config), 'ACC-SETH-06 an unknown key was persisted');
    assert.deepEqual(Object.keys(st.config.proactive).sort(), [...TRIGGER_IDS].sort(),
      'ACC-SETH-06 a made-up trigger was persisted');
  });

  test('ACC-SETH-07 an unknown mode is still a 400', async () => {
    const r = await post('/api/config', { mode: 'GODMODE' });
    assert.equal(r.status, 400, 'ACC-SETH-07');
  });

  test('ACC-SETH-08 the target score moves the readiness report', async () => {
    await postJson('/api/config', { targetScore: 6.5 });
    const rd = await getJson('/api/readiness');
    assert.equal(rd.target, 6.5, 'ACC-SETH-08 /api/readiness ignored the configured target');
    assert.ok(rd.trajectory <= 6.5, `ACC-SETH-08 the trajectory (${rd.trajectory}) must sit under the target`);
    await postJson('/api/config', { targetScore: 9 });
    assert.equal((await getJson('/api/readiness')).target, 9, 'ACC-SETH-08 and back again');
  });

  test('ACC-SETH-09 appearance survives a round trip and a restart', async () => {
    await postJson('/api/config', { appearance: { theme: 'dark', density: 'compact', fontSize: 'large' } });
    const st = await persisted();
    assert.deepEqual(st.config.appearance, { theme: 'dark', density: 'compact', fontSize: 'large' },
      'ACC-SETH-09 appearance is not persisted server-side');
  });
});

describe('the exam date is a setting, and the record is not a scratchpad', () => {
  test('ACC-SETH-10 GET reports the record, not the config mirror', async () => {
    const d = await getJson('/api/exam-date');
    assert.equal(d.examDate, '2026-10-12', 'ACC-SETH-10 date');
    assert.equal(d.present, true, 'ACC-SETH-10 present');
    assert.equal(d.source, 'session_memory.json', 'ACC-SETH-10 source');
  });

  test('ACC-SETH-11 POST writes the record, and changes exactly one line of it', async () => {
    const before = fs.readFileSync(MEMORY, 'utf8');
    const r = await postJson('/api/exam-date', { date: '2027-01-09' });
    assert.equal(r.status, 200, `ACC-SETH-11 ${JSON.stringify(r.body)}`);
    const after = fs.readFileSync(MEMORY, 'utf8');
    const changed = before.split('\n').filter((l, i) => l !== after.split('\n')[i]);
    assert.equal(changed.length, 1, `ACC-SETH-11 ${changed.length} lines changed`);
    assert.equal(JSON.parse(after).exam_date, '2027-01-09', 'ACC-SETH-11 value');
    assert.equal(JSON.parse(after).student, 'Fixture Student', 'ACC-SETH-11 the rest of the record survived');
  });

  test('ACC-SETH-12 the config mirror and the readiness countdown follow it immediately', async () => {
    assert.equal((await getJson('/api/config')).config.examDate, '2027-01-09',
      'ACC-SETH-12 config.examDate is a stale second copy');
    const rd = await getJson('/api/readiness');
    assert.equal(rd.examDate, '2027-01-09', 'ACC-SETH-12 readiness is still on the old date');
  });

  test('ACC-SETH-13 there is no second copy of the date in .state.json to drift', async () => {
    const st = await persisted();
    assert.equal(st.config.examDate, '2027-01-09',
      'ACC-SETH-13 the mirror in .state.json did not follow the record');
    assert.equal(st.config.examDate, JSON.parse(fs.readFileSync(MEMORY, 'utf8')).exam_date,
      'ACC-SETH-13 the mirror and the record disagree');
  });

  test('ACC-SETH-14 a nonsense date is a 400 and the record is untouched', async () => {
    const before = fs.readFileSync(MEMORY, 'utf8');
    for (const date of ['whenever', '2026-02-30', '', null, { evil: true }]) {
      const r = await postJson('/api/exam-date', { date });
      assert.equal(r.status, 400, `ACC-SETH-14 ${JSON.stringify(date)} was accepted`);
    }
    assert.equal(fs.readFileSync(MEMORY, 'utf8'), before, 'ACC-SETH-14 a refused write touched the record');
    // put it back for the rest of the run
    await postJson('/api/exam-date', { date: '2026-10-12' });
  });
});

describe('data: paths, sizes, and the one thing that may be deleted', () => {
  test('ACC-SETH-15 the stats name real paths inside the project', async () => {
    const d = await getJson('/api/data-stats');
    for (const k of ['projectRoot', 'tutorData', 'chats', 'state', 'voiceCache', 'sessionMemory', 'dashboard']) {
      assert.equal(typeof d.paths[k], 'string', `ACC-SETH-15 paths.${k}`);
      assert.ok(path.isAbsolute(d.paths[k]), `ACC-SETH-15 paths.${k} must be absolute`);
    }
    assert.ok(d.paths.tutorData.startsWith(d.paths.projectRoot),
      'ACC-SETH-15 tutor_data must sit inside the project root');
    assert.equal(typeof d.chats.bytes, 'number', 'ACC-SETH-15 chat archive size');
    assert.equal(typeof d.voiceCache.bytes, 'number', 'ACC-SETH-15 voice cache size');
  });

  test('ACC-SETH-16 clearing the audio cache removes the wavs and reports the truth', async () => {
    const d0 = await getJson('/api/data-stats');
    const dir = d0.paths.voiceCache;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'deadbeef.wav'), Buffer.alloc(4096));
    fs.writeFileSync(path.join(dir, 'keepme.json'), '{}');

    const before = await getJson('/api/data-stats');
    assert.equal(before.voiceCache.files, 1, 'ACC-SETH-16 the fixture wav is counted');
    assert.equal(before.voiceCache.bytes, 4096, 'ACC-SETH-16 bytes');

    const r = await postJson('/api/voice-cache/clear', {});
    assert.equal(r.status, 200, 'ACC-SETH-16 status');
    assert.equal(r.body.removed, 1, 'ACC-SETH-16 removed count');
    assert.equal(r.body.voiceCache.files, 0, 'ACC-SETH-16 the response reports the cache as empty');
    assert.equal((await getJson('/api/data-stats')).voiceCache.files, 0, 'ACC-SETH-16 and it really is');
    assert.ok(fs.existsSync(path.join(dir, 'keepme.json')), 'ACC-SETH-16 a non-wav file was deleted');
  });

  test('ACC-SETH-17 clearing the cache never touches the student record or the chats', async () => {
    const memBefore = fs.readFileSync(MEMORY, 'utf8');
    const chatsDir = path.join(box.appDir, 'chats');
    const chatsBefore = fs.existsSync(chatsDir) ? fs.readdirSync(chatsDir).sort() : [];
    await postJson('/api/voice-cache/clear', {});
    assert.equal(fs.readFileSync(MEMORY, 'utf8'), memBefore, 'ACC-SETH-17 the student record was modified');
    const chatsAfter = fs.existsSync(chatsDir) ? fs.readdirSync(chatsDir).sort() : [];
    assert.deepEqual(chatsAfter, chatsBefore, 'ACC-SETH-17 a chat file disappeared');
    for (const f of ['backlog.json', 'activity_log.json']) {
      assert.ok(fs.existsSync(path.join(box.tutorData, f)), `ACC-SETH-17 ${f} was removed`);
    }
  });

  test('ACC-SETH-18 the proactive rate limit is live, not a restart-only constant', async () => {
    const r = await postJson('/api/config', { proactiveRateLimitMin: 45 });
    assert.equal(r.body.config.proactiveRateLimitMin, 45, 'ACC-SETH-18 accepted');
    const st = await persisted();
    assert.equal(st.config.proactiveRateLimitMin, 45, 'ACC-SETH-18 persisted');
    // A floor is a floor: it cannot be turned off.
    const off = await postJson('/api/config', { proactiveRateLimitMin: 0 });
    assert.equal(off.body.config.proactiveRateLimitMin, 1,
      'ACC-SETH-18 the rate limit could be removed entirely');
  });
});

// ACC-REG-01..05 — the non-negotiable one.
//
// session_memory.json and session_notes.md are the student's live record and the public
// dashboard parses them. They must stay byte-compatible.
//
// Two things are checked:
//   1. the REAL files still satisfy the schema the dashboard reads (read-only), and
//      the REAL dashboard builder still renders from a copy of them;
//   2. nothing in this suite mutated any of them.
//
// The dashboard builder writes into tutor_data/dashboard-site/data, so it is run
// against a temp COPY of the real record rather than the real tree.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeSandbox, defaultTutorData, REPO_ROOT } from '../helpers/sandbox.mjs';

const TUTOR = path.join(REPO_ROOT, 'tutor_data');
const LIVE = {
  session_memory: path.join(TUTOR, 'memory', 'session_memory.json'),
  session_notes: path.join(TUTOR, 'session_notes.md'),
  backlog: path.join(TUTOR, 'backlog.json'),
  activity_log: path.join(TUTOR, 'activity_log.json'),
};

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const before = Object.fromEntries(
  Object.entries(LIVE).filter(([, p]) => fs.existsSync(p)).map(([k, p]) => [k, sha(p)]),
);

const boxes = [];
after(() => boxes.forEach((b) => b.dispose()));

dataDescribe('§Verification the byte-compatibility regression', () => {
  test('ACC-REG-01 the live session_memory.json still has the shape the dashboard reads', () => {
    const mem = JSON.parse(fs.readFileSync(LIVE.session_memory, 'utf8'));
    // The keys dashboard.js, mood.js, readiness.js and proactive.js all read.
    for (const key of ['topic_stats', 'questions_attempted', 'sessions', 'review_queue']) {
      assert.ok(key in mem, `ACC-REG-01 session_memory.json lost the "${key}" key`);
    }
    assert.equal(typeof mem.topic_stats, 'object', 'ACC-REG-01 topic_stats is not an object');
    assert.ok(Array.isArray(mem.questions_attempted), 'ACC-REG-01 questions_attempted is not an array');
    assert.ok(Array.isArray(mem.sessions), 'ACC-REG-01 sessions is not an array');
    assert.ok(Array.isArray(mem.review_queue), 'ACC-REG-01 review_queue is not an array');
    for (const [topic, s] of Object.entries(mem.topic_stats)) {
      assert.equal(typeof s.attempted, 'number', `ACC-REG-01 topic_stats.${topic}.attempted`);
      assert.equal(typeof s.correct, 'number', `ACC-REG-01 topic_stats.${topic}.correct`);
    }
  });

  test('ACC-REG-01 no Monday key was bolted onto the student record', () => {
    const mem = JSON.parse(fs.readFileSync(LIVE.session_memory, 'utf8'));
    for (const k of ['mood_history', 'explanations', 'phrasings', 'observations', 'monday']) {
      assert.ok(!(k in mem),
        `ACC-REG-01 "${k}" was written into session_memory.json — Monday's memory belongs in tutor_data/monday/`);
    }
  });

  test('ACC-REG-02 session_notes.md keeps its existing format', () => {
    if (!fs.existsSync(LIVE.session_notes)) return;
    const txt = fs.readFileSync(LIVE.session_notes, 'utf8');
    assert.ok(txt.length > 0, 'ACC-REG-02 session_notes.md is empty');
    assert.match(txt, /^#|\n#/, 'ACC-REG-02 session_notes.md no longer looks like markdown headings');
  });

  test('ACC-REG-04 backlog.json and activity_log.json keep their shape', () => {
    if (fs.existsSync(LIVE.backlog)) {
      const b = JSON.parse(fs.readFileSync(LIVE.backlog, 'utf8'));
      assert.ok(Array.isArray(b.items ?? b), 'ACC-REG-04 backlog.json is neither {items:[]} nor an array');
    }
    if (fs.existsSync(LIVE.activity_log)) {
      const a = JSON.parse(fs.readFileSync(LIVE.activity_log, 'utf8'));
      assert.ok(Array.isArray(a.entries ?? a), 'ACC-REG-04 activity_log.json lost its entries array');
    }
  });

  test('ACC-REG-01/02 the real dashboard builder still renders from the real record', async () => {
    // A sandbox seeded with COPIES of the live files, so buildDashboard's writes
    // land in the temp tree and never in tutor_data/dashboard-site.
    const box = makeSandbox({
      tag: 'reg',
      tutorData: defaultTutorData({
        'memory/session_memory.json': fs.readFileSync(LIVE.session_memory, 'utf8'),
        ...(fs.existsSync(LIVE.activity_log)
          ? { 'activity_log.json': fs.readFileSync(LIVE.activity_log, 'utf8') } : {}),
        ...(fs.existsSync(LIVE.backlog)
          ? { 'backlog.json': fs.readFileSync(LIVE.backlog, 'utf8') } : {}),
      }),
    });
    boxes.push(box);
    const dash = await box.imp('dashboard.js');
    let out;
    assert.doesNotThrow(() => { out = dash.buildDashboard(); },
      'ACC-REG-01 the dashboard builder threw on the live session_memory.json');
    assert.ok(out.questions >= 0 && out.topics >= 0, 'ACC-REG-01 the dashboard produced no counts');

    const dataDir = path.join(box.tutorData, 'dashboard-site', 'data');
    for (const f of ['stats.json', 'activity.json', 'elements.json', 'questions.json']) {
      const p = path.join(dataDir, f);
      assert.ok(fs.existsSync(p), `ACC-REG-01 the dashboard did not emit ${f}`);
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(p, 'utf8')), `ACC-REG-01 ${f} is not valid JSON`);
    }
  });

  test('ACC-REG-03/05 the suite has not modified a single live student file', () => {
    const changed = [];
    for (const [name, hashBefore] of Object.entries(before)) {
      const now = sha(LIVE[name]);
      if (now !== hashBefore) changed.push(name);
    }
    assert.deepEqual(changed, [],
      `ACC-REG-05 THE TEST SUITE MUTATED LIVE STUDENT DATA: ${changed.join(', ')}`);
  });

  /**
   * The leak this guards against is a sandboxed dashboard build escaping into the real
   * tutor_data tree. A freshness check alone cannot see that: the live app watches
   * tutor_data and regenerates the same files whenever the student's record changes, so a
   * recently-written file was as likely to be the app doing its job as the suite
   * misbehaving — and the test failed on a machine where the app was simply running.
   *
   * What distinguishes the two is CONTENT. A leaked build is rendered from the fixture
   * tree, which has four attempted questions and a handful of topics; a real one describes
   * the actual record. So the test reads the files back and asserts they still describe
   * reality, which is the property that actually matters.
   */
  test('ACC-REG-05 the real dashboard-site data still describes the real record', () => {
    const dataDir = path.join(TUTOR, 'dashboard-site', 'data');
    if (!fs.existsSync(dataDir)) return;
    const statsPath = path.join(dataDir, 'stats.json');
    if (!fs.existsSync(statsPath)) return;

    const live = JSON.parse(fs.readFileSync(path.join(TUTOR, 'memory', 'session_memory.json'), 'utf8'));
    const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    const attempted = stats.questions ?? stats.total_questions_attempted ?? stats.attempted ?? null;

    if (attempted == null) return;   // shape changed; ACC-REG-01 owns that
    const real = live.questions_attempted?.length ?? 0;
    assert.ok(
      Math.abs(attempted - real) <= Math.max(20, real * 0.1),
      `ACC-REG-05 the real dashboard data describes ${attempted} questions but the record holds `
      + `${real} — a sandbox build has leaked into tutor_data/dashboard-site/data`,
    );
  });
});

// Needs the private paper collection and study record, which the public repo does not ship.
import { existsSync as __exists } from 'node:fs';
function dataDescribe(...a) {
  const has = __exists(new URL('../../../major exams/tmua/jz', import.meta.url));
  return (has ? describe : describe.skip)(...a);
}

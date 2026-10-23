// ACC-MEM-01..10 and ACC-SELF-01..11 — Monday's own memory and its self-knowledge.
// Every write here lands in a temp fixture tree; nothing touches tutor_data/monday/.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';
import { TOOL_NAMES } from '../helpers/assertions.mjs';

let sbx, mem;
before(async () => { sbx = makeSandbox({ tag: 'mem' }); mem = await sbx.imp('mondaymem.js'); });
after(() => sbx.dispose());

describe('§B1 Monday\'s own memory store', () => {
  test('ACC-MEM-01 tutor_data/monday/ is a separate directory from the student record', () => {
    assert.ok(mem.MONDAY_DIR.endsWith(`${'/'}monday`), 'ACC-MEM-01 MONDAY_DIR');
    assert.ok(!mem.MONDAY_DIR.includes('/memory/'), 'ACC-MEM-01 not inside tutor_data/memory');
  });

  test('ACC-MEM-02 memory.json carries all five documented keys', async () => {
    await mem.mondayNote({ kind: 'observation', content: 'seed' });
    const m = sbx.readJson('monday/memory.json');
    for (const k of ['schema_version', 'explanations', 'phrasings', 'observations', 'mood_history']) {
      assert.ok(k in m, `ACC-MEM-02 memory.json missing ${k}`);
    }
    for (const k of ['explanations', 'phrasings', 'observations', 'mood_history']) {
      assert.ok(Array.isArray(m[k]), `ACC-MEM-02 ${k} must be an array`);
    }
  });

  test('ACC-MEM-03 explanations[] entries have the documented fields and outcome vocabulary', async () => {
    const box = makeSandbox({ tag: 'mem-x' });
    const m = await box.imp('mondaymem.js');
    await m.mondayNote({ kind: 'explanation', topic: 'logs', content: 'change of base first', outcome: 'landed', evidence: 'got the next two right' });
    const e = box.readJson('monday/memory.json').explanations.at(-1);
    for (const k of ['ts', 'topic', 'technique', 'approach', 'outcome', 'evidence']) {
      assert.ok(k in e, `ACC-MEM-03 explanation entry missing ${k}`);
    }
    assert.ok(['landed', 'bounced', 'partial'].includes(e.outcome),
      `ACC-MEM-03 outcome "${e.outcome}" outside {landed,bounced,partial}`);
    assert.equal(e.outcome, 'landed', 'ACC-MEM-03 the given outcome is kept');
    // Every one of the three permitted values must round-trip.
    for (const oc of ['landed', 'bounced', 'partial']) {
      await m.mondayNote({ kind: 'explanation', topic: 't', content: 'x', outcome: oc });
      assert.equal(box.readJson('monday/memory.json').explanations.at(-1).outcome, oc,
        `ACC-MEM-03 outcome ${oc} must be accepted`);
    }
    box.dispose();
  });

  test('ACC-MEM-04 phrasings[] entries have the documented fields and reception vocabulary', async () => {
    const box = makeSandbox({ tag: 'mem-p' });
    const m = await box.imp('mondaymem.js');
    for (const rc of ['good', 'flat', 'bad']) {
      await m.mondayNote({ kind: 'phrasing', content: `line ${rc}`, outcome: rc, context: 'after a wrong answer' });
      const p = box.readJson('monday/memory.json').phrasings.at(-1);
      for (const k of ['ts', 'line', 'context', 'reception', 'note']) {
        assert.ok(k in p, `ACC-MEM-04 phrasing entry missing ${k}`);
      }
      assert.equal(p.reception, rc, `ACC-MEM-04 reception ${rc} must be accepted`);
    }
    box.dispose();
  });

  test('ACC-MEM-05 mood_history keeps the last 200 — the 201st drops the oldest', async () => {
    const box = makeSandbox({ tag: 'mem-h' });
    const m = await box.imp('mondaymem.js');
    // recordMood coalesces a run of the same mood, so alternate to force distinct entries.
    const cycle = ['focused', 'sharp', 'gentle', 'clinical', 'wry', 'grave'];
    for (let i = 0; i < 260; i++) m.recordMood(cycle[i % cycle.length], `reason ${i}`);
    const h = box.readJson('monday/memory.json').mood_history;
    assert.ok(h.length <= 200, `ACC-MEM-05 mood_history holds ${h.length}, cap is 200`);
    assert.equal(h.length, 200, 'ACC-MEM-05 the cap should be reached, not undershot');
    const last = h.at(-1);
    assert.equal(last.mood, cycle[259 % cycle.length], 'ACC-MEM-05 the newest entry is kept');
    assert.ok(!h.some((e) => e.reason === 'reason 0'),
      'ACC-MEM-05 the oldest entry should have fallen off');
    box.dispose();
  });

  test('ACC-MEM-06 journal.md exists and takes narrative entries', async () => {
    const box = makeSandbox({ tag: 'mem-j' });
    const m = await box.imp('mondaymem.js');
    const r = await m.mondayNote({ kind: 'journal', content: 'He fought sequences for forty minutes and won.' });
    assert.equal(r.ok, true, 'ACC-MEM-06 journal write accepted');
    assert.match(box.read('monday/journal.md'), /fought sequences/, 'ACC-MEM-06 written to journal.md');
    box.dispose();
  });

  test('ACC-MEM-07 a note appends without destroying prior entries', async () => {
    const box = makeSandbox({ tag: 'mem-a' });
    const m = await box.imp('mondaymem.js');
    await m.mondayNote({ kind: 'observation', content: 'first' });
    await m.mondayNote({ kind: 'observation', content: 'second' });
    await m.mondayNote({ kind: 'phrasing', content: 'a line', outcome: 'good' });
    const j = box.readJson('monday/memory.json');
    assert.equal(j.observations.length, 2, 'ACC-MEM-07 both observations survive');
    assert.equal(j.observations[0].content, 'first', 'ACC-MEM-07 the first is still first');
    assert.equal(j.phrasings.length, 1, 'ACC-MEM-07 a note of one kind does not wipe another');
    box.dispose();
  });

  test('ACC-MEM-08 mondayRecall filters by kind and topic', async () => {
    const box = makeSandbox({ tag: 'mem-r' });
    const m = await box.imp('mondaymem.js');
    await m.mondayNote({ kind: 'explanation', topic: 'logarithms', content: 'change of base', outcome: 'landed' });
    await m.mondayNote({ kind: 'explanation', topic: 'sequences', content: 'index shifting', outcome: 'bounced' });
    const logs = await m.mondayRecall({ kind: 'explanation', topic: 'logarithms' });
    assert.ok(logs.hits >= 1, 'ACC-MEM-08 the matching topic is found');
    assert.ok(logs.entries.every((e) => JSON.stringify(e).includes('logarithm')),
      `ACC-MEM-08 recall leaked a non-matching topic: ${JSON.stringify(logs.entries)}`);
    box.dispose();
  });

  test('ACC-MEM-09 recall on an unknown topic returns empty rather than throwing', async () => {
    let r;
    await assert.doesNotReject(async () => { r = await mem.mondayRecall({ kind: 'all', topic: 'quantum basket weaving' }); },
      'ACC-MEM-09');
    assert.equal(r.hits, 0, 'ACC-MEM-09 no hits');
  });

  test('ACC-MEM-10 writing Monday memory never touches session_memory.json', async () => {
    const box = makeSandbox({ tag: 'mem-iso' });
    const m = await box.imp('mondaymem.js');
    const before = box.read('memory/session_memory.json');
    await m.mondayNote({ kind: 'observation', content: 'x' });
    await m.mondayNote({ kind: 'journal', content: 'y' });
    m.recordMood('sharp', 'z');
    assert.equal(box.read('memory/session_memory.json'), before,
      'ACC-MEM-10 session_memory.json changed while writing Monday memory');
    box.dispose();
  });
});

describe('§B1 self-knowledge — computed, not memorised', () => {
  test('ACC-SELF-03 the tool count equals the tools actually registered in session.js', async () => {
    const s = await mem.mondaySelf();
    assert.equal(s.tool_count, s.tools.length, 'ACC-SELF-03 internally consistent');
    assert.deepEqual([...s.tools].sort(), [...TOOL_NAMES].sort(),
      'ACC-SELF-03 the reported tools must be exactly those registered in session.js');
    assert.equal(s.tool_count, TOOL_NAMES.length,
      `ACC-SELF-03 reports ${s.tool_count} tools, session.js registers ${TOOL_NAMES.length}`);
    assert.ok(s.text.includes(String(s.tool_count)),
      'ACC-SELF-03 the spoken text must carry the true count');
  });

  test('ACC-SELF-01 mondaySelf changes when the underlying state changes', async () => {
    const box = makeSandbox({ tag: 'self-live' });
    const m = await box.imp('mondaymem.js');
    const before = await m.mondaySelf();
    await m.mondayNote({ kind: 'observation', content: 'he prefers being told the answer is wrong outright' });
    await m.mondayNote({ kind: 'explanation', topic: 'logs', content: 'x', outcome: 'landed' });
    const after = await m.mondaySelf();
    assert.notEqual(after.my_observations_recorded, before.my_observations_recorded,
      'ACC-SELF-01 the observation count did not move — this looks memorised, not computed');
    assert.notEqual(after.my_explanations_recorded, before.my_explanations_recorded,
      'ACC-SELF-01 the explanation count did not move');
    assert.notEqual(after.text, before.text, 'ACC-SELF-01 the rendered text is identical across a real state change');
    box.dispose();
  });

  test('ACC-SELF-01 it also tracks the record it reads rather than a constant', async () => {
    const box = makeSandbox({
      tag: 'self-rec',
      tutorData: defaultTutorData({
        'memory/session_memory.json': {
          schema_version: 3, session_number: 77, topic_stats: {},
          questions_attempted: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
          review_queue: [{ id: 'a' }], sessions: [], misconceptions: [],
        },
      }),
    });
    const m = await box.imp('mondaymem.js');
    const s = await m.mondaySelf();
    assert.equal(s.lessons_logged, 77, 'ACC-SELF-01 lesson number read from the file');
    assert.equal(s.questions_on_record, 3, 'ACC-SELF-01 question count read from the file');
    assert.equal(s.review_queue, 1, 'ACC-SELF-01 review queue read from the file');
    box.dispose();
  });

  test('ACC-SELF-02 the output is not a paragraph lifted from self_model.md', async () => {
    const s = await mem.mondaySelf();
    const model = sbx.read('monday/self_model.md');
    assert.notEqual(s.text.trim(), model.trim(), 'ACC-SELF-02 mondaySelf just returns the stored file');
    assert.ok(!model.includes(String(s.tool_count)),
      'ACC-SELF-02 the tool count is hard-coded into self_model.md — that is memorised, not computed');
  });

  test('ACC-SELF-04..08 it states the build, the limits and the voice honestly', async () => {
    const s = await mem.mondaySelf();
    const t = s.text;
    assert.match(t, /Agent SDK/i, 'ACC-SELF-04 Claude Agent SDK');
    assert.match(t, /local Node server/i, 'ACC-SELF-04 local Node server');
    assert.ok(!/\bBash\b/.test(s.tools.join(' ')), 'ACC-SELF-05 Bash must not be a registered tool');
    assert.match(t, /no web access/i, 'ACC-SELF-06 states no web access');
    assert.match(s.writes, /tutor_data/, 'ACC-SELF-07 writes confined to tutor_data/');
    assert.match(t, /tutor_data/, 'ACC-SELF-07 stated in the text');
    assert.match(t, /82M|82 ?m(illion)?/i, 'ACC-SELF-08 states the local 82M voice model');
  });

  test('ACC-SELF-09 it reports live file-derived facts, not constants', async () => {
    const s = await mem.mondaySelf();
    for (const k of ['papers_on_disk', 'index_questions', 'chats_on_disk', 'questions_on_record']) {
      assert.equal(typeof s[k], 'number', `ACC-SELF-09 ${k} should be a computed number`);
    }
    assert.ok(s.uptime_ms >= 0, 'ACC-SELF-09 uptime is measured');
  });

  test('ACC-SELF-10 readSelfModel returns the content of tutor_data/monday/self_model.md', () => {
    const out = mem.readSelfModel();
    assert.ok(out.includes('I am the assistant that runs this tutor.'),
      'ACC-SELF-10 the file content is returned');
  });

  test('ACC-SELF-10 readSelfModel does not throw when the file is absent', () => {
    const box = makeSandbox({ tag: 'self-none', tutorData: {} });
    assert.doesNotThrow(async () => {
      const m = await box.imp('mondaymem.js');
      assert.equal(typeof m.readSelfModel(), 'string', 'ACC-SELF-10 still a string');
    }, 'ACC-SELF-10');
    box.dispose();
  });

  test('ACC-SELF-11 buildSystemPrompt embeds readSelfModel output', async () => {
    const { buildSystemPrompt } = await sbx.imp('prompt.js');
    const body = mem.readSelfModel().trim();
    assert.ok(body.length > 0, 'setup: a self model exists');
    assert.ok(buildSystemPrompt().includes('I am the assistant that runs this tutor.'), 'ACC-SELF-11');
  });
});

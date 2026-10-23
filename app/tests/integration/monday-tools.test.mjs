// ACC-TOOL-01..16 — the tools Monday actually calls, driven through their real
// handlers. The SDK is module-mocked so createSdkMcpServer hands back the tool array
// it was given; nothing here talks to a model.
//
// Expectations come from the plan: §1.5 (three annotation tools, show_pdf's shape),
// §1.6 (add_paper is the only route in, everything else goes to the library) and
// §2.3 (show_video mirrors show_pdf and is suppressed in EXAM via modeGates).
// Requires --experimental-test-module-mocks.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';
import { TOOL_NAMES } from '../helpers/assertions.mjs';

let sbx, session, servers, PAPER;

const text = (r) => r.content.map((c) => c.text ?? '').join('\n');

/** A tutor plus the broadcast log, and its tools by name. */
function makeTutor(config = {}) {
  const events = [];
  servers.length = 0;
  const tutor = session.createTutor((event) => events.push(event), null, config, { getChat: () => null });
  const cfg = servers[0];
  assert.ok(cfg, 'setup: createSdkMcpServer was not called');
  const tools = Object.fromEntries(cfg.tools.map((t) => [t.name, t]));
  return { tutor, events, tools, call: (name, args) => tools[name].handler(args, {}) };
}

before(async () => {
  process.env.MONDAY_PYTHON = '/nonexistent/no/python/here';
  process.env.MONDAY_VOICE_READY_MS = '200';
  servers = [];
  mock.module('@anthropic-ai/claude-agent-sdk', {
    namedExports: {
      query: () => ({ send() {}, async interrupt() {}, [Symbol.asyncIterator]: async function* () { await new Promise(() => {}); } }),
      tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
      createSdkMcpServer: (cfg) => { servers.push(cfg); return { type: 'sdk', name: cfg.name, instance: cfg, tools: cfg.tools }; },
    },
  });

  sbx = makeSandbox({ tag: 'tools' });
  PAPER = path.join(sbx.root, 'major exams', 'TMUA 2019 Paper 1.pdf');
  fs.mkdirSync(path.dirname(PAPER), { recursive: true });
  fs.writeFileSync(PAPER, '%PDF-1.4 fixture');
  sbx.write('file_manifest.json', { generated: 'x', tmua: { 2019: { p1: PAPER } } });
  sbx.write('reference/video_index.json', {
    schema_version: 1,
    videos: [{
      id: 'JsfrZMpd6oo', title: 'Necessity vs Sufficiency', kind: 'concept', duration_s: 900,
      topic: ['logic_and_proof'], technique: ['converse_or_contrapositive_analysis'],
      trap_type: ['necessary_confused_with_sufficient'], segments: [],
    }],
  });
  session = await sbx.imp('session.js');
});
after(() => {
  delete process.env.MONDAY_PYTHON;
  delete process.env.MONDAY_VOICE_READY_MS;
  sbx.dispose();
});

describe('§1.5 the five-file tool contract', () => {
  test('ACC-TOOL-01 every name in the contract list is actually registered', () => {
    const { tools } = makeTutor();
    const missing = TOOL_NAMES.filter((n) => !(n in tools));
    assert.deepEqual(missing, [], `ACC-TOOL-01 declared but not registered: ${missing.join(', ')}`);
  });

  test('ACC-TOOL-02 nothing is registered that the contract list does not name', () => {
    const { tools } = makeTutor();
    const extra = Object.keys(tools).filter((n) => !TOOL_NAMES.includes(n));
    assert.deepEqual(extra, [], `ACC-TOOL-02 registered but undeclared: ${extra.join(', ')}`);
  });

  test('ACC-TOOL-03 the tool count prompt.js states matches what is registered', async () => {
    const { tools } = makeTutor();
    const prompt = await sbx.imp('prompt.js');
    const stated = prompt.buildSystemPrompt().match(/exactly these (\d+) tutor tools/);
    assert.ok(stated, 'ACC-TOOL-03 the prompt no longer states a tool count at all');
    assert.equal(Number(stated[1]), Object.keys(tools).length,
      'ACC-TOOL-03 a wrong number here becomes a false fact Monday repeats about itself');
  });

  test('ACC-TOOL-04 every new tool is documented in the prompt catalogue', async () => {
    const prompt = await sbx.imp('prompt.js');
    const p = prompt.buildSystemPrompt();
    for (const n of ['read_annotations', 'annotate_pdf', 'clear_annotations', 'add_paper', 'file_to_library', 'show_video', 'find_video']) {
      assert.ok(p.includes(`mcp__tutor__${n}`), `ACC-TOOL-04 ${n} is registered but absent from the catalogue`);
    }
  });
});

describe('§1.5 Monday reads and writes marks', () => {
  test('ACC-TOOL-05 read_annotations resolves a paper by path, id or manifest key', async () => {
    const { call } = makeTutor();
    for (const arg of [PAPER, 'tmua/2019/p1']) {
      const out = text(await call('read_annotations', { paper: arg }));
      assert.match(out, /no annotations recorded/i, `ACC-TOOL-05 ${arg}: ${out}`);
      assert.match(out, /tmua\/2019\/p1/, `ACC-TOOL-05 ${arg} did not resolve to the manifest key`);
    }
  });

  test('ACC-TOOL-06 an unresolvable paper says so instead of failing silently', async () => {
    const { call } = makeTutor();
    const out = text(await call('read_annotations', { paper: 'the blue one' }));
    assert.match(out, /cannot work out which paper/i, `ACC-TOOL-06: ${out}`);
  });

  test('ACC-TOOL-07 annotate_pdf writes author "monday" and broadcasts so the pane updates live', async () => {
    const { call, events } = makeTutor();
    const out = text(await call('annotate_pdf', {
      paper: PAPER, page: 3,
      marks: [{ type: 'arrow', from: [200, 300], to: [260, 250], note: 'the case you dropped' }],
    }));
    assert.match(out, /page 3/, `ACC-TOOL-07: ${out}`);

    const ev = events.find((e) => e.type === 'annotations_changed');
    assert.ok(ev, `ACC-TOOL-07 no broadcast — the pane would need a reload. Got: ${events.map((e) => e.type).join(', ')}`);
    assert.equal(ev.page, 3, 'ACC-TOOL-07 the broadcast names the page');
    assert.equal(ev.author, 'monday', 'ACC-TOOL-07 the broadcast names the author');

    const A = await sbx.imp('annotations.js');
    const stored = A.readDoc(PAPER).pages['3'];
    assert.equal(stored.length, 1, 'ACC-TOOL-07 the mark was persisted');
    assert.equal(stored[0].author, 'monday', 'ACC-TOOL-07 author is monday');
    assert.equal(stored[0].color, A.MONDAY_COLOR, 'ACC-TOOL-07 a distinct colour, so the two never blur');
  });

  test('ACC-TOOL-08 read_annotations reads back highlight text, not coordinates', async () => {
    const { call } = makeTutor();
    await call('annotate_pdf', {
      paper: PAPER, page: 3,
      marks: [{ type: 'highlight', quads: [[70, 700, 300, 715]], text: 'for all real x', note: 'you read past this' }],
    });
    const out = text(await call('read_annotations', { paper: PAPER, page: 3 }));
    assert.match(out, /for all real x/, `ACC-TOOL-08 the highlighted text is missing:\n${out}`);
    assert.match(out, /the case you dropped/, 'ACC-TOOL-08 the arrow note is missing');
    assert.ok(!/\[\[\d/.test(out), `ACC-TOOL-08 raw coordinates leaked to the model:\n${out}`);
  });

  test('ACC-TOOL-09 unusable marks are refused with a usable message', async () => {
    const { call } = makeTutor();
    const out = text(await call('annotate_pdf', { paper: PAPER, page: 3, marks: [{ type: 'ink', paths: [] }] }));
    assert.match(out, /not usable|needs/i, `ACC-TOOL-09: ${out}`);
  });

  test('ACC-TOOL-10 clear_annotations defaults to Monday\'s own marks and leaves his working alone', async () => {
    const A = await sbx.imp('annotations.js');
    A.saveDoc(A.applyPages(A.readDoc(PAPER), { 3: [{ type: 'ink', paths: [[10, 10], [20, 20]] }] }, { author: 'student' }));
    const before = A.readDoc(PAPER).pages['3'];
    assert.ok(before.some((m) => m.author === 'student'), 'setup: he has a mark on the page');

    const { call } = makeTutor();
    const out = text(await call('clear_annotations', { paper: PAPER, page: 3 }));
    assert.match(out, /cleared 2 monday marks/i, `ACC-TOOL-10: ${out}`);

    const after = A.readDoc(PAPER).pages['3'] ?? [];
    assert.ok(after.every((m) => m.author !== 'monday'), 'ACC-TOOL-10 Monday\'s marks are gone');
    assert.ok(after.some((m) => m.author === 'student'),
      'ACC-TOOL-10 housekeeping deleted the student\'s working — it must default to Monday\'s marks only');
  });
});

describe('§2.3 show_video', () => {
  test('ACC-TOOL-11 it mirrors show_pdf: broadcasts, and returns text to the model', async () => {
    const { call, events } = makeTutor({ mode: 'DRILL' });
    const out = text(await call('show_video', { videoId: 'JsfrZMpd6oo', t: 120, note: 'watch the counterexample' }));
    const ev = events.find((e) => e.type === 'show_video');
    assert.ok(ev, `ACC-TOOL-11 no show_video broadcast. Got: ${events.map((e) => e.type).join(', ')}`);
    assert.equal(ev.videoId, 'JsfrZMpd6oo', 'ACC-TOOL-11 videoId');
    assert.equal(ev.t, 120, 'ACC-TOOL-11 t');
    assert.equal(ev.note, 'watch the counterexample', 'ACC-TOOL-11 note');
    assert.match(out, /JsfrZMpd6oo/, 'ACC-TOOL-11 the model is told what happened');
  });

  test('ACC-TOOL-12 EXAM suppresses it, in code — a tutorial video is a hint with pictures', async () => {
    const { call, events } = makeTutor({ mode: 'EXAM' });
    const out = text(await call('show_video', { videoId: 'JsfrZMpd6oo', t: 0 }));
    assert.match(out, /refused/i, `ACC-TOOL-12: ${out}`);
    assert.match(out, /exam/i, 'ACC-TOOL-12 the refusal names the reason');
    assert.equal(events.find((e) => e.type === 'show_video'), undefined,
      'ACC-TOOL-12 EXAM must suppress the broadcast too, not just the return text');
  });

  test('ACC-TOOL-12b the gate is modeGates, so it cannot drift from the other EXAM locks', async () => {
    const modes = await sbx.imp('modes.js');
    assert.equal(modes.modeGates('EXAM').videoAllowed, false, 'ACC-TOOL-12b EXAM');
    for (const m of ['DRILL', 'TEACH', 'POSTMORTEM', 'PAUSE']) {
      assert.equal(modes.modeGates(m).videoAllowed, true, `ACC-TOOL-12b ${m}`);
    }
  });

  test('ACC-TOOL-13 an id that is not 11 characters is refused rather than opened', async () => {
    const { call, events } = makeTutor({ mode: 'DRILL' });
    const out = text(await call('show_video', { videoId: 'not-a-real-id-at-all' }));
    assert.match(out, /not a youtube video id/i, `ACC-TOOL-13: ${out}`);
    assert.equal(events.find((e) => e.type === 'show_video'), undefined, 'ACC-TOOL-13 nothing was opened');
  });

  test('ACC-TOOL-14 find_video maps a trap onto a real indexed video', async () => {
    const { call } = makeTutor();
    const out = text(await call('find_video', { trap: 'necessary_confused_with_sufficient' }));
    assert.match(out, /JsfrZMpd6oo/, `ACC-TOOL-14: ${out}`);
    const none = text(await call('find_video', { topic: 'nothing_indexed_here' }));
    assert.match(none, /nothing indexed/i, `ACC-TOOL-14 an empty result must say "not indexed": ${none}`);
  });
});

describe('§1.6 papers are added on the word, everything else is filed', () => {
  test('ACC-TOOL-15 add_paper refuses anything that is not a PDF under the project root', async () => {
    const { call } = makeTutor();
    assert.match(text(await call('add_paper', { path: '/etc/hosts' })), /outside project root/i, 'ACC-TOOL-15 outside root');
    const notes = path.join(sbx.tutorData, 'inbox', 'notes.txt');
    fs.writeFileSync(notes, 'hello');
    assert.match(text(await call('add_paper', { path: notes })), /not a pdf/i, 'ACC-TOOL-15 not a PDF');
    assert.match(text(await call('add_paper', { path: path.join(sbx.tutorData, 'inbox', 'ghost.pdf') })), /no such file/i, 'ACC-TOOL-15 missing');
  });

  test('ACC-TOOL-16 file_to_library moves a non-paper into library/<topic>/ and journals it', async () => {
    const src = path.join(sbx.tutorData, 'inbox', 'logic worksheet.pdf');
    fs.writeFileSync(src, '%PDF-1.4 worksheet');
    const { call } = makeTutor();
    const out = text(await call('file_to_library', { path: src, topic: 'logic_and_proof', note: 'Tyler worksheet on quantifiers' }));

    const dest = path.join(sbx.tutorData, 'library', 'logic_and_proof', 'logic worksheet.pdf');
    assert.ok(fs.existsSync(dest), `ACC-TOOL-16 not filed. Tool said: ${out}`);
    assert.ok(!fs.existsSync(src), 'ACC-TOOL-16 the inbox copy must be moved, not duplicated');
    assert.match(out, /library\/logic_and_proof/, `ACC-TOOL-16 the tool reports where it went: ${out}`);

    const journal = fs.readFileSync(path.join(sbx.tutorData, 'monday', 'journal.md'), 'utf8');
    assert.match(journal, /logic worksheet/, 'ACC-TOOL-16 nothing was written to the journal');
    assert.match(journal, /quantifiers/, 'ACC-TOOL-16 the note itself is missing from the journal');
  });
});

describe('§3.2 marks and accuracy, never grades', () => {
  test('ACC-TOOL-17 MONDAY_BLOCK carries the rule, in the identity block Monday cannot skim past', async () => {
    const prompt = await sbx.imp('prompt.js');
    const p = prompt.buildSystemPrompt();
    assert.match(p, /MARKS AND ACCURACY, NEVER GRADES/,
      'ACC-TOOL-17 the rule is missing — the readiness projection reaches Monday on every turn via <monday-state>, so nothing else stops it commenting on grades');
    assert.match(p, /no grade predictions/i, 'ACC-TOOL-17 predictions');
    assert.match(p, /raw marks/i, 'ACC-TOOL-17 what it reports instead');
  });

  test('ACC-TOOL-18 the projection stays available for planning — the rule is about speech, not data', async () => {
    const readiness = await sbx.imp('readiness.js');
    const r = await readiness.computeReadiness();
    assert.equal(typeof r.projected, 'number',
      'ACC-TOOL-18 the projected grade was removed — it is the planning metric behind the 9.0 target and the grave mood');
  });
});

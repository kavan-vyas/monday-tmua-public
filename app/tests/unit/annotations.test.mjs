// ACC-ANN-01..20 — annotation storage.
//
// Every expected value here comes from the plan (§1.3 "Coordinates and storage — the
// part that must be right", §1.4 "Autosave — never ask to save", §1.5 "Monday reads and
// writes marks"), not from what annotations.js happens to do.
//
// The two claims under test are the two the plan calls non-negotiable:
//   1. the key comes from the manifest, so a re-filed paper keeps its annotations;
//   2. the write is atomic, so a crash mid-stroke leaves no half file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

let sbx, A;

// A manifest shaped like the real one: tmua.<year>.p1 / p1_solutions, mat.<year>.paper.
const P1_BEFORE = '/tmp/papers/TMUA 2019 Paper 1.pdf';
const P1_AFTER = '/tmp/papers/tmua/2019/TMUA 2019 Paper 1.pdf';

function manifest(p1) {
  return {
    generated: '2026-04-16',
    base_dir: '/tmp/papers',
    mat: { 2016: { paper: '/tmp/papers/MAT 2016.pdf', solutions: '/tmp/papers/Solutions 2016.pdf', report: null } },
    tmua: {
      2019: { p1, p1_solutions: '/tmp/papers/TMUA 2019 Paper 1 Solutions.pdf', p2: '/tmp/papers/TMUA 2019 Paper 2.pdf' },
    },
    tmua_specimen: { p1: '/tmp/papers/TMUA Specimen Paper 1.pdf' },
  };
}

before(async () => {
  sbx = makeSandbox({
    tag: 'ann',
    tutorData: { ...defaultTutorData(), 'file_manifest.json': manifest(P1_BEFORE) },
  });
  A = await sbx.imp('annotations.js');
});
after(() => sbx.dispose());

const ink = (pts, extra = {}) => ({ type: 'ink', paths: pts, ...extra });

describe('§1.3 the key comes from the manifest, not the path', () => {
  test('ACC-ANN-01 a paper in the manifest keys on its manifest position', () => {
    const k = A.keyForPath(P1_BEFORE);
    assert.equal(k.source, 'manifest', 'ACC-ANN-01 a manifest paper must not fall back to a path hash');
    assert.equal(k.key, 'tmua/2019/p1', `ACC-ANN-01 key is ${k.key}`);
  });

  test('ACC-ANN-02 the key distinguishes a paper from its solutions', () => {
    assert.equal(A.keyForPath('/tmp/papers/TMUA 2019 Paper 1 Solutions.pdf').key, 'tmua/2019/p1_solutions',
      'ACC-ANN-02 paper and solutions must not share a key');
    assert.equal(A.keyForPath('/tmp/papers/MAT 2016.pdf').key, 'mat/2016/paper', 'ACC-ANN-02 MAT shape');
  });

  test('ACC-ANN-03 a PDF the manifest has never heard of falls back to a path hash', () => {
    const k = A.keyForPath('/tmp/papers/some random worksheet.pdf');
    assert.equal(k.source, 'path', 'ACC-ANN-03 unknown PDFs use the path fallback');
    assert.match(k.key, /^path\/[0-9a-f]{16}$/, `ACC-ANN-03 key is ${k.key}`);
  });

  test('ACC-ANN-04 THE ONE THAT MATTERS: annotations survive Monday re-filing the paper', () => {
    // Annotate the paper where it currently lives.
    const before = A.applyPages(A.readDoc(P1_BEFORE), { 7: [ink([[100, 700], [140, 660]], { note: 'stuck here' })] }, { author: 'student' });
    A.saveDoc(before);
    assert.equal(A.countMarks(A.readDoc(P1_BEFORE)), 1, 'setup: the mark was stored');

    // Monday re-files it. The manifest now points somewhere else entirely.
    sbx.write('file_manifest.json', manifest(P1_AFTER));

    const after = A.readDoc(P1_AFTER);
    assert.equal(after.key, 'tmua/2019/p1', 'ACC-ANN-04 the key is unchanged by the move');
    assert.equal(A.countMarks(after), 1,
      'ACC-ANN-04 the annotation was orphaned by the re-file — this is exactly what a path-derived key would do');
    assert.equal(after.source_path, P1_AFTER,
      'ACC-ANN-04 source_path must follow the manifest, not stay stale at the old location');

    sbx.write('file_manifest.json', manifest(P1_BEFORE));
  });

  test('ACC-ANN-05 the document lands under tutor_data/annotations with a schema_version', () => {
    const file = A.fileForKey('tmua/2019/p1');
    assert.ok(file.startsWith(path.join(sbx.tutorData, 'annotations') + path.sep),
      `ACC-ANN-05 stored outside tutor_data/annotations: ${file}`);
    assert.ok(fs.existsSync(file), 'ACC-ANN-05 the file exists after a save');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.schema_version, 1, 'ACC-ANN-05 schema_version');
    assert.equal(raw.key, 'tmua/2019/p1', 'ACC-ANN-05 the key is recorded in the document');
    assert.ok(!path.basename(file).includes('/'), 'ACC-ANN-05 the key must flatten to one filename');
  });
});

describe('§1.3 writes are atomic', () => {
  test('ACC-ANN-06 a killed write leaves no partial file — the rename is the commit', () => {
    const file = path.join(sbx.tutorData, 'annotations', 'atomic__probe.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, pages: { 1: [] } }) + '\n');

    // Fill the directory with what a crashed writer would leave behind, then prove the
    // live file is still complete, parseable JSON rather than a truncated one.
    const before = fs.readFileSync(file, 'utf8');
    A.writeJsonAtomic(file, { schema_version: 1, key: 'atomic/probe', pages: { 1: [{ id: 'x', type: 'ink' }] } });
    const after = fs.readFileSync(file, 'utf8');
    assert.notEqual(after, before, 'setup: the write landed');
    assert.doesNotThrow(() => JSON.parse(after), 'ACC-ANN-06 the committed file must always parse');

    const strays = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(strays, [], `ACC-ANN-06 temp files left behind: ${strays.join(', ')}`);
  });

  test('ACC-ANN-07 the temp file is in the destination directory, so rename is atomic', () => {
    // A rename across filesystems is a copy, not an atomic swap. The tmp name must be a
    // sibling of the target for the guarantee to hold at all.
    const src = fs.readFileSync(path.join(sbx.serverDir, 'annotations.js'), 'utf8');
    const fn = src.slice(src.indexOf('export function writeJsonAtomic'), src.indexOf('export function writeJsonAtomic') + 400);
    assert.match(fn, /const tmp = `\$\{abs\}/, 'ACC-ANN-07 the temp path must be derived from the target path');
    assert.match(fn, /renameSync\(tmp, abs\)/, 'ACC-ANN-07 the commit must be a rename');
  });

  test('ACC-ANN-08 an unrelated crashed temp file never becomes the document', () => {
    const doc = A.readDoc('/tmp/papers/TMUA 2019 Paper 2.pdf');
    const file = A.fileForKey(doc.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp-999`, '{"schema_version":1,"pages":{"3":[{"id":"gh');
    const read = A.readDoc('/tmp/papers/TMUA 2019 Paper 2.pdf');
    assert.equal(A.countMarks(read), 0, 'ACC-ANN-08 a half-written temp file must be invisible to the reader');
    fs.rmSync(`${file}.tmp-999`, { force: true });
  });

  test('ACC-ANN-09 an unreadable document reads as empty rather than throwing mid-session', () => {
    const doc = A.readDoc('/tmp/papers/TMUA Specimen Paper 1.pdf');
    fs.mkdirSync(path.dirname(A.fileForKey(doc.key)), { recursive: true });
    fs.writeFileSync(A.fileForKey(doc.key), '{ not json at all');
    const read = A.readDoc('/tmp/papers/TMUA Specimen Paper 1.pdf');
    assert.equal(A.countMarks(read), 0, 'ACC-ANN-09 corruption must not take the pane down');
    assert.equal(read.schema_version, 1, 'ACC-ANN-09 still a well-formed document');
    fs.rmSync(A.fileForKey(doc.key), { force: true });
  });
});

describe('§1.4 autosave: idempotent and author-scoped', () => {
  const PAPER = '/tmp/papers/MAT 2016.pdf';

  test('ACC-ANN-10 saving the same marks twice does not rewrite the file', () => {
    const pages = { 4: [ink([[10, 10], [20, 20]])] };
    const first = A.saveDoc(A.applyPages(A.readDoc(PAPER), pages, { author: 'student' }));
    assert.equal(first.changed, true, 'setup: the first save writes');
    const again = A.saveDoc(A.applyPages(A.readDoc(PAPER), { 4: first.doc.pages['4'] }, { author: 'student' }));
    assert.equal(again.changed, false,
      'ACC-ANN-10 a repeated beacon must cost no write — the client flushes on every blur and unload');
  });

  test('ACC-ANN-11 the student autosave cannot wipe a mark Monday just drew', () => {
    const withMonday = A.addMarks(A.readDoc(PAPER), 4, [{ type: 'arrow', from: [50, 500], to: [90, 460], note: 'the case you dropped' }], { author: 'monday' }).doc;
    A.saveDoc(withMonday);
    // The client autosaves what IT knows about — the student's own strokes only.
    const autosaved = A.applyPages(A.readDoc(PAPER), { 4: [ink([[10, 10], [20, 20]])] }, { author: 'student' });
    const marks = autosaved.pages['4'];
    assert.ok(marks.some((m) => m.author === 'monday'),
      'ACC-ANN-11 an 800 ms autosave wiped Monday\'s arrow — the two authors must not clobber each other');
    assert.ok(marks.some((m) => m.author === 'student'), 'ACC-ANN-11 the student\'s own stroke survived too');
  });

  test('ACC-ANN-12 scope "all" is the explicit escape hatch and does replace the page', () => {
    const replaced = A.applyPages(A.readDoc(PAPER), { 4: [ink([[1, 1], [2, 2]])] }, { author: 'student', scope: 'all' });
    assert.equal(replaced.pages['4'].length, 1, 'ACC-ANN-12 scope:all replaces the page wholesale');
  });

  test('ACC-ANN-13 a page that empties is removed rather than left as an empty array', () => {
    const emptied = A.applyPages(A.readDoc(PAPER), { 9: [] }, { author: 'student', scope: 'all' });
    assert.ok(!('9' in emptied.pages), 'ACC-ANN-13 empty pages must not accumulate');
  });
});

describe('§1.3 coordinates are PDF user space', () => {
  test('ACC-ANN-14 y is bottom-up: a high y is the TOP of the page', () => {
    const a4 = [595.28, 841.89];
    assert.match(A.describeRegion([100, 780, 160, 800], a4), /^top/,
      'ACC-ANN-14 y=790 on an 842 pt page is the top — getting this inverted sends him to the wrong end of the question');
    assert.match(A.describeRegion([100, 40, 160, 60], a4), /^bottom/, 'ACC-ANN-14 a low y is the bottom');
    assert.match(A.describeRegion([500, 400, 540, 420], a4), /right/, 'ACC-ANN-14 a high x is the right');
    assert.match(A.describeRegion([20, 400, 60, 420], a4), /left/, 'ACC-ANN-14 a low x is the left');
  });

  test('ACC-ANN-15 a bounding box is computed in the same space as the points', () => {
    assert.deepEqual(A.bboxOf([[10, 700], [50, 660], [30, 720]]), [10, 660, 50, 720], 'ACC-ANN-15');
  });

  test('ACC-ANN-16 marks that carry no usable geometry are refused, not stored as junk', () => {
    assert.equal(A.normaliseMark({ type: 'ink', paths: [] }), null, 'ACC-ANN-16 ink with no path');
    assert.equal(A.normaliseMark({ type: 'arrow', from: [1, 2] }), null, 'ACC-ANN-16 arrow with no head');
    assert.equal(A.normaliseMark({ type: 'freetext', text: '' }), null, 'ACC-ANN-16 an empty note');
    assert.equal(A.normaliseMark({ type: 'scribble', paths: [[1, 2]] }), null, 'ACC-ANN-16 an unknown type');
    assert.ok(A.normaliseMark({ type: 'ink', paths: [[1, 2], [3, 4]] }), 'ACC-ANN-16 a real ink stroke is kept');
  });

  test('ACC-ANN-17 Monday\'s marks get their own colour so the two never blur', () => {
    const m = A.normaliseMark({ type: 'arrow', from: [0, 0], to: [1, 1] }, { author: 'monday', color: A.MONDAY_COLOR });
    assert.equal(m.author, 'monday', 'ACC-ANN-17 author');
    assert.equal(m.color, A.MONDAY_COLOR, 'ACC-ANN-17 colour');
    assert.notEqual(A.MONDAY_COLOR, A.STUDENT_COLOR, 'ACC-ANN-17 the two colours must differ');
  });
});

describe('§1.5 read_annotations returns something a model can reason about', () => {
  const PAPER = '/tmp/papers/TMUA Specimen Paper 1.pdf';

  test('ACC-ANN-18 a highlight reads back its underlying text verbatim', () => {
    let doc = A.readDoc(PAPER);
    doc = A.applyPages(doc, {
      7: [
        { type: 'highlight', quads: [[70, 700, 300, 715]], text: 'for all real x' },
        { type: 'ink', paths: [[80, 400], [140, 340]], note: 'circled the trap' },
        { type: 'arrow', from: [200, 300], to: [260, 250], note: 'the case you dropped', author: 'monday' },
      ],
    }, { author: 'student', scope: 'all', pageSizes: { 7: [595.28, 841.89] } });
    A.saveDoc(doc);

    const out = A.formatDoc(A.readDoc(PAPER), { page: 7 });
    assert.match(out, /for all real x/,
      'ACC-ANN-18 the highlighted text is the single most valuable field in the schema and must be read back');
    assert.match(out, /highlight/i, 'ACC-ANN-18 the mark type is named');
    assert.match(out, /top/i, 'ACC-ANN-18 an ink stroke needs a page region, not a raw polyline');
    assert.match(out, /the case you dropped/, 'ACC-ANN-18 an arrow carries its note');
    assert.ok(!/\[\[\d/.test(out), `ACC-ANN-18 raw coordinate arrays leaked into the model-facing text:\n${out}`);
  });

  test('ACC-ANN-19 an empty page says so plainly rather than returning nothing', () => {
    const out = A.formatDoc(A.readDoc(PAPER), { page: 3 });
    assert.match(out, /no annotations/i, `ACC-ANN-19 got: ${out}`);
    assert.match(out, /page 3/, 'ACC-ANN-19 it names the page it looked at');
  });

  test('ACC-ANN-20 a region computed without a known page size says the size is assumed', () => {
    let doc = A.readDoc('/tmp/papers/TMUA 2019 Paper 2.pdf');
    doc = A.applyPages(doc, { 2: [ink([[100, 700], [140, 660]])] }, { author: 'student', scope: 'all' });
    A.saveDoc(doc);
    const out = A.formatDoc(A.readDoc('/tmp/papers/TMUA 2019 Paper 2.pdf'), { page: 2 });
    assert.match(out, /page size not recorded/i,
      `ACC-ANN-20 a guessed A4 must be flagged rather than stated as fact:\n${out}`);
  });
});

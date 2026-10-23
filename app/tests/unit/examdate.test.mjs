// ACC-EXAM-01..12 — the one setting that writes to the student record.
//
// tutor_data/memory/session_memory.json holds the student's whole history. The
// settings pane may change exactly one key in it, `exam_date`, and the property
// that matters is not "the date changed" but "NOTHING ELSE DID". These tests are
// about the second half.
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

const boxes = [];
after(() => boxes.forEach((b) => b.dispose()));

/** A record shaped like the real one: hand-formatted, key order meaningful. */
const REAL_SHAPE = `{
  "schema_version": "2.0",
  "student": "Test Student",
  "exam_date": "2026-10-12",
  "session_number": 2,
  "topic_stats": {
    "algebra": { "attempted": 20, "correct": 17 }
  },
  "questions_attempted": [
    { "id": "q1", "topic": "algebra", "date": "2026-08-01", "correct": true }
  ],
  "misconceptions": []
}
`;

async function box(memory = REAL_SHAPE) {
  const b = makeSandbox({
    tag: 'examdate',
    tutorData: { ...defaultTutorData(), 'memory/session_memory.json': memory },
  });
  boxes.push(b);
  const m = await b.imp('examdate.js');
  return { b, m, file: path.join(b.tutorData, 'memory', 'session_memory.json') };
}

describe('§settings — the exam date', () => {
  test('ACC-EXAM-01 the record is read, not the config', async () => {
    const { m } = await box();
    const r = m.readExamDate();
    assert.equal(r.examDate, '2026-10-12', 'ACC-EXAM-01 date');
    assert.equal(r.present, true, 'ACC-EXAM-01 present');
    assert.equal(r.source, 'session_memory.json', 'ACC-EXAM-01 source');
  });

  test('ACC-EXAM-02 a record with no date reports the default and says so', async () => {
    const { m } = await box('{\n  "schema_version": "2.0",\n  "student": "Test Student"\n}\n');
    const r = m.readExamDate();
    assert.equal(r.present, false, 'ACC-EXAM-02 present must be false, not silently true');
    assert.equal(r.source, 'default', 'ACC-EXAM-02 source');
    assert.match(r.examDate, /^\d{4}-\d{2}-\d{2}$/, 'ACC-EXAM-02 still an ISO date');
  });

  test('ACC-EXAM-03 writing a date changes ONE line and nothing else', async () => {
    const { m, file } = await box();
    const before = fs.readFileSync(file, 'utf8');
    const r = m.writeExamDate('2027-01-09');
    assert.equal(r.ok, true, `ACC-EXAM-03 ${r.error ?? ''}`);
    assert.equal(r.changed, true, 'ACC-EXAM-03 changed');

    const after = fs.readFileSync(file, 'utf8');
    const diff = before.split('\n')
      .map((line, i) => [line, after.split('\n')[i]])
      .filter(([a, b2]) => a !== b2);
    assert.equal(diff.length, 1, `ACC-EXAM-03 ${diff.length} lines changed:\n${JSON.stringify(diff, null, 2)}`);
    assert.equal(diff[0][1], '  "exam_date": "2027-01-09",', 'ACC-EXAM-03 the changed line');
    assert.equal(before.split('\n').length, after.split('\n').length, 'ACC-EXAM-03 line count');
  });

  test('ACC-EXAM-04 every other value in the record is byte-identical afterwards', async () => {
    const { m, file } = await box();
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.writeExamDate('2027-01-09');
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete before.exam_date; delete after.exam_date;
    assert.deepEqual(after, before, 'ACC-EXAM-04 the student record was altered beyond the exam date');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))),
      ['schema_version', 'student', 'exam_date', 'session_number', 'topic_stats', 'questions_attempted', 'misconceptions'],
      'ACC-EXAM-04 the key order of the record changed — it was reserialised, not edited');
  });

  test('ACC-EXAM-05 a previous copy of the record is kept', async () => {
    const { m, b } = await box();
    const r = m.writeExamDate('2027-01-09');
    assert.ok(r.backup, 'ACC-EXAM-05 no backup path was returned');
    assert.ok(fs.existsSync(r.backup), 'ACC-EXAM-05 the backup file is not there');
    assert.match(fs.readFileSync(r.backup, 'utf8'), /"exam_date": "2026-10-12"/,
      'ACC-EXAM-05 the backup holds the PREVIOUS record');
    assert.ok(r.backup.startsWith(path.join(b.tutorData, '.backups')),
      'ACC-EXAM-05 the backup landed outside tutor_data/.backups');
  });

  test('ACC-EXAM-06 writing the same date again is a no-op', async () => {
    const { m, file } = await box();
    const before = fs.readFileSync(file, 'utf8');
    const r = m.writeExamDate('2026-10-12');
    assert.equal(r.ok, true, 'ACC-EXAM-06 ok');
    assert.equal(r.changed, false, 'ACC-EXAM-06 it should report no change');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'ACC-EXAM-06 the file was rewritten anyway');
  });

  const bad = ['', 'soon', '2026-13-01', '2026-02-30', '12/10/2026', '2026-10-12T00:00:00Z', '../../etc/passwd', null];
  test('ACC-EXAM-07 anything that is not a real date is refused, and nothing is written', async () => {
    const { m, file } = await box();
    const before = fs.readFileSync(file, 'utf8');
    for (const v of bad) {
      const r = m.writeExamDate(v);
      assert.equal(r.ok, false, `ACC-EXAM-07 "${v}" was accepted`);
      assert.equal(typeof r.error, 'string', 'ACC-EXAM-07 a refusal must say why');
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'ACC-EXAM-07 a refused write still touched the file');
  });

  test('ACC-EXAM-08 a record that does not parse is never written to', async () => {
    const { m, file } = await box('{ "student": "the student", oh dear');
    const before = fs.readFileSync(file, 'utf8');
    const r = m.writeExamDate('2027-01-09');
    assert.equal(r.ok, false, 'ACC-EXAM-08 a corrupt record was written to');
    assert.match(r.error, /not valid JSON/, 'ACC-EXAM-08 the reason names the problem');
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'ACC-EXAM-08 the corrupt file was modified');
  });

  test('ACC-EXAM-09 a record with no exam_date key gains one, in its own indentation', async () => {
    const { m, file } = await box('{\n    "schema_version": "2.0",\n    "student": "Test Student"\n}\n');
    const r = m.writeExamDate('2027-01-09');
    assert.equal(r.ok, true, `ACC-EXAM-09 ${r.error ?? ''}`);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\n {4}"exam_date": "2027-01-09",/, `ACC-EXAM-09 indentation:\n${text}`);
    const obj = JSON.parse(text);
    assert.equal(obj.exam_date, '2027-01-09', 'ACC-EXAM-09 value');
    assert.equal(obj.student, 'Test Student', 'ACC-EXAM-09 the rest survived');
  });

  test('ACC-EXAM-10 a null exam_date is replaced rather than duplicated', async () => {
    const { m, file } = await box('{\n  "exam_date": null,\n  "student": "Test Student"\n}\n');
    assert.equal(m.writeExamDate('2027-01-09').ok, true, 'ACC-EXAM-10 write');
    const text = fs.readFileSync(file, 'utf8');
    assert.equal((text.match(/"exam_date"/g) ?? []).length, 1, `ACC-EXAM-10 duplicated the key:\n${text}`);
    assert.equal(JSON.parse(text).exam_date, '2027-01-09', 'ACC-EXAM-10 value');
  });

  test('ACC-EXAM-11 readiness.js reads the new date straight back', async () => {
    const { m, b } = await box();
    m.writeExamDate('2027-01-09');
    const R = await b.imp('readiness.js');
    assert.equal(R.resolveExamDate(), '2027-01-09',
      'ACC-EXAM-11 resolveExamDate() is the single source of truth and did not see the write');
  });

  test('ACC-EXAM-12 no temporary file is left behind', async () => {
    const { m, b } = await box();
    m.writeExamDate('2027-01-09');
    const strays = fs.readdirSync(path.join(b.tutorData, 'memory')).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(strays, [], `ACC-EXAM-12 temp files: ${strays.join(', ')}`);
  });
});

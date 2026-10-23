// Shared shape assertions. Every expected value here traces to ACCEPTANCE.md.
import assert from 'node:assert/strict';

export const MOODS = ['focused', 'sharp', 'gentle', 'clinical', 'wry', 'grave'];
export const MODES = ['DRILL', 'EXAM', 'POSTMORTEM', 'TEACH', 'CONSOLIDATION', 'PAUSE'];
/** ACC-MOOD-10 — highest first. */
export const PRECEDENCE = ['clinical', 'grave', 'gentle', 'sharp', 'wry', 'focused'];
export const TRIGGER_IDS = [
  'idle_nudge', 'repeat_mistake', 'avoided_topic', 'backlog_due',
  'session_debrief', 'exam_milestone', 'late_night',
];
/**
 * ACC-UI-18 — the tools registered in session.js.
 *
 * Written out by hand ON PURPOSE. Importing server/toolnames.js here would make this
 * assertion tautological: the test would check the list against itself and pass however
 * wrong the list was. The whole point is that a tool added to session.js and forgotten
 * everywhere else fails here.
 */
export const TOOL_NAMES = [
  'show_pdf', 'get_pdf_page', 'find_in_pdf',
  'read_annotations', 'annotate_pdf', 'clear_annotations',
  'add_backlog', 'list_backlog', 'relabel_backlog', 'remove_backlog', 'complete_backlog',
  'read_backlog_notes', 'write_backlog_note',
  'query_tag_index', 'question_profile', 'drill_set', 'index_stats', 'audit_paper',
  'triage_pdf', 'add_paper', 'file_to_library',
  'show_video', 'find_video',
  'get_schedule', 'start_timer', 'exam_sittings', 'sitting_report', 'log_activity',
  'journal_note', 'monday_recall', 'monday_note', 'monday_self',
];

/** ACC-STATE-01..11 */
export function assertMondayState(s, where = 'state') {
  assert.equal(typeof s, 'object', `${where}: not an object`);
  assert.ok(s, `${where}: null`);
  assert.ok(MOODS.includes(s.mood), `ACC-STATE-01 ${where}.mood=${s.mood}`);
  assert.equal(typeof s.reason, 'string', `ACC-STATE-02 ${where}.reason type`);
  assert.ok(s.reason.length > 0, `ACC-STATE-02 ${where}.reason empty`);
  assert.ok(MODES.includes(s.mode), `ACC-STATE-03 ${where}.mode=${s.mode}`);
  assert.equal(typeof s.lesson, 'number', `ACC-STATE-04 ${where}.lesson`);
  assert.ok(Number.isFinite(s.lesson), `ACC-STATE-04 ${where}.lesson finite`);
  assert.equal(typeof s.sessionElapsedMs, 'number', `ACC-STATE-05 ${where}.sessionElapsedMs`);
  assert.ok(s.sessionElapsedMs >= 0, `ACC-STATE-05 ${where}.sessionElapsedMs >= 0`);
  assert.equal(typeof s.daysToExam, 'number', `ACC-STATE-06 ${where}.daysToExam`);
  assert.ok(Number.isFinite(s.daysToExam), `ACC-STATE-06 ${where}.daysToExam finite`);
  assert.equal(typeof s.streak, 'number', `ACC-STATE-07 ${where}.streak`);
  assert.ok(Number.isInteger(s.streak), `ACC-STATE-07 ${where}.streak integer`);
  assert.equal(typeof s.sessionAccuracy, 'object', `ACC-STATE-08 ${where}.sessionAccuracy`);
  assert.equal(typeof s.sessionAccuracy.correct, 'number', `ACC-STATE-08 correct`);
  assert.equal(typeof s.sessionAccuracy.total, 'number', `ACC-STATE-08 total`);
  assert.ok(s.sessionAccuracy.correct <= s.sessionAccuracy.total, `ACC-STATE-08 correct <= total`);
  assert.equal(typeof s.backlogDue, 'number', `ACC-STATE-09 ${where}.backlogDue`);
  assert.ok(s.backlogDue >= 0, `ACC-STATE-09 >= 0`);
  assert.ok(typeof s.lastSessionDate === 'string' || s.lastSessionDate === null,
    `ACC-STATE-10 ${where}.lastSessionDate=${s.lastSessionDate} (must be string|null, never undefined)`);
  assertReadiness(s.readiness, `${where}.readiness`);
}

/** ACC-STATE-11 */
export function assertReadiness(r, where = 'readiness') {
  assert.equal(typeof r, 'object', `ACC-STATE-11 ${where}: not an object`);
  assert.ok(r, `ACC-STATE-11 ${where}: null`);
  assert.equal(typeof r.overall, 'number', `ACC-STATE-11 ${where}.overall`);
  assert.equal(typeof r.projected, 'number', `ACC-STATE-11 ${where}.projected`);
  assert.ok(Array.isArray(r.weakest), `ACC-STATE-11 ${where}.weakest is array`);
  for (const w of r.weakest) {
    assert.equal(typeof w.topic, 'string', `ACC-STATE-11 ${where}.weakest[].topic`);
    assert.equal(typeof w.score, 'number', `ACC-STATE-11 ${where}.weakest[].score`);
  }
}

/** ACC-VOICE-63/64/65 — a base64 payload that is a complete, standalone WAV. */
export function assertStandaloneWav(b64, where = 'chunk') {
  const buf = Buffer.from(b64, 'base64');
  assert.ok(buf.length > 44, `ACC-VOICE-63 ${where}: ${buf.length} bytes, too short for a WAV`);
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF', `ACC-VOICE-63 ${where}: bytes 0-3 must be RIFF`);
  assert.equal(buf.subarray(8, 12).toString('latin1'), 'WAVE', `ACC-VOICE-63 ${where}: bytes 8-11 must be WAVE`);
  const declared = buf.readUInt32LE(4);
  assert.equal(declared, buf.length - 8,
    `ACC-VOICE-64 ${where}: RIFF size ${declared} != fileLength-8 (${buf.length - 8})`);
  const body = buf.subarray(12).toString('latin1');
  assert.ok(body.includes('fmt '), `ACC-VOICE-65 ${where}: no fmt chunk`);
  assert.ok(body.includes('data'), `ACC-VOICE-65 ${where}: no data chunk`);
  return buf;
}

/** ACC-VOICE-61/62 — seq starts at 0 and is contiguous. */
export function assertSeqContiguousFromZero(seqs, where = 'utterance') {
  assert.ok(seqs.length > 0, `ACC-VOICE-61 ${where}: no chunks at all`);
  assert.equal(seqs[0], 0, `ACC-VOICE-61 ${where}: first seq is ${seqs[0]}, must be 0`);
  for (let i = 0; i < seqs.length; i++) {
    assert.equal(seqs[i], i, `ACC-VOICE-62 ${where}: seq[${i}] is ${seqs[i]}, expected ${i}`);
  }
}

/** Build a minimal but genuinely valid mono 24 kHz WAV of `ms` milliseconds. */
export function makeWav(ms = 100, sampleRate = 24000) {
  const frames = Math.round((sampleRate * ms) / 1000);
  const dataBytes = frames * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / sampleRate)), 44 + i * 2);
  }
  return buf;
}

// The exam date, and the ONLY thing in this codebase allowed to write to the
// student record.
//
// tutor_data/memory/session_memory.json is the student's real record: 236 attempted
// questions, per-topic statistics, misconceptions, the lot. readiness.js reads
// it and refuses to write to it on principle; dashboard.js parses it. Exactly
// one key in it is a *setting* rather than a *record*: `exam_date`. The settings
// pane has to be able to change that key and nothing else, ever.
//
// So this module does not serialise the record back out. Serialising and
// rewriting a 2000-line hand-maintained JSON file to change one string is how
// key order, spacing and — on a bad day — a whole array get lost. Instead it
// rewrites ONE LINE of the file's text, and then proves the result is safe:
//
//   1. the new text must still parse as JSON;
//   2. the parsed object must be deep-equal to the old one apart from
//      `exam_date` — if any other value moved, the write is abandoned;
//   3. a timestamped copy of the previous file is kept alongside it.
//
// If any of that fails the original file is left exactly as it was.
import fs from 'node:fs';
import path from 'node:path';
import { TUTOR_DATA, insideTutorData } from './paths.js';
import { DEFAULT_EXAM_DATE } from './readiness.js';

export const SESSION_MEMORY = path.join(TUTOR_DATA, 'memory', 'session_memory.json');
const BACKUPS = path.join(TUTOR_DATA, '.backups');

/** YYYY-MM-DD, and a date that actually exists. Returns null otherwise. */
export function normaliseExamDate(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10) === s ? s : null;
}

/** Everything except `exam_date`, for the "nothing else moved" check. */
function withoutExamDate(obj) {
  const { exam_date: _drop, ...rest } = obj ?? {};
  return rest;
}

/**
 * Read the date as it stands, plus whether the record actually carries one.
 * @returns {{examDate:string, present:boolean, source:string, file:string}}
 */
export function readExamDate() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(SESSION_MEMORY, 'utf8')); } catch { /* unreadable */ }
  const stored = normaliseExamDate(raw?.exam_date);
  return {
    examDate: stored ?? DEFAULT_EXAM_DATE,
    present: stored != null,
    source: stored != null ? 'session_memory.json' : 'default',
    file: SESSION_MEMORY,
  };
}

/**
 * Write `exam_date` into the student record, changing nothing else.
 *
 * @param {string} value  YYYY-MM-DD
 * @returns {{ok:true, examDate:string, changed:boolean, backup:string|null}
 *          |{ok:false, error:string}}
 */
export function writeExamDate(value) {
  const date = normaliseExamDate(value);
  if (!date) return { ok: false, error: 'exam date must be a real calendar date in YYYY-MM-DD' };

  // Belt and braces: the path is a module constant, but it is still checked, so
  // this function cannot become a file-write primitive by accident later.
  const abs = insideTutorData(SESSION_MEMORY);
  if (!abs) return { ok: false, error: 'session_memory.json is outside tutor_data — refused' };

  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch (err) {
    return { ok: false, error: `cannot read the student record: ${err.message}` };
  }

  let before;
  try { before = JSON.parse(text); } catch (err) {
    // A record that does not parse is a record we do not touch.
    return { ok: false, error: `the student record is not valid JSON (${err.message}) — refusing to write` };
  }
  if (!before || typeof before !== 'object' || Array.isArray(before)) {
    return { ok: false, error: 'the student record is not a JSON object — refusing to write' };
  }
  if (normaliseExamDate(before.exam_date) === date) {
    return { ok: true, examDate: date, changed: false, backup: null };
  }

  // One line, in place. The indentation and trailing comma of the existing line
  // are preserved so a diff of this file is a single-character-range change.
  const LINE = /^([ \t]*)"exam_date"[ \t]*:[ \t]*(?:"[^"\n]*"|null)([ \t]*,?)[ \t]*$/m;
  let next;
  if (LINE.test(text)) {
    next = text.replace(LINE, (_m, indent, comma) => `${indent}"exam_date": ${JSON.stringify(date)}${comma}`);
  } else {
    // No such key yet: add it as the first entry, in the file's own indentation.
    const open = text.indexOf('{');
    if (open < 0) return { ok: false, error: 'the student record has no JSON object to write into' };
    const indent = (text.slice(open + 1).match(/\n([ \t]+)\S/) ?? [null, '  '])[1];
    const rest = text.slice(open + 1);
    const sep = rest.trim().startsWith('}') ? '' : ',';
    next = `${text.slice(0, open + 1)}\n${indent}"exam_date": ${JSON.stringify(date)}${sep}${rest}`;
  }

  // ── the proof ─────────────────────────────────────────────────────────────
  let after;
  try { after = JSON.parse(next); } catch (err) {
    return { ok: false, error: `the edit would not have parsed (${err.message}) — nothing was written` };
  }
  if (normaliseExamDate(after.exam_date) !== date) {
    return { ok: false, error: 'the edit did not land on exam_date — nothing was written' };
  }
  if (JSON.stringify(withoutExamDate(after)) !== JSON.stringify(withoutExamDate(before))) {
    return { ok: false, error: 'the edit would have changed something other than exam_date — nothing was written' };
  }

  let backup = null;
  try {
    fs.mkdirSync(BACKUPS, { recursive: true });
    backup = path.join(BACKUPS, `session_memory.json.${Date.now()}`);
    fs.copyFileSync(abs, backup);
    // Keep the last eight, same policy as session.js's snapshot().
    const mine = fs.readdirSync(BACKUPS).filter((f) => f.startsWith('session_memory.json.')).sort();
    for (const old of mine.slice(0, -8)) fs.rmSync(path.join(BACKUPS, old), { force: true });
  } catch { backup = null; /* a missing backup is not a reason to refuse the write */ }

  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, abs);           // atomic: no half-written record is ever visible
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: `write failed: ${err.message}` };
  }

  return { ok: true, examDate: date, changed: true, backup };
}

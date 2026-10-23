// Drop-anything paper intake.
//
// You drop a PDF — any name, any folder, "scan_0421.pdf" is fine — and this works out
// what it is, files it where the collection expects it, registers it, classifies every
// question and rebuilds the index. One queue, one paper at a time, progress broadcast
// as it goes.
//
// Identification is deterministic first (filename conventions). Only when that comes up
// short does it read the paper itself: first-page text, or a rasterised first page when
// the text layer is unusable. That keeps the common case free and the random case working.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT_ROOT } from './paths.js';
import { identify, unitFor, auditPaper, ingestPaper, plan, formatAudit } from './ingest.js';
import { extractPages, rasterizeBase64 } from './pdf.js';

const EXAMS = path.join(PROJECT_ROOT, 'major exams');

// ---------------------------------------------------------------- deep identify

const COMPLETE = (id) =>
  Boolean(id.family) &&
  (id.family !== 'TMUA' || id.paperNo) &&
  (Boolean(id.year) || Boolean(id.variant)) &&
  (id.family !== 'MAT' || id.variant !== 'specimen' || id.specimenNo);

/** Ask the model what this paper is. Cheap: one page of text, or one page image. */
async function identifyByContent(file, pages) {
  const usable = pages.slice(0, 2).join('\n').replace(/\s+/g, ' ').trim();
  const useImage = usable.length < 200;
  const promptText = `You are identifying a maths exam paper PDF so it can be filed automatically.

${useImage ? 'The first page is attached as an image (its text layer is unusable).' : `First pages, as text:\n"""\n${usable.slice(0, 3000)}\n"""`}

Filename: ${path.basename(file)}

Reply with ONE line of JSON and nothing else:
{"family":"MAT"|"TMUA"|"STEP"|null,"year":<number|null>,"paperNo":1|2|3|null,"variant":"specimen"|"practice"|null,"kind":"paper"|"solutions"|"answer_key"|"answer_sheet"|"report"|"reference","confidence":0.0-1.0}

Rules:
- family: MAT = Oxford Mathematics Admissions Test. TMUA = Test of Mathematics for University Admission. STEP = Cambridge STEP.
- year: the year the paper was SAT. null for specimen/practice papers, which have no year.
- paperNo: TMUA Paper 1 or 2; STEP 1, 2 or 3. null for MAT.
- kind: "paper" only for a question paper. Worked solutions or a mark scheme are "solutions". A grid of letters is "answer_key". A blank response grid is "answer_sheet". Note that question papers often MENTION their answer sheet — that does not make them one.
- confidence: how sure you are overall.`;

  const content = [{ type: 'text', text: promptText }];
  if (useImage) {
    try {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: await rasterizeBase64(file, 1, 110) } });
    } catch {}
  }

  const q = query({
    prompt: (async function* () { yield { type: 'user', message: { role: 'user', content } }; })(),
    options: { model: 'haiku', cwd: PROJECT_ROOT, maxTurns: 1, allowedTools: [] },
  });
  let out = '';
  for await (const msg of q) {
    if (msg.type === 'assistant') for (const b of msg.message.content) if (b.type === 'text') out += b.text;
    if (msg.type === 'result') break;
  }
  const m = out.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/** Filename first; read the paper only if that leaves something unknown. */
export async function identifyDeep(file, { onProgress = () => {} } = {}) {
  const pages = await extractPages(file).catch(() => []);
  const base = identify(file, pages[0] ?? '');
  if (COMPLETE(base)) return { ...base, source: 'filename' };

  onProgress('reading the paper to identify it…');
  const guess = await identifyByContent(file, pages);
  if (!guess) return { ...base, source: 'filename', low_confidence: true };

  // Merge: trust the filename where it said something, the model where it did not.
  const merged = {
    family: base.family ?? guess.family ?? null,
    year: base.year ?? (guess.variant ? null : guess.year) ?? null,
    variant: base.variant ?? guess.variant ?? null,
    paperNo: base.paperNo ?? guess.paperNo ?? null,
    specimenNo: base.specimenNo ?? null,
    kind: base.kind !== 'paper' ? base.kind : (guess.kind ?? 'paper'),
    handwritten: base.handwritten,
    source: 'content',
    confidence: guess.confidence ?? null,
  };
  if (merged.variant === 'specimen' && !merged.specimenNo) merged.specimenNo = 1;
  return merged;
}

// ---------------------------------------------------------------- canonical place

const matDecade = (y) => (y <= 2010 ? '2001-2010' : y <= 2020 ? '2011-2020' : '2021-2030');

/**
 * Where this file belongs, named the way the rest of the collection is named. Returns
 * null when we cannot place it — the caller then leaves the file alone rather than
 * inventing a location.
 */
export function canonicalFor(id) {
  const { family, year, variant, paperNo, specimenNo, kind, handwritten } = id;
  const hw = handwritten ? ' (Handwritten)' : '';

  if (family === 'MAT') {
    if (variant === 'specimen') {
      const n = specimenNo ?? 1;
      const dir = path.join(EXAMS, 'mat', 'specimen');
      const name = kind === 'solutions' ? `Solutions Specimen ${n}${hw}.pdf` : `MAT Specimen ${n}.pdf`;
      return { dir, name };
    }
    if (!year) return null;
    const dir = path.join(EXAMS, 'mat', 'new', matDecade(year), String(year));
    const name =
      kind === 'solutions' ? `Solutions ${year}${hw}.pdf`
      : kind === 'report' ? `MAT ${year} Report.pdf`
      : `MAT ${year}.pdf`;
    return { dir, name };
  }

  if (family === 'TMUA') {
    const label = variant === 'practice' ? 'Practice' : variant === 'specimen' ? 'Specimen' : String(year ?? '');
    if (!label) return null;
    const dir = path.join(EXAMS, 'tmua', variant ?? String(year));
    const stem = `TMUA ${label}`;
    if (kind === 'answer_key') return { dir, name: `${stem} Answer Key.pdf` };
    if (!paperNo) return null;
    const p = `${stem} Paper ${paperNo}`;
    const name =
      kind === 'solutions' ? `${p} Solutions${hw}.pdf`
      : kind === 'answer_sheet' ? `${p} Answer Sheet.pdf`
      : `${p}.pdf`;
    return { dir, name };
  }

  if (family === 'STEP') {
    // Filed but not classified — the index schema does not model STEP's long-form
    // questions. Follows the archive's own layout: old/<year> before 1994, then
    // new/<decade>/<year>, with companions named "<year> Solutions.pdf" etc.
    if (!year) return { dir: path.join(EXAMS, 'step', 'misc'), name: id.originalName ?? 'STEP paper.pdf' };
    const decade = year < 1994 ? null
      : year <= 2000 ? '1994-2000' : year <= 2010 ? '2001-2010' : year <= 2020 ? '2011-2020' : '2021-2030';
    const dir = decade
      ? path.join(EXAMS, 'step', 'new', decade, String(year))
      : path.join(EXAMS, 'step', 'old', String(year));
    const name =
      kind === 'solutions' ? `${year} Solutions${hw}.pdf`
      : kind === 'report' ? `${year} Examiners' Report.pdf`
      : `${year} STEP${paperNo ? ` ${paperNo}` : ''}.pdf`;
    return { dir, name };
  }

  return null;
}

const sameSize = (a, b) => { try { return fs.statSync(a).size === fs.statSync(b).size; } catch { return false; } };

/** Move the file into place. Never overwrites; detects an identical duplicate. */
export async function fileIntoPlace(file, id) {
  const target = canonicalFor(id);
  if (!target) return { moved: false, reason: 'no canonical location for this paper', path: file };
  const dest = path.join(target.dir, target.name);
  if (path.resolve(file) === path.resolve(dest)) return { moved: false, reason: 'already in place', path: dest };

  await fsp.mkdir(target.dir, { recursive: true });
  if (fs.existsSync(dest)) {
    if (sameSize(dest, file)) {
      await fsp.rm(file, { force: true });
      return { moved: false, duplicate: true, reason: 'already have this paper — dropped copy discarded', path: dest };
    }
    const alt = path.join(target.dir, target.name.replace(/\.pdf$/i, ` (dropped ${new Date().toISOString().slice(0, 10)}).pdf`));
    await fsp.rename(file, alt);
    return { moved: true, conflict: true, reason: 'a different file already had that name — kept both', path: alt };
  }
  await fsp.rename(file, dest);
  return { moved: true, path: dest };
}

// ---------------------------------------------------------------- one paper

/** Identify → file → register → classify → merge. Returns a report for the UI. */
export async function autoIngest(file, { onProgress = () => {} } = {}) {
  const name = path.basename(file);
  onProgress(`identifying ${name}…`);
  const id = await identifyDeep(file, { onProgress });
  id.originalName = name;

  const label = [id.family, id.variant ?? id.year, id.paperNo ? `Paper ${id.paperNo}` : null].filter(Boolean).join(' ') || 'unrecognised';
  if (!id.family) {
    return { ok: false, file, label, stage: 'identify', message: `Could not tell what ${name} is, so I have left it where it is. Rename it like "TMUA 2023 Paper 1.pdf" and drop it again.` };
  }

  const placed = await fileIntoPlace(file, id);
  const at = placed.path;
  if (placed.duplicate) {
    return { ok: true, file: at, label, stage: 'duplicate', message: `${label} — already in the collection, so the dropped copy was discarded.` };
  }
  onProgress(placed.moved ? `filed as ${path.basename(at)}` : `left in place (${placed.reason})`);

  if (id.kind !== 'paper') {
    // Companions are filed, then picked up automatically when their paper is ingested.
    const a = await auditPaper(at).catch(() => null);
    return {
      ok: true, file: at, label, stage: 'companion', kind: id.kind,
      message: `${label} ${id.kind.replace('_', ' ')} filed as ${path.basename(at)}.${a?.unit ? ' Its paper will pick it up automatically.' : ''}`,
    };
  }

  if (!unitFor(id)) {
    return {
      ok: true, file: at, label, stage: 'unsupported',
      message: `${label} filed as ${path.basename(at)}. It is not classifiable — ${plan({ ok: true, unit: null, identified: id })[0]}. The tutor can still open it.`,
    };
  }

  onProgress('classifying questions — this takes a few minutes…');
  const r = await ingestPaper(at, { onProgress: (t) => onProgress(t) });
  const a = r.audit;
  const todo = plan(a);
  return {
    ok: todo.length === 0,
    file: at, label, stage: 'ingested',
    classified: a.classified, expected: a.questions.expected,
    audit: formatAudit(a),
    message: todo.length === 0
      ? `${label} is ready — filed as ${path.basename(at)}, ${a.classified} questions classified and indexed.`
      : `${label} filed as ${path.basename(at)}, but still to do: ${todo.join(', ')}.`,
  };
}

// ---------------------------------------------------------------- queue

// Classification is minutes-long and token-heavy, so papers are processed strictly one
// at a time however many get dropped at once.
const queue = [];
let running = false;

export function pending() { return queue.length + (running ? 1 : 0); }

export function enqueuePaper(file, { onProgress = () => {}, onDone = () => {} } = {}) {
  queue.push({ file, onProgress, onDone });
  if (!running) drain();
  return { queued: queue.length, running };
}

async function drain() {
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      const report = await autoIngest(job.file, { onProgress: job.onProgress });
      job.onDone(report);
    } catch (err) {
      job.onDone({ ok: false, file: job.file, stage: 'error', message: `Ingest failed: ${err.message}` });
    }
  }
  running = false;
}

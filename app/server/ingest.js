// Paper ingest pipeline: audit a PDF dropped into the project, then build every
// resource the tutor needs for it.
//
// The four resources a paper needs to be fully usable:
//   1. a file_manifest.json entry            (so paths are findable)
//   2. a solutions/answer-key pairing        (so answers can be marked, not guessed)
//   3. a usable read path                    (clean text layer, or "rasterise every page")
//   4. a classification shard + merged index (so query_tag_index can find its questions)
//
// Everything here is deterministic except step 4, which runs the same Agent SDK
// classification the original 540-question build used, against the same
// tutor_data/reference/TAGGING_SPEC.md. Re-running is safe: audit is read-only,
// manifest registration is idempotent, and classification refuses to clobber a
// complete shard unless asked to.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT_ROOT, TUTOR_DATA } from './paths.js';
import { extractPages, pageCount } from './pdf.js';

const execFileP = promisify(execFile);
const MANIFEST = path.join(TUTOR_DATA, 'file_manifest.json');
const REF = path.join(TUTOR_DATA, 'reference');
const SHARDS = path.join(REF, 'shards');
const SPEC = path.join(REF, 'TAGGING_SPEC.md');
const MERGE = path.join(REF, 'merge_shards.py');

const readJSON = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

// ---------------------------------------------------------------- identification

/**
 * What is this PDF? Filename first (these papers are consistently named), first-page
 * text as the tie-breaker. Returns nulls rather than guessing when it cannot tell.
 */
export function identify(file, firstPageText = '') {
  const name = path.basename(file);
  const text = firstPageText.slice(0, 1500);
  // Filename is authoritative; page text only fills in what the name does not say.
  // Covers are full of misleading words — TMUA 2016's cover mentions "practice", every
  // TMUA cover mentions its answer sheet — so text must never override a name signal.
  const inName = (re) => re.test(name);
  const has = (re) => re.test(name) || re.test(text);

  // Kind comes from the FILENAME, which is consistent across this collection. Page text
  // is only a fallback, because a question paper's own cover mentions its companions:
  // every TMUA paper says "Additional materials: Answer sheet", which would otherwise
  // misfile the paper itself as an answer sheet.
  const kindOf = (s) =>
    // "Answer Sheet" is the blank response grid — test before answer_key or it collides.
    /answer\s*sheet/i.test(s) ? 'answer_sheet'
    : /answer\s*key/i.test(s) ? 'answer_key'
    : /hints\s*(and|&)\s*answers|solutions?|worked answers|mark scheme/i.test(s) ? 'solutions'
    : /report/i.test(s) ? 'report'
    // Specs, formulae booklets and topic notes sit alongside the papers but are not
    // question papers; without this they audit as broken papers with 0 questions.
    : /specification|formulae\s*booklet|notes on|content spec|read\s*me/i.test(s) ? 'reference'
    : null;
  // Filename only — deliberately no text fallback. Every TMUA question paper's cover
  // reads "Additional materials: Answer sheet", and MAT covers reference their mark
  // scheme, so consulting page text reclassifies real papers as their own companions.
  // A misnamed file shows up in the audit anyway: wrong question count, no companions.
  const kind = kindOf(name) ?? 'paper';

  const family = has(/\bTMUA\b|test of mathematics for university admission/i) ? 'TMUA'
    : has(/\bMAT\b|mathematics admissions test/i) ? 'MAT'
    : has(/\bSTEP\b/i) ? 'STEP'
    : null;

  const variant = inName(/specimen/i) ? 'specimen' : inName(/practice/i) ? 'practice' : null;
  // Specimen and practice papers carry no exam year. They often mention one in the
  // body text (the TMUA specimen cites 2017), which must not be read as its year.
  // 19xx matters: the STEP archive goes back to 1987.
  const yearMatch = variant ? null : (name.match(/\b(19|20)\d{2}\b/) ?? text.match(/\b(19|20)\d{2}\b/));
  const year = yearMatch ? Number(yearMatch[0]) : null;
  const specimenNo = variant === 'specimen' ? Number(name.match(/specimen\s*(\d)/i)?.[1] ?? 0) || null : null;
  const paperNo = family === 'TMUA'
    ? (inName(/paper\s*1|\bP1\b/i) ? 1 : inName(/paper\s*2|\bP2\b/i) ? 2
      : /paper\s*1/i.test(text) ? 1 : /paper\s*2|second of two papers/i.test(text) ? 2 : null)
    : null;
  const handwritten = has(/handwritten/i);

  return { family, year, variant, paperNo, specimenNo, kind, handwritten };
}

/** Manifest key + index unit + id prefix for an identified paper. */
export function unitFor(id) {
  const { family, year, variant, paperNo, specimenNo } = id;
  if (family === 'MAT') {
    if (variant === 'specimen') {
      if (!specimenNo) return null; // "MAT Specimen.pdf" with no number — ambiguous
      return {
        manifest: ['mat_specimen', `specimen_${specimenNo}`],
        unit: `mat_specimen_${specimenNo}`,
        idPrefix: `MATSPEC${specimenNo}`,
        examFamily: 'MAT',
      };
    }
    if (!year) return null;
    return { manifest: ['mat', String(year)], unit: `mat_${year}`, idPrefix: `MAT${year}`, examFamily: 'MAT' };
  }
  if (family === 'TMUA') {
    if (!paperNo) return null;
    const p = `p${paperNo}`;
    const examFamily = `TMUA_P${paperNo}`;
    if (variant === 'practice') return { manifest: ['tmua_practice'], unit: `tmua_practice_${p}`, idPrefix: `TMUAPRACP${paperNo}`, examFamily, key: p };
    if (variant === 'specimen') return { manifest: ['tmua_specimen'], unit: `tmua_specimen_${p}`, idPrefix: `TMUASPECP${paperNo}`, examFamily, key: p };
    if (!year) return null;
    return { manifest: ['tmua', String(year)], unit: `tmua_${year}_${p}`, idPrefix: `TMUA${year}P${paperNo}`, examFamily, key: p };
  }
  return null;
}

// ---------------------------------------------------------------- text quality

// A "clean" text layer means the tutor can find_in_pdf and the classifier can read
// questions as text. TMUA Practice P1/P2 are the known-bad case: the font encoding
// yields glyph soup, so every page has to be rasterised and read as an image.
export function judgeText(pages) {
  const body = pages.join('\n');
  const chars = body.replace(/\s/g, '').length;
  // Average over pages that carry text: cover sheets, answer grids and the blank pages
  // these papers pad with would otherwise make a clean paper look thin.
  const substantive = pages.filter((p) => p.replace(/\s/g, '').length > 40);
  const perPage = substantive.length ? Math.round(chars / substantive.length) : 0;
  // Private-use-area and replacement glyphs are the signature of a broken embedded font.
  const garbled = (body.match(/[-�]/g) ?? []).length;
  const garbleRatio = chars ? garbled / chars : 0;
  const letters = (body.match(/[A-Za-z]/g) ?? []).length;
  const letterRatio = chars ? letters / chars : 0;

  let verdict = 'clean';
  if (perPage < 80) verdict = 'image_only';
  else if (garbleRatio > 0.02 || letterRatio < 0.25) verdict = 'corrupt';
  else if (perPage < 300) verdict = 'thin';
  return { verdict, chars_per_page: perPage, garble_ratio: Number(garbleRatio.toFixed(4)), letter_ratio: Number(letterRatio.toFixed(2)) };
}

/** Count the questions actually present, so a truncated or odd paper is caught early. */
export function countQuestions(pages, family) {
  const body = pages.join('\n');
  if (family === 'TMUA') {
    const found = new Set();
    for (const m of body.matchAll(/^\s{0,6}(\d{1,2})\s{2,}\S/gm)) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 20) found.add(n);
    }
    return { expected: 20, found: found.size, missing: [...Array(20)].map((_, i) => i + 1).filter((n) => !found.has(n)) };
  }
  if (family === 'MAT') {
    const found = new Set();
    for (const m of body.matchAll(/^\s{0,6}([A-J])[.)]\s/gm)) found.add(m[1]);
    const all = 'ABCDEFGHIJ'.split('');
    return { expected: 10, found: found.size, missing: all.filter((c) => !found.has(c)) };
  }
  return { expected: null, found: null, missing: [] };
}

// ---------------------------------------------------------------- companions

/** Look beside the paper for its solutions / answer key / report. */
export function findCompanions(paperPath) {
  const dir = path.dirname(paperPath);
  const id = identify(paperPath);
  let siblings = [];
  try { siblings = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.pdf')); } catch {}

  const out = { solutions: null, solutions_handwritten: null, answer_key: null, report: null };
  for (const f of siblings) {
    const abs = path.join(dir, f);
    if (abs === paperPath) continue;
    const sid = identify(abs);
    // For TMUA, a sibling must be for the same paper number to count as its solutions.
    if (id.family === 'TMUA' && sid.paperNo && id.paperNo && sid.paperNo !== id.paperNo) {
      if (sid.kind !== 'answer_key') continue; // one key covers both papers
    }
    if (sid.kind === 'solutions') {
      if (sid.handwritten) out.solutions_handwritten ??= abs;
      else out.solutions ??= abs;
    } else if (sid.kind === 'answer_key') out.answer_key ??= abs;
    else if (sid.kind === 'report') out.report ??= abs;
  }
  return out;
}

// ---------------------------------------------------------------- audit

/** Read-only. Never writes anything. Safe to run on anything, repeatedly. */
export async function auditPaper(file) {
  const abs = path.resolve(PROJECT_ROOT, file);
  const problems = [];
  if (!fs.existsSync(abs)) return { ok: false, file: abs, problems: ['File does not exist.'] };
  if (!abs.toLowerCase().endsWith('.pdf')) return { ok: false, file: abs, problems: ['Not a PDF.'] };
  if (!abs.startsWith(PROJECT_ROOT + path.sep)) problems.push('Outside the project root — the tutor will refuse to open it. Move it under the project first.');

  const pages = await extractPages(abs).catch(() => []);
  const total = await pageCount(abs).catch(() => null);
  const id = identify(abs, pages[0] ?? '');
  const text = judgeText(pages);
  const questions = countQuestions(pages, id.family);
  const companions = findCompanions(abs);
  const unit = unitFor(id);

  if (id.kind !== 'paper') problems.push(`This looks like a ${id.kind}, not a question paper. Ingest the question paper; companions are picked up automatically.`);
  if (!id.family) problems.push('Cannot tell which exam this is from the filename or first page — pass --family MAT|TMUA.');
  if (id.family === 'TMUA' && !id.paperNo) problems.push('Cannot tell Paper 1 from Paper 2 — pass --paper 1|2.');
  if (!id.year && !id.variant) problems.push('No year found — pass --year YYYY.');
  if (text.verdict === 'corrupt' || text.verdict === 'image_only') {
    problems.push(`Text layer is ${text.verdict} (${text.chars_per_page} chars/page). Classification will rasterise every page and read images — slower, still accurate. find_in_pdf will be unreliable for this paper.`);
  }
  if (questions.expected && questions.found < questions.expected) {
    const detail = `Detected ${questions.found}/${questions.expected} questions in the text layer${questions.missing.length <= 5 ? ` (missing ${questions.missing.join(', ')})` : ''}.`;
    problems.push(text.verdict === 'clean' || text.verdict === 'thin'
      ? `${detail} The detector is a heuristic and undercounts odd layouts — worth an eyeball, not necessarily a fault.`
      : `${detail} Expected, given the ${text.verdict} text layer — the classifier will read the pages as images instead.`);
  }
  if (!companions.solutions && !companions.answer_key) {
    problems.push('No solutions and no answer key found beside it. Questions will be tagged verification_status "inferred_no_solution" and the tutor will not be able to mark from a mark scheme.');
  } else if (!companions.solutions) {
    problems.push('Answer key only, no worked solutions — questions will be tagged "answer_key_only" (same as TMUA 2022).');
  }

  // Already known? The merged index is authoritative for "is this classified" — MAT
  // years live in batched shards (mat_2016-2018.json), so a per-unit shard filename
  // is not a reliable test. Fall back to a partial shard for work still in progress.
  const manifest = readJSON(MANIFEST, {});
  const registered = unit ? Boolean(getIn(manifest, unit.manifest)) : false;
  const shardPath = unit ? path.join(SHARDS, `${unit.unit}.json`) : null;
  const shard = shardPath && fs.existsSync(shardPath) ? readJSON(shardPath, null) : null;
  const classified = unit
    ? Math.max(countInIndex(unit.idPrefix), shard?.questions?.length ?? 0)
    : 0;

  return {
    ok: true, file: abs, pages: total, identified: id, unit, text, questions, companions,
    registered, classified, shard_path: shardPath, problems,
  };
}

const getIn = (o, keys) => keys.reduce((a, k) => (a == null ? a : a[k]), o);

/** How many questions with this id prefix are already in the merged indexes. */
function countInIndex(idPrefix) {
  let n = 0;
  for (const f of ['mat_full_tag_index.json', 'tmua_full_tag_index.json']) {
    const d = readJSON(path.join(REF, f), null);
    for (const q of d?.questions ?? []) {
      // MAT2016 must not match MAT2016... nothing else does, but guard specimens:
      // MATSPEC1 vs MAT2016 differ in prefix already, so a startsWith is safe here.
      if (q.id.startsWith(idPrefix)) n++;
    }
  }
  return n;
}

export function formatAudit(a) {
  if (!a.ok) return `AUDIT FAILED: ${a.file}\n  ${a.problems.join('\n  ')}`;
  const i = a.identified;
  const L = [
    `AUDIT ${path.basename(a.file)}`,
    `  identified   ${i.family ?? '?'} ${i.year ?? i.variant ?? '?'}${i.paperNo ? ` Paper ${i.paperNo}` : ''} (${i.kind})`,
    `  pages        ${a.pages ?? '?'}`,
    `  text layer   ${a.text.verdict} — ${a.text.chars_per_page} chars/page`,
    `  questions    ${a.questions.found ?? '?'} / ${a.questions.expected ?? '?'} detected`,
    `  solutions    ${a.companions.solutions ? path.basename(a.companions.solutions) : '(none)'}`,
    `  answer key   ${a.companions.answer_key ? path.basename(a.companions.answer_key) : '(none)'}`,
    `  manifest     ${a.registered ? 'registered' : 'NOT registered'}`,
    `  tag index    ${a.classified ? `${a.classified} questions classified` : 'NOT classified'}`,
    `  unit         ${a.unit?.unit ?? '(no automatic slot — hand-key this one)'}`,
  ];
  if (a.problems.length) L.push('  needs attention:', ...a.problems.map((p) => `    - ${p}`));
  const todo = plan(a);
  L.push(todo.length ? `  to do: ${todo.join(', ')}` : '  to do: nothing — this paper is fully resourced.');
  return L.join('\n');
}

/**
 * What still has to happen for this paper to be fully usable. A paper the pipeline
 * cannot place must say so loudly — silence here would report an unhandled paper as
 * "fully resourced", which is worse than no audit at all.
 */
export function plan(a) {
  const todo = [];
  if (!a.ok) return ['audit failed'];
  if (!a.unit) {
    const fam = a.identified.family;
    if (fam && fam !== 'MAT' && fam !== 'TMUA') {
      todo.push(`${fam} is not supported by the classification index (its schema is MAT/TMUA only) — manifest registration and PDF tools still work, tagging does not`);
    } else {
      todo.push('cannot place this paper — ambiguous exam/year/paper number, pass --family/--year/--paper');
    }
    return todo;
  }
  if (!a.registered) todo.push('register in manifest');
  const expected = a.questions.expected ?? 0;
  if (a.classified < expected) todo.push(a.classified ? `finish classification (${a.classified}/${expected})` : 'classify questions');
  return todo;
}

// ---------------------------------------------------------------- manifest

/** Idempotent: adds the entry if absent, fills blank fields, never restructures. */
export function registerPaper(a, { dryRun = false } = {}) {
  if (!a.unit) return { changed: false, reason: 'no automatic manifest slot for this paper' };
  const manifest = readJSON(MANIFEST, null);
  if (!manifest) return { changed: false, reason: 'file_manifest.json unreadable' };

  const [top, sub] = a.unit.manifest;
  manifest[top] ??= {};
  const target = sub ? (manifest[top][sub] ??= {}) : manifest[top];
  const before = JSON.stringify(target);

  const k = a.unit.key; // 'p1'/'p2' for TMUA, undefined for MAT
  const set = (field, val) => { if (val && !target[field]) target[field] = val; };
  set(k ? k : 'paper', a.file);
  set(k ? `${k}_solutions` : 'solutions', a.companions.solutions);
  set(k ? `${k}_solutions_handwritten` : 'solutions_handwritten', a.companions.solutions_handwritten);
  set('answer_key', a.companions.answer_key);
  if (!k) set('report', a.companions.report);
  target.full_solutions_available = Boolean(a.companions.solutions || target.full_solutions_available);

  const changed = JSON.stringify(target) !== before;
  if (changed && !dryRun) {
    fs.copyFileSync(MANIFEST, path.join(TUTOR_DATA, '.backups', `file_manifest.json.${Date.now()}`));
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
  }
  return { changed, path: a.unit.manifest.join('.') + (k ? `.${k}` : ''), dryRun };
}

// ---------------------------------------------------------------- classification

function classifyPrompt(a) {
  const u = a.unit;
  const n = a.questions.expected;
  const isTmua = u.examFamily.startsWith('TMUA');
  const sol = a.companions.solutions;
  const key = a.companions.answer_key;
  const verification = sol ? 'mark_scheme_read' : key ? 'answer_key_only' : 'inferred_no_solution';
  const idExample = isTmua ? `${u.idPrefix}Q01 ... ${u.idPrefix}Q${String(n).padStart(2, '0')}` : `${u.idPrefix}A ... ${u.idPrefix}J`;
  const partDesc = isTmua ? '"1".."20" (unpadded string)' : 'the letter A..J';

  return `Classify all ${n} questions of ${path.basename(a.file)}.

FIRST read the spec and follow it exactly: ${SPEC}

Paper: "${a.file}"
${sol ? `Worked solutions: "${sol}"` : key ? `Answer key (letters only): "${key}"` : 'No solutions and no answer key exist for this paper.'}

WORK ORDER — follow strictly, do not deviate:
1. Read the paper and ${sol ? 'the solutions' : key ? 'the answer key' : 'nothing else'} with: pdftotext -layout "<path>" -
${a.text.verdict === 'clean' || a.text.verdict === 'thin'
  ? '   The text layer is usable; only rasterise an individual page if a figure is essential and the text cannot convey it.'
  : `   WARNING: this paper's text layer is ${a.text.verdict}. Expect glyph soup. Rasterise pages with:\n     pdftoppm -r 130 -png -f <page> -l <page> "<path>" <scratch>/pg\n   and Read the PNGs. Budget for reading every page as an image.`}
2. Tag questions in batches of 5, and WRITE THE SHARD FILE AFTER EVERY BATCH. Never go
   more than 5 questions without writing. A crash must never lose more than 5 items.
${sol ? '3. Read the official worked solution for every question before tagging it. Where the solution explains why a wrong option is attractive, use that for trap_type — it is real data.'
      : key ? '3. No worked solutions exist. Solve each question yourself from the paper text, check your answer against the answer key, and derive technique/trap tags from your own solution plus the distractor options. Report any question where your answer disagrees with the key. Do NOT exhaustively re-derive every question — one sound pass each.'
            : '3. No solutions or key exist. Solve each question yourself and tag from your own solution. Flag low confidence in the shard note.'}

Fields for every item: id = ${idExample}, part = ${partDesc}, year = ${a.identified.year ?? 'null'},
paper = "${isTmua ? u.examFamily : 'MAT'}", exam_family = "${u.examFamily}",
paper_section = ${isTmua ? (u.examFamily === 'TMUA_P2' ? '"P2_logic_and_proof"' : '"P1_pure" or "P1_applications" per question') : 'null'},
verification_status = "${verification}", cross_links = [] (always empty — links are computed globally at merge).
Exactly ${n} items.

Output shard: ${path.join(SHARDS, `${u.unit}.json`)} with "unit": "${u.unit}".
Valid JSON only, no markdown fence, no prose outside the JSON.

Modify no other file. Report back: item count, any new_tags you introduced${key && !sol ? ', and any question where your answer disagreed with the key' : ''}.`;
}

/**
 * Run the classifier. Same spec, same conventions, same output shape as the original
 * 540-question build — that is what makes this reproducible rather than bespoke.
 */
export async function classifyPaper(a, { onProgress = () => {}, model = 'sonnet', force = false } = {}) {
  if (!a.unit) return { ok: false, reason: 'no index unit for this paper' };
  const shardPath = path.join(SHARDS, `${a.unit.unit}.json`);
  const expected = a.questions.expected ?? 0;
  if (!force && a.classified >= expected && expected > 0) {
    return { ok: true, skipped: true, count: a.classified, reason: 'already fully classified' };
  }

  fs.mkdirSync(SHARDS, { recursive: true });
  const q = query({
    prompt: classifyPrompt(a),
    options: {
      model,
      cwd: PROJECT_ROOT,
      permissionMode: 'bypassPermissions',
      allowedTools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
      maxTurns: 120,
    },
  });

  let lastText = '';
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const b of msg.message.content) {
        if (b.type === 'text' && b.text.trim()) { lastText = b.text.trim(); onProgress(lastText.slice(0, 160)); }
        if (b.type === 'tool_use' && b.name === 'Write') onProgress(`writing shard…`);
      }
    }
    if (msg.type === 'result') break;
  }

  const shard = readJSON(shardPath, null);
  const count = shard?.questions?.length ?? 0;
  return { ok: count > 0, count, expected, complete: count >= expected, shard_path: shardPath, note: lastText.slice(0, 400) };
}

// ---------------------------------------------------------------- merge + verify

/** Rebuild both indexes from all shards and report validation output. */
export async function mergeIndexes({ strict = false } = {}) {
  const args = [MERGE];
  if (strict) args.push('--strict');
  try {
    const { stdout } = await execFileP('python3', args, { cwd: PROJECT_ROOT, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, output: stdout };
  } catch (err) {
    return { ok: false, output: (err.stdout ?? '') + (err.stderr ?? err.message) };
  }
}

/** Full pipeline: audit → register → classify → merge → re-audit. */
export async function ingestPaper(file, opts = {}) {
  const { classify = true, dryRun = false, force = false, onProgress = () => {} } = opts;
  const steps = [];
  let audit = await auditPaper(file);
  steps.push({ step: 'audit', ok: audit.ok, detail: formatAudit(audit) });
  if (!audit.ok || !audit.unit) return { audit, steps, done: false };

  const reg = registerPaper(audit, { dryRun });
  steps.push({ step: 'manifest', ok: true, detail: reg.changed ? `registered at ${reg.path}${dryRun ? ' (dry run)' : ''}` : 'already registered — no change' });
  if (reg.changed && !dryRun) audit = await auditPaper(file);

  if (classify && !dryRun) {
    onProgress('classifying…');
    const c = await classifyPaper(audit, { onProgress, force });
    steps.push({ step: 'classify', ok: c.ok, detail: c.skipped ? `skipped — ${c.reason}` : `${c.count}/${c.expected} questions${c.complete ? '' : ' — INCOMPLETE, re-run to finish'}` });
    if (c.ok && !c.skipped) {
      const m = await mergeIndexes({ strict: false });
      steps.push({ step: 'merge', ok: m.ok, detail: m.output.trim().split('\n').filter((l) => /^(wrote|normalised|PROBLEM|MISSING|warnings)/.test(l)).join('\n') || m.output.trim().slice(0, 400) });
    }
  } else if (classify && dryRun) {
    steps.push({ step: 'classify', ok: true, detail: 'skipped (dry run)' });
  }

  const final = await auditPaper(file);
  return { audit: final, steps, done: plan(final).length === 0 };
}

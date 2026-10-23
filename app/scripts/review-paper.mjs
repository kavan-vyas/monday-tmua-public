// Build a review paper: an explicit list of questions, each followed by its own answer.
//
//   node scripts/review-paper.mjs build understood --title "Understood Review Paper"
//
// Unlike a backlog paper, which is a sittable retry, this is for going over questions he now
// understands or only half-trusted (his "m" marks). So the order is not scattered: questions
// still on the open backlog come first, then the ones already cleared, each group by
// priority, and every question page is followed straight away by its answer page.
//
// The question list is tutor_data/backlog-papers/<slug>/selection.json ("include": canonical
// ids). Hand-written answers for papers with no published scheme live in <slug>/written/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pool, sliceFor, priority } from '../server/backlogpaper.js';
import { renderPage, cropVertical } from '../server/mutant.js';
import { paperRow } from '../server/papers.js';
import { canonicalId } from '../server/canonical.js';
import { TUTOR_DATA, PROJECT_ROOT } from '../server/paths.js';

const argv = process.argv;
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const esc = (s) => String(s).replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_{}])/g, '\\$1')
  .replace(/\^/g, '\\^{}').replace(/~/g, '\\~{}');
const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
const WORK = path.join(TUTOR_DATA, 'backlog-papers');
// Its own folder: a backlog paper ships as paper + separate Answers PDF, and that folder is
// checked for the pair; a review paper carries its answers inline.
const REVIEW_PAPER_DIR = path.join(PROJECT_ROOT, 'major exams', 'tmua', 'review paper');

/** "Tyler Mock Set D Paper 1, Q19" — the paper a question came from, in words. */
function sourceName(r) {
  const official = /^tmua_(\d{4})_p([12])$/.exec(r.paper_id ?? '');
  const title = paperRow(r.paper_id)?.title
    ?? (official ? `TMUA ${official[1]} Paper ${official[2]}` : String(r.ref).replace(/\s*Q\s*\d+$/, ''));
  return `${title}, Q${r.qnum}`;
}

/** m-marked questions, read off the question ledger rather than trusted from the backlog. */
function maybes() {
  const s = JSON.parse(fs.readFileSync(path.join(TUTOR_DATA, 'memory', 'session_memory.json'), 'utf8'));
  const out = new Set();
  for (const x of s.questions_attempted ?? []) {
    if (x.paper === 'MAT' || !x.shaky) continue;
    out.add(canonicalId('TMUA', x.qid ?? `${x.year} ${x.part}`));
  }
  return out;
}

function build(slug) {
  const dir = path.join(WORK, slug);
  const sel = JSON.parse(fs.readFileSync(path.join(dir, 'selection.json'), 'utf8'));
  const title = flag('title', slug);

  // Prefer the open item where a question has both an open and a closed entry.
  const byCid = new Map();
  for (const r of pool({ statuses: ['open', 'done'] })) {
    if (!byCid.has(r.cid) || r.status === 'open') byCid.set(r.cid, r);
  }
  const missing = sel.include.filter((c) => !byCid.has(c));
  if (missing.length) { console.error(`not in the backlog or not locatable: ${missing.join(', ')}`); process.exit(1); }

  const m = maybes();
  const rows = sel.include.map((c) => byCid.get(c));
  const byPriority = (a, b) => priority(b) - priority(a) || a.cid.localeCompare(b.cid);
  const open = rows.filter((r) => r.status === 'open').sort(byPriority);
  const cleared = rows.filter((r) => r.status !== 'open').sort(byPriority);

  fs.rmSync(path.join(dir, 'img'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });

  const manifest = [];
  for (const [i, r] of [...open, ...cleared].entries()) {
    const n = i + 1;
    const q = cut(r, 'qp', path.join(dir, 'img', `q${String(n).padStart(3, '0')}.png`));
    const a = r.ms && r.ms_page ? answerCuts(r, path.join(dir, 'img'), n) : null;
    const written = a ? null : path.join(dir, 'written', `${safeRef(r.ref)}.tex`);
    if (written && !fs.existsSync(written)) { console.error(`no scheme and no written answer: ${r.ref} (${written})`); process.exit(1); }
    manifest.push({
      n, cid: r.cid, ref: r.ref, source: sourceName(r), part: r.status === 'open' ? 'A' : 'B',
      mark: m.has(r.cid) ? 'm' : 'n', topic: r.topic, bucket: r.bucket, note: r.detail ?? '',
      priority: priority(r), q, a, written: written ? path.relative(dir, written) : null,
    });
    console.log(`  ${String(n).padStart(3)}. [${manifest.at(-1).part}] ${r.ref.padEnd(22)} ${m.has(r.cid) ? 'm' : 'n'}  `
      + `a:${a ? a.map((x) => `p${x.page}${x.crop ? `[${x.crop}]` : ''}`).join('+') : 'written'}`);
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    slug, title, generated: new Date().toISOString(), rule: sel.rule, count: manifest.length,
    open: open.length, cleared: cleared.length, questions: manifest, excluded: sel.excluded,
  }, null, 2));

  const pdf = compile(dir, 'paper.tex', tex(title, manifest, sel));
  const out = [];
  for (const dst of [path.join(os.homedir(), 'Downloads', `${title}.pdf`), path.join(REVIEW_PAPER_DIR, `${title}.pdf`)]) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(pdf, dst);
    out.push(dst);
  }
  console.log(`\n${manifest.length} questions (${open.length} on the backlog, ${cleared.length} cleared). placed:`);
  for (const p of out) console.log(`  ${p}`);
}

/** Render one question (or its solution) and crop it to itself where it shares a page. */
function cut(r, which, dst) {
  const pdf = which === 'qp' ? r.qp : r.ms;
  const page = which === 'qp' ? r.qp_page : r.ms_page;
  const png = renderPage(pdf, page);
  const crop = sliceFor(pdf, page,
    which === 'qp' ? r.marker : (r.msMarker ?? r.marker),
    which === 'qp' ? r.nextMarker : (r.msNextMarker ?? r.nextMarker));
  if (crop) cropVertical(png, dst, crop); else fs.copyFileSync(png, dst);
  return { file: path.relative(path.dirname(path.dirname(dst)), dst), crop, page };
}

/**
 * The solution to one question, as one or two page slices.
 *
 * Two things the backlog paper's single crop gets wrong here. A loose label ("2 ") matches
 * any line that starts with the digit — "2 · 3 · 5 · 7 + 1" on Euclid's page — so a label
 * only counts when it stands alone ("20.") or reads "Question 20". And solutions that run
 * on (Chen's, whose page index is also a page early) continue onto the next page, so the
 * slice carries on there until the next question's label.
 */
function answerCuts(r, imgDir, n) {
  const q = r.qnum;
  const start = new RegExp(`^(?:Question\\s+${q}\\b.*|Q${q}\\s.*|Q?${q}\\.?)$`);
  const next = new RegExp(`^(?:Question\\s+${q + 1}\\b.*|Q${q + 1}\\s.*|Q?${q + 1}\\.?)$`);
  const pages = [];
  for (let p = Math.max(1, r.ms_page - 2); p <= r.ms_page + 3; p++) {
    const l = lines(r.ms, p);
    if (l) pages.push({ p, ...l });
  }
  // The indexed page first, then the one after, and only then the one before: a stray
  // "5" on the previous page (an option, a page number) must not outrank the real label.
  const order = [r.ms_page, r.ms_page + 1, r.ms_page - 1, r.ms_page - 2];
  // Pages before the indexed one only count with a written-out label ("Q20 ...",
  // "Question 20"): a bare "20" there is far more often an option or a stray number.
  const worded = new RegExp(`^(?:Question\\s+${q}\\b.*|Q${q}\\s.*)$`);
  const labelOn = (pg) => (pg.p < r.ms_page ? worded : start);
  const at = order.map((p) => pages.find((pg) => pg.p === p)).find((pg) => pg?.lines.some((l) => labelOn(pg).test(l.text)));
  if (!at) return [cut(r, 'ms', path.join(imgDir, `a${String(n).padStart(3, '0')}.png`))];

  const out = [];
  const first = at.lines.find((l) => labelOn(at).test(l.text));
  const stop = at.lines.find((l) => l.y > first.y + 1 && next.test(l.text));
  const own = at.lines.filter((l) => l.y >= first.y && (!stop || l.y < stop.y - 1) && !/^\d+$/.test(l.text));
  out.push({ page: at.p, top: first.y / at.height - 0.012, bottom: stop ? stop.y / at.height - 0.006 : 1, lines: own.length });
  // Runs over: follow onto the next page(s) down to the next label, at most two more
  // (Heracles' last solutions span three pages). A page that opens with the next label,
  // or carries only a running header above it, is not a continuation.
  let from = at, ended = Boolean(stop);
  for (let k = 0; k < 2 && !ended; k++) {
    const nx = pages.find((pg) => pg.p === from.p + 1);
    if (!nx) break;
    const end = nx.lines.find((l) => next.test(l.text));
    const body = nx.lines.filter((l) => l.text && (!end || l.y < end.y - 1));
    if (body.length <= 2 || (end && end.y / nx.height < 0.15)) break;
    out.push({ page: nx.p, top: Math.max(0, body[0].y / nx.height - 0.012), bottom: end ? end.y / nx.height - 0.006 : 1, lines: body.length });
    from = nx; ended = Boolean(end);
  }
  // A slice holding nothing but the label ("20." at the foot of a page, the working
  // overleaf) is dropped rather than printed as a near-empty strip.
  const kept = out.length > 1 && out[0].lines <= 1 ? out.slice(1) : out;
  return kept.map((s, i) => {
    const dst = path.join(imgDir, `a${String(n).padStart(3, '0')}${i ? '-' + i : ''}.png`);
    const png = renderPage(r.ms, s.page);
    const crop = [Number(Math.max(0, s.top).toFixed(4)), Number(Math.min(1, s.bottom).toFixed(4))];
    if (crop[0] < 0.02 && crop[1] > 0.98) fs.copyFileSync(png, dst); else cropVertical(png, dst, crop);
    return { file: path.relative(path.dirname(imgDir), dst), crop, page: s.page };
  });
}

/** Text lines of one page with their vertical positions, from the bbox layer. */
function lines(pdf, page) {
  let xml;
  try {
    xml = execFileSync('pdftotext', ['-bbox-layout', '-f', String(page), '-l', String(page), pdf, '-'],
      { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const dims = /<page width="([\d.]+)" height="([\d.]+)"/.exec(xml);
  if (!dims) return null;
  const out = [];
  for (const m of xml.matchAll(/<line xMin="[\d.]+" yMin="([\d.]+)" xMax="[\d.]+" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
    out.push({ y: Number(m[1]), text: m[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  // A bare number in the footer is a page number, never a question label.
  const height = Number(dims[2]);
  return { height, lines: out.filter((l) => !(/^\d+$/.test(l.text) && l.y / height > 0.9)) };
}

const BUCKET = { didnt_know: 'did not know it', slipped: 'slipped', timing: 'too slow' };

function tex(title, manifest, sel) {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const A = manifest.filter((x) => x.part === 'A');
  const B = manifest.filter((x) => x.part === 'B');
  const t = [
    '\\documentclass[11pt,a4paper]{article}',
    '\\usepackage[margin=1.5cm]{geometry}\\usepackage{graphicx}\\usepackage{xcolor}',
    '\\usepackage{fancyhdr}\\usepackage[T1]{fontenc}\\usepackage{lmodern}\\usepackage{amsmath,amssymb}',
    '\\usepackage{enumitem}\\usepackage{mdframed}\\usepackage{longtable}',
    '\\usepackage[utf8]{inputenc}\\DeclareUnicodeCharacter{2212}{-}\\DeclareUnicodeCharacter{00B2}{\\ensuremath{^2}}',
    '\\DeclareUnicodeCharacter{2014}{---}\\DeclareUnicodeCharacter{2013}{--}\\DeclareUnicodeCharacter{2019}{\'}',
    '\\DeclareUnicodeCharacter{2018}{`}\\DeclareUnicodeCharacter{201C}{``}\\DeclareUnicodeCharacter{201D}{\'\'}',
    '\\DeclareUnicodeCharacter{2026}{\\ldots}\\DeclareUnicodeCharacter{00D7}{\\ensuremath{\\times}}',
    '\\DeclareUnicodeCharacter{2264}{\\ensuremath{\\le}}\\DeclareUnicodeCharacter{2265}{\\ensuremath{\\ge}}',
    '\\DeclareUnicodeCharacter{03B8}{\\ensuremath{\\theta}}\\DeclareUnicodeCharacter{03C0}{\\ensuremath{\\pi}}',
    '\\DeclareUnicodeCharacter{221A}{\\ensuremath{\\surd}}\\DeclareUnicodeCharacter{2192}{\\ensuremath{\\to}}',
    '\\DeclareUnicodeCharacter{00B1}{\\ensuremath{\\pm}}',
    '\\definecolor{accent}{HTML}{9A3412}\\definecolor{rule}{HTML}{C9C2B6}\\definecolor{soft}{HTML}{F5F2ED}',
    '\\newmdenv[linecolor=rule,linewidth=0.6pt,backgroundcolor=soft,innertopmargin=6pt,',
    'innerbottommargin=6pt,innerleftmargin=8pt,innerrightmargin=8pt]{keybox}',
    `\\pagestyle{fancy}\\fancyhf{}\\lhead{\\small ${esc(title)}}\\rhead{\\small\\thepage}`,
    '\\renewcommand{\\headrulewidth}{0.4pt}\\setlength{\\parindent}{0pt}',
    '\\begin{document}',
    '\\thispagestyle{empty}\\vspace*{3cm}\\begin{center}',
    `{\\LARGE\\bfseries ${esc(title)}}\\\\[6pt]{\\large every maybe, and every question you now understand}\\\\[16pt]`,
    `{\\small ${manifest.length} questions: ${A.length} still on your backlog first, then ${B.length} already cleared.\\\\`,
    'Each group is in priority order --- most overdue, least re-earned and hardest first.\\\\',
    'Every question is followed straight away by its answer, with your own note at the time.\\\\[10pt]',
    `Compiled ${date}}`,
    '\\end{center}\\vfill',
    '\\begin{center}\\begin{minipage}{0.85\\textwidth}\\begin{keybox}',
    '\\textbf{How to use it.} Cover the answer page. Do the question, then turn over. If you',
    'cannot say \\emph{why} the method works, the question is not understood yet --- mark it and',
    'tell Monday. Questions you said you were still confused on are left out; they are listed at the back.',
    '\\end{keybox}\\end{minipage}\\end{center}',
    '\\newpage',
    '\\section*{\\color{accent}Contents}',
    '{\\small\\begin{longtable}{rp{6.2cm}clp{3.2cm}}',
    '\\textbf{Q} & \\textbf{From} & \\textbf{Mark} & \\textbf{Topic} & \\textbf{Why}\\\\\\hline\\endhead',
  ];
  for (const x of manifest) {
    if (x.n === 1) t.push(`\\noalign{\\medskip}\\multicolumn{5}{l}{\\textbf{\\color{accent}Part A --- on your backlog (${A.length})}}\\\\`);
    if (x.part === 'B' && x.n === A.length + 1) t.push(`\\noalign{\\medskip}\\multicolumn{5}{l}{\\textbf{\\color{accent}Part B --- already cleared (${B.length})}}\\\\`);
    t.push(`${x.n} & ${esc(x.source)} & ${x.mark === 'm' ? 'maybe' : 'wrong'} & `
      + `${esc(String(x.topic ?? '').replace(/_/g, ' '))} & ${esc(BUCKET[x.bucket] ?? x.bucket ?? '')}\\\\`);
  }
  t.push('\\end{longtable}}', '\\newpage');

  const divider = (label, count, blurb) => [
    '\\thispagestyle{empty}\\vspace*{6cm}\\begin{center}',
    `{\\Huge\\bfseries\\color{accent} ${label}}\\\\[10pt]{\\large ${count} questions}\\\\[8pt]{\\small ${blurb}}`,
    '\\end{center}\\newpage'];

  for (const x of manifest) {
    if (x.n === 1) t.push(...divider('Part A', A.length, 'Still open on your backlog. These count toward clearance.'));
    if (x.part === 'B' && x.n === A.length + 1) t.push(...divider('Part B', B.length, 'Already cleared from the backlog --- keep them clear.'));
    const head = `\\begin{center}{\\small\\color{accent}\\textbf{Question ${x.n}}}\\\\{\\footnotesize from ${esc(x.source)}`
      + ` \\quad$\\cdot$\\quad you marked it ${x.mark === 'm' ? '\\textbf{maybe}' : '\\textbf{wrong}'}}\\end{center}\\vspace{1mm}`;
    t.push(head,
      `\\begin{center}\\includegraphics[width=\\textwidth,height=0.84\\textheight,keepaspectratio]{${x.q.file}}\\end{center}`,
      '\\newpage',
      `\\begin{center}{\\small\\color{accent}\\textbf{Answer to Question ${x.n}}}\\\\{\\footnotesize ${esc(x.source)}}\\end{center}\\vspace{1mm}`);
    if (x.a) {
      // Each slice at full width; a long solution flows onto a second page rather than
      // being shrunk until it cannot be read.
      for (const s of x.a) t.push(`\\begin{center}\\includegraphics[width=\\textwidth,height=0.72\\textheight,keepaspectratio]{${s.file}}\\end{center}`);
    } else {
      t.push('\\begin{keybox}\\textbf{No published mark scheme.} This paper ships none, so the answer below is worked out '
        + 'here rather than quoted. Check it against your own working.\\end{keybox}\\vspace{2mm}',
        fs.readFileSync(path.join(WORK, manifestSlug, x.written), 'utf8'));
    }
    if (x.note) t.push('\\vfill\\begin{keybox}\\small\\textbf{Your note at the time.} \\emph{' + esc(x.note) + '}\\end{keybox}');
    t.push('\\newpage');
  }

  t.push('\\section*{\\color{accent}Left out, and why}',
    `{\\small ${esc(sel.rule)}}\\\\[6pt]`,
    '{\\small\\begin{longtable}{p{4.2cm}p{12cm}}');
  for (const [cid, why] of Object.entries(sel.excluded ?? {})) t.push(`${esc(cid)} & ${esc(why)}\\\\`);
  t.push('\\end{longtable}}', '\\end{document}');
  return t.join('\n');
}

let manifestSlug = null;

function compile(dir, name, source) {
  fs.writeFileSync(path.join(dir, name), source);
  for (let i = 0; i < 2; i++) {
    try {
      execFileSync('pdflatex', ['-interaction=nonstopmode', name], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch { /* nonstopmode exits non-zero on recoverable errors; the log says which */ }
  }
  const pdf = path.join(dir, name.replace(/\.tex$/, '.pdf'));
  if (!fs.existsSync(pdf)) throw new Error(`pdflatex produced nothing for ${name}; see ${name.replace(/\.tex$/, '.log')}`);
  return pdf;
}

const [cmd, slug] = argv.slice(2);
if (cmd === 'build' && slug) { manifestSlug = slug; build(slug); }
else {
  console.log('usage: node scripts/review-paper.mjs build <slug> [--title "Name"]');
  process.exit(1);
}

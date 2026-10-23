// Build a backlog paper: a sittable retry paper out of open backlog items, plus its mark scheme.
//
//   node scripts/backlog-paper.mjs build logic-mat \
//        --topic logic_and_proof --type sufficiency_or_necessity,logical_deduction,proof \
//        --logic --include-exam MAT --size 20 --seed 20260921
//
// Produces two PDFs and places both in ~/Downloads and in "major exams/tmua/backlog paper":
//   <Name>.pdf            the paper — cover, then one question per page, scattered
//   <Name> Answers.pdf    the mark scheme — the real solution pages where they exist
//
// --size is a FLOOR. Filters that match more than it produce a longer paper; filters that
// match less are topped up from the rest of the backlog by priority, because he asked for a
// whole paper and a half-empty one is not one.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pool, select, shuffle, sliceFor, matches, priority, LOGIC, BACKLOG_PAPER_DIR } from '../server/backlogpaper.js';
import { renderPage, cropVertical } from '../server/mutant.js';
import { TUTOR_DATA } from '../server/paths.js';
import os from 'node:os';

const argv = process.argv;
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const WORK = path.join(TUTOR_DATA, 'backlog-papers');
const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const esc = (s) => String(s).replace(/([&%$#_{}])/g, '\\$1').replace(/\\\\/g, '\\textbackslash{}');

function build(slug) {
  const filter = {
    topics: [...list(flag('topic')), ...(has('logic') ? LOGIC.topics : [])],
    types: [...list(flag('type')), ...(has('logic') ? LOGIC.types : [])],
    techniques: [...list(flag('technique')), ...(has('logic') ? LOGIC.techniques : [])],
    traps: [...list(flag('trap')), ...(has('logic') ? LOGIC.traps : [])],
  };
  const size = Number(flag('size', 20));
  const seed = Number(flag('seed', 1));
  const includeAll = list(flag('include-exam'));
  const title = flag('title', slug);

  const rows = pool();
  const picked = select(rows, filter, { size, includeAll });
  const ordered = shuffle(picked, seed);
  if (!ordered.length) { console.error('nothing matched, and the backlog is empty'); process.exit(1); }

  const matched = picked.filter((r) => matches(r, filter)).length;
  const forced = picked.filter((r) => includeAll.includes(r.exam) && !matches(r, filter)).length;
  console.log(`${ordered.length} questions: ${matched} matched the filter`
    + (forced ? `, ${forced} pulled in by --include-exam` : '')
    + (picked.length - matched - forced > 0 ? `, ${picked.length - matched - forced} topped up by priority` : ''));

  const dir = path.join(WORK, slug);
  fs.rmSync(path.join(dir, 'img'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'img'), { recursive: true });

  const manifest = [];
  const noScheme = [];
  for (const [i, r] of ordered.entries()) {
    const n = i + 1;
    const q = cut(r, 'qp', path.join(dir, 'img', `q${String(n).padStart(2, '0')}.png`));
    let a = null;
    if (r.ms && r.ms_page) a = cut(r, 'ms', path.join(dir, 'img', `a${String(n).padStart(2, '0')}.png`));
    else noScheme.push({ n, r });
    manifest.push({ n, ref: r.ref, exam: r.exam, topic: r.topic, bucket: r.bucket, q, a });
    console.log(`  ${String(n).padStart(2)}. ${r.ref.padEnd(20)} ${r.kind === 'mat' ? 'MAT' : 'TMUA'}  `
      + `q:${path.basename(q.file)}${q.crop ? ' (cropped)' : ''}  a:${a ? path.basename(a.file) + (a.crop ? ' (cropped)' : '') : 'NO MARK SCHEME'}`);
  }

  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    slug, title, generated: new Date().toISOString(), seed, filter, size,
    count: ordered.length, questions: manifest,
    hand_written_answers: noScheme.map((x) => ({ n: x.n, ref: x.r.ref })),
  }, null, 2));

  WRITTEN_DIR = path.join(dir, 'written');
  fs.mkdirSync(WRITTEN_DIR, { recursive: true });
  const paper = compile(dir, 'paper.tex', paperTex(title, manifest, ordered));
  const answers = compile(dir, 'answers.tex', answersTex(title, manifest, ordered, noScheme));

  const out = [];
  for (const [src, base] of [[paper, `${title}.pdf`], [answers, `${title} Answers.pdf`]]) {
    for (const dst of [path.join(DOWNLOADS, base), path.join(BACKLOG_PAPER_DIR, base)]) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      out.push(dst);
    }
  }
  console.log('\nplaced:');
  for (const p of out) console.log(`  ${p}`);
  if (noScheme.length) {
    console.log(`\n${noScheme.length} question(s) have no published mark scheme and carry a written answer:`);
    for (const x of noScheme) console.log(`  Q${x.n} — ${x.r.ref}`);
  }
}

/** Render one question (or its solution) and crop it to itself where it shares a page. */
function cut(r, which, dst) {
  const pdf = which === 'qp' ? r.qp : r.ms;
  const page = which === 'qp' ? r.qp_page : r.ms_page;
  const marker = which === 'qp' ? r.marker : (r.msMarker ?? r.marker);
  const next = which === 'qp' ? r.nextMarker : (r.msNextMarker ?? r.nextMarker);
  const png = renderPage(pdf, page);
  const crop = sliceFor(pdf, page, marker, next);
  if (crop) cropVertical(png, dst, crop); else fs.copyFileSync(png, dst);
  return { file: path.relative(path.dirname(path.dirname(dst)), dst), crop, pdf, page };
}

const PREAMBLE = (head) => [
  '\\documentclass[11pt,a4paper]{article}',
  '\\usepackage[margin=1.5cm]{geometry}\\usepackage{graphicx}\\usepackage{xcolor}',
  '\\usepackage{fancyhdr}\\usepackage[T1]{fontenc}\\usepackage{lmodern}\\usepackage{amsmath,amssymb}',
  '\\usepackage{enumitem}\\usepackage{mdframed}',
  '\\definecolor{accent}{HTML}{9A3412}\\definecolor{rule}{HTML}{C9C2B6}\\definecolor{soft}{HTML}{F5F2ED}',
  '\\newmdenv[linecolor=rule,linewidth=0.6pt,backgroundcolor=soft,innertopmargin=6pt,',
  'innerbottommargin=6pt,innerleftmargin=8pt,innerrightmargin=8pt]{keybox}',
  `\\pagestyle{fancy}\\fancyhf{}\\lhead{\\small ${head}}\\rhead{\\small\\thepage}`,
  '\\renewcommand{\\headrulewidth}{0.4pt}\\setlength{\\parindent}{0pt}',
].join('\n');

function paperTex(title, manifest, rows) {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const t = [PREAMBLE(`${esc(title)} --- backlog paper`), '\\begin{document}',
    '\\thispagestyle{empty}\\vspace*{3cm}\\begin{center}',
    `{\\LARGE\\bfseries ${esc(title)}}\\\\[6pt]{\\large a backlog paper}\\\\[16pt]`,
    `{\\small ${manifest.length} questions you have already got wrong and have not yet re-earned,`,
    'taken from the open backlog and printed exactly as they appear on their own papers.\\\\',
    'They are deliberately \\textbf{not} grouped by topic or by source --- you do not get that\\\\',
    'help in the exam, and knowing a question is "a logic one" is most of the work.\\\\[8pt]',
    'Answers are in the companion document. Sit this first.\\\\[10pt]',
    `Compiled ${date}}`,
    '\\end{center}\\vfill',
    '\\begin{center}\\begin{minipage}{0.8\\textwidth}\\begin{keybox}',
    '\\textbf{How to use it.} Time yourself at the real rate --- 75 minutes for 20 questions is',
    '3 minutes 45 each. Mark it before you look at anything. A question you get right here is',
    'not cleared until you can say \\emph{why} the method works, because you have already',
    'seen every one of these once.',
    '\\end{keybox}\\end{minipage}\\end{center}',
    '\\newpage'];
  for (const m of manifest) {
    t.push(`\\begin{center}{\\small\\color{accent}\\textbf{Question ${m.n}}}\\end{center}\\vspace{2mm}`,
      `\\begin{center}\\includegraphics[width=\\textwidth,height=0.86\\textheight,keepaspectratio]{${m.q.file}}\\end{center}`,
      '\\newpage');
  }
  t.push('\\end{document}');
  return t.join('\n');
}

function answersTex(title, manifest, rows, noScheme) {
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const byN = new Map(rows.map((r, i) => [i + 1, r]));
  const t = [PREAMBLE(`${esc(title)} --- answers`), '\\begin{document}',
    '\\thispagestyle{empty}\\vspace*{3cm}\\begin{center}',
    `{\\LARGE\\bfseries ${esc(title)}}\\\\[6pt]{\\large answers}\\\\[16pt]`,
    `{\\small Worked solutions for all ${manifest.length} questions, in the same order as the paper.\\\\`,
    'Each is the published mark scheme page for that question, cropped to it.\\\\',
    (noScheme.length
      ? `${noScheme.length} question${noScheme.length === 1 ? '' : 's'} come${noScheme.length === 1 ? 's' : ''} from a paper that publishes no mark scheme;\\\\`
        + ' those carry a written answer, clearly marked as such.\\\\'
      : ''),
    `[10pt]Compiled ${date}}`,
    '\\end{center}\\newpage',
    '\\section*{\\color{accent}Where each question came from}',
    '\\begin{center}\\small\\begin{tabular}{rlllc}',
    '\\textbf{Q} & \\textbf{Source} & \\textbf{Topic} & \\textbf{Why it is in the backlog} & \\textbf{Scheme}\\\\\\hline'];
  for (const m of manifest) {
    t.push(`${m.n} & ${esc(m.ref)} & ${esc(String(m.topic ?? '').replace(/_/g, ' '))} & `
      + `${esc(({ didnt_know: 'did not know it', slipped: 'slipped', timing: 'too slow' })[m.bucket] ?? m.bucket)} & `
      + `${m.a ? 'published' : 'written'}\\\\`);
  }
  t.push('\\end{tabular}\\end{center}\\newpage');
  for (const m of manifest) {
    const r = byN.get(m.n);
    t.push(`\\begin{center}{\\small\\color{accent}\\textbf{Question ${m.n} --- ${esc(m.ref)}}}\\end{center}\\vspace{2mm}`);
    if (m.a) {
      t.push(`\\begin{center}\\includegraphics[width=\\textwidth,height=0.84\\textheight,keepaspectratio]{${m.a.file}}\\end{center}`);
    } else {
      // A paper with no published scheme gets an answer written by hand, kept in
      // written/<ref>.tex so a rebuild does not throw it away. Without that the answer
      // would have to be re-written every time the paper is regenerated, which is exactly
      // how it would end up not being written at all.
      t.push('\\begin{keybox}\\textbf{No published mark scheme.} '
        + `${esc(r.ref.replace(/\\s*Q\\s*\\d+$/, ''))} ships none, so the answer below is worked out here `
        + 'rather than quoted. Check it against your own working before you trust it.\\end{keybox}',
        '\\vspace{3mm}');
      const hand = writtenAnswer(r);
      t.push(hand ?? `\\textbf{\\color{accent}This answer has not been written yet.} Add it to `
        + `\\texttt{written/${esc(safeRef(r.ref))}.tex} and rebuild.`);
      if (r.detail) t.push('\\vspace{4mm}', `\\textbf{Your note at the time.} \\emph{${esc(r.detail)}}`);
    }
    t.push('\\newpage');
  }
  t.push('\\end{document}');
  return t.join('\n');
}

/** A hand-written answer for a question whose paper publishes no mark scheme. */
const safeRef = (ref) => String(ref).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
let WRITTEN_DIR = null;
function writtenAnswer(r) {
  if (!WRITTEN_DIR) return null;
  const f = path.join(WRITTEN_DIR, `${safeRef(r.ref)}.tex`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function compile(dir, name, source) {
  fs.writeFileSync(path.join(dir, name), source);
  for (let i = 0; i < 2; i++) {
    execFileSync('pdflatex', ['-interaction=nonstopmode', name], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  const pdf = path.join(dir, name.replace(/\.tex$/, '.pdf'));
  if (!fs.existsSync(pdf)) throw new Error(`pdflatex produced nothing for ${name}`);
  return pdf;
}

const [cmd, slug] = argv.slice(2);
if (cmd === 'build' && slug) build(slug);
else {
  console.log('usage: node scripts/backlog-paper.mjs build <slug> [--topic a,b] [--type c] [--technique d]');
  console.log('       [--trap e] [--logic] [--include-exam MAT] [--size 20] [--seed 1] [--title "Name"]');
  process.exit(1);
}

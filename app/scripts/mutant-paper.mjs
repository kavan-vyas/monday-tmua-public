// Build a mutant paper: the mechanical half of the process described in MUTANT_PAPERS.md.
//
//   node scripts/mutant-paper.mjs brief counting --topic combinatorics \
//        --technique counting_by_cases,complement_counting,binomial_expansion
//        → tutor_data/mutant/counting/{brief.md,brief.json,questions.json,paper.tex}
//
//   node scripts/mutant-paper.mjs build counting
//        → compiles paper.tex, renders the companion from questions.json, and copies BOTH
//          PDFs to ~/Downloads and to "major exams/tmua/mutant papers"
//
// `brief` gathers evidence and stops. It does not write prose, because the whole value of
// these documents is the sentence naming what he actually did wrong, and that comes out of
// his own notes rather than out of a template. `build` does everything after the writing.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { candidates, satPapers, renderPage, cropVertical, place, WORK_DIR, MUTANT_DIR } from '../server/mutant.js';

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const flag = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(APP, 'templates', 'mutant-paper.tex');

function brief(slug) {
  const filters = {
    topics: list(flag('topic')),
    techniques: list(flag('technique')),
    traps: list(flag('trap')),
    all: process.argv.includes('--all'),
  };
  if (!filters.topics.length && !filters.techniques.length && !filters.traps.length) {
    console.error('give at least one of --topic / --technique / --trap');
    process.exit(1);
  }
  const rows = candidates(filters);
  const dir = path.join(WORK_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify({
    slug, generated: new Date().toISOString(), filters,
    sat_papers: [...satPapers()].sort(),
    count: rows.length, questions: rows,
  }, null, 2));

  // The readable version: this is what actually gets used when writing the analysis.
  const md = [`# Mutant paper brief — ${slug}`, '',
    `Filters: ${JSON.stringify(filters)}`,
    `Candidates: **${rows.length}**, from sat papers only.`, '',
    '| weight | status | question | d | answer | backlog | his note |',
    '|---|---|---|---|---|---|---|'];
  for (const q of rows) {
    md.push(`| ${q.weight} | ${q.status} | ${q.qid} | ${q.difficulty ?? '—'} | ${q.answer ?? '—'} | `
      + `${q.backlog ? `${q.backlog.bucket} t${q.backlog.tier}` : '—'} | ${(q.his_note ?? '').replace(/\|/g, '/').slice(0, 160)} |`);
  }
  md.push('', '## Detail', '');
  for (const q of rows) {
    md.push(`### ${q.qid} — ${q.status}${q.backlog ? ' (open in backlog)' : ''}`,
      `- index: \`${q.index_id}\` · difficulty ${q.difficulty} · answer **${q.answer ?? 'none published'}**`,
      `- topic: ${(q.topic ?? []).join(', ')}`,
      `- technique: ${(q.technique ?? []).join(', ')}`,
      `- trap: ${(q.trap_type ?? []).join(', ') || '—'}`,
      `- index description: ${q.description ?? '—'}`,
      q.his_note ? `- **his note:** ${q.his_note}` : '- his note: none',
      q.backlog ? `- **backlog:** ${q.backlog.bucket}, tier ${q.backlog.tier}, due ${q.backlog.due} — ${q.backlog.detail}` : '',
      `- question paper: \`${q.qp}\` page ${q.qp_page}`,
      q.ms ? `- mark scheme: \`${q.ms}\` page ${q.ms_page ?? '?'}` : '- mark scheme: none published for this paper',
      '');
  }
  fs.writeFileSync(path.join(dir, 'brief.md'), md.join('\n'));

  // A starting questions.json: the companion's page list, in brief order, whole pages.
  // Trim it by hand to the questions the analysis actually uses, and add a `crop` where a
  // page holds more than one question.
  if (!fs.existsSync(path.join(dir, 'questions.json'))) {
    fs.writeFileSync(path.join(dir, 'questions.json'), JSON.stringify({
      title: slug, questions: rows.filter((q) => q.qp && q.qp_page).map((q) => ({
        label: q.qid, pdf: q.qp, page: q.qp_page, crop: null,
      })),
    }, null, 2));
  }
  if (!fs.existsSync(path.join(dir, 'paper.tex')) && fs.existsSync(TEMPLATE)) {
    fs.copyFileSync(TEMPLATE, path.join(dir, 'paper.tex'));
  }

  console.log(`${rows.length} candidates → ${path.relative(process.cwd(), dir)}`);
  console.log(`  brief.md        read this, then write paper.tex`);
  console.log(`  questions.json  trim to the questions you used, then: mutant-paper.mjs build ${slug}`);
  const bad = rows.filter((q) => q.status === 'wrong' || q.status === 'open').length;
  console.log(`\n${bad} of ${rows.length} are wrong or still open — those lead the document.`);
}

/** Render the companion: one question per page, unmarked. */
function companion(dir, slug) {
  const spec = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'));
  const qs = spec.questions ?? [];
  if (!qs.length) throw new Error('questions.json lists no questions');
  const imgs = path.join(dir, 'companion');
  fs.rmSync(imgs, { recursive: true, force: true });
  fs.mkdirSync(imgs, { recursive: true });

  const rows = [];
  for (const [i, q] of qs.entries()) {
    const png = renderPage(q.pdf, q.page);
    const dst = path.join(imgs, `q${String(i + 1).padStart(2, '0')}.png`);
    if (q.crop) cropVertical(png, dst, q.crop); else fs.copyFileSync(png, dst);
    rows.push({ label: q.label, file: path.basename(dst) });
    console.log(`  ${String(i + 1).padStart(2)}. ${q.label}  ←  ${path.basename(q.pdf)} p${q.page}${q.crop ? ' (cropped)' : ''}`);
  }

  const title = spec.title ?? slug;
  const tex = [
    '\\documentclass[11pt,a4paper]{article}',
    '\\usepackage[margin=1.5cm]{geometry}\\usepackage{graphicx}\\usepackage{xcolor}',
    '\\usepackage{fancyhdr}\\usepackage[T1]{fontenc}\\usepackage{lmodern}',
    '\\definecolor{accent}{HTML}{9A3412}',
    `\\pagestyle{fancy}\\fancyhf{}\\lhead{\\small TMUA --- ${title}, as printed}\\rhead{\\small\\thepage}`,
    '\\renewcommand{\\headrulewidth}{0.4pt}\\setlength{\\parindent}{0pt}',
    '\\begin{document}',
    '\\thispagestyle{empty}\\vspace*{5cm}\\begin{center}',
    `{\\LARGE\\bfseries ${title}}\\\\[6pt]{\\large as printed}\\\\[18pt]`,
    `{\\small The ${qs.length} questions from the companion analysis, one per page,\\\\`,
    'exactly as they appear on the paper --- no annotations, no answers, nothing marked.\\\\',
    'Sit them cold, then read the other document.\\\\[10pt]',
    `Compiled ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}}`,
    '\\end{center}\\newpage',
  ];
  for (const r of rows) {
    tex.push(`\\begin{center}{\\small\\color{accent}\\textbf{${r.label.replace(/&/g, '\\&')}}}\\end{center}\\vspace{2mm}`,
      `\\begin{center}\\includegraphics[width=\\textwidth,height=0.86\\textheight,keepaspectratio]{${r.file}}\\end{center}`,
      '\\newpage');
  }
  tex.push('\\end{document}');
  fs.writeFileSync(path.join(imgs, 'companion.tex'), tex.join('\n'));
  latex(imgs, 'companion.tex');
  return { pdf: path.join(imgs, 'companion.pdf'), count: qs.length };
}

function latex(dir, file) {
  for (let i = 0; i < 2; i++) {
    execFileSync('pdflatex', ['-interaction=nonstopmode', file], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  }
  const pdf = path.join(dir, file.replace(/\.tex$/, '.pdf'));
  if (!fs.existsSync(pdf)) throw new Error(`pdflatex produced nothing for ${file}`);
  return pdf;
}

function build(slug) {
  const dir = path.join(WORK_DIR, slug);
  if (!fs.existsSync(dir)) { console.error(`no brief for "${slug}" — run: mutant-paper.mjs brief ${slug} --topic …`); process.exit(1); }
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'));
  const name = meta.output_name ?? `TMUA ${meta.title ?? slug}`;

  console.log('companion:');
  const comp = companion(dir, slug);

  console.log('\nanalysis:');
  const analysis = latex(dir, 'paper.tex');
  console.log(`  paper.tex → ${path.basename(analysis)}`);

  // Both documents, both destinations, always. A mutant paper that only reached Downloads
  // is lost the next time he clears them; one that only reached the collection he never sees.
  const out = [];
  const staged = [[analysis, `${name} Misconceptions.pdf`], [comp.pdf, `${name} Questions (as printed).pdf`]];
  for (const [src, base] of staged) {
    const tmp = path.join(dir, base);
    fs.copyFileSync(src, tmp);
    out.push(...place(tmp));
    fs.rmSync(tmp, { force: true });
  }
  // The source stays with the collection, the way the earlier ones did.
  fs.copyFileSync(path.join(dir, 'paper.tex'), path.join(MUTANT_DIR, `${name} Misconceptions.tex`));

  console.log('\nplaced:');
  for (const p of out) console.log(`  ${p}`);
  console.log(`\n${comp.count} questions. Check the companion page count is ${comp.count + 1} (title page + one each).`);
}

const [cmd, slug] = process.argv.slice(2);
if (cmd === 'brief' && slug) brief(slug);
else if (cmd === 'build' && slug) build(slug);
else {
  console.log('usage:');
  console.log('  node scripts/mutant-paper.mjs brief <slug> --topic a,b [--technique c,d] [--trap e] [--all]');
  console.log('    groups are OR-ed by default (any signal); --all requires every group to match');
  console.log('  node scripts/mutant-paper.mjs build <slug>');
  process.exit(1);
}

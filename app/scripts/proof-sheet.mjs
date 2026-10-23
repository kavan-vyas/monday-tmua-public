// Side-by-side proof sheet: every transcribed question rendered next to the PDF page it
// came from. The automated checker (check-questions.mjs) can prove that LaTeX compiles
// and that option letters match, but it cannot prove that an expression MEANS what the
// page means — only a human eye can. This makes that pass take five minutes per paper
// instead of an hour.
//
//   node scripts/proof-sheet.mjs jz_a_p1     # writes + prints the path, then `open` it
//   node scripts/proof-sheet.mjs             # every transcribed paper
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import katex from 'katex';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(APP, '..');
const QDIR = path.join(ROOT, 'tutor_data', 'exams', 'questions');
const OUT = path.join(os.tmpdir(), 'jz-proof');

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Escape the PROSE only, and hand the maths to KaTeX raw. Escaping the whole string first
// turns every `x < 3` inside an inequality into `x &lt; 3`, which KaTeX rejects — the
// transcription is fine and the proof sheet is what is broken. Same tokenizer as the app's
// own renderer (web/src/exam/Tex.jsx), for the same reason.
function body(src) {
  const s = String(src ?? '');
  let out = '';
  let last = 0;
  const re = /\$\$([\s\S]+?)\$\$|\$([^$]+)\$/g;
  let m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    const texSrc = m[1] ?? m[2];
    try { out += katex.renderToString(texSrc, { displayMode: Boolean(m[1]), throwOnError: true }); }
    catch (e) { out += `<span class="bad">LaTeX error: ${esc(String(e.message).slice(0, 120))}</span>`; }
    last = m.index + m[0].length;
  }
  return (out + esc(s.slice(last))).replace(/\n/g, '<br>');
}

function sheet(paperId) {
  const doc = JSON.parse(fs.readFileSync(path.join(QDIR, `${paperId}.json`), 'utf8'));
  const imgDir = path.join(OUT, paperId);
  fs.mkdirSync(imgDir, { recursive: true });

  const rows = doc.questions.map((q) => {
    const png = path.join(imgDir, `p-${String(q.pdf_page).padStart(2, '0')}.png`);
    if (!fs.existsSync(png)) {
      execFileSync('/opt/homebrew/bin/pdftoppm',
        ['-f', String(q.pdf_page), '-l', String(q.pdf_page), '-r', '110', '-png', doc.pdf, path.join(imgDir, 'p')]);
    }
    const opts = q.options.map((o) =>
      `<li><b>${o.letter}</b> ${body(o.latex)}</li>`).join('');
    const fig = q.figure ? `<div class="fig">figure: ${esc(q.figure.file)}</div>` : '';
    return `<section>
  <h2>Q${q.qnum} <small>${esc(q.cid)} · page ${q.pdf_page} · ${q.options.length} options</small></h2>
  <div class="pair">
    <div class="mine"><div class="stem">${body(q.stem)}</div>
      ${q.display ? `<div class="disp">${body(q.display)}</div>` : ''}${fig}
      <ol class="opts">${opts}</ol></div>
    <div class="theirs"><img src="${path.relative(OUT, png)}" alt="page ${q.pdf_page}"></div>
  </div>
</section>`;
  }).join('\n');

  const html = `<!doctype html><meta charset="utf-8"><title>${paperId} proof sheet</title>
<link rel="stylesheet" href="katex.min.css">
<style>
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;background:#f6f6f6;color:#111}
 h1{font-size:20px} section{background:#fff;border:1px solid #ddd;border-radius:6px;margin:0 0 20px;padding:16px}
 h2{font-size:15px;margin:0 0 12px} h2 small{font-weight:400;color:#777}
 .pair{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start}
 .stem{margin-bottom:10px} .disp{text-align:center;margin:14px 0}
 .opts{list-style:none;padding:0;margin:14px 0 0} .opts li{padding:3px 0}
 .opts b{display:inline-block;width:1.6em;color:#777}
 .theirs img{width:100%;border:1px solid #eee}
 .bad{background:#ffe0e0;color:#a00;padding:1px 4px;border-radius:3px}
 .fig{font:12px ui-monospace,monospace;color:#a60;margin-top:8px}
</style>
<h1>${paperId} — ${doc.questions.length} questions · left: what the app will show · right: the PDF page</h1>
${rows}`;

  fs.copyFileSync(path.join(APP, 'node_modules', 'katex', 'dist', 'katex.min.css'), path.join(OUT, 'katex.min.css'));
  const fontsSrc = path.join(APP, 'node_modules', 'katex', 'dist', 'fonts');
  const fontsDst = path.join(OUT, 'fonts');
  if (!fs.existsSync(fontsDst)) fs.cpSync(fontsSrc, fontsDst, { recursive: true });

  const file = path.join(OUT, `${paperId}.html`);
  fs.writeFileSync(file, html);
  return file;
}

const only = process.argv[2];
const ids = fs.readdirSync(QDIR).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
  .filter((id) => !only || id === only).sort();
for (const id of ids) console.log(sheet(id));

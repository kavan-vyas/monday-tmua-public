// Export a paper as a PDF with the student's own annotations burned into the pages.
//
// The app draws marks live over a pdf.js canvas and stores them in PDF user space, which is
// the only coordinate system that survives zooming and re-rendering. Nothing until now could
// take those marks OFF the screen: the annotated paper existed only inside the app.
//
// This renders every page, draws the marks on top, and leaves a directory of page images
// for a document builder to assemble.
//
//   node scripts/export-marked-paper.mjs <annotation-key> <out-dir> [--dpi 150]
//
// The annotation key is the file name in tutor_data/annotations without .json, e.g.
// tmua__2017__p2.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TUTOR_DATA } from '../server/paths.js';

const ANN = path.join(TUTOR_DATA, 'annotations');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/**
 * Marks as the page sees them: pixel coordinates at the chosen dpi.
 *
 * Two conversions. pdf.js hands back PDF user space, whose origin is the BOTTOM left, while
 * an image counts from the top — so y flips against the page height. And the page height
 * itself comes from the annotation file rather than the render, because that is the height
 * the marks were made against; trusting the render instead puts every stroke in the wrong
 * place on any page of a different size.
 */
export function toPixels(mark, pageHeightPt, scale) {
  const pts = Array.isArray(mark.paths) ? mark.paths : [];
  return pts
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map(([x, y]) => [x * scale, (pageHeightPt - y) * scale]);
}

const PY = `
import sys, json
from PIL import Image, ImageDraw

src, dst, payload = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
im = Image.open(src).convert('RGB')
overlay = Image.new('RGBA', im.size, (0, 0, 0, 0))
d = ImageDraw.Draw(overlay)

for mark in payload['marks']:
    pts = [tuple(p) for p in mark['points']]
    # JSON has no tuples and PIL will not take a list as a colour.
    mark['rgba'] = tuple(mark['rgba'])
    if len(pts) < 2:
        # A dot: a single tap still means something, so it is drawn rather than dropped.
        if pts:
            x, y = pts[0]
            r = mark['width']
            d.ellipse([x - r, y - r, x + r, y + r], fill=mark['rgba'])
        continue
    if mark['kind'] == 'highlight':
        d.line(pts, fill=mark['rgba'], width=mark['width'], joint='curve')
    else:
        d.line(pts, fill=mark['rgba'], width=mark['width'], joint='curve')
        if mark['kind'] == 'arrow':
            (x0, y0), (x1, y1) = pts[-2], pts[-1]
            import math
            ang = math.atan2(y1 - y0, x1 - x0)
            L = max(10, mark['width'] * 4)
            for s in (2.6, -2.6):
                d.line([(x1, y1), (x1 - L * math.cos(ang + s * 0.45), y1 - L * math.sin(ang + s * 0.45))],
                       fill=mark['rgba'], width=mark['width'])

im = Image.alpha_composite(im.convert('RGBA'), overlay).convert('RGB')
im.save(dst)
print(json.dumps({"ok": True, "marks": len(payload['marks'])}))
`;

const hexToRgba = (hex, alpha) => {
  const h = String(hex ?? '#1b6ef3').replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(n.slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, alpha];
};

export function exportMarkedPaper(key, outDir, { dpi = 150 } = {}) {
  const doc = readJson(path.join(ANN, `${key}.json`));
  const pdf = doc.source_path;
  if (!fs.existsSync(pdf)) throw new Error(`the annotated paper is missing: ${pdf}`);
  fs.mkdirSync(outDir, { recursive: true });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'marked-'));
  try {
    execFileSync('pdftoppm', ['-r', String(dpi), '-png', pdf, path.join(tmp, 'pg')],
      { stdio: ['ignore', 'ignore', 'ignore'], maxBuffer: 1 << 28 });
    const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.png')).sort();
    const scale = dpi / 72;
    const out = [];

    for (const [i, f] of files.entries()) {
      const pageNo = i + 1;
      const marks = doc.pages?.[String(pageNo)] ?? [];
      const dst = path.join(outDir, `page-${String(pageNo).padStart(3, '0')}.png`);
      if (!marks.length) {
        fs.copyFileSync(path.join(tmp, f), dst);
        out.push({ page: pageNo, marks: 0, file: dst });
        continue;
      }
      const heightPt = (doc.page_sizes?.[String(pageNo)] ?? [595.22, 842])[1];
      const payload = {
        marks: marks.map((m) => ({
          kind: m.type ?? 'ink',
          points: toPixels(m, heightPt, scale),
          rgba: hexToRgba(m.color, m.type === 'highlight' ? 90 : 255),
          width: Math.max(2, Math.round((m.type === 'highlight' ? 10 : 2.2) * scale)),
        })),
      };
      execFileSync('python3', ['-c', PY, path.join(tmp, f), dst, JSON.stringify(payload)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      out.push({ page: pageNo, marks: marks.length, file: dst });
    }
    return { key, pdf, pages: out, marked: out.filter((p) => p.marks > 0).map((p) => p.page) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [key, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!key || !outDir) {
    console.error('usage: node scripts/export-marked-paper.mjs <annotation-key> <out-dir> [--dpi N]');
    process.exit(1);
  }
  const dpiArg = process.argv.indexOf('--dpi');
  const res = exportMarkedPaper(key, outDir, { dpi: dpiArg > -1 ? Number(process.argv[dpiArg + 1]) : 150 });
  console.log(`${res.pages.length} pages from ${path.basename(res.pdf)}`);
  console.log(`marks drawn on page(s): ${res.marked.join(', ') || 'none'}`);
}

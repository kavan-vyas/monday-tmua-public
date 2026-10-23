// Crop the diagram out of a full-page render.
//
// The transcription pass saved whole PDF pages as "figures", which would have shown the
// question text and every option a second time underneath the transcribed stem. What the
// exam screen actually wants is the drawn region alone.
//
// The heuristic: threshold hard enough to ignore JZ's light-grey diagonal watermark, group
// the inked rows into bands, and take the tallest band. Body text at 200 dpi makes bands
// about 30-45px tall; a diagram is several hundred. Originals are kept as *.full.png so a
// bad crop is always recoverable.
//
//   node scripts/crop-figures.mjs            # crop anything not yet cropped
//   node scripts/crop-figures.mjs --force    # redo them all from the kept originals
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIGS = path.join(ROOT, 'tutor_data', 'exams', 'figures');
const force = process.argv.includes('--force');

const PY = `
import sys, json
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('L')
w, h = im.size
px = im.load()

INK = 150            # the watermark sits around 200; real strokes are far darker
GAP = 18             # blank rows that separate one band from the next
PAD = 28

rows = []
for y in range(h):
    n = 0
    for x in range(0, w, 2):        # every other column is plenty and twice as fast
        if px[x, y] < INK:
            n += 1
            if n > 2: break
    rows.append(n > 2)

bands, start, blank = [], None, 0
for y, inked in enumerate(rows):
    if inked:
        if start is None: start = y
        blank = 0
    elif start is not None:
        blank += 1
        if blank >= GAP:
            bands.append((start, y - blank))
            start, blank = None, 0
if start is not None: bands.append((start, h - 1))

if not bands:
    print(json.dumps({"ok": False, "why": "no ink found"})); sys.exit()

top, bottom = max(bands, key=lambda b: b[1] - b[0])
height = bottom - top

# Horizontal extent of the ink inside that band only.
left, right = w, 0
for y in range(top, bottom + 1):
    for x in range(w):
        if px[x, y] < INK:
            if x < left: left = x
            if x > right: right = x

box = (max(0, left - PAD), max(0, top - PAD), min(w, right + PAD), min(h, bottom + PAD))
Image.open(src).crop(box).save(dst)
print(json.dumps({"ok": True, "band_h": height, "bands": len(bands), "box": list(box), "page": [w, h]}))
`;

const PY_EXACT = `
import sys, json
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
box = tuple(json.loads(sys.argv[3]))
im = Image.open(src)
im.crop(box).save(dst)
print(json.dumps({"ok": True, "box": list(box), "page": list(im.size)}))
`;

/**
 * Crop boxes written down in the transcription, as `figure.crop` = [x0, y0, x1, y1] at the
 * render's own resolution. The band heuristic was tuned on JZ pages and fails on any paper
 * whose figure is not the tallest inked thing on it — Chen's four-panel graph question
 * (two bands, not one), a small Wordle grid under a full paragraph, a question whose
 * emoji-as-variables run through the prose. Where a box is declared it wins outright; the
 * heuristic still handles everything that declares none.
 */
function declaredCrops() {
  const QDIR = path.join(ROOT, 'tutor_data', 'exams', 'questions');
  const out = new Map();
  if (!fs.existsSync(QDIR)) return out;
  for (const f of fs.readdirSync(QDIR).filter((x) => x.endsWith('.json'))) {
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(QDIR, f), 'utf8')); } catch { continue; }
    for (const q of doc.questions ?? []) {
      const fig = q.figure;
      if (fig?.file && Array.isArray(fig.crop) && fig.crop.length === 4) out.set(fig.file, fig.crop);
    }
  }
  return out;
}

const crops = declaredCrops();
const files = fs.readdirSync(FIGS).filter((f) => f.endsWith('.png') && !f.endsWith('.full.png'));
for (const f of files) {
  const cur = path.join(FIGS, f);
  const full = path.join(FIGS, f.replace(/\.png$/, '.full.png'));
  if (!fs.existsSync(full)) fs.copyFileSync(cur, full);
  else if (!force) { console.log(`skip ${f} — already cropped`); continue; }

  const box = crops.get(f);
  const out = box
    ? execFileSync('python3', ['-c', PY_EXACT, full, cur, JSON.stringify(box)], { encoding: 'utf8' })
    : execFileSync('python3', ['-c', PY, full, cur], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  if (!r.ok) { console.log(`FAIL ${f} — ${r.why}`); continue; }
  const [x0, y0, x1, y1] = r.box;
  const how = box ? 'declared crop' : `tallest of ${r.bands} bands`;
  console.log(`ok   ${f}  ${x1 - x0}x${y1 - y0}  (${how} on a ${r.page[0]}x${r.page[1]} page)`);
}

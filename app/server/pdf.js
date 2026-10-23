import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const execFileP = promisify(execFile);
const CACHE = path.join(os.tmpdir(), 'tmua-pdf-cache');

// Launched from Finder/launchd the process PATH is only /usr/bin:/bin:/usr/sbin:/sbin,
// so bare 'pdftoppm'/'pdfinfo' fail with ENOENT. Resolve poppler binaries ourselves.
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];
const binCache = new Map();

export async function poppler(name) {
  if (binCache.has(name)) return binCache.get(name);
  for (const dir of BIN_DIRS) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      binCache.set(name, candidate);
      return candidate;
    } catch {}
  }
  throw new Error(
    `${name} not found — install poppler (brew install poppler). Looked in: ${BIN_DIRS.join(', ')}`
  );
}

function cacheKey(pdfPath, page, dpi) {
  return crypto.createHash('md5').update(`${pdfPath}|${page}|${dpi}`).digest('hex');
}

// Rasterize one PDF page to PNG, cached. Returns absolute path to the PNG.
export async function rasterizeToFile(pdfPath, page, dpi = 150) {
  await fs.mkdir(CACHE, { recursive: true });
  const key = cacheKey(pdfPath, page, dpi);
  const out = path.join(CACHE, `${key}.png`);
  try {
    await fs.access(out);
    return out;
  } catch {}
  const prefix = path.join(CACHE, key);
  await execFileP(await poppler('pdftoppm'), ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', pdfPath, prefix]);
  // pdftoppm pads the page suffix based on total page count — find whatever it produced
  const produced = (await fs.readdir(CACHE)).find(
    (n) => n.startsWith(`${key}-`) && n.endsWith('.png')
  );
  if (!produced) throw new Error(`pdftoppm produced no output for ${pdfPath} p${page}`);
  await fs.rename(path.join(CACHE, produced), out);
  return out;
}

export async function rasterizeBase64(pdfPath, page, dpi = 120) {
  const file = await rasterizeToFile(pdfPath, page, dpi);
  return (await fs.readFile(file)).toString('base64');
}

// Locate which page of a PDF contains some text. Cheap (text, not rasterised images),
// so the tutor can find the exact question / mark-scheme page instead of guessing a
// page number or answering from memory.
export async function searchPdf(pdfPath, query, max = 8) {
  const bin = await poppler('pdftotext');
  const { stdout } = await execFileP(bin, ['-layout', pdfPath, '-'], { maxBuffer: 64 * 1024 * 1024 });
  const pages = stdout.split('\f');
  const needle = String(query).toLowerCase();
  const hits = [];
  for (let i = 0; i < pages.length && hits.length < max; i++) {
    const idx = pages[i].toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    hits.push({
      page: i + 1,
      snippet: pages[i].slice(Math.max(0, idx - 140), idx + 260).replace(/\s+/g, ' ').trim(),
    });
  }
  return { total_pages: pages.length, hits };
}

// Raw text of a PDF, one entry per page. Used by the ingest audit to judge whether a
// paper's text layer is usable or whether every page will need rasterising.
export async function extractPages(pdfPath, { first, last } = {}) {
  const args = ['-layout'];
  if (first) args.push('-f', String(first));
  if (last) args.push('-l', String(last));
  args.push(pdfPath, '-');
  const { stdout } = await execFileP(await poppler('pdftotext'), args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\f').filter((_, i, a) => i < a.length - 1 || a[i].trim());
}

export async function pageCount(pdfPath) {
  const { stdout } = await execFileP(await poppler('pdfinfo'), [pdfPath]);
  const m = stdout.match(/^Pages:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

#!/usr/bin/env node
// voice:doctor — one command that answers "is voice broken, and if so where".
// Read-only. Checks the whole chain the worker depends on and prints a line per check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GREEN = '\x1b[32m'; const RED = '\x1b[31m'; const YEL = '\x1b[33m'; const DIM = '\x1b[2m'; const R = '\x1b[0m';
let bad = 0; let warn = 0;
const ok = (m, d = '') => console.log(`${GREEN}✓${R} ${m}${d ? ` ${DIM}${d}${R}` : ''}`);
const err = (m, d = '') => { bad++; console.log(`${RED}✗${R} ${m}${d ? ` ${DIM}${d}${R}` : ''}`); };
const wrn = (m, d = '') => { warn++; console.log(`${YEL}!${R} ${m}${d ? ` ${DIM}${d}${R}` : ''}`); };

// 1. Interpreter: venv preferred, else system python3.
const venvPy = path.join(HERE, '.venv', 'bin', 'python3');
const venvReady = fs.existsSync(venvPy) && fs.existsSync(path.join(HERE, '.venv', '.ready'));
let PY = process.env.MONDAY_PYTHON || (venvReady ? venvPy : 'python3');
if (venvReady) ok('pinned venv present', venvPy);
else if (fs.existsSync(venvPy)) wrn('venv exists but not marked ready — using system python3 (re-run `npm run voice:setup`)', 'incomplete install');
else wrn('no venv — using system python3 (run `npm run voice:setup` to pin)', PY);

let pyVer = '';
try { pyVer = execFileSync(PY, ['--version'], { encoding: 'utf8' }).trim(); ok('interpreter runs', pyVer); }
catch (e) { err('interpreter missing', `${PY}: ${e.message}`); }

// 2. Python imports + versions, checked in the chosen interpreter.
const REQ = { kokoro: '0.9.4', misaki: '0.9.4', torch: '2.11.0', soundfile: '0.14.0', numpy: '2.4.4', huggingface_hub: '1.12.2' };
if (pyVer) {
  const probe = `
import importlib.metadata as m, json
out={}
for p in ${JSON.stringify(Object.keys(REQ))}:
    try: out[p]=m.version(p)
    except Exception as e: out[p]=None
try:
    import torch; out['_mps']=bool(getattr(torch.backends,'mps',None) and torch.backends.mps.is_available())
except Exception: out['_mps']=False
print(json.dumps(out))`;
  try {
    const got = JSON.parse(execFileSync(PY, ['-c', probe], { encoding: 'utf8' }));
    for (const [p, want] of Object.entries(REQ)) {
      if (!got[p]) err(`python package missing: ${p}`);
      else if (got[p] !== want) wrn(`${p} ${got[p]}`, `pinned ${want}`);
      else ok(`${p} ${got[p]}`);
    }
    got._mps ? ok('torch MPS available') : wrn('torch MPS unavailable', 'voice will run on CPU (slower)');
  } catch (e) { err('could not probe python packages', e.message); }
}

// 3. ffmpeg (moods degrade to pace-only without it — a warning, not fatal).
const ffmpeg = '/opt/homebrew/bin/ffmpeg';
fs.existsSync(ffmpeg) ? ok('ffmpeg present', ffmpeg) : wrn('ffmpeg missing at ' + ffmpeg, 'moods collapse to pace-only');

// 4. Kokoro weights cached (offline boot depends on this).
const snaps = path.join(os.homedir(), '.cache', 'huggingface', 'hub', 'models--hexgrad--Kokoro-82M', 'snapshots');
(fs.existsSync(snaps) && fs.readdirSync(snaps).length)
  ? ok('Kokoro-82M weights cached', snaps)
  : err('Kokoro weights NOT cached', 'first run needs network — clear HF_HUB_OFFLINE for one fetch');

// 5. Monday voice tensor + hash (missing => silent fallback to bm_george + cache miss).
const pt = path.join(HERE, 'voices', 'monday.pt');
const meta = path.join(HERE, 'voices', 'monday.json');
if (fs.existsSync(pt)) {
  let hash = '?';
  try { hash = JSON.parse(fs.readFileSync(meta, 'utf8')).voice_hash ?? '?'; } catch { /* ignore */ }
  ok('Monday voice tensor present', `voice_hash ${hash}`);
} else err('voices/monday.pt missing', 'run `npm run voice:build` — voice falls back to bm_george');

// 6. Voice cache dir + size.
const cache = process.env.MONDAY_VOICE_CACHE || path.resolve(HERE, '..', '.voicecache');
if (fs.existsSync(cache)) {
  let mb = 0; try { for (const f of fs.readdirSync(cache)) if (f.endsWith('.wav')) mb += fs.statSync(path.join(cache, f)).size; } catch { /* ignore */ }
  ok('voice cache', `${(mb / 1e6).toFixed(0)}MB in ${cache}`);
} else wrn('no voice cache yet', 'first synthesis will be cold');

console.log('');
if (bad) console.log(`${RED}${bad} problem(s)${R}${warn ? `, ${warn} warning(s)` : ''} — voice will be degraded until fixed.`);
else if (warn) console.log(`${YEL}${warn} warning(s)${R}, but voice should work.`);
else console.log(`${GREEN}All green — voice is healthy.${R}`);
process.exit(bad ? 1 : 0);

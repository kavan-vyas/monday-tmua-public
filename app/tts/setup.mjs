#!/usr/bin/env node
// voice:setup — build the pinned, isolated Python env for the TTS worker, once.
// Idempotent: re-running upgrades to the pinned versions. voice.js auto-detects .venv.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENV = path.join(HERE, '.venv');
const PY = path.join(VENV, 'bin', 'python3');
const REQ = path.join(HERE, 'requirements.txt');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: HERE });

const base = process.env.MONDAY_SETUP_PYTHON || 'python3';
if (!fs.existsSync(PY)) {
  console.log(`[voice:setup] creating venv at ${VENV}`);
  run(base, ['-m', 'venv', VENV]);
} else {
  console.log(`[voice:setup] venv exists at ${VENV}`);
}
console.log('[voice:setup] upgrading pip');
run(PY, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q']);
console.log('[voice:setup] installing pinned requirements (torch is large — this can take a few minutes)');
// Remove any stale ready-marker first, so a failed/interrupted install never looks done.
try { fs.rmSync(path.join(VENV, '.ready'), { force: true }); } catch { /* ignore */ }
run(PY, ['-m', 'pip', 'install', '-r', REQ]);
// Only now, after pip succeeded, mark the venv usable. voice.js/doctor require this
// marker, so a half-built venv (interrupted download) is ignored, not used-and-broken.
fs.writeFileSync(path.join(VENV, '.ready'), new Date().toISOString() + '\n');
console.log('[voice:setup] done. Run `npm run voice:doctor` to verify, then restart the server.');

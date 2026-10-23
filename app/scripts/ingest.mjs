#!/usr/bin/env node
// Reproducible paper ingest.
//
//   npm run ingest -- "<paper.pdf>"              audit, register, classify, merge
//   npm run ingest -- "<paper.pdf>" --audit      audit only, writes nothing
//   npm run ingest -- "<paper.pdf>" --dry-run    show what would change
//   npm run ingest -- "<paper.pdf>" --no-classify
//   npm run ingest -- "<paper.pdf>" --force      re-classify even if the shard is complete
//   npm run ingest -- --all <dir>                audit every PDF under a directory
//
// Safe to re-run: the audit is read-only, manifest registration is idempotent, and
// classification refuses to overwrite a complete shard unless --force is given.
import fs from 'node:fs';
import path from 'node:path';
import { auditPaper, formatAudit, ingestPaper, plan, mergeIndexes } from '../server/ingest.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const targets = argv.filter((a) => !a.startsWith('--'));

if (!targets.length) {
  console.error('usage: npm run ingest -- "<paper.pdf>" [--audit] [--dry-run] [--no-classify] [--force]');
  console.error('       npm run ingest -- --all "<directory>"');
  process.exit(1);
}

function pdfsUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...pdfsUnder(p));
    else if (e.name.toLowerCase().endsWith('.pdf')) out.push(p);
  }
  return out;
}

const files = flag('--all') ? targets.flatMap((t) => (fs.statSync(t).isDirectory() ? pdfsUnder(t) : [t])) : targets;

let exitCode = 0;

if (flag('--audit') || flag('--all')) {
  // Read-only sweep. Only question papers are reported in full; companions are noise.
  const rows = [];
  for (const f of files) {
    const a = await auditPaper(f);
    if (a.ok && a.identified.kind !== 'paper') continue;
    rows.push(a);
    console.log(formatAudit(a));
    console.log();
  }
  const incomplete = rows.filter((a) => plan(a).length);
  const unsupported = incomplete.filter((a) => !a.unit);
  const actionable = incomplete.filter((a) => a.unit);
  console.log(`${rows.length} question paper(s) audited — ${actionable.length} need work, ${unsupported.length} unsupported/ambiguous, ${rows.length - incomplete.length} fully resourced.`);
  for (const a of actionable) console.log(`  TODO  ${path.basename(a.file)}: ${plan(a).join(', ')}`);
  if (unsupported.length) {
    const byFamily = {};
    for (const a of unsupported) (byFamily[a.identified.family ?? 'unidentified'] ??= []).push(path.basename(a.file));
    for (const [fam, list] of Object.entries(byFamily)) {
      console.log(`  SKIP  ${fam}: ${list.length} file(s) — ${plan(unsupported.find((a) => (a.identified.family ?? 'unidentified') === fam))[0]}`);
    }
  }
  process.exit(0);
}

for (const f of files) {
  console.log(`\n=== ingest ${path.basename(f)} ===`);
  const r = await ingestPaper(f, {
    classify: !flag('--no-classify'),
    dryRun: flag('--dry-run'),
    force: flag('--force'),
    onProgress: (t) => process.stdout.write(`  … ${t}\n`),
  });
  for (const s of r.steps) console.log(`\n[${s.ok ? 'ok' : 'FAIL'}] ${s.step}\n${s.detail}`);
  console.log(`\n=> ${r.done ? 'fully resourced' : 'still to do: ' + (plan(r.audit).join(', ') || 'see problems above')}`);
  if (!r.done) exitCode = 1;
}

if (!flag('--dry-run') && !flag('--no-classify')) {
  const m = await mergeIndexes({ strict: true });
  console.log(`\n=== final index validation ===\n${m.output.trim()}`);
  if (!m.ok) exitCode = 1;
}

process.exit(exitCode);

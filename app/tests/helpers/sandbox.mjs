// A disposable copy of the server modules pointed at a disposable tutor_data tree.
//
// WHY: paths.js hard-codes PROJECT_ROOT at the real repo, so importing mood.js or
// mondaymem.js directly reads — and, for mondayNote/proactive, WRITES — the student's live
// record. Nothing in this suite is allowed near that. So we copy app/server/*.js into
// a temp dir, rewrite that copy's paths.js to point at a temp fixture tree, and import
// from there. The modules under test are byte-identical apart from paths.js.
//
// All of B's modules import only node builtins (checked), so the copy needs no
// node_modules. index.js and session.js do; makeAppSandbox() symlinks them in.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const APP_DIR = path.resolve(HERE, '..', '..');
export const REPO_ROOT = path.resolve(APP_DIR, '..');
export const REAL_SERVER = path.join(APP_DIR, 'server');

const roots = [];

function tmpRoot(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `monday-test-${tag}-`));
  roots.push(dir);
  return dir;
}

/** Remove every sandbox this process created. Registered on exit as a backstop. */
export function cleanupSandboxes() {
  while (roots.length) {
    const d = roots.pop();
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
process.on('exit', cleanupSandboxes);

// ------------------------------------------------------------------ fixtures

export const FIXTURE_EXAM_DATE = '2026-10-01';

/** A believable but entirely synthetic student record. */
export function defaultTutorData(overrides = {}) {
  const day = 86400000;
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString().slice(0, 10);
  return {
    'memory/session_memory.json': {
      schema_version: 3,
      session_number: 14,
      exam_date: null,
      topic_stats: {
        algebra: { attempted: 20, correct: 17 },
        logs: { attempted: 10, correct: 5 },
        sequences: { attempted: 6, correct: 2 },
        trigonometry: { attempted: 12, correct: 9 },
      },
      questions_attempted: [
        { id: 'q1', topic: 'algebra', date: iso(1 * day), correct: true, difficulty: 2 },
        { id: 'q2', topic: 'logs', date: iso(30 * day), correct: false, difficulty: 3 },
        { id: 'q3', topic: 'sequences', date: iso(60 * day), correct: false, difficulty: 3 },
        { id: 'q4', topic: 'trigonometry', date: iso(2 * day), correct: true, difficulty: 2 },
      ],
      sessions: [{ date: iso(2 * day), minutes: 55 }],
      review_queue: [{ id: 'q2' }, { id: 'q3' }],
      misconceptions: [],
    },
    'activity_log.json': { entries: [] },
    'backlog.json': { items: [] },
    'file_manifest.json': { files: [] },
    'reference/mat_full_tag_index.json': { questions: [] },
    'reference/tmua_full_tag_index.json': {
      questions: [
        ...Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, topic: 'algebra' })),
        ...Array.from({ length: 20 }, (_, i) => ({ id: `l${i}`, topic: 'logs' })),
        ...Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, topic: 'sequences' })),
        ...Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, topic: 'trigonometry' })),
      ],
    },
    'monday/self_model.md': '# Monday\n\nI am the assistant that runs this tutor.\n',
    'monday/memory.json': {
      schema_version: 'monday-1',
      explanations: [], phrasings: [], observations: [], mood_history: [],
    },
    'monday/journal.md': '',
    'TMUA_Master_Prompt_v3.txt': 'MASTER PROMPT FIXTURE\nSection 7 phase timing rules.\n',
    ...overrides,
  };
}

function writeTree(root, tree) {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

// ------------------------------------------------------------------ sandbox

/**
 * Copy the server modules into a temp dir with paths.js repointed at a temp
 * tutor_data tree.
 *
 * @returns {{root, appDir, serverDir, tutorData, imp(name): Promise<module>, dispose()}}
 */
export function makeSandbox({ tutorData = defaultTutorData(), tag = 'srv', port = null, state = null } = {}) {
  const root = tmpRoot(tag);
  const appDir = path.join(root, 'app');
  const serverDir = path.join(appDir, 'server');
  const tutorDir = path.join(root, 'tutor_data');

  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(path.join(appDir, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ type: 'module' }));

  for (const f of fs.readdirSync(REAL_SERVER)) {
    if (!f.endsWith('.js')) continue;
    fs.copyFileSync(path.join(REAL_SERVER, f), path.join(serverDir, f));
  }
  // node_modules for the modules that need the SDK / ws / zod.
  try {
    fs.symlinkSync(path.join(APP_DIR, 'node_modules'), path.join(appDir, 'node_modules'), 'dir');
  } catch { /* already there */ }
  // tts, for voice.js's TTS_DIR resolution.
  try {
    fs.symlinkSync(path.join(APP_DIR, 'tts'), path.join(appDir, 'tts'), 'dir');
  } catch { /* ignore */ }
  // design/, for mood.js's `import { MOOD } from '../design/tokens.js'`. The copy above
  // takes server/*.js only, so any sibling directory a server module reaches into has to
  // be linked in as well or the import fails to resolve inside the sandbox.
  try {
    if (fs.existsSync(path.join(APP_DIR, 'design'))) {
      fs.symlinkSync(path.join(APP_DIR, 'design'), path.join(appDir, 'design'), 'dir');
    }
  } catch { /* ignore */ }

  // The ONLY edit to the copied source: repoint the roots.
  // index.js hard-codes `const PORT = 3941` with no env override, and the real app
  // owns that port. The copy's port line is rewritten so an e2e boot can use a spare
  // one. This is the only source edit besides paths.js, and it is one literal.
  if (port != null) {
    const idx = fs.readFileSync(path.join(REAL_SERVER, 'index.js'), 'utf8');
    const patched = idx.replace(/const PORT = \d+;/, `const PORT = ${port};`);
    if (patched === idx) throw new Error('sandbox: could not find the PORT literal in index.js');
    fs.writeFileSync(path.join(serverDir, 'index.js'), patched);
  }

  const paths = fs.readFileSync(path.join(REAL_SERVER, 'paths.js'), 'utf8')
    .replace(/export const PROJECT_ROOT = [^;]*;/, `export const PROJECT_ROOT = ${JSON.stringify(root)};`);
  if (!paths.includes(root)) throw new Error('sandbox: failed to repoint paths.js PROJECT_ROOT');
  fs.writeFileSync(path.join(serverDir, 'paths.js'), paths);

  writeTree(tutorDir, tutorData);
  fs.mkdirSync(path.join(tutorDir, 'inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(appDir, '.state.json'),
    JSON.stringify(state ?? { config: { model: 'sonnet', effort: 'high' } }, null, 2),
  );

  // Cache-bust so two sandboxes in one process do not share module state.
  const stamp = path.basename(root);
  const imp = (name) => import(`${pathToFileURL(path.join(serverDir, name)).href}?sbx=${stamp}`);

  return {
    root, appDir, serverDir, tutorData: tutorDir, imp,
    read(rel) { return fs.readFileSync(path.join(tutorDir, rel), 'utf8'); },
    readJson(rel) { return JSON.parse(this.read(rel)); },
    write(rel, content) {
      const abs = path.join(tutorDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    },
    stateFile: path.join(appDir, '.state.json'),
    dispose() { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} },
  };
}

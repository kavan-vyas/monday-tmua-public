import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { pending as papersPending } from './organise.js';
import { readDoc, saveDoc, applyPages, countMarks, fileForKey } from './annotations.js';
import { checkScope, redirectLine } from './scope.js';
import { createTutor } from './session.js';
import { rasterizeToFile, pageCount } from './pdf.js';
import { questionPage } from './qpage.js';
import { readQuestions as examQuestions, readAnswers as examAnswers, parsePaperId } from './exam.js';
import { pageFor as pageIndexFor, locate } from './pageindex.js';
import { paperRow as registryPaper } from './papers.js';
import { canonicalId } from './canonical.js';
import { getSchedule, safeConfig, writeConfig, readConfig as readCalendarConfig } from './calendar.js';
import {
  summary as backlogSummary, listItems as listBacklogItems,
  completeItem as completeBacklogItem, undoItem as undoBacklogItem, addNote as addBacklogNote, addTime as addBacklogTime,
  budgetFor as backlogBudgetFor, lastPace as backlogLastPace, paceStats as backlogPaceStats,
} from './backlog.js';
import { resolvePaths as resolveTagPaths, allQuestions as allTagQuestions } from './tagindex.js';
import { triage as triagePdf, summarise as summariseTriage } from './triage.js';
import { PROJECT_ROOT, TUTOR_DATA, INBOX, insideRoot, insideTutorData, PAPERS } from './paths.js';
import { buildDashboard } from './dashboard.js';
import { buildRecommendations } from './recommend.js';
import { triage, summarise } from './triage.js';
import { createProactive, DEFAULT_TOGGLES } from './proactive.js';
import { computeReadiness, resolveExamDate, resetReadinessCache } from './readiness.js';
import { MOOD_COLORS } from './mood.js';
import { MODES, MODE_BLURBS, modeGates } from './modes.js';
import { readMoodHistory } from './mondaymem.js';
import {
  startVoice, stopVoice, voiceStatus, lineText, speak,
  getVoiceOptions, voiceCacheStats, clearVoiceCache, voiceCacheDir,
} from './voice.js';
import { readExamDate, writeExamDate, SESSION_MEMORY } from './examdate.js';
import * as exam from './exam.js';
import * as paperflow from './paperflow.js';
import * as target85 from './target.js';
import { openExamWindow } from './examwindow.js';

const PORT = 3941;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'web', 'dist');

// ---------- persisted state ----------
// .state.json: { activeChatId, config, inboxSeen } — chats/<id>.json holds each
// conversation exactly (every recorded event) so nothing is ever lost.
const STATE_FILE = path.join(__dirname, '..', '.state.json');
const CHATS_DIR = path.join(__dirname, '..', 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });

const chatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const chatFile = (id) => path.join(CHATS_DIR, `${id}.json`);

let savedState = {};
try {
  savedState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {}

// .state.json migration (plangamma C4): `persona` is retired, and voice / proactive /
// examDate / mode gain defaults. Saved scalars win over the defaults; the nested
// objects merge UNDER them, so a switch the user has changed survives and a trigger
// added later still arrives with its default. Nothing is dropped except `persona`.
const savedCfg = { ...(savedState.config ?? {}) };
delete savedCfg.persona;
let state = {
  // Spread first so any key we do not model here survives the round trip
  // (plangamma C4: nothing is dropped except `persona`).
  ...savedState,
  activeChatId: savedState.activeChatId ?? null,
  config: {
    model: 'sonnet',
    effort: 'high',
    mode: 'DRILL',
    examDate: resolveExamDate(),
    proactiveEnabled: true,
    ...savedCfg,
    voice: { enabled: true, volume: 0.9, ...(savedCfg.voice ?? {}) },
    proactive: { ...DEFAULT_TOGGLES, ...(savedCfg.proactive ?? {}) },
  },
  inboxSeen: savedState.inboxSeen ?? [],
};

// migrate pre-chats state shape ({ transcript, sessionId })
if (!state.activeChatId && Array.isArray(savedState.transcript)) {
  const id = chatId();
  fs.writeFileSync(chatFile(id), JSON.stringify({
    id,
    title: savedState.transcript.find((e) => e.type === 'user_message')?.text?.slice(0, 48) || 'earlier chat',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionId: savedState.sessionId ?? null,
    transcript: savedState.transcript,
  }));
  state.activeChatId = id;
}

function loadChat(id) {
  try {
    return JSON.parse(fs.readFileSync(chatFile(id), 'utf8'));
  } catch {
    return null;
  }
}

let activeChat = (state.activeChatId && loadChat(state.activeChatId)) ?? {
  id: chatId(), title: '', createdAt: Date.now(), updatedAt: Date.now(), sessionId: null, transcript: [],
};
state.activeChatId = activeChat.id;
let transcript = activeChat.transcript;
fs.writeFileSync(STATE_FILE, JSON.stringify(state)); // commit new shape now — a restart must not re-migrate

function listChats() {
  const out = [];
  for (const f of fs.readdirSync(CHATS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const c = loadChat(f.slice(0, -5));
    if (c) out.push({ id: c.id, title: c.title || 'untitled', updatedAt: c.updatedAt, messages: c.transcript.filter((e) => e.type === 'user_message').length, active: c.id === activeChat.id });
  }
  // include the active chat even before its first save
  if (!out.some((c) => c.id === activeChat.id)) {
    out.push({ id: activeChat.id, title: activeChat.title || 'untitled', updatedAt: activeChat.updatedAt, messages: 0, active: true });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------- websocket + transcript ----------
const clients = new Set();

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    activeChat.updatedAt = Date.now();
    activeChat.sessionId = tutor.getSessionId();
    activeChat.transcript = transcript;
    fs.writeFile(chatFile(activeChat.id), JSON.stringify(activeChat), () => {});
    state.config = tutor.getConfig();
    fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
  }, 400);
}

let readinessTimer = null;
function pushReadiness() {
  clearTimeout(readinessTimer);
  readinessTimer = setTimeout(() => {
    const cfg = tutor.getConfig();
    computeReadiness({ examDate: cfg.examDate, target: cfg.targetScore })
      .then((r) => broadcast({ type: 'readiness', ...r }, false))
      .catch(() => {});
  }, 300);
  readinessTimer.unref?.();
}

function broadcast(event, record = true) {
  // A finished turn may have moved the numbers: refresh the READINESS pane.
  if (event.type === 'turn_done') pushReadiness();
  if (record) {
    transcript.push(event);
    if (event.type === 'user_message' && !activeChat.title && event.text) {
      activeChat.title = event.text.slice(0, 48);
      broadcastChats();
    }
    saveState();
  }
  if (event.type === 'session_init') saveState();
  const data = JSON.stringify(event);
  for (const ws of clients) if (ws.readyState === 1) ws.send(data);
}

// One place that knows how the voice worker's audio reaches clients, reused by boot,
// the enable-config path, /api/speak (lazy start) and /api/voice/restart.
const voiceOnAudio = (evt) => broadcast(evt, false);
function ensureVoiceStarted() {
  const s = voiceStatus().status;
  if (s === 'ready' || s === 'starting') return;
  startVoice({ onAudio: voiceOnAudio }).catch(() => {});
}

function broadcastChats() {
  broadcast({ type: 'chats', chats: listChats() }, false);
}

const tutor = createTutor(broadcast, activeChat.sessionId ?? null, state.config, {
  // mood.js needs the live chat for session-elapsed time and hysteresis keying.
  getChat: () => activeChat,
});

function flushActiveChat() {
  clearTimeout(saveTimer);
  activeChat.updatedAt = Date.now();
  activeChat.sessionId = tutor.getSessionId();
  activeChat.transcript = transcript;
  fs.writeFileSync(chatFile(activeChat.id), JSON.stringify(activeChat));
  state.config = tutor.getConfig();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

async function startNewChat() {
  if (transcript.length) flushActiveChat(); // before reset — keeps the chat's resume id
  else fs.rmSync(chatFile(activeChat.id), { force: true }); // don't keep empty shells
  await tutor.reset();
  activeChat = { id: chatId(), title: '', createdAt: Date.now(), updatedAt: Date.now(), sessionId: null, transcript: [] };
  transcript = activeChat.transcript;
  state.activeChatId = activeChat.id;
  saveState();
  broadcast({ type: 'reset' }, false);
  broadcastChats();
}

async function switchChat(id) {
  if (id === activeChat.id) return;
  const next = loadChat(id);
  if (!next) return;
  if (transcript.length) flushActiveChat();
  await tutor.loadSession(next.sessionId ?? null);
  activeChat = next;
  transcript = activeChat.transcript;
  state.activeChatId = activeChat.id;
  saveState();
  broadcast({ type: 'chat_switched', id, events: transcript }, false);
  broadcastChats();
}

async function deleteChat(id) {
  if (id === activeChat.id) {
    await tutor.reset();
    fs.rmSync(chatFile(id), { force: true });
    activeChat = { id: chatId(), title: '', createdAt: Date.now(), updatedAt: Date.now(), sessionId: null, transcript: [] };
    transcript = activeChat.transcript;
    state.activeChatId = activeChat.id;
    saveState();
    broadcast({ type: 'reset' }, false);
  } else {
    fs.rmSync(chatFile(id), { force: true });
  }
  broadcastChats();
}

// ---------- inbox tracking (files not yet shown to the tutor) ----------
async function inboxNew() {
  let files = [];
  try {
    files = (await fsp.readdir(INBOX)).filter((f) => !f.startsWith('.'));
  } catch {}
  return files.map((f) => path.join(INBOX, f)).filter((p) => !state.inboxSeen.includes(p));
}

// ---------- file tree ----------
const TREE_EXTS = new Set(['.pdf', '.md', '.json', '.txt', '.png', '.jpg', '.jpeg', '.html']);

async function buildTree(dir, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'app') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: full, dir: true, children: await buildTree(full, depth + 1) });
    } else if (TREE_EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push({ name: e.name, path: full, dir: false });
    }
  }
  return out;
}

// ---------- http ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json',
  '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  // pdf.js ships ES modules (.mjs — the worker), binary CMaps (.bcmap), Type1
  // standard fonts (.pfb) and optional wasm decoders. Without these entries the
  // static server hands them back as application/octet-stream and the module
  // worker refuses to execute.
  '.mjs': 'text/javascript', '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
};

// Paths that must 404 rather than fall through to the SPA shell. Serving index.html
// with a 200 for a missing script turns "asset not found" into an unrelated parse
// error three layers down — which is exactly how a mis-pathed pdf.js worker fails.
// Anything under /assets/ is a build artefact, and anything with a file extension we
// know how to serve was asked for as a file, not as a client-side route.
const ASSET_EXTS = new Set([
  '.js', '.mjs', '.css', '.map', '.wasm', '.bcmap', '.pfb',
  '.png', '.jpg', '.jpeg', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.webmanifest',
]);
function isAssetRequest(pathname) {
  return pathname.startsWith('/assets/') || ASSET_EXTS.has(path.extname(pathname).toLowerCase());
}

/**
 * The DATA section of the settings pane: where everything lives and how big it
 * has got. Read-only, and it never walks outside the project — the four roots
 * below are module constants, not anything a client can name.
 */
async function dirStats(dir, filter = () => true) {
  const out = { dir, files: 0, bytes: 0 };
  try {
    for (const f of await fsp.readdir(dir)) {
      if (!filter(f)) continue;
      try {
        const st = await fsp.stat(path.join(dir, f));
        if (!st.isFile()) continue;
        out.files += 1;
        out.bytes += st.size;
      } catch { /* raced */ }
    }
  } catch { /* not there yet */ }
  return out;
}

async function dataStats() {
  const chats = await dirStats(CHATS_DIR, (f) => f.endsWith('.json'));
  let stateBytes = 0;
  try { stateBytes = (await fsp.stat(STATE_FILE)).size; } catch { /* not written yet */ }
  return {
    chats: { ...chats, active: activeChat.id, messages: transcript.length },
    voiceCache: voiceCacheStats(),
    state: { file: STATE_FILE, bytes: stateBytes },
    paths: {
      projectRoot: PROJECT_ROOT,
      tutorData: TUTOR_DATA,
      inbox: INBOX,
      chats: CHATS_DIR,
      state: STATE_FILE,
      voiceCache: voiceCacheDir(),
      sessionMemory: SESSION_MEMORY,
      dashboard: path.join(TUTOR_DATA, 'dashboard.html'),
    },
  };
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/tree') {
      return json(res, 200, {
        tree: [
          { name: 'tutor_data', path: TUTOR_DATA, dir: true, children: await buildTree(TUTOR_DATA) },
          { name: 'major exams', path: path.join(PROJECT_ROOT, 'major exams'), dir: true, children: await buildTree(path.join(PROJECT_ROOT, 'major exams')) },
        ],
      });
    }

    if (url.pathname === '/api/file') {
      const abs = insideRoot(url.searchParams.get('path') ?? '');
      if (!abs) return json(res, 403, { error: 'outside root' });
      const ext = path.extname(abs).toLowerCase();
      if (!['.md', '.json', '.txt', '.html'].includes(ext)) return json(res, 400, { error: 'not a text file' });
      return json(res, 200, { text: await fsp.readFile(abs, 'utf8') });
    }

    if (url.pathname === '/api/pdf-info') {
      const abs = insideRoot(url.searchParams.get('path') ?? '');
      if (!abs) return json(res, 403, { error: 'outside root' });
      return json(res, 200, { pages: await pageCount(abs) });
    }

    if (url.pathname === '/api/pdf-page') {
      const abs = insideRoot(url.searchParams.get('path') ?? '');
      const page = Number(url.searchParams.get('page') ?? 1);
      if (!abs) return json(res, 403, { error: 'outside root' });
      const png = await rasterizeToFile(abs, page, 150);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
      return fs.createReadStream(png).pipe(res);
    }

    // ---- annotations -------------------------------------------------------
    // Coordinates in these payloads are PDF user space (points, origin bottom-left),
    // never screen pixels — see annotations.js.
    //
    // NOTE ON THE GUARD: the PDF itself lives under "major exams/", NOT under
    // tutor_data/, so insideTutorData is the wrong test for `path` and would refuse
    // every real paper. It is applied where it belongs — to the file being written,
    // which must always land inside tutor_data/annotations/.
    if (url.pathname === '/api/annotations' && req.method !== 'POST') {
      const abs = insideRoot(url.searchParams.get('path') ?? '');
      if (!abs) return json(res, 403, { error: 'outside root' });
      const doc = readDoc(abs);
      if (!insideTutorData(fileForKey(doc.key))) return json(res, 403, { error: 'refused' });
      return json(res, 200, doc);
    }

    if (url.pathname === '/api/annotations' && req.method === 'POST') {
      // sendBeacon posts text/plain on unload. Parse the bytes, ignore the header —
      // refusing the beacon would lose the last strokes of every session.
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch (err) {
        return json(res, 400, { error: `bad JSON: ${err.message}` });
      }
      const abs = insideRoot(body.path ?? '');
      if (!abs) return json(res, 403, { error: 'outside root' });
      const author = typeof body.author === 'string' && body.author ? body.author : 'student';
      const scope = body.scope === 'all' ? 'all' : 'author';
      const doc = applyPages(readDoc(abs), body.pages ?? {}, {
        author, scope, pageSizes: body.page_sizes ?? null,
      });
      if (!insideTutorData(fileForKey(doc.key))) return json(res, 403, { error: 'refused' });
      // Idempotent by construction: saveDoc compares before writing, so a beacon that
      // repeats the last autosave costs one read and no write.
      const saved = saveDoc(doc);
      if (saved.changed) broadcast({ type: 'annotations_changed', path: abs, key: saved.doc.key, author }, false);
      return json(res, 200, { ok: true, key: saved.doc.key, changed: saved.changed, marks: countMarks(saved.doc) });
    }

    if (url.pathname === '/api/save' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const abs = insideRoot(body.path ?? '');
      if (!abs) return json(res, 403, { error: 'outside root' });
      if (!['.md', '.json', '.txt'].includes(path.extname(abs).toLowerCase()))
        return json(res, 400, { error: 'not an editable file type' });
      await fsp.writeFile(abs, body.text ?? '');
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/api/raw') {
      const abs = insideRoot(url.searchParams.get('path') ?? '');
      if (!abs || !fs.existsSync(abs)) return json(res, abs ? 404 : 403, { error: 'not available' });
      res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream' });
      return fs.createReadStream(abs).pipe(res);
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const abs = insideRoot(url.searchParams.get('path') ?? '');
      if (!abs) return json(res, 403, { error: 'outside root' });
      execFile('open', [abs]);
      return json(res, 200, { ok: true });
    }

    // latest session report from session_notes.md, shaped for a mailto: draft
    if (url.pathname === '/api/email-draft') {
      let notes = '';
      try {
        notes = await fsp.readFile(path.join(TUTOR_DATA, 'session_notes.md'), 'utf8');
      } catch {}
      const blocks = notes.split(/\n(?=## Session )/).filter((b) => b.trimStart().startsWith('## Session'));
      const last = (blocks.at(-1) ?? '').trim();
      if (!last) return json(res, 404, { error: 'no session report found in session_notes.md' });
      const subject = last.split('\n')[0].replace(/^##\s*/, 'TMUA — ');
      return json(res, 200, { subject, body: last });
    }

    // ---- backlog (spaced revision: +1 / +7 / +21 days) ----
    if (url.pathname === '/api/backlog') {
      const exam = url.searchParams.get('exam');
      let takeaways = [];
      try { takeaways = JSON.parse(fs.readFileSync(path.join(TUTOR_DATA, 'backlog_takeaways.json'), 'utf8')).takeaways ?? []; } catch {}
      // Resolve each item's source PDF so the driven session can open the paper.
      const pad2 = (n) => String(n).padStart(2, '0');
      // Every mock collection resolves the same way: turn the row's human reference into a
      // canonical id, ask the page index which paper that id belongs to, and read the PDFs
      // off the registry row. This replaces four hand-written manifest lookups — Chen,
      // Rosie, Asher Falcon and Tyler — that reached for the tmua_unofficial and
      // tmua_jz_mocks keys. Neither key exists any more, so all of them had been quietly
      // answering null, and it now covers Heracles and Euclid without a branch each.
      const registryRow = (it) => {
        const loc = locate(canonicalId(it.exam ?? 'TMUA', String(it.ref)));
        return loc ? registryPaper(loc.paperId) : null;
      };
      const paperPath = (it) => {
        try {
          const ref = String(it.ref);
          // Official papers keep their manifest lookup: they are the only ones with
          // several kinds of solution file, which the manifest distinguishes and the
          // registry does not.
          if (it.exam === 'MAT') { const m = ref.match(/(\d{4}).*?q?1?\s*([a-j])/i); if (m) return resolveTagPaths(`MAT${m[1]}${m[2].toUpperCase()}`)?.paper ?? null; }
          else if (it.exam === 'TMUA' && /^\d{4}/.test(ref)) { const m = ref.match(/(\d{4}).*?p\s*([12]).*?q\s*(\d+)/i); if (m) return resolveTagPaths(`TMUA${m[1]}P${m[2]}Q${pad2(m[3])}`)?.paper ?? null; }
          return registryRow(it)?.qp ?? null;
        } catch {}
        return null;
      };
      // The worked solutions for the same question, when the collection has one. Mirrors
      // paperPath rather than sharing it: official papers have several kinds of solution
      // file and the mocks have at most one, so only the official branch differs.
      const msPath = (it) => {
        try {
          const ref = String(it.ref);
          if (it.exam === 'MAT') { const m = ref.match(/(\d{4}).*?q?1?\s*([a-j])/i); if (m) return resolveTagPaths(`MAT${m[1]}${m[2].toUpperCase()}`)?.solutions ?? null; }
          else if (it.exam === 'TMUA' && /^\d{4}/.test(ref)) { const m = ref.match(/(\d{4}).*?p\s*([12]).*?q\s*(\d+)/i); if (m) return resolveTagPaths(`TMUA${m[1]}P${m[2]}Q${pad2(m[3])}`)?.solutions ?? null; }
          return registryRow(it)?.ms ?? null;
        } catch {}
        // A registry row whose `ms` is null says the paper genuinely has no mark scheme:
        // Rosie, Asher Falcon and the Euclid R2Drew edition are all published without one.
        return null;
      };
      // ?recent=1 returns what was last marked pass/fail, newest first, open and closed
      // together — the view for spotting a rework you did not actually do.
      const recent = url.searchParams.get('recent') === '1';
      // ?slow=1 is the timing view: right, but not right fast enough. Filtered server
      // side like ?recent, so the client never has to re-derive a budget it does not own.
      const items = listBacklogItems({
        dueOnly: url.searchParams.get('due') === '1',
        exam: exam && exam !== 'ALL' ? exam : null,
        includeDone: url.searchParams.get('done') === '1',
        recentDays: recent ? Number(url.searchParams.get('days')) || 30 : null,
        slowOnly: url.searchParams.get('slow') === '1',
      // budget rides along on every item so the driven session can start its countdown
      // from the same number the history was graded against — one round trip, no second
      // copy of the pace arithmetic in the browser.
      }).map((it) => ({ ...it, paper_path: paperPath(it), ms_path: msPath(it), budget: backlogBudgetFor(it), pace: backlogLastPace(it) }));
      const paceBy = url.searchParams.get('paceBy') || 'topic';
      return json(res, 200, {
        summary: { ...backlogSummary(), paceStats: backlogPaceStats({ groupBy: paceBy, exam: exam && exam !== 'ALL' ? exam : null }) },
        takeaways,
        items,
      });
    }
    // The exam always opens in its own full-screen Chrome window (examwindow.js).
    if (url.pathname === '/api/exam/open' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      try { return json(res, 200, { ok: true, ...(await openExamWindow(b.path ?? '/exam')) }); } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); }
    }
    // The 8.5+ page: distance to 35/40 and the day-by-day plan to close it.
    if (url.pathname === '/api/target85' && req.method === 'GET') return json(res, 200, target85.computeTarget());
    if (url.pathname === '/api/target85/task' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const plan = target85.updateTask(b);
      return json(res, plan.error ? 404 : 200, plan.error ? plan : { plan });
    }
    // Paper flow: guided per-question rework of a mock (video | paper/MS | panel).
    if (url.pathname.startsWith('/api/paperflow/')) {
      try {
        const paper = url.searchParams.get('paper');
        if (url.pathname === '/api/paperflow/list') return json(res, 200, { papers: paperflow.listFlows(url.searchParams.get('collection') ?? 'jz') });
        if (url.pathname === '/api/paperflow/state' && req.method === 'GET') {
          const row = registryPaper(paper);
          return json(res, 200, { state: paperflow.getState(paper), answers: paperflow.answerKey(paper), qp: row?.qp ?? null, ms: row?.ms ?? null });
        }
        if (url.pathname === '/api/paperflow/state' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          return json(res, 200, { state: paperflow.saveState(b.paper ?? paper, b.patch ?? {}) });
        }
        if (url.pathname === '/api/paperflow/video') return json(res, 200, await paperflow.findVideo(paper));
        if (url.pathname === '/api/paperflow/finish' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const r = paperflow.finishFlow(b.paper ?? paper);
          broadcast({ type: 'backlog_changed' }, false);
          return json(res, 200, r);
        }
        if (url.pathname === '/api/paperflow/reset' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          return json(res, 200, { state: paperflow.resetFlow(b.paper ?? paper) });
        }
        return json(res, 404, { error: 'no such paperflow route' });
      } catch (e) {
        return json(res, e.status ?? 500, { error: e.message });
      }
    }
    if (url.pathname === '/api/backlog/complete' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      // seconds arrives with the verdict, not in a separate call: elapsed and result
      // have to land on the same history entry or neither number means anything.
      const r = completeBacklogItem(b.id, b.result ?? 'pass', b.note ?? '', b.seconds ?? null);
      broadcast({ type: 'backlog_changed' }, false);
      return json(res, r.error ? 400 : 200, r);
    }
    if (url.pathname === '/api/backlog/undo' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const r = undoBacklogItem(b.id);
      broadcast({ type: 'backlog_changed' }, false);
      return json(res, r.error ? 400 : 200, r);
    }
    if (url.pathname === '/api/backlog/note' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const r = addBacklogNote(b.id, b.author ?? 'student', b.text ?? '');
      if (!r) return json(res, 404, { error: 'no such item' });
      broadcast({ type: 'backlog_changed' }, false);
      return json(res, 200, r);
    }
    if (url.pathname === '/api/backlog/time' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const r = addBacklogTime(b.id, b.seconds ?? 0);
      if (!r) return json(res, 404, { error: 'no such item' });
      return json(res, 200, { id: r.id, time_seconds: r.time_seconds });
    }

    // ---- health: one call the UI polls to show "up / voice / dashboard fresh" ----
    if (url.pathname === '/api/health') {
      let voice = { status: 'unknown', ready: false };
      try { voice = voiceStatus(); } catch {}
      let dash = { fresh: false, generated: null, ageMin: null };
      try {
        const f = path.join(TUTOR_DATA, 'dashboard-site', 'data', 'stats.json');
        const st = fs.statSync(f);
        const ageMin = Math.round((Date.now() - st.mtimeMs) / 60000);
        const generated = JSON.parse(fs.readFileSync(f, 'utf8')).generated ?? null;
        dash = { fresh: ageMin <= 30, generated, ageMin };
      } catch {}
      let due = null;
      try { due = backlogSummary().due; } catch {}
      return json(res, 200, { ok: true, ts: Date.now(), voice, dashboard: dash, backlog: { due } });
    }

    // ---- inbox: one glance at what got dropped, what's pending, what's indexed ----
    if (url.pathname === '/api/inbox') {
      const pending = [];
      try {
        const files = fs.readdirSync(INBOX).filter((f) => /\.pdf$/i.test(f));
        for (const f of files) {
          const abs = path.join(INBOX, f);
          let t = null;
          try { t = summariseTriage(await triagePdf(abs)); } catch { t = 'could not read'; }
          const st = fs.statSync(abs);
          pending.push({ name: f, dropped: new Date(st.mtimeMs).toISOString().slice(0, 16), summary: t });
        }
      } catch {}
      let coverage = { official: 0, mock: 0 };
      try {
        const all = allTagQuestions();
        coverage = { official: all.filter((q) => !/TYLER_|CHEN_/.test(q.id)).length, mock: all.filter((q) => /TYLER_|CHEN_/.test(q.id)).length };
      } catch {}
      return json(res, 200, { pending, coverage });
    }

    // ---- recommendations: weak topic -> drill questions + video (analytics that act) ----
    if (url.pathname === '/api/recommendations') {
      let out = { recommendations: [] };
      try { out = buildRecommendations(); } catch (e) { out = { recommendations: [], error: String(e?.message ?? e) }; }
      return json(res, 200, out);
    }

    // ---- calendar (read-only Google iCal feeds) ----
    if (url.pathname === '/api/calendar') {
      const days = Math.min(31, Math.max(1, Number(url.searchParams.get('days') ?? 7)));
      const force = url.searchParams.get('force') === '1';
      const sched = await getSchedule({ days, force });
      return json(res, 200, { ...sched, calendars: safeConfig(), days });
    }
    if (url.pathname === '/api/calendar/config' && req.method === 'GET') {
      return json(res, 200, { calendars: safeConfig() });
    }
    // The client never sees the secret URLs, so it cannot resend them — the server
    // merges instead: {add:{name,url}} appends, {remove:name} drops one.
    if (url.pathname === '/api/calendar/config' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const current = readCalendarConfig().calendars;
      let next = current;
      if (body.add) next = [...current.filter((c) => c.name !== body.add.name), body.add];
      else if (body.remove) next = current.filter((c) => c.name !== body.remove);
      else if (Array.isArray(body.calendars)) next = body.calendars;
      const saved = writeConfig(next);
      return json(res, 200, { ok: true, calendars: saved.map((c) => ({ name: c.name })) });
    }

    // Sparse config patch from the SETTINGS popover and the mode selector.
    // Body is any subset of { model, effort, voice, proactive, proactiveEnabled, mode }.
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const patch = JSON.parse((await readBody(req)).toString('utf8'));
      if (patch.mode && !MODES.includes(patch.mode)) return json(res, 400, { error: `unknown mode ${patch.mode}` });
      const cfg = await tutor.setConfig(patch);       // broadcasts `config` + `monday_state`
      proactive.setToggles(cfg.proactive);            // or the switches wait for a restart
      proactive.setRateLimit(cfg.proactiveRateLimitMin * 60000);
      // Lazy start: turning voice on brings the worker up if it was never started
      // (boot leaves it down when voice is off, so its failures can't degrade anything).
      if (patch.voice?.enabled === true) ensureVoiceStarted();
      pushReadiness();                                // targetScore moves the projection
      saveState();
      return json(res, 200, { ok: true, config: cfg });
    }
    // Speak an arbitrary line on demand. The ▶ on a message uses this whenever the
    // client has no cached chunks for it — after a reload the in-memory audio store
    // is empty, so without this the button would render and do nothing. Repeat text
    // hits the synthesis cache, so a second press is near-instant.
    if (url.pathname === '/api/speak' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: 'no text' });
      const cfg = tutor.getConfig();
      if (cfg.voice?.enabled === false) return json(res, 409, { error: 'voice is off' });
      if (!modeGates(cfg.mode).voiceEnabled) return json(res, 409, { error: `voice is muted in ${cfg.mode}` });
      ensureVoiceStarted();  // lazy: bring the worker up if this is the first thing to want it
      const utteranceId = `replay-${Date.now().toString(36)}`;
      speak({ text, mood: body.mood || 'focused', mode: cfg.mode, utteranceId }).catch(() => {});
      return json(res, 200, { ok: true, utteranceId });
    }

    // Everything the settings pane needs to render itself in one round trip: the
    // live config, the palette, and what each mode actually gates (read straight
    // out of modes.js, so the pane can never describe a gate that is not real).
    if (url.pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        config: tutor.getConfig(),
        moodColors: MOOD_COLORS,
        modes: MODES,
        modeGates: Object.fromEntries(MODES.map((m) => [m, modeGates(m)])),
        modeBlurbs: MODE_BLURBS,
        voice: { ...voiceStatus(), options: getVoiceOptions() },   // live worker state + prosody
      });
    }

    // ── the exam date ───────────────────────────────────────────────────────
    // It lives in tutor_data/memory/session_memory.json, which readiness.js and
    // the dashboard both read. There is deliberately no second copy: config.examDate
    // is a mirror kept in step by the POST below, and the GET always reports the
    // record itself.
    if (url.pathname === '/api/exam-date' && req.method === 'GET') {
      const r = readExamDate();
      return json(res, 200, { ...r, target: tutor.getConfig().targetScore });
    }
    if (url.pathname === '/api/exam-date' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = writeExamDate(body.date);
      if (!r.ok) return json(res, 400, { error: r.error });
      // Keep the config mirror and every live consumer in step immediately.
      await tutor.setConfig({ examDate: r.examDate });
      resetReadinessCache();
      pushReadiness();
      saveState();
      return json(res, 200, { ok: true, examDate: r.examDate, changed: r.changed, file: SESSION_MEMORY });
    }

    // ── data: where things are, and how big they have got ───────────────────
    if (url.pathname === '/api/data-stats' && req.method === 'GET') {
      return json(res, 200, await dataStats());
    }
    // The audio cache is the one store the settings pane may delete. It is
    // regenerable by definition — the worst case is that the next line Monday
    // says takes a second longer.
    // Manual re-arm. Self-heal (voice.js) means this is rarely needed, but the health
    // strip offers it: stop the worker and start it fresh.
    if (url.pathname === '/api/voice/restart' && req.method === 'POST') {
      try { await stopVoice(); } catch { /* ignore */ }
      startVoice({ onAudio: voiceOnAudio }).catch(() => {});
      return json(res, 200, { ok: true, voice: voiceStatus() });
    }
    if (url.pathname === '/api/voice-cache/clear' && req.method === 'POST') {
      const r = clearVoiceCache();
      return json(res, 200, { ok: true, removed: r.removed, bytes: r.bytes, voiceCache: r.after });
    }

    // Same object as the `readiness` event, so the pane is populated on open
    // rather than on the next broadcast.
    if (url.pathname === '/api/readiness') {
      const cfg = tutor.getConfig();
      return json(res, 200, await computeReadiness({ examDate: cfg.examDate, target: cfg.targetScore }));
    }

    if (url.pathname === '/api/inbox-new') {
      return json(res, 200, { files: await inboxNew() });
    }

    if (url.pathname === '/api/inbox-ack' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      for (const p of body.paths ?? []) if (!state.inboxSeen.includes(p)) state.inboxSeen.push(p);
      saveState();
      return json(res, 200, { ok: true });
    }

    // Drop a PDF from the browser. It lands in the inbox and STOPS THERE — nothing is
    // identified, filed, registered or classified. `filed:false` says so explicitly so
    // the client never claims otherwise; `queued` is what add_paper has in flight.
    if (url.pathname === '/api/paper' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const safe = String(body.name ?? 'paper.pdf').replace(/[^\w.() -]/g, '_');
      const dest = path.join(INBOX, safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`);
      await fsp.mkdir(INBOX, { recursive: true });
      await fsp.writeFile(dest, Buffer.from(body.data, 'base64'));
      return json(res, 200, { path: dest, filed: false, queued: papersPending() });
    }

    if (url.pathname === '/api/inbox' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'));
      const ext = (body.media_type ?? 'image/png').split('/')[1].replace('jpeg', 'jpg');
      const name = `ss_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
      const dest = path.join(INBOX, name);
      await fsp.mkdir(INBOX, { recursive: true });
      await fsp.writeFile(dest, Buffer.from(body.data, 'base64'));
      // the inbox watcher broadcasts inbox_added
      return json(res, 200, { path: dest });
    }

    // One dashboard now: the prep tracker (dashboard-site). The DASH button opens
    // /dashboard/, which serves that whole tree locally so its data/*.json fetches
    // resolve — the same rich page that is pushed to GitHub Pages, just fresh and
    // local. The old in-app dashboard.html is retired. /analytics.json etc. are kept
    // as 404-free stubs only so an old cached tab does not error.
    if (url.pathname === '/dashboard') { res.writeHead(302, { location: '/dashboard/' }); return res.end(); }
    if (url.pathname === '/dashboard/' || url.pathname.startsWith('/dashboard/')) {
      const rel = url.pathname === '/dashboard/' ? 'index.html' : url.pathname.slice('/dashboard/'.length);
      const base = path.join(TUTOR_DATA, 'dashboard-site');
      const abs = path.join(base, rel);
      if (!abs.startsWith(base) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return json(res, 404, { error: 'not found' });
      const isHtml = path.extname(abs).toLowerCase() === '.html';
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': isHtml ? 'no-store' : 'no-cache',
      });
      return fs.createReadStream(abs).pipe(res);
    }
    if (url.pathname === '/analytics.json' || url.pathname === '/activity_log.json') {
      const abs = path.join(TUTOR_DATA, url.pathname.slice(1));
      if (!fs.existsSync(abs)) return json(res, 200, {});
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return fs.createReadStream(abs).pipe(res);
    }

    // ---- exam simulator (the exam simulator at /exam) --------------------
    // Answers appear in exactly one of these payloads — /api/exam/results, and only
    // once the sitting is finished. See server/exam.js's header.
    // Which page is this question on? Answered per click rather than per backlog load:
    // scanning a PDF's text costs a tenth of a second, and most rows are never opened.
    if (url.pathname === '/api/question-page' && req.method === 'GET') {
      const p = url.searchParams.get('path');
      const ref = url.searchParams.get('ref') ?? '';
      const exam = url.searchParams.get('exam') ?? '';
      const kind = url.searchParams.get('kind') === 'ms' ? 'ms' : 'qp';
      const abs = p ? insideRoot(p) : null;
      if (!abs) return json(res, 403, { error: 'refused' });

      // The index knows the page for every paper that has one — which is now all 38 of
      // them, official and mock. Searching the PDF is what happens when it does not.
      const known = pageIndexFor(ref, exam, kind);
      if (known) return json(res, 200, { page: known.page, source: known.source });

      const page = await questionPage(abs, { ref, exam });
      return json(res, 200, { page: page ?? null, source: page ? 'search' : 'none' });
    }

    if (url.pathname.startsWith('/api/exam/')) {
      // Starting a sitting forces EXAM and finishing lands in POSTMORTEM, through the
      // same setConfig path the WS set_mode message uses — so voice, proactivity and
      // show_video are gated by the real thing, not by the exam screen's good manners.
      const setMode = async (mode) => { await tutor.setConfig({ mode }); saveState(); };
      try {
        if (url.pathname === '/api/exam/papers' && req.method === 'GET') {
          return json(res, 200, { papers: exam.listPapers() });
        }

        if (url.pathname === '/api/exam/sitting' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          return json(res, 200, await exam.createSitting(body, { setMode }));
        }

        if (url.pathname === '/api/exam/sitting' && req.method === 'GET') {
          return json(res, 200, exam.sittingPayload(url.searchParams.get('id') ?? ''));
        }

        if (url.pathname === '/api/exam/answer' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          return json(res, 200, exam.recordAnswer(body));
        }

        if (url.pathname === '/api/exam/events' && req.method === 'POST') {
          // sendBeacon posts text/plain on unload. Parse the bytes and ignore the
          // header, exactly as /api/annotations does — refusing the beacon would lose
          // the last minute of every sitting's click stream.
          let body;
          try {
            body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          } catch (err) {
            return json(res, 400, { error: `bad JSON: ${err.message}` });
          }
          const accepted = exam.appendEvents(body.sittingId, body.events);
          return json(res, 200, { ok: true, accepted });
        }

        // Practice pause / resume. Accepts sendBeacon's text/plain on page close.
        if ((url.pathname === '/api/exam/pause' || url.pathname === '/api/exam/resume') && req.method === 'POST') {
          let body = {};
          try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch { /* empty */ }
          return json(res, 200, url.pathname.endsWith('pause') ? exam.pauseSitting(body.sittingId) : exam.resumeSitting(body.sittingId));
        }
        if (url.pathname === '/api/exam/sittings' && req.method === 'GET') {
          const status = url.searchParams.get('status');
          const all = exam.listSittings({ limit: 200, groupId: url.searchParams.get('group') || null });
          return json(res, 200, { sittings: status ? all.filter((x) => x.status === status) : all.slice(0, 20) });
        }
        if (url.pathname === '/api/exam/finish' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const results = await exam.finishSitting(body, {
            broadcast: (event) => broadcast(event, false),
            setMode,
          });
          return json(res, 200, { ok: true, results });
        }

        if (url.pathname === '/api/exam/results' && req.method === 'GET') {
          return json(res, 200, exam.results(url.searchParams.get('id') ?? ''));
        }

        if (url.pathname === '/api/exam/explain' && req.method === 'GET') {
          return json(res, 200, exam.explainAnswer(url.searchParams.get('id') ?? '', url.searchParams.get('q')));
        }

        if (url.pathname === '/api/exam/figure' && req.method === 'GET') {
          const fig = exam.figureFor(url.searchParams.get('paper') ?? '', url.searchParams.get('q') ?? '');
          if (!fig) return json(res, 404, { error: 'no figure for that question' });
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' });
          return fs.createReadStream(fig.path).pipe(res);
        }
      } catch (err) {
        return json(res, err.status ?? 500, { error: err.message, ...(err.transcribed ? { transcribed: err.transcribed } : {}) });
      }
      return json(res, 404, { error: `no such exam route: ${req.method} ${url.pathname}` });
    }

    // MathJax and its STIX2 font for the exam screen, served straight out of node_modules:
    // together they are ~40 MB of lazily-loaded font data, and copying that into every
    // build would double it on disk for no gain. The real test driver renders maths
    // with exactly this pair, which is why the exam uses it instead of KaTeX.
    const VENDOR = {
      '/vendor/mathjax/': path.join(__dirname, '..', 'node_modules', 'mathjax'),
      '/vendor/mathjax-stix2-font/': path.join(__dirname, '..', 'node_modules', '@mathjax', 'mathjax-stix2-font'),
    };
    const vendorKey = Object.keys(VENDOR).find((k) => url.pathname.startsWith(k));
    if (vendorKey) {
      const root = VENDOR[vendorKey];
      const vfile = path.join(root, decodeURIComponent(url.pathname.slice(vendorKey.length)));
      if (!vfile.startsWith(root + path.sep) || !fs.existsSync(vfile) || !fs.statSync(vfile).isFile()) {
        return json(res, 404, { error: `no such vendor file: ${url.pathname}` });
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(vfile)] ?? 'application/octet-stream',
        'cache-control': 'public, max-age=604800',
      });
      return fs.createReadStream(vfile).pipe(res);
    }

    // static frontend
    let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(DIST)) return json(res, 403, { error: 'no' });
    if (!fs.existsSync(file)) {
      // An asset that is not there is a 404, not the SPA shell. See isAssetRequest.
      if (isAssetRequest(url.pathname)) return json(res, 404, { error: `no such asset: ${url.pathname}` });
      file = path.join(DIST, 'index.html');
    }
    if (!fs.existsSync(file)) return json(res, 404, { error: 'frontend not built — run: npm run build' });
    // index.html must never be cached: it names the hashed asset bundles, so a stale
    // copy points the app at files that no longer exist and the window silently runs
    // old code (or fails to load a pane at all) until it is force-reloaded. WKWebView
    // in the .app caches aggressively and has no reload button, which makes this worse
    // than it sounds. Hashed assets under /assets are content-addressed, so they are
    // safe to cache hard — a new build produces new names.
    const isHtml = path.extname(file) === '.html';
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': isHtml
        ? 'no-store, must-revalidate'
        : (url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    return fs.createReadStream(file).pipe(res);
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
});

// ---------- websocket ----------
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', async (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'replay', events: transcript }));
  // moodColors rides on `config` so app/server/mood.js stays the single source of
  // truth for the palette — the client's copy is only a fallback until this lands.
  ws.send(JSON.stringify({ type: 'config', ...tutor.getConfig(), moodColors: MOOD_COLORS }));
  ws.send(JSON.stringify({ type: 'chats', chats: listChats() }));
  try {
    ws.send(JSON.stringify({ type: 'inbox_state', count: (await inboxNew()).length }));
  } catch {}
  try {
    const state = { ...tutor.getState(), moodHistory: readMoodHistory(60) };
    // First client after a server start gets the wake-up: orb + a boot line in
    // Monday's own voice, picked from agent A's line bank. Recorded (§C3), so it
    // survives a reload; every later connect just gets the state.
    if (!bootSent) {
      bootSent = true;
      // Recorded (§C3) so it survives a reload — but a restart must not stack another
      // greeting on the last one. Drop a trailing boot line first: consecutive
      // restarts collapse to the freshest greeting, while a greeting that was
      // actually followed by work stays where it is, as history.
      while (transcript.length && transcript[transcript.length - 1].type === 'monday_boot') transcript.pop();
      broadcast({ type: 'monday_boot', greeting: bootGreeting(state), state }, true);
    } else {
      ws.send(JSON.stringify({ type: 'monday_state', ...state }));
    }
  } catch (err) { console.log('[monday] boot state failed:', err.message); }
  computeReadiness({ examDate: tutor.getConfig().examDate, target: tutor.getConfig().targetScore })
    .then((r) => ws.send(JSON.stringify({ type: 'readiness', ...r })))
    .catch(() => {});
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'user_message') {
        // Scope gate: an off-topic message is answered deterministically and never
        // reaches the tutor, so no amount of persuasion gets a recipe out of it.
        // Fails open — see scope.js; anything maths-shaped or short skips the check.
        const verdict = (msg.images?.length ? { blocked: false } : await checkScope(msg.text ?? ''));
        if (verdict.blocked) {
          broadcast({ type: 'user_message', text: msg.text, imageCount: 0 });
          const due = listBacklogItems({ dueOnly: true })[0];
          const next = due ? `${due.exam} ${due.ref} is due — ready?` : null;
          broadcast({ type: 'assistant_message', text: redirectLine(next) });
          broadcast({ type: 'turn_done', cost: 0, duration_ms: 0, is_error: false }, false);
          console.log(`[scope] blocked off-topic message (${verdict.topic}, ${verdict.confidence})`);
          return;
        }
        tutor.sendUser(msg.text, msg.images ?? []);
      }
      else if (msg.type === 'activity') tutor.noteActivity?.();
      else if (msg.type === 'interrupt') tutor.interrupt();
      else if (msg.type === 'reset' || msg.type === 'new_chat') await startNewChat();
      else if (msg.type === 'switch_chat') await switchChat(msg.id);
      else if (msg.type === 'delete_chat') await deleteChat(msg.id);
      else if (msg.type === 'set_config') {
        await tutor.setConfig(msg);
        proactive.setToggles(tutor.getConfig().proactive);
        saveState();
      }
      else if (msg.type === 'set_mode') {
        if (!MODES.includes(msg.mode)) throw new Error(`unknown mode ${msg.mode}`);
        await tutor.setConfig({ mode: msg.mode });
        saveState();
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', text: err.message }));
    }
  });
  ws.on('close', () => clients.delete(ws));
});

// ---------- watcher: live workspace updates ----------
// Both trees the file browser shows. `major exams` was previously unwatched, so
// filing, renaming or moving a paper stayed invisible until the app was restarted.
chokidar
  .watch([TUTOR_DATA, PAPERS], { ignoreInitial: true, ignored: /(^|\/)\../ })
  .on('all', (event, p) => {
    // unlink/addDir/unlinkDir matter as much as add/change: a moved or renamed paper
    // otherwise lingers in the tree pointing at a path that no longer exists.
    if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) return;
    broadcast({ type: 'file_changed', path: p, event }, false);
    // Anything landing in the inbox (drop, Finder, screenshot tool) pings the UI —
    // and does NOTHING ELSE. A dropped PDF used to be auto-identified, moved into
    // "major exams/", registered in the manifest and classified, on the assumption
    // that every PDF is a paper. It is not: worksheets, notes and textbook extracts
    // get dropped too, and auto-filing them was actively wrong. Papers are now added
    // on the word, through the add_paper tool; everything else goes to the library
    // through file_to_library. The trigger moved; the machinery is untouched.
    if (event === 'add' && p.startsWith(INBOX + path.sep) && !state.inboxSeen.includes(p)) {
      broadcast({ type: 'inbox_added', path: p }, false);
      // Read the pages before anyone reasons about the file. The old ingest guessed a
      // slot from the filename and renamed to match, which is how a mock and a custom
      // paper both became "Practice Paper 1". Nothing is moved or renamed here — the
      // evidence goes to Monday, and Monday picks add_paper or file_to_library.
      if (p.toLowerCase().endsWith('.pdf')) {
        triage(p).then((t) => {
          broadcast({ type: 'inbox_triaged', ...t }, false);
          tutor.sendHidden(
            `[app] PDF dropped in the inbox: ${summarise(t)}\n`
            + `Full path: ${p}\n`
            + 'Do NOT trust the filename. Using this evidence, tell him in one line what it '
            + 'looks like and file it: add_paper if it is a real exam paper, file_to_library '
            + 'otherwise, renaming it to something descriptive if the current name is useless. '
            + (t.combined_paper2_starts
                ? `This file holds TWO papers — Paper 2 starts at page ${t.combined_paper2_starts}. Say so and split it before filing.`
                : ''),
          );
        }).catch((err) => broadcast({ type: 'inbox_triage_error', path: p, text: err.message }, false));
      }
    }
    scheduleDashboard('files');
  });

// ---------- dashboard: keep it current without being asked ----------
// It used to regenerate only mid-conversation (every couple of assistant turns, or
// on a journal note), so it went stale whenever the student was not actively talking to
// Monday — and the days-to-exam figure was simply wrong once the date rolled over.
// Now: debounced after any file change, on a 15-minute tick, and immediately after
// midnight so the countdown is right first thing. Pure code, no tokens.
let dashTimer = null;
function scheduleDashboard(reason) {
  clearTimeout(dashTimer);
  dashTimer = setTimeout(() => rebuildDashboard(reason), 4000);
}
function rebuildDashboard(reason) {
  try {
    const r = buildDashboard();
    broadcast({ type: 'dashboard', ...r, reason }, false);
  } catch (err) {
    console.error('[dashboard]', err.message);
  }
}
setInterval(() => rebuildDashboard('tick'), 15 * 60 * 1000).unref?.();
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 30, 0); // half a minute past, so the date has definitely turned
  setTimeout(() => { rebuildDashboard('midnight'); scheduleMidnight(); }, next - now).unref?.();
}
scheduleMidnight();
rebuildDashboard('boot');

// ---------- dropped files ----------
// There is deliberately no auto-ingest here any more. See the watcher above: a drop
// lands in tutor_data/inbox/ and notifies the client, full stop. Filing, manifest
// registration and classification happen only when Monday calls add_paper, which runs
// the same organise.js/ingest.js pipeline this used to run implicitly.

// ---------- proactivity ----------
// This replaces the old hourly backlogTick wholesale. proactive.js re-implements
// backlog.js's daily notification (banner and once-a-day dedupe included) as one of
// its seven triggers, so maybeNotify() must NOT also be called — the two keep
// separate dedupe files and would double-notify.
//
// 60 seconds, not hourly: idle_nudge is a 6-minute rule and session_debrief a
// 40-minute one, neither of which means anything on an hourly tick. The tick is
// cheap — it returns at the first disabled toggle or at the rate limit without
// touching disk — and the one-interruption-per-10-minutes floor is enforced inside
// the module however often it is called.
const proactive = createProactive({
  emit: (evt) => broadcast(evt, false),
  queueInstruction: (text) => tutor.sendHidden(text),
  getState: () => ({
    ...tutor.getState(),                       // advance:false — a tick is not a turn
    proactiveEnabled: state.config.proactiveEnabled !== false,
    sessionActive: clients.size > 0 && transcript.length > 0 && tutor.isSessionLive(),
    lastUserMessageAt: tutor.getLastUserMessageAt(),
  }),
  toggles: state.config.proactive ?? DEFAULT_TOGGLES,
  rateLimitMs: (state.config.proactiveRateLimitMin ?? 10) * 60000,
});

function proactiveTick() {
  try {
    // Nobody watching, nothing to interrupt. The diagnostic triggers push a real
    // model turn, and burning one into an empty room is worse than missing it —
    // the condition is still true a minute later when a client connects.
    if (clients.size === 0) return;
    const r = proactive.tick();
    if (r.fired) console.log(`[proactive] ${r.fired}: ${String(r.text ?? '').slice(0, 80)}`);
  } catch (err) {
    console.log('[proactive] tick failed:', err.message);
  }
}
setTimeout(proactiveTick, 8000).unref?.();
setInterval(proactiveTick, 60 * 1000).unref?.();

// ---------- Monday's wake-up line ----------
let bootSent = false;

function timeOfDay(d = new Date()) {
  const h = d.getHours();
  if (h >= 23 || h < 5) return 'late';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

// The greeting comes from agent A's line bank (boot.<mood>.<time of day>), which is
// also what the voice path pre-renders, so the written and spoken lines are the same
// words. The fallbacks are the focused line for this time of day, then a literal —
// never a mood manner table, which this comment used to claim and never did.
function bootGreeting(st) {
  const id = `boot.${st.mood ?? 'focused'}.${timeOfDay()}`;
  return lineText(id) || lineText(`boot.focused.${timeOfDay()}`) || 'Monday here. Where do you want to start?';
}

server.listen(PORT, () => {
  console.log(`TMUA tutor app: http://localhost:${PORT}`);
  // Voice is best-effort and must never delay the listener: not awaited, never fatal.
  // Only start the worker when voice is actually on — if it's off, keep it down so its
  // load/HF failures can't degrade anything; it starts lazily on enable / first speak.
  if (state.config?.voice?.enabled === false) {
    console.log('[voice] off in config — worker idle, will start on enable');
  } else {
    startVoice({ onAudio: voiceOnAudio })
      .then((ok) => console.log(ok ? '[voice] Monday has a voice' : `[voice] running silent (${voiceStatus().reason || voiceStatus().status})`))
      .catch(() => {});
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { flushActiveChat(); } catch {}
    try { await stopVoice(); } catch {}
    process.exit(0);
  });
}

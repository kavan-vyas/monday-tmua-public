// Monday's voice: lifecycle, queue and cache index for the Python TTS worker.
//
// The single rule this module exists to enforce: voice is an enhancement, never
// a dependency. If Python is missing, the model won't load, ffmpeg is gone, or
// the worker dies mid-sentence, every function here quietly becomes a no-op and
// the tutor carries on in silence. Nothing in this file may throw into a caller.
//
// Interface is fixed by plangamma.md C2. Everything past `stopVoice` is
// additive convenience that D may use or ignore.
//
//   startVoice({ onAudio })                    spawn + warm the worker
//   speak({ text, mood, mode, utteranceId })   resolves once fully queued
//   cancelSpeech(utteranceId)
//   warmLineBank()
//   voiceReady()
//   stopVoice()
//
// Additive, and what the settings pane drives:
//   setVoiceOptions({ rate, longForm, maxChars, prosody })
//   getVoiceOptions()
//   voiceCacheDir() / voiceCacheStats() / clearVoiceCache()
//
// onAudio receives, per chunk:
//   { type:'audio_chunk', utteranceId, seq, mime:'audio/wav', b64, ms }
// and once at the end of each utterance:
//   { type:'audio_end', utteranceId }

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TTS_DIR = path.resolve(HERE, '..', 'tts');
const WORKER = path.join(TTS_DIR, 'monday_tts.py');
const LINEBANK_FILE = path.join(TTS_DIR, 'linebank.json');
// Must agree with CACHE_DIR in tts/monday_tts.py, which is
// `MONDAY_VOICE_CACHE` or app/.voicecache — the same directory, resolved twice.
const CACHE_DIR = path.resolve(process.env.MONDAY_VOICE_CACHE || path.join(HERE, '..', '.voicecache'));

// Prefer the pinned venv interpreter when one has been set up (voice:setup), so a
// change to the system python3 can't silently break voice. Fall back to system python3.
function detectPython() {
  if (process.env.MONDAY_PYTHON) return process.env.MONDAY_PYTHON;
  const venv = path.join(TTS_DIR, '.venv', 'bin', 'python3');
  // Require the .ready marker (written only after voice:setup's pip install succeeds),
  // so a half-built or interrupted venv is never used as the interpreter — that would
  // be worse than the system python3 it replaces.
  try {
    if (fs.existsSync(venv) && fs.existsSync(path.join(TTS_DIR, '.venv', '.ready'))) return venv;
  } catch { /* ignore */ }
  return 'python3';
}
const PYTHON = detectPython();

// The Kokoro weights live in the HF cache after the first run. If they are present we
// spawn the worker OFFLINE — no Hub round-trip on cold boot, which was the single most
// common "voice keeps breaking" trigger (a flaky/blocked fetch crashing the load and
// burning the restart budget). Only when the cache is genuinely missing do we allow the
// one online fetch a first install needs.
function hfCached() {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const snaps = path.join(home, '.cache', 'huggingface', 'hub', 'models--hexgrad--Kokoro-82M', 'snapshots');
    return fs.existsSync(snaps) && fs.readdirSync(snaps).length > 0;
  } catch { return false; }
}

const READY_TIMEOUT_MS = Number(process.env.MONDAY_VOICE_READY_MS || 25000);
const MAX_RESTARTS = 3;              // crash budget before we degrade — but degrade now self-heals
const RESTART_WINDOW_MS = 60000;     // crash budget resets after a quiet minute
// Self-heal: a degraded engine no longer stays silent until a server restart. It waits,
// then re-arms, on a capped exponential backoff so a truly-dead box doesn't spin.
const HEAL_BACKOFF_MS = [30000, 60000, 120000, 300000]; // 30s, 1m, 2m, then 5m cap
// Liveness: any line from the worker proves it is alive; ping only provokes a pong when
// idle. No pong for this long while ready, or stuck 'starting' past the ceiling, = wedged.
const HEARTBEAT_MS = Number(process.env.MONDAY_VOICE_HEARTBEAT_MS || 10000);
const PONG_TIMEOUT_MS = Number(process.env.MONDAY_VOICE_PONG_MS || 25000);
const STARTING_CEILING_MS = Number(process.env.MONDAY_VOICE_START_CEILING_MS || 45000);
const MAX_PREREADY = 200;            // bound the pre-ready queue so a hung worker can't grow it forever
// Lines from the worker's stderr that mean a real failure (vs its normal [monday-tts] logs).
const ERR_SIGNATURE = /Traceback|ModuleNotFoundError|No module named|ImportError|RuntimeError|OSError|CUDA|out of memory|Errno|HTTPError|ConnectionError|OfflineModeIsEnabled|LocalEntryNotFound|Could not|CalledProcessError/i;
const MAX_CHUNK_CHARS = 420;         // long sentences get split so audio starts sooner
const MIN_CHUNK_CHARS = 14;          // a two-word fragment waits for its neighbour

export const MOODS = ['focused', 'sharp', 'gentle', 'clinical', 'wry', 'grave'];
const DEFAULT_MOOD = 'focused';

// ---------------------------------------------------------------- module state

const V = {
  proc: null,
  status: 'off',        // off | starting | ready | degraded
  reason: '',
  onAudio: null,
  info: null,           // the worker's ready payload: voiceHash, device, planVersion
  utterances: new Map(),
  preReady: [],         // requests that arrived while the model was still loading
  restarts: 0,
  firstRestartAt: 0,
  stopping: false,
  readyWaiters: [],
  restartTimer: null,
  // Self-heal + liveness bookkeeping.
  healTimer: null,
  healAttempt: 0,
  nextRetryAt: 0,
  heartbeatTimer: null,
  lastPongAt: 0,
  startedAt: 0,
  lastError: '',        // last error-looking line the worker printed, for a human reason
  // Live prosody settings, written by the settings pane through
  // session.js -> setVoiceOptions(). Defaults are exactly the tts/prosody.py
  // presets, so a fresh install sounds identical to before this existed.
  opts: { rate: 1, longForm: true, maxChars: 480, prosody: {} },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (n) => Math.round(n * 1000) / 1000;

function log(...a) { console.log('[voice]', ...a); }
function warn(...a) { console.warn('[voice]', ...a); }

function degrade(reason) {
  if (V.status === 'degraded') return; // already degraded + a heal is pending
  V.status = 'degraded';
  // Fold in the worker's own last error line so the reason is diagnostic, not just "exited".
  V.reason = V.lastError ? `${reason} — ${V.lastError}` : reason;
  if (V.restartTimer) { clearTimeout(V.restartTimer); V.restartTimer = null; }
  stopHeartbeat();
  warn(`silent: ${reason}`);
  // Anything still waiting gets closed out so the UI never hangs on an
  // utterance whose audio is never going to arrive.
  for (const id of [...V.utterances.keys()]) finish(id);
  V.preReady.length = 0;
  flushReadyWaiters();
  // The headline change: degraded is no longer terminal. Schedule a rate-limited
  // re-arm so a transient failure recovers on its own, no server restart needed.
  scheduleHeal();
}

// Re-arm after a degrade, on a capped exponential backoff. Idempotent: one timer at a
// time. A successful `ready` resets healAttempt (handleMessage), so recovery is cheap
// but a persistently-dead box backs off to one attempt every 5 minutes.
function scheduleHeal() {
  if (V.stopping || V.healTimer) return;
  const wait = HEAL_BACKOFF_MS[Math.min(V.healAttempt, HEAL_BACKOFF_MS.length - 1)];
  V.healAttempt += 1;
  V.nextRetryAt = Date.now() + wait;
  log(`degraded; retrying voice in ${Math.round(wait / 1000)}s (attempt ${V.healAttempt})`);
  V.healTimer = setTimeout(() => {
    V.healTimer = null;
    V.nextRetryAt = 0;
    if (V.stopping || V.status === 'ready') return;
    V.status = 'off';           // clear the degraded latch so startVoice will proceed
    V.restarts = 0;
    V.firstRestartAt = 0;
    startVoice().catch(() => { /* startVoice never throws; belt and braces */ });
  }, wait);
  if (V.healTimer.unref) V.healTimer.unref();
}

// Liveness watchdog. Any line from the worker stamps lastPongAt (see spawnWorker), so a
// busy worker is never falsely killed; ping only matters when idle. A worker stuck in
// 'starting' past the ceiling, or silent past the pong timeout while ready, is wedged —
// SIGKILL it and let handleExit restart (which feeds the same self-healing budget).
function startHeartbeat() {
  stopHeartbeat();
  V.lastPongAt = Date.now();
  V.heartbeatTimer = setInterval(() => {
    if (V.stopping || !V.proc) return;
    if (V.status === 'starting') {
      if (V.startedAt && Date.now() - V.startedAt > STARTING_CEILING_MS) {
        warn('worker wedged in starting; killing to restart');
        try { V.proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      return;
    }
    if (V.status !== 'ready') return;
    if (Date.now() - V.lastPongAt > PONG_TIMEOUT_MS) {
      warn('no response from worker; wedged, killing to restart');
      try { V.proc.kill('SIGKILL'); } catch { /* ignore */ }
      return;
    }
    send({ op: 'ping' });
  }, HEARTBEAT_MS);
  if (V.heartbeatTimer.unref) V.heartbeatTimer.unref();
}
function stopHeartbeat() {
  if (V.heartbeatTimer) { clearInterval(V.heartbeatTimer); V.heartbeatTimer = null; }
}

function flushReadyWaiters() {
  const ws = V.readyWaiters.splice(0);
  for (const w of ws) { try { w(); } catch { /* ignore */ } }
}

// ------------------------------------------------------------------- lifecycle

/** Spawn and warm the Python worker. Never throws; resolves to voiceReady(). */
export async function startVoice({ onAudio } = {}) {
  if (typeof onAudio === 'function') V.onAudio = onAudio;
  if (V.status === 'ready') return true;
  if (V.status === 'degraded') return false;
  if (V.status !== 'starting') {
    V.stopping = false;
    if (!spawnWorker()) return false;
  }
  // Resolve early on a timeout rather than holding up server boot for the model
  // load; if `ready` turns up later we flip to ready in the background and the
  // queued requests drain then.
  await new Promise((resolve) => {
    let done = false;
    const once = () => { if (!done) { done = true; clearTimeout(t); resolve(); } };
    const t = setTimeout(() => {
      if (V.status === 'starting') {
        log(`still loading after ${READY_TIMEOUT_MS} ms; continuing without it`);
      }
      once();
    }, READY_TIMEOUT_MS);
    // Deliberately NOT unref'd: this promise is the whole contract of
    // startVoice, and an unref'd timer lets an idle process exit with it
    // unsettled. It is cleared the moment we resolve either way.
    V.readyWaiters.push(once);
  });
  return voiceReady();
}

function spawnWorker() {
  if (!fs.existsSync(WORKER)) {
    degrade(`worker missing at ${WORKER}`);
    return false;
  }
  // Offline when the weights are cached (the common case): no Hub round-trip on boot.
  const offline = hfCached();
  const env = { ...process.env, PYTHONUNBUFFERED: '1', HF_HUB_DISABLE_TELEMETRY: '1' };
  if (offline) { env.HF_HUB_OFFLINE = '1'; env.TRANSFORMERS_OFFLINE = '1'; }
  else log('Kokoro weights not cached — allowing one online fetch (first run)');
  let proc;
  try {
    proc = spawn(PYTHON, [WORKER, '--serve'], {
      cwd: TTS_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
  } catch (err) {
    degrade(`spawn failed: ${err.message}`);
    return false;
  }

  V.proc = proc;
  V.status = 'starting';
  V.reason = '';
  V.startedAt = Date.now();

  proc.on('error', (err) => {
    if (proc !== V.proc) return;
    // ENOENT means there is no interpreter at that path at all: the commonest
    // silent-mode cause, and not something a retry can fix. Degrade at once so
    // an awaited startVoice() resolves straight away instead of sitting through
    // three pointless respawns.
    if (err.code === 'ENOENT') { V.proc = null; degrade(`no interpreter at ${PYTHON}`); return; }
    handleExit(`spawn error: ${err.message}`);
  });
  proc.on('exit', (code, signal) => {
    if (proc !== V.proc) return;
    handleExit(`worker exited (code=${code} signal=${signal})`);
  });

  createInterface({ input: proc.stdout }).on('line', (line) => {
    if (!line.trim()) return;
    V.lastPongAt = Date.now(); // any line proves the worker is alive
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    try { handleMessage(msg); } catch (err) { warn('handler failed:', err.message); }
  });

  // The worker's stderr is its log; straight to the console, never buffered. We also
  // sniff it for real error signatures so a crash's REASON (a missing module, an offline
  // fetch, an OOM) reaches the health strip instead of being buried in the console.
  createInterface({ input: proc.stderr }).on('line', (line) => {
    if (!line.trim()) return;
    console.error('[voice:py]', line);
    if (ERR_SIGNATURE.test(line)) V.lastError = line.trim().slice(0, 200);
  });

  log(`worker starting (${PYTHON} ${WORKER})`);
  return true;
}

function handleExit(reason) {
  V.proc = null;
  if (V.stopping) { V.status = 'off'; flushReadyWaiters(); return; }

  const now = Date.now();
  if (now - V.firstRestartAt > RESTART_WINDOW_MS) { V.restarts = 0; V.firstRestartAt = now; }
  if (V.restarts >= MAX_RESTARTS) {
    degrade(`${reason}; ${MAX_RESTARTS} restarts exhausted`);
    return;
  }
  V.restarts += 1;
  warn(`${reason}; restart ${V.restarts}/${MAX_RESTARTS}`);
  // Close out anything in flight: its audio is never arriving.
  for (const id of [...V.utterances.keys()]) finish(id);
  V.status = 'starting';
  V.restartTimer = setTimeout(() => {
    V.restartTimer = null;
    if (!V.stopping) spawnWorker();
  }, 500 * V.restarts);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'ready': {
      V.status = 'ready';
      V.info = msg;
      V.healAttempt = 0;       // a clean load resets the backoff
      V.nextRetryAt = 0;
      V.lastError = '';        // a successful load clears any stale error
      startHeartbeat();
      log(`ready in ${msg.ms} ms on ${msg.device}, voice ${msg.voiceHash}`);
      flushReadyWaiters();
      const queued = V.preReady.splice(0);
      for (const r of queued) send(r);
      break;
    }

    case 'audio': {
      const u = V.utterances.get(msg.utteranceId);
      if (!u || u.cancelled) { maybeFinish(msg.utteranceId); return; }
      u.received += 1;
      // The outbound seq is renumbered, NOT passed through. The worker skips a
      // request when it is cancelled or has nothing speakable, and reports an
      // error instead of audio when synthesis fails — either leaves a hole in its
      // own numbering. The client plays only a contiguous run from 0, so a hole
      // would stall the rest of the utterance for good. Chunks come back in
      // submission order (the worker renders on one thread), so a counter is
      // enough to close the gaps.
      emit({
        type: 'audio_chunk',
        utteranceId: msg.utteranceId,
        seq: u.emitted++,
        mime: msg.mime || 'audio/wav',
        b64: msg.b64,
        ms: msg.ms,
      });
      maybeFinish(msg.utteranceId);
      break;
    }

    case 'skipped': {
      const u = V.utterances.get(msg.utteranceId);
      if (u) u.received += 1;
      maybeFinish(msg.utteranceId);
      break;
    }

    case 'error': {
      warn(`synthesis error (${msg.utteranceId ?? '-'} #${msg.seq ?? '-'}): ${msg.message}`);
      const u = V.utterances.get(msg.utteranceId);
      if (u) u.received += 1;
      maybeFinish(msg.utteranceId);
      break;
    }

    case 'pong':
      // Liveness already stamped in the line handler; nothing more to do.
      break;

    default:
      break;
  }
}

function send(obj) {
  const p = V.proc;
  if (!p || !p.stdin || p.stdin.destroyed) return false;
  try {
    p.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (err) {
    warn('write failed:', err.message);
    return false;
  }
}

function emit(evt) {
  if (typeof V.onAudio !== 'function') return;
  // Warm-up renders only to populate the cache; their audio is never played. Dropping
  // them by prefix (instead of nulling onAudio globally during warm-up) means a REAL
  // utterance spoken while the bank warms is not silently swallowed.
  if (typeof evt.utteranceId === 'string' && evt.utteranceId.startsWith('warm:')) return;
  try { V.onAudio(evt); } catch (err) { warn('onAudio threw:', err.message); }
}

/** True when the worker is loaded and taking work. */
export function voiceReady() {
  return V.status === 'ready' && !!V.proc;
}

/** Diagnostics for the status line / integration checks. Additive. */
export function voiceStatus() {
  return {
    status: V.status,
    reason: V.reason,
    ready: voiceReady(),
    inFlight: V.utterances.size,
    device: V.info?.device ?? null,
    voiceHash: V.info?.voiceHash ?? null,
    planVersion: V.info?.planVersion ?? null,
    // Self-heal visibility: when degraded, how many seconds until the next re-arm.
    retryInSeconds: V.nextRetryAt ? Math.max(0, Math.round((V.nextRetryAt - Date.now()) / 1000)) : null,
    healAttempt: V.healAttempt,
  };
}

/** Shut the worker down cleanly. Safe to call when nothing is running. */
export async function stopVoice() {
  V.stopping = true;
  if (V.restartTimer) { clearTimeout(V.restartTimer); V.restartTimer = null; }
  if (V.healTimer) { clearTimeout(V.healTimer); V.healTimer = null; }
  V.nextRetryAt = 0;
  stopHeartbeat();
  const p = V.proc;
  for (const id of [...V.utterances.keys()]) finish(id);
  V.preReady.length = 0;
  if (!p) { V.status = 'off'; flushReadyWaiters(); return; }
  try { send({ op: 'shutdown' }); p.stdin.end(); } catch { /* ignore */ }
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2000);
    if (t.unref) t.unref();
    p.once('exit', () => { clearTimeout(t); resolve(); });
  });
  V.proc = null;
  V.status = 'off';
  flushReadyWaiters();
  log('stopped');
}

// ------------------------------------------------ utterance bookkeeping

function track(utteranceId) {
  let u = V.utterances.get(utteranceId);
  if (!u) {
    u = { sent: 0, received: 0, emitted: 0, complete: false, cancelled: false, chars: 0, truncated: false };
    V.utterances.set(utteranceId, u);
  }
  return u;
}

function maybeFinish(utteranceId) {
  const u = V.utterances.get(utteranceId);
  if (!u) return;
  if (u.complete && u.received >= u.sent) finish(utteranceId);
}

function finish(utteranceId) {
  if (!V.utterances.has(utteranceId)) return;
  V.utterances.delete(utteranceId);
  emit({ type: 'audio_end', utteranceId });
}

// --------------------------------------------------------------- text chunking

// Maths must survive sentence splitting intact: the full stop in "find $f'(2)$."
// is a sentence end, the one in "$0.5$" is not, and a chunk boundary landing
// inside $...$ would hand the Python side an unparseable fragment.
const MATH_RE = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|```[\s\S]*?```|`[^`\n]+`/g;
const SENT_END = /([.!?…]+["')\]]*)(\s+|$)/g;
const ABBREV_TAIL =
  /(?:^|[\s("'])(?:e\.g|i\.e|etc|vs|cf|approx|resp|no|fig|eq|ch|pp|Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|[A-Za-z])$/;

// A NUL is the one character that cannot occur in model output or inside a
// LaTeX span, so it is safe as a placeholder marker.
const SENTINEL = '\u0000';

function protect(text) {
  const spans = [];
  const out = String(text).replace(MATH_RE, (m) => {
    spans.push(m);
    return `${SENTINEL}M${spans.length - 1}${SENTINEL}`;
  });
  return { out, spans };
}

function restore(text, spans) {
  return text.replace(new RegExp(`${SENTINEL}M(\\d+)${SENTINEL}`, 'g'), (_, i) => spans[Number(i)] ?? '');
}

/** Split text into speakable chunks on sentence boundaries. Exported for tests. */
export function splitSentences(text) {
  if (!text || !String(text).trim()) return [];
  const { out, spans } = protect(text);
  const pieces = [];

  for (const para of out.split(/\n\s*\n/)) {
    if (!para.trim()) continue;
    let start = 0;
    SENT_END.lastIndex = 0;
    let m;
    while ((m = SENT_END.exec(para)) !== null) {
      if (ABBREV_TAIL.test(para.slice(start, m.index))) continue;
      const piece = para.slice(start, m.index + m[1].length).trim();
      if (piece) pieces.push(piece);
      start = m.index + m[0].length;
      SENT_END.lastIndex = start;
      if (m[0].length === m[1].length && m[2] === '') break;
    }
    const tail = para.slice(start).trim();
    if (tail) pieces.push(tail);
  }

  // Glue runts onto their neighbour, then split anything still oversized at a
  // clause boundary so the first audio lands sooner on a long explanation.
  const merged = [];
  for (const p of pieces) {
    if (merged.length && merged[merged.length - 1].length < MIN_CHUNK_CHARS) {
      merged[merged.length - 1] += ' ' + p;
    } else {
      merged.push(p);
    }
  }
  const sized = [];
  for (const p of merged) {
    if (p.length <= MAX_CHUNK_CHARS) { sized.push(p); continue; }
    let buf = '';
    for (const clause of p.split(/(?<=[,;:])\s+/)) {
      if (buf && (buf + ' ' + clause).length > MAX_CHUNK_CHARS) { sized.push(buf); buf = clause; }
      else buf = buf ? buf + ' ' + clause : clause;
    }
    if (buf) sized.push(buf);
  }

  return sized.map((p) => restore(p, spans).trim()).filter(Boolean);
}

function normaliseMood(mood) {
  const m = String(mood || '').toLowerCase();
  return MOODS.includes(m) ? m : DEFAULT_MOOD;
}

function muted(mode) {
  // Belt and braces: D gates on modeGates(mode).voiceEnabled too, but EXAM must
  // be silent even if a call site forgets.
  return String(mode || '').toUpperCase() === 'EXAM';
}

let autoId = 0;
function nextId() { return `u${Date.now().toString(36)}${(autoId++).toString(36)}`; }

// -------------------------------------------------------------------- speaking

/**
 * The prosody numbers to send with a chunk in this mood: the global speaking
 * rate multiplied by the mood's own, and the mood's pause scale. 1.0 / 1.0 is
 * the untouched tts/prosody.py preset.
 */
export function prosodyFor(mood) {
  const m = normaliseMood(mood);
  const per = V.opts.prosody?.[m] ?? {};
  const perRate = Number.isFinite(Number(per.rate)) ? Number(per.rate) : 1;
  const perPause = Number.isFinite(Number(per.pause)) ? Number(per.pause) : 1;
  return {
    rate: round3(clamp(V.opts.rate * perRate, 0.5, 2)),
    pause: round3(clamp(perPause, 0.3, 3)),
  };
}

function enqueue(utteranceId, chunks, mood) {
  const u = track(utteranceId);
  const { rate, pause } = prosodyFor(mood);
  for (const text of chunks) {
    // "Short lines only": the first chunk of a reply is ALWAYS spoken, and once
    // maxChars of it has been said the rest of the turn is written but silent.
    // A long explanation therefore gets an opening sentence, not a monologue.
    if (!V.opts.longForm && u.chars >= V.opts.maxChars) { u.truncated = true; continue; }
    u.chars += text.length;
    const req = { op: 'speak', utteranceId, seq: u.sent, text, mood, rate, pause };
    u.sent += 1;
    if (V.status === 'ready') send(req);
    else if (V.preReady.length < MAX_PREREADY) V.preReady.push(req); // drains on `ready`; bounded so a hung load can't grow it forever
  }
}

/**
 * Speak `text`. Splits on sentence boundaries and hands each chunk to the
 * worker immediately, so sentence n is synthesised while n+1 is still being
 * written. Resolves once everything is queued: never waits for audio, and never
 * blocks the model turn.
 */
export async function speak({ text, mood, mode, utteranceId } = {}) {
  const id = utteranceId || nextId();
  try {
    if (muted(mode)) return id;
    if (V.status === 'degraded' || V.status === 'off') return id;
    const chunks = splitSentences(text);
    if (!chunks.length) return id;
    enqueue(id, chunks, normaliseMood(mood));
    const u = track(id);
    u.complete = true;
    maybeFinish(id);
    return id;
  } catch (err) {
    warn('speak failed:', err.message);
    finish(id);
    return id;
  }
}

/** Stop an utterance: drop what is queued and close it out for the client. */
export function cancelSpeech(utteranceId) {
  if (!utteranceId) return;
  try {
    const u = V.utterances.get(utteranceId);
    if (u) u.cancelled = true;
    for (let i = V.preReady.length - 1; i >= 0; i--) {
      if (V.preReady[i].utteranceId === utteranceId) V.preReady.splice(i, 1);
    }
    send({ op: 'cancel', utteranceId });
    finish(utteranceId);
  } catch (err) {
    warn('cancel failed:', err.message);
  }
}

/**
 * Streaming form of speak(), for assistant_delta. Push deltas as they arrive;
 * each completed sentence is dispatched at once rather than waiting for the
 * whole turn. Additive to C2, and the recommended assistant_delta wiring.
 */
export function createSpeechStream({ mood, mode, utteranceId } = {}) {
  const id = utteranceId || nextId();
  const m = normaliseMood(mood);
  const silent = muted(mode);
  let buf = '';
  let started = false;

  const flushComplete = () => {
    // Dispatch only text up to the last settled sentence terminator; the tail
    // may still be growing.
    const { out, spans } = protect(buf);
    let cut = -1;
    SENT_END.lastIndex = 0;
    let mm;
    while ((mm = SENT_END.exec(out)) !== null) {
      if (mm[2] === '') break;               // terminator at the very end: not settled yet
      if (ABBREV_TAIL.test(out.slice(0, mm.index))) continue;
      cut = mm.index + mm[0].length;
    }
    if (cut <= 0) return;
    const ready = restore(out.slice(0, cut), spans);
    buf = restore(out.slice(cut), spans);
    const chunks = splitSentences(ready);
    if (chunks.length) { started = true; enqueue(id, chunks, m); }
  };

  return {
    utteranceId: id,
    push(delta) {
      try {
        if (silent || !delta) return;
        if (V.status === 'degraded' || V.status === 'off') return;
        buf += delta;
        flushComplete();
      } catch (err) { warn('stream push failed:', err.message); }
    },
    end() {
      try {
        if (silent) return id;
        const chunks = splitSentences(buf);
        buf = '';
        if (chunks.length && V.status !== 'degraded' && V.status !== 'off') {
          started = true;
          enqueue(id, chunks, m);
        }
        if (!started) return id;
        const u = track(id);
        u.complete = true;
        maybeFinish(id);
      } catch (err) { warn('stream end failed:', err.message); finish(id); }
      return id;
    },
    cancel() { cancelSpeech(id); },
  };
}

// ------------------------------------------------------------------- line bank

let lineBank = null;

/** The parsed line bank, or an empty one if the file is missing or broken. */
export function getLineBank() {
  if (lineBank) return lineBank;
  try {
    lineBank = JSON.parse(fs.readFileSync(LINEBANK_FILE, 'utf8'));
    if (!Array.isArray(lineBank.lines)) lineBank.lines = [];
  } catch (err) {
    warn(`line bank unavailable (${err.message})`);
    lineBank = { lines: [] };
  }
  lineBank.byId = new Map(lineBank.lines.map((l) => [l.id, l]));
  return lineBank;
}

/** Look up a fixed line's text without speaking it. */
export function lineText(id) {
  return getLineBank().byId.get(id)?.text ?? null;
}

/**
 * Speak one of Monday's fixed lines. Identical to speak() with the bank's text.
 * The instant path is the audio cache, not a separate code path, so there is
 * nothing here that can drift out of sync with ordinary speech.
 */
export async function speakLine({ id, mood, mode, utteranceId } = {}) {
  const entry = getLineBank().byId.get(id);
  if (!entry) { warn(`no line ${id}`); return utteranceId || nextId(); }
  return speak({ text: entry.text, mood: mood || entry.mood, mode, utteranceId });
}

/**
 * Pre-render every fixed line into the audio cache, so boot greetings, verdict
 * stems, timer alerts and nudge openers later play with zero synthesis latency.
 * One line at a time through the worker; safe to call repeatedly (already cached
 * lines return in milliseconds). Never throws.
 */
export async function warmLineBank() {
  const bank = getLineBank();
  if (!bank.lines.length) return { rendered: 0, skipped: 0, total: 0 };
  if (!voiceReady()) {
    if (V.status === 'starting') await new Promise((r) => V.readyWaiters.push(r));
    if (!voiceReady()) {
      warn('line bank not warmed: worker unavailable');
      return { rendered: 0, skipped: bank.lines.length, total: bank.lines.length };
    }
  }

  const jobs = [];
  for (const l of bank.lines) {
    const moods = l.moods && l.moods.length ? l.moods : [l.mood || DEFAULT_MOOD];
    for (const m of moods) jobs.push({ id: l.id, text: l.text, mood: normaliseMood(m) });
  }

  const started = Date.now();
  let done = 0;
  // No global onAudio swap: warm utterances (uid `warm:…`) are dropped in emit() by
  // prefix, so real speech during warm-up is unaffected.
  for (const job of jobs) {
    const uid = `warm:${job.id}:${job.mood}`;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      let settled = false;
      const finishOnce = () => { if (settled) return; settled = true; clearInterval(watcher); clearTimeout(t); resolve(); };
      const t = setTimeout(finishOnce, 60000);
      if (t.unref) t.unref();
      const u = track(uid);
      u.sent = 1;
      u.complete = true;
      const watcher = setInterval(() => {
        if (!V.utterances.has(uid) || V.status === 'degraded') finishOnce();
      }, 40);
      if (watcher.unref) watcher.unref();
      const pr = prosodyFor(job.mood);
      if (!send({ op: 'speak', utteranceId: uid, seq: 0, text: job.text, mood: job.mood, rate: pr.rate, pause: pr.pause })) {
        V.utterances.delete(uid);
        finishOnce();
      }
    });
    done += 1;
    if (V.status === 'degraded') break;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`line bank warm: ${done}/${jobs.length} in ${secs}s`);
  return { rendered: done, skipped: jobs.length - done, total: jobs.length };
}

// ------------------------------------------------------------- live settings

/**
 * Adopt the user's voice settings. Called by session.js on every config change
 * and once at boot, so the panel's sliders are the live values and not a copy.
 * Every field is optional and every value is clamped: this is a second gate
 * behind mergeConfig(), not a substitute for it.
 *
 * @param {{rate?:number, longForm?:boolean, maxChars?:number,
 *          prosody?:Record<string,{rate?:number,pause?:number}>}} opts
 */
export function setVoiceOptions(opts = {}) {
  try {
    const o = opts ?? {};
    if (Number.isFinite(Number(o.rate))) V.opts.rate = round3(clamp(Number(o.rate), 0.5, 2));
    if (typeof o.longForm === 'boolean') V.opts.longForm = o.longForm;
    if (Number.isFinite(Number(o.maxChars))) V.opts.maxChars = Math.round(clamp(Number(o.maxChars), 40, 20000));
    if (o.prosody && typeof o.prosody === 'object') {
      const next = {};
      for (const mood of MOODS) {
        const p = o.prosody[mood];
        if (!p || typeof p !== 'object') continue;
        next[mood] = {
          rate: Number.isFinite(Number(p.rate)) ? round3(clamp(Number(p.rate), 0.5, 2)) : 1,
          pause: Number.isFinite(Number(p.pause)) ? round3(clamp(Number(p.pause), 0.3, 3)) : 1,
        };
      }
      V.opts.prosody = next;
    }
  } catch (err) { warn('setVoiceOptions failed:', err.message); }
  return getVoiceOptions();
}

/** The live voice settings, for diagnostics and for the settings pane. */
export function getVoiceOptions() {
  return {
    rate: V.opts.rate,
    longForm: V.opts.longForm,
    maxChars: V.opts.maxChars,
    prosody: JSON.parse(JSON.stringify(V.opts.prosody ?? {})),
  };
}

// --------------------------------------------------------------- audio cache

/** Where the Python worker writes its rendered wavs. Same value on both sides. */
export function voiceCacheDir() { return CACHE_DIR; }

/** { dir, files, bytes } for the DATA section of the settings pane. Never throws. */
export function voiceCacheStats() {
  const out = { dir: CACHE_DIR, files: 0, bytes: 0 };
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.wav')) continue;
      try {
        const st = fs.statSync(path.join(CACHE_DIR, f));
        if (!st.isFile()) continue;
        out.files += 1;
        out.bytes += st.size;
      } catch { /* raced with an eviction */ }
    }
  } catch { /* no cache yet — zero is the honest answer */ }
  return out;
}

/**
 * Delete every rendered wav. Only `*.wav` directly inside the cache directory:
 * no recursion, no globbing outside it, nothing else removed. Losing the cache
 * costs re-synthesis time and nothing else.
 */
export function clearVoiceCache() {
  const before = voiceCacheStats();
  let removed = 0;
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (!f.endsWith('.wav')) continue;
      const abs = path.join(CACHE_DIR, f);
      // Refuse anything that is not a plain file sitting directly in the cache.
      if (path.dirname(abs) !== CACHE_DIR) continue;
      try {
        if (!fs.statSync(abs).isFile()) continue;
        fs.rmSync(abs, { force: true });
        removed += 1;
      } catch { /* already gone */ }
    }
  } catch { /* no cache directory: nothing to clear */ }
  log(`cache cleared: ${removed} files, ${(before.bytes / 1e6).toFixed(1)} MB`);
  return { removed, bytes: before.bytes, dir: CACHE_DIR, after: voiceCacheStats() };
}

// The exam's event recorder.
//
// The point of the simulator is as much the record as the sitting: the app's timing axis
// has never had a single real timed attempt to work with. So this captures everything the
// screen can see — every selection and re-selection, every revisit, every flag, every
// click including the ones that hit nothing — and ships it in batches.
//
// One rule governs the design: LOSING TELEMETRY MUST NEVER LOSE AN ANSWER. Answers go
// through /api/exam/answer on their own, synchronously. Everything here is best-effort.

const FLUSH_MS = 5000;
const MAX_BUFFER = 5000;   // a two-hour sitting produces low hundreds; this is a runaway guard
const CLICK_HZ = 20;       // coalesce pointer spam rather than record every pixel

let sittingId = null;
let startedAt = 0;
let buffer = [];
let timer = null;
let lastClick = 0;

const now = () => Date.now();
export const since = () => (startedAt ? now() - startedAt : 0);

/** A short, stable description of what was clicked — enough to replay intent, not a DOM dump. */
function describe(el) {
  if (!el || !el.closest) return 'none';
  const named = el.closest('[data-tele]');
  if (named) return named.getAttribute('data-tele');
  const tag = (el.tagName || '?').toLowerCase();
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : '';
  return `${tag}${cls}`;
}

export function start(id, startedAtMs) {
  sittingId = id;
  startedAt = startedAtMs || now();
  buffer = [];
  if (timer) clearInterval(timer);
  timer = setInterval(() => flush(), FLUSH_MS);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  return flush();
}

export function record(type, payload = {}) {
  if (!sittingId) return;
  if (buffer.length >= MAX_BUFFER) buffer.shift();
  buffer.push({ t: since(), type, ...payload });
}

/** Raw pointer trail, including clicks that hit no control — misses are signal too. */
export function recordClick(e) {
  const t = now();
  if (t - lastClick < 1000 / CLICK_HZ) return;
  lastClick = t;
  record('click', { x: Math.round(e.clientX), y: Math.round(e.clientY), target: describe(e.target) });
}

export async function flush({ beacon = false } = {}) {
  if (!sittingId || !buffer.length) return true;
  const events = buffer;
  buffer = [];
  const body = JSON.stringify({ sittingId, events });

  if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // text/plain so the browser sends it without a preflight; the server parses the body
    // regardless of content-type, exactly as /api/annotations does for the same reason.
    const ok = navigator.sendBeacon('/api/exam/events', new Blob([body], { type: 'text/plain' }));
    if (!ok) buffer = events.concat(buffer);
    return ok;
  }

  try {
    const res = await fetch('/api/exam/events', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true,
    });
    if (!res.ok) throw new Error(String(res.status));
    return true;
  } catch {
    // Put them back at the HEAD: a transient failure should not reorder the timeline.
    buffer = events.concat(buffer).slice(-MAX_BUFFER);
    return false;
  }
}

/**
 * Attention tracking. Idle is 45s without pointer, key or scroll — long enough that
 * thinking hard about a question is not "idle", short enough to catch him leaving the desk.
 */
const IDLE_MS = 45000;

export function attach(root) {
  if (!root) return () => {};
  let idleAt = null;
  let lastAct = now();

  const activity = () => {
    lastAct = now();
    if (idleAt) { record('idle_end', { ms: lastAct - idleAt }); idleAt = null; }
  };
  const idleTick = setInterval(() => {
    if (!idleAt && now() - lastAct > IDLE_MS) { idleAt = lastAct + IDLE_MS; record('idle_start'); }
  }, 5000);

  const onClick = (e) => { activity(); recordClick(e); };
  const onKey = () => activity();
  const onScroll = () => activity();
  const onBlur = () => { record('blur'); flush(); };
  const onFocus = () => { activity(); record('focus'); };
  const onHide = () => { if (document.visibilityState === 'hidden') flush({ beacon: true }); };
  const onPageHide = () => flush({ beacon: true });

  root.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  root.addEventListener('scroll', onScroll, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  return () => {
    clearInterval(idleTick);
    root.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    root.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
  };
}

// The exam always opens in its own full-screen Chrome window: nothing else on screen, as in
// the test centre. (His standing preference, 10 Oct.)
//
// Chrome runs it under a dedicated profile, for two reasons. Launch flags such as
// --start-fullscreen only apply when Chrome STARTS, and a separate profile is a separate
// Chrome process, so they take effect even while his everyday Chrome is open. And the
// break-between-papers state lives in that profile's localStorage, so it must always be the
// same one.
//
// A second click must not stack a second window over a sitting in progress. The profile is
// started with a local-only DevTools port, through which an existing exam window is found,
// made full screen and brought to the front instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app';
const PROFILE = path.join(os.homedir(), 'Library', 'Application Support', 'Monday Exam Chrome');
const DEVTOOLS_PORT = 9400;
const ORIGIN = 'http://localhost:3941';
const ACTIVATE_BIN = path.join(PROFILE, 'activate');

const run = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

async function devtools(route, ms = 600) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}${route}`, { signal: ctl.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** One browser-level DevTools session: send each command in turn, then close. */
async function browserCommands(wsUrl, commands) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params }));
  });
  try { return await commands(send); } finally { ws.close(); }
}

/** Bring the exam Chrome to the front — by pid, so his everyday Chrome is never the one raised. */
async function activate() {
  try {
    const pids = (await run('pgrep', ['-f', `--user-data-dir=${PROFILE}`])).split('\n').map(Number).filter(Boolean);
    if (!pids.length) return;
    if (!fs.existsSync(ACTIVATE_BIN)) {
      const src = path.join(PROFILE, 'activate.swift');
      fs.writeFileSync(src, 'import AppKit\nfor a in CommandLine.arguments.dropFirst() { if let p = Int32(a), let app = NSRunningApplication(processIdentifier: p) { app.activate(options: [.activateAllWindows]) } }\n');
      await run('xcrun', ['swiftc', '-O', src, '-o', ACTIVATE_BIN]);
    }
    await run(ACTIVATE_BIN, pids.map(String));
  } catch { /* focusing is a nicety; the window is already open */ }
}

/**
 * Open (or re-show) the exam window at `route`. Resolves to how it was done, or rejects
 * when Chrome is not available so the caller can fall back to an ordinary browser tab.
 */
const examPages = async () => ((await devtools('/json/list')) ?? [])
  .filter((t) => t.type === 'page' && t.url.startsWith(`${ORIGIN}/exam`));

/** Full screen + to the front, through the browser-level DevTools session. */
async function showFullscreen(targetId) {
  const version = await devtools('/json/version');
  if (!version?.webSocketDebuggerUrl) return;
  await browserCommands(version.webSocketDebuggerUrl, async (send) => {
    const win = (await send('Browser.getWindowForTarget', { targetId })).result;
    if (win?.windowId && win.bounds?.windowState !== 'fullscreen') {
      // A window has to be 'normal' before it can change to another state.
      if (win.bounds?.windowState !== 'normal') await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'normal' } });
      await send('Browser.setWindowBounds', { windowId: win.windowId, bounds: { windowState: 'fullscreen' } });
    }
    await send('Target.activateTarget', { targetId });
  });
  await activate();
}

/**
 * Open (or re-show) the exam window at `route`. Resolves to how it was done, or rejects
 * when Chrome is not available so the caller can fall back to an ordinary browser tab.
 */
export async function openExamWindow(route = '/exam') {
  if (!String(route).startsWith('/exam')) throw new Error('not an exam route');
  if (process.platform !== 'darwin' || !fs.existsSync(CHROME)) throw new Error('Google Chrome is not installed');
  const url = `${ORIGIN}${route}`;

  // An exam window is already open: bring it back. Mid-sitting (/exam?id=…, which includes
  // the break between papers) it is never navigated away; otherwise it moves to `route`.
  const open = await examPages();
  if (open.length) {
    const page = open[0];
    const here = new URL(page.url);
    if (!(here.pathname === '/exam' && here.searchParams.has('id')) && page.url !== url) {
      await browserCommands(page.webSocketDebuggerUrl, (send) => send('Page.navigate', { url }));
    }
    await showFullscreen(page.id);
    return { via: 'existing-window' };
  }

  // None open. --app gives a bare window (no tabs, no address bar). If the exam profile is
  // already running with no windows, Chrome hands these arguments to that process, which
  // opens the app window there; --start-fullscreen is then not applied, so full screen is
  // set through DevTools once the page exists, in every case.
  fs.mkdirSync(PROFILE, { recursive: true });
  await run('open', ['-na', CHROME, '--args',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${DEVTOOLS_PORT}`,
    `--app=${url}`, '--start-fullscreen', '--no-first-run', '--no-default-browser-check']);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const [page] = await examPages();
    if (page) {
      await new Promise((r) => setTimeout(r, 400));     // let the window finish appearing
      await showFullscreen(page.id);
      return { via: 'launched' };
    }
  }
  return { via: 'launched', note: 'window did not report in time; it may not be full screen' };
}

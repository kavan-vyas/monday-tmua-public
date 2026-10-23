// Boot the real index.js in a sandbox, on a spare port, as a child process.
// Nothing here touches the live app on :3941 or the real tutor_data tree.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';

/**
 * An OS-assigned free port.
 *
 * This is a hint, not a reservation: the socket has to be closed before the number can be
 * handed out, and node --test runs test FILES IN PARALLEL, so two e2e suites could be
 * given the same port microseconds apart and the loser died with EADDRINUSE. bootServer
 * therefore treats a port as disposable and retries with a fresh one.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * @param {ReturnType<import('./sandbox.mjs').makeSandbox>} sbx  built with { port }
 * @returns {Promise<{proc, port, log:()=>string, stop:()=>Promise<void>}>}
 */
/** Rewrite the port literal the sandbox baked into its copy of index.js. */
function patchPort(entry, port) {
  const src = fs.readFileSync(entry, 'utf8');
  const next = src.replace(/const PORT = \d+;/, `const PORT = ${port};`);
  if (next === src) throw new Error('boot: could not find the PORT literal to repoint');
  fs.writeFileSync(entry, next);
}

export async function bootServer(sbx, port, { timeoutMs = 20000, env = {}, attempts = 4 } = {}) {
  const entry = path.join(sbx.serverDir, 'index.js');
  if (!fs.existsSync(entry)) throw new Error('boot: no index.js in the sandbox');

  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      port = await freePort();
      patchPort(entry, port);
    }
    try {
      return await spawnOnce(sbx, entry, port, timeoutMs, env);
    } catch (e) {
      lastErr = e;
      // Only a port collision is worth another go; a genuine boot failure is not.
      if (!/EADDRINUSE|address already in use/i.test(String(e.message))) throw e;
    }
  }
  throw lastErr;
}

async function spawnOnce(sbx, entry, port, timeoutMs, env) {
  const proc = spawn(process.execPath, [entry], {
    cwd: sbx.appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Voice must not be a boot dependency: point it at nothing on purpose.
      MONDAY_PYTHON: '/nonexistent/no/python/here',
      MONDAY_VOICE_READY_MS: '300',
      MONDAY_VOICE_CACHE: path.join(sbx.root, '.voicecache'),
      ...env,
    },
  });

  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });

  const started = Date.now();
  for (;;) {
    if (out.includes(`http://localhost:${port}`)) break;
    if (proc.exitCode != null || /EADDRINUSE/.test(out)) {
      try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      throw new Error(`boot: server exited (${proc.exitCode})\n${out}`);
    }
    if (Date.now() - started > timeoutMs) { proc.kill('SIGKILL'); throw new Error(`boot: timed out\n${out}`); }
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    proc,
    port,
    log: () => out,
    async stop() {
      if (proc.exitCode != null) return;
      proc.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => proc.once('exit', r)),
        new Promise((r) => setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} r(); }, 4000)),
      ]);
    },
  };
}

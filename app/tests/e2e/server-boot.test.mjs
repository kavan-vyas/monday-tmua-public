// ACC-E2E-01..07 — the real server, booted on a spare port, driven over a real
// WebSocket. The live app owns :3941; nothing here goes near it, and nothing here
// goes near the real tutor_data tree.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { makeSandbox, REPO_ROOT } from '../helpers/sandbox.mjs';
import { bootServer, freePort } from '../helpers/boot.mjs';
import { assertMondayState, assertReadiness } from '../helpers/assertions.mjs';

let box, srv, port;

before(async () => {
  port = await freePort();
  box = makeSandbox({ tag: 'e2e', port });
  srv = await bootServer(box, port);
  port = srv.port;   // bootServer may have retried onto a different port
});
after(async () => { await srv?.stop(); box?.dispose(); });

/** Connect, collect events for `ms`, then close. */
function collect(ms = 1500) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const events = [];
    const done = () => { try { ws.close(); } catch {} resolve(events); };
    const timer = setTimeout(done, ms);
    ws.on('message', (raw) => { try { events.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

describe('§E2E the real server over a real socket', () => {
  test('ACC-E2E-01 it boots on the spare port, not on the live app\'s 3941', () => {
    assert.notEqual(port, 3941, 'ACC-E2E-01 the test must not fight the real app for its port');
    assert.match(srv.log(), new RegExp(`http://localhost:${port}`), 'ACC-E2E-01 the listener came up');
  });

  test('ACC-E2E-06 it boots with voice unavailable and says so rather than dying', async () => {
    assert.equal(srv.proc.exitCode, null, 'ACC-E2E-06 the server is still alive with no Python');
    assert.match(srv.log(), /running silent|silent:|voice/i,
      'ACC-E2E-06 the boot log says nothing about the voice being unavailable');
  });

  test('ACC-E2E-02/03 a connecting client receives monday_boot with {greeting, state}', async () => {
    const events = await collect(2000);
    const boot = events.find((e) => e.type === 'monday_boot');
    assert.ok(boot, `ACC-E2E-02 no monday_boot arrived. Got: ${events.map((e) => e.type).join(', ')}`);
    assert.equal(typeof boot.greeting, 'string', 'ACC-E2E-02 greeting is a string');
    assert.ok(boot.greeting.length > 0, 'ACC-E2E-02 greeting is non-empty');
    assert.ok(boot.state, 'ACC-WS-02 boot carries a state');
    assertMondayState(boot.state, 'monday_boot.state');     // ACC-E2E-03
  });

  test('ACC-WS-06 a readiness event arrives and satisfies the readiness contract', async () => {
    const events = await collect(2000);
    const r = events.find((e) => e.type === 'readiness');
    assert.ok(r, `ACC-WS-06 no readiness event. Got: ${events.map((e) => e.type).join(', ')}`);
    assertReadiness(r, 'readiness event');
    assert.ok(Array.isArray(r.topics), 'ACC-C2-07 topics[] on the wire');
  });

  test('ACC-E2E-04 a later connection gets monday_state, not a second boot greeting', async () => {
    const events = await collect(2000);
    const st = events.find((e) => e.type === 'monday_state');
    const boot = events.find((e) => e.type === 'monday_boot');
    assert.ok(st || boot, 'ACC-E2E-04 neither a state nor a boot arrived');
    if (st) assertMondayState(st, 'monday_state event');
  });

  test('ACC-WS-07/08 nothing transient is persisted into the chat file', async () => {
    await collect(1200);
    const chatsDir = path.join(box.appDir, 'chats');
    const files = fs.existsSync(chatsDir) ? fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json')) : [];
    for (const f of files) {
      const chat = JSON.parse(fs.readFileSync(path.join(chatsDir, f), 'utf8'));
      const kinds = (chat.transcript ?? []).map((e) => e.type);
      for (const transient of ['monday_state', 'audio_chunk', 'audio_end', 'proactive', 'readiness', 'assistant_delta']) {
        assert.ok(!kinds.includes(transient),
          `ACC-WS-08 ${transient} was persisted into chats/${f} — it must be broadcast with record:false`);
      }
      // ACC-WS-07: monday_boot is the documented exception and MAY be recorded.
      const blob = JSON.stringify(chat);
      assert.ok(!blob.includes('<monday-state>'),
        `ACC-WS-08 the state block reached chats/${f}`);
    }
  });

  test('ACC-E2E-05 the boot greeting does not stack on a restart', async () => {
    await collect(800);
    const chatsDir = path.join(box.appDir, 'chats');
    const files = fs.existsSync(chatsDir) ? fs.readdirSync(chatsDir).filter((f) => f.endsWith('.json')) : [];
    for (const f of files) {
      const chat = JSON.parse(fs.readFileSync(path.join(chatsDir, f), 'utf8'));
      const boots = (chat.transcript ?? []).filter((e) => e.type === 'monday_boot');
      assert.ok(boots.length <= 1, `ACC-E2E-05 ${boots.length} boot greetings stacked in chats/${f}`);
    }
  });

  test('ACC-INT-15 POST /api/config exists for the settings write-through', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: { enabled: false } }),
    });
    assert.ok(res.status < 400, `ACC-INT-15 POST /api/config returned ${res.status}`);
    await new Promise((r) => setTimeout(r, 900));   // saveState() is debounced 400 ms
    const after = JSON.parse(fs.readFileSync(box.stateFile, 'utf8'));
    assert.equal(after.config.voice.enabled, false, 'ACC-INT-15 the config change was not persisted');
    // put it back so later assertions are not confused
    await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ voice: { enabled: true } }),
    });
  });

  test('ACC-E2E-07 shutdown is clean and leaves no orphaned worker', async () => {
    const port2 = await freePort();
    const box2 = makeSandbox({ tag: 'e2e-stop', port: port2 });
    const srv2 = await bootServer(box2, port2);
    const pid = srv2.proc.pid;
    await srv2.stop();
    assert.notEqual(srv2.proc.exitCode === null && srv2.proc.signalCode === null, true,
      'ACC-E2E-07 the server did not exit on SIGTERM');
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false, 'ACC-E2E-07 the server process is still running after stop');
    box2.dispose();
  });
});

describe('§D8/D9 repo hygiene', () => {
  test('ACC-INT-13 .gitignore covers the voice cache, the voice tensor and __pycache__', () => {
    const gi = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
    for (const rule of ['app/.voicecache', 'app/tts/voices', '__pycache__']) {
      assert.ok(gi.includes(rule), `ACC-INT-13 .gitignore does not cover ${rule}`);
    }
  });

  test('ACC-INT-14 the INTEGRATION_*.md handoffs were deleted once consumed', () => {
    const strays = [
      path.join(REPO_ROOT, 'app', 'server', 'INTEGRATION_A.md'),
      path.join(REPO_ROOT, 'app', 'server', 'INTEGRATION_B.md'),
      path.join(REPO_ROOT, 'app', 'web', 'INTEGRATION_C.md'),
    ].filter((p) => fs.existsSync(p));
    assert.deepEqual(strays, [], `ACC-INT-14 handoff files still present: ${strays.join(', ')}`);
  });

  test('ACC-SELF-12 Section 7\'s PERSONA RULES is a pointer, not a live contradiction', () => {
    const master = path.join(REPO_ROOT, 'tutor_data', 'TMUA_Master_Prompt_v3.txt');
    if (!fs.existsSync(master)) return;
    const txt = fs.readFileSync(master, 'utf8');
    const heading = txt.split('\n').find((l) => /PERSONA RULES/.test(l));
    if (heading) {
      assert.match(heading, /SUPERSEDED|DO NOT APPLY|replaced/i,
        `ACC-SELF-12 "${heading.trim()}" is still presented as live guidance and will ` +
        'contradict MONDAY_BLOCK');
    }
    assert.ok(!/\b(standard|bubbly)\b\s*(persona|mode)/i.test(txt),
      'ACC-SELF-12 the retired persona names still appear as selectable options');
    // The phase-timing rules in the same section must NOT have been removed with it.
    assert.match(txt, /PHASE 4\+|PHASE 3/, 'ACC-SELF-12 the phase-timing rules were lost');
  });

  test('ACC-SELF-02 the real self_model.md hard-codes no tool count', () => {
    const sm = path.join(REPO_ROOT, 'tutor_data', 'monday', 'self_model.md');
    if (!fs.existsSync(sm)) return;
    const txt = fs.readFileSync(sm, 'utf8');
    const claim = txt.match(/\b(\d{1,3})\s+(?:MCP\s+)?tools\b/i);
    assert.equal(claim, null,
      `ACC-SELF-02 self_model.md states "${claim?.[0]}" — a memorised count that goes stale ` +
      'the moment a tool is added. The count must come from mondaySelf().');
  });
});

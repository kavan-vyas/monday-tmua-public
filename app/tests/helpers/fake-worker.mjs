// A stand-in for tts/monday_tts.py --serve.
//
// voice.js spawns `${MONDAY_PYTHON} ${WORKER} --serve` and talks newline-JSON
// over the pipes. That is the only seam between the settings and the actual
// synthesiser, so this script sits in it: it announces `ready`, then answers
// every speak request with an `audio` frame whose payload is the base64 of the
// request itself.
//
// A test can therefore read back, byte for byte, what the server asked the
// synthesiser to say — which chunks, in which order, at which rate and with
// which pause scale. A prosody control that moves a number but never reaches
// here fails visibly instead of looking fine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const SCRIPT = `
import sys, json, base64
sys.stdout.write(json.dumps({"type":"ready","ms":1,"device":"fake","voiceHash":"fake","planVersion":0,"moods":[]}) + "\\n")
sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except Exception:
        continue
    op = msg.get("op")
    if op == "shutdown":
        break
    if op != "speak":
        continue
    payload = base64.b64encode(json.dumps(msg, sort_keys=True).encode()).decode()
    sys.stdout.write(json.dumps({
        "type": "audio", "utteranceId": msg.get("utteranceId"), "seq": msg.get("seq", 0),
        "mime": "application/json", "b64": payload, "ms": 1, "cached": False,
    }) + "\\n")
    sys.stdout.flush()
`;

/**
 * Write an executable that behaves like the worker and hand back the path to
 * use as MONDAY_PYTHON. It ignores the worker path argv voice.js passes it,
 * which is exactly what a real interpreter would not do — but the worker file
 * still has to exist, or voice.js degrades before spawning anything.
 */
export function makeFakePython(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const py = path.join(dir, 'fake_worker.py');
  fs.writeFileSync(py, SCRIPT);
  const sh = path.join(dir, 'fake-python');
  fs.writeFileSync(sh, `#!/bin/sh\nexec ${process.env.MONDAY_TEST_PYTHON || 'python3'} ${JSON.stringify(py)}\n`);
  fs.chmodSync(sh, 0o755);
  return sh;
}

/** Decode the audio_chunk frames this worker produced back into speak requests. */
export function requestsFrom(events) {
  return events
    .filter((e) => e.type === 'audio_chunk' && e.mime === 'application/json')
    .map((e) => JSON.parse(Buffer.from(e.b64, 'base64').toString('utf8')));
}

/** Somewhere disposable to put the script. */
export function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `monday-fakeworker-${tag}-`));
}

/** Wait until `fn()` is true, or give up. Returns whether it came true. */
export async function until(fn, ms = 4000) {
  const started = Date.now();
  for (;;) {
    if (fn()) return true;
    if (Date.now() - started > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Drain a readline over a stream — unused by default, kept for debugging. */
export function lines(stream, onLine) {
  createInterface({ input: stream }).on('line', onLine);
}

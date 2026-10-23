// ACC-VOICE-60..71 — the real audio path.
//
// The Python worker is spawned for real and a real utterance is synthesised, so
// what is asserted here is genuine WAV bytes on the genuine event contract:
// every audio_chunk.b64 must decode as a COMPLETE standalone WAV, seq must start
// at 0 and be contiguous, and audio_end must close the utterance exactly once.
//
// Skips (rather than fails) if the model is not available on this machine — a
// missing model is what the ACC-VOICE-50..55 degradation tests are for.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { assertStandaloneWav, assertSeqContiguousFromZero } from '../helpers/assertions.mjs';

const READY_MS = 90000;
let sbx, voice, ready, cacheDir;
const seen = [];

before(async () => {
  cacheDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'monday-voicecache-'));
  process.env.MONDAY_VOICE_CACHE = cacheDir;
  process.env.MONDAY_VOICE_READY_MS = String(READY_MS);
  delete process.env.MONDAY_PYTHON;                     // the real interpreter
  sbx = makeSandbox({ tag: 'wav' });
  voice = await sbx.imp('voice.js');
  ready = await voice.startVoice({ onAudio: (e) => seen.push(e) });
});

after(async () => {
  try { await voice?.stopVoice(); } catch {}
  sbx?.dispose();
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch {}
  delete process.env.MONDAY_VOICE_CACHE;
  delete process.env.MONDAY_VOICE_READY_MS;
});

/** Speak and wait for audio_end, or give up. */
async function utter(id, text, mood = 'focused', timeoutMs = 120000) {
  const before = seen.length;
  await voice.speak({ text, mood, mode: 'DRILL', utteranceId: id });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (seen.some((e) => e.type === 'audio_end' && e.utteranceId === id)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return seen.slice(before).filter((e) => e.utteranceId === id);
}

describe('§A2/§C3 the audio_chunk contract, against real synthesis', () => {
  test('the worker came up (otherwise the rest is skipped)', (t) => {
    if (!ready) t.skip(`voice worker unavailable: ${JSON.stringify(voice.voiceStatus())}`);
    else assert.equal(voice.voiceReady(), true);
  });

  test('ACC-VOICE-60..67 a real utterance satisfies the whole chunk contract', async (t) => {
    if (!ready) return t.skip('voice worker unavailable');
    const events = await utter(
      'wav-1',
      'Given $f(x)=\\frac{x^2-1}{x-2}$, find the derivative at two. ' +
      'That is a quotient, so use the quotient rule. Then check the sign carefully.',
    );

    const chunks = events.filter((e) => e.type === 'audio_chunk');
    const ends = events.filter((e) => e.type === 'audio_end');

    assert.ok(chunks.length > 0, 'ACC-VOICE-60 no audio_chunk arrived');

    // ACC-VOICE-60 — exact payload shape.
    for (const c of chunks) {
      assert.deepEqual(
        Object.keys(c).sort(),
        ['b64', 'mime', 'ms', 'seq', 'type', 'utteranceId'],
        `ACC-VOICE-60 chunk ${c.seq} has the wrong field set: ${Object.keys(c).join(', ')}`,
      );
      assert.equal(c.type, 'audio_chunk', 'ACC-VOICE-60 type');
      assert.equal(c.mime, 'audio/wav', `ACC-VOICE-60 mime is ${c.mime}, contract says audio/wav`);
      assert.equal(c.utteranceId, 'wav-1', 'ACC-VOICE-60 utteranceId');
      assert.equal(typeof c.ms, 'number', 'ACC-VOICE-66 ms type');
      assert.ok(c.ms > 0, `ACC-VOICE-66 chunk ${c.seq} declares ms=${c.ms}`);
      assert.equal(typeof c.b64, 'string', 'ACC-VOICE-60 b64 type');
    }

    // ACC-VOICE-61/62 — seq starts at 0 and is contiguous.
    assertSeqContiguousFromZero(chunks.map((c) => c.seq), 'wav-1');

    // ACC-VOICE-63/64/65 — EVERY chunk is a complete standalone WAV, not just the first.
    for (const c of chunks) {
      const buf = assertStandaloneWav(c.b64, `chunk ${c.seq}`);
      // A standalone WAV must be independently openable: 24 kHz mono per §A1 step 4.
      const fmtAt = buf.subarray(12).indexOf('fmt ') + 12;
      const sampleRate = buf.readUInt32LE(fmtAt + 12);
      assert.equal(sampleRate, 24000,
        `ACC-VOICE-05 chunk ${c.seq} declares ${sampleRate} Hz, the pipeline is 24 kHz`);
    }

    // ACC-VOICE-67 — audio_end exactly once, after the last chunk.
    assert.equal(ends.length, 1, `ACC-VOICE-67 ${ends.length} audio_end events for one utterance`);
    assert.deepEqual(Object.keys(ends[0]).sort(), ['type', 'utteranceId'], 'ACC-WS-04 audio_end payload');
    assert.equal(events.indexOf(ends[0]), events.length - 1,
      'ACC-VOICE-67 audio_end did not arrive last');

    // ACC-VOICE-69 — a three-sentence turn streams as more than one chunk.
    assert.ok(chunks.length >= 2,
      `ACC-VOICE-69 a three-sentence utterance produced ${chunks.length} chunk(s); nothing to stream`);
  });

  test('ACC-VOICE-61 a second utterance restarts seq at 0', async (t) => {
    if (!ready) return t.skip('voice worker unavailable');
    const events = await utter('wav-2', 'A short second utterance. And one more sentence for it.');
    const chunks = events.filter((e) => e.type === 'audio_chunk');
    assert.ok(chunks.length > 0, 'setup: audio arrived');
    assertSeqContiguousFromZero(chunks.map((c) => c.seq), 'wav-2');
  });

  test('ACC-VOICE-04 the maths really is converted, not read as LaTeX', async (t) => {
    if (!ready) return t.skip('voice worker unavailable');
    // The plan is what the worker speaks; assert on it directly via the CLI path.
    // monday_tts.py hands fd 1 to the noisy libraries and reports on fd 2, so the
    // plan dump arrives on stderr, not stdout.
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('python3', [
      path.join(sbx.appDir, 'tts', 'monday_tts.py'),
      '--once', 'Given $f(x)=\\frac{x^2-1}{x-2}$.', '--dry-run',
    ], { encoding: 'utf8', env: { ...process.env, MONDAY_VOICE_CACHE: cacheDir } });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.ok(!/\\frac/.test(out), `ACC-VOICE-04 raw LaTeX in the spoken plan: ${out.slice(0, 300)}`);
    assert.match(out, /over/, 'ACC-VOICE-04 the fraction is not spoken as "over"');
  });

  test('ACC-VOICE-42 a repeated line is served from the cache', async (t) => {
    if (!ready) return t.skip('voice worker unavailable');
    const text = 'This exact sentence will be spoken twice in a row.';
    const first = await utter('cache-1', text);
    const t0 = Date.now();
    const second = await utter('cache-2', text);
    const elapsed = Date.now() - t0;
    assert.ok(first.length > 0 && second.length > 0, 'setup: both utterances produced audio');
    const a = first.filter((e) => e.type === 'audio_chunk').map((e) => e.b64.length);
    const b = second.filter((e) => e.type === 'audio_chunk').map((e) => e.b64.length);
    assert.deepEqual(b, a, 'ACC-VOICE-42 the cached render differs from the first — the key is unstable');
    assert.ok(fs.readdirSync(cacheDir).some((f) => /^[0-9a-f]{64}\.wav$/.test(f)),
      'ACC-VOICE-41 nothing was written to the cache under a sha256 name');
    assert.ok(elapsed < 20000, `ACC-VOICE-42 the cached replay took ${elapsed} ms`);
  });

  test('ACC-VOICE-71 cancelSpeech stops one utterance and leaves others alone', async (t) => {
    if (!ready) return t.skip('voice worker unavailable');
    const before = seen.length;
    await voice.speak({
      text: 'A long line that will be cancelled before it can finish speaking. ' +
            'It has several sentences. And another one. And a fourth for good measure.',
      mood: 'focused', mode: 'DRILL', utteranceId: 'cancel-1',
    });
    voice.cancelSpeech('cancel-1');
    await new Promise((r) => setTimeout(r, 1500));
    const after = seen.slice(before).filter((e) => e.utteranceId === 'cancel-1');
    assert.ok(after.some((e) => e.type === 'audio_end'),
      'ACC-VOICE-71 a cancelled utterance must still be closed out so the UI does not hang');

    // A fresh utterance afterwards still works.
    const next = await utter('after-cancel', 'A fresh line after the cancellation. Second sentence here.');
    assert.ok(next.filter((e) => e.type === 'audio_chunk').length > 0,
      'ACC-VOICE-71 cancelling one utterance killed the next');
  });
});

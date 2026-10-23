// ACC-VOICE-50..55 — §A2's hard requirement: "if the worker dies or Python is
// missing, voice.js degrades to a silent no-op and the app keeps working."
// Voice is an enhancement, never a dependency.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox } from '../helpers/sandbox.mjs';

const boxes = [];
after(() => boxes.forEach((b) => b.dispose()));

/** A fresh voice.js with the interpreter pointed wherever we like. */
async function voiceWith(python, { readyMs = 1500 } = {}) {
  const prevPy = process.env.MONDAY_PYTHON;
  const prevMs = process.env.MONDAY_VOICE_READY_MS;
  process.env.MONDAY_PYTHON = python;
  process.env.MONDAY_VOICE_READY_MS = String(readyMs);
  const box = makeSandbox({ tag: 'voice' });
  boxes.push(box);
  const v = await box.imp('voice.js');       // constants are read at module load
  if (prevPy === undefined) delete process.env.MONDAY_PYTHON; else process.env.MONDAY_PYTHON = prevPy;
  if (prevMs === undefined) delete process.env.MONDAY_VOICE_READY_MS; else process.env.MONDAY_VOICE_READY_MS = prevMs;
  return { v, box };
}

const NO_PYTHON = '/nonexistent/definitely/not/a/python';

describe('§A2 silent degradation', () => {
  test('ACC-VOICE-50 startVoice() settles when Python is missing — no throw, no hang', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    const chunks = [];
    const settled = await Promise.race([
      v.startVoice({ onAudio: (e) => chunks.push(e) }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e })),
      new Promise((res) => setTimeout(() => res({ timeout: true }), 8000)),
    ]);
    assert.ok(!settled.timeout, 'ACC-VOICE-50 startVoice() hung with no interpreter');
    assert.equal(settled.ok, true, `ACC-VOICE-50 startVoice() rejected: ${settled.e}`);
    assert.equal(settled.r, false, 'ACC-VOICE-50 it should resolve to "not ready", not to true');
    await v.stopVoice();
  });

  test('ACC-VOICE-51 voiceReady() is false with no interpreter', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    assert.equal(v.voiceReady(), false, 'ACC-VOICE-51 before start');
    await v.startVoice({ onAudio() {} });
    assert.equal(v.voiceReady(), false, 'ACC-VOICE-51 after a failed start');
    await v.stopVoice();
  });

  test('ACC-VOICE-52 speak() resolves silently and emits no audio', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    const chunks = [];
    await v.startVoice({ onAudio: (e) => chunks.push(e) });
    let id;
    await assert.doesNotReject(async () => {
      id = await v.speak({ text: 'Given $f(x)=x^2$, find the derivative.', mood: 'focused', mode: 'DRILL', utteranceId: 'u-silent' });
    }, 'ACC-VOICE-52 speak() threw with voice degraded');
    assert.ok(id, 'ACC-VOICE-52 speak() still returns an utterance id');
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(chunks.filter((c) => c.type === 'audio_chunk').length, 0,
      'ACC-VOICE-52 audio was emitted with no interpreter');
    await v.stopVoice();
  });

  test('ACC-VOICE-53 a worker that dies immediately leaves speak() a silent no-op', async () => {
    // /usr/bin/false exists and exits non-zero at once: a worker that dies on start.
    const { v } = await voiceWith('/usr/bin/false', { readyMs: 800 });
    const chunks = [];
    await v.startVoice({ onAudio: (e) => chunks.push(e) });
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 5; i++) {
        await v.speak({ text: `Sentence ${i}.`, mood: 'sharp', mode: 'DRILL', utteranceId: `dead-${i}` });
      }
    }, 'ACC-VOICE-53 speak() threw after the worker died');
    assert.equal(v.voiceReady(), false, 'ACC-VOICE-53 not ready');
    assert.equal(chunks.filter((c) => c.type === 'audio_chunk').length, 0, 'ACC-VOICE-53 no audio');
    await v.stopVoice();
  });

  test('ACC-VOICE-54 cancelSpeech/stopVoice/warmLineBank are safe before any start', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    assert.doesNotThrow(() => v.cancelSpeech('never-existed'), 'ACC-VOICE-54 cancelSpeech');
    assert.doesNotThrow(() => v.cancelSpeech(undefined), 'ACC-VOICE-54 cancelSpeech(undefined)');
    await assert.doesNotReject(() => v.stopVoice(), 'ACC-VOICE-54 stopVoice');
    await assert.doesNotReject(() => v.warmLineBank(), 'ACC-VOICE-54 warmLineBank');
  });

  test('ACC-VOICE-55 a degraded voice does not stop the rest of the module working', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    await v.startVoice({ onAudio() {} });
    // Sentence splitting is pure and must keep working regardless of the worker.
    const text = 'The first sentence runs on a while. The second sentence does too. And a third.';
    const parts = v.splitSentences(text);
    assert.ok(Array.isArray(parts) && parts.length > 0,
      `ACC-VOICE-55 splitSentences broke under degradation: ${JSON.stringify(parts)}`);
    assert.equal(parts.join(' ').replace(/\s+/g, ' ').trim(), text,
      'ACC-VOICE-55 splitting must preserve the text exactly');
    assert.equal(typeof v.voiceStatus().status, 'string', 'ACC-VOICE-55 status still readable');

    // ACC-VOICE-69: a multi-sentence turn is chunked so sentence n can be
    // synthesised while n+1 is still arriving.
    assert.ok(parts.length >= 2,
      `ACC-VOICE-69 a three-sentence turn produced ${parts.length} chunk(s) — nothing to stream`);
    await v.stopVoice();
  });

  test('ACC-VOICE-56 a degraded engine schedules a self-heal instead of staying silent forever', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    await v.startVoice({ onAudio() {} });            // ENOENT → degrade
    const s = v.voiceStatus();
    assert.equal(s.status, 'degraded', 'ACC-VOICE-56 should be degraded with no interpreter');
    assert.equal(typeof s.healAttempt, 'number', 'ACC-VOICE-56 healAttempt is a number');
    assert.ok(s.healAttempt >= 1, 'ACC-VOICE-56 a heal attempt was scheduled');
    assert.ok(typeof s.retryInSeconds === 'number' && s.retryInSeconds > 0,
      `ACC-VOICE-56 a retry is pending, got retryInSeconds=${s.retryInSeconds}`);
    await v.stopVoice();
    assert.equal(v.voiceStatus().retryInSeconds, null,
      'ACC-VOICE-56 stopVoice cancels the pending self-heal');
  });

  test('ACC-VOICE-57 voiceStatus exposes the self-heal fields', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    const s = v.voiceStatus();
    assert.ok('retryInSeconds' in s, 'ACC-VOICE-57 retryInSeconds present');
    assert.ok('healAttempt' in s, 'ACC-VOICE-57 healAttempt present');
    await v.stopVoice();
  });

  test('ACC-VOICE-52 a speech stream over a degraded voice is inert but well-behaved', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    const chunks = [];
    await v.startVoice({ onAudio: (e) => chunks.push(e) });
    const s = v.createSpeechStream({ mood: 'focused', mode: 'DRILL', utteranceId: 'stream-1' });
    assert.doesNotThrow(() => { s.push('One sentence. '); s.push('And another. '); s.end(); },
      'ACC-VOICE-52 the speech stream threw while degraded');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(chunks.filter((c) => c.type === 'audio_chunk').length, 0, 'ACC-VOICE-52 no audio');
    await v.stopVoice();
  });
});

describe('§A2 EXAM is silent at the voice layer too', () => {
  test('ACC-MODE-05 speak() in EXAM emits nothing even when voice is otherwise available', async () => {
    const { v } = await voiceWith(NO_PYTHON);
    const chunks = [];
    await v.startVoice({ onAudio: (e) => chunks.push(e) });
    await v.speak({ text: 'This must not be spoken.', mood: 'clinical', mode: 'EXAM', utteranceId: 'exam-1' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(chunks.length, 0, 'ACC-MODE-05 EXAM produced audio events');
    await v.stopVoice();
  });
});

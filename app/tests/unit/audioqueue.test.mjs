// ACC-UI-22/23 — the Web Audio queue: gapless scheduling, out-of-order seq tolerated.
// The real MondayAudio class is exercised against a Web Audio double.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_DIR } from '../helpers/sandbox.mjs';
import { installFakeAudio } from '../helpers/fake-audio.mjs';
import { makeWav } from '../helpers/assertions.mjs';

const CHUNK_MS = 100;
let fake, MondayAudio;

before(async () => {
  fake = installFakeAudio({ decodeMs: CHUNK_MS });
  const mod = await import(pathToFileURL(path.join(APP_DIR, 'web', 'src', 'monday', 'audio.js')).href);
  MondayAudio = mod.MondayAudio;
});
after(() => fake.restore());

/** A valid WAV whose final byte marks which chunk it is, so order is checkable. */
function chunk(utteranceId, seq) {
  const wav = makeWav(CHUNK_MS);
  wav[wav.length - 1] = seq;              // marker the fake decoder reads back
  return { utteranceId, seq, mime: 'audio/wav', b64: wav.toString('base64'), ms: CHUNK_MS };
}

describe('§C2 Web Audio queue', () => {
  test('ACC-UI-22 chunks are scheduled gaplessly — each starts where the last ended', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    fake.setTime(0);
    for (let i = 0; i < 5; i++) await a.push(chunk('u1', i));
    a.end('u1');

    assert.equal(fake.scheduled.length, 5, 'ACC-UI-22 every chunk was scheduled');
    for (let i = 1; i < fake.scheduled.length; i++) {
      const gap = fake.scheduled[i].at - (fake.scheduled[i - 1].at + fake.scheduled[i - 1].buffer.duration);
      assert.ok(Math.abs(gap) < 1e-9,
        `ACC-UI-22 gap of ${gap.toFixed(6)}s between chunk ${i - 1} and ${i} — playback must be gapless`);
    }
  });

  test('ACC-UI-23 out-of-order seq is buffered and played in order, not dropped', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    fake.setTime(0);
    // Deliberately scrambled arrival.
    for (const seq of [2, 0, 4, 1, 3]) await a.push(chunk('u2', seq));
    a.end('u2');

    assert.equal(fake.scheduled.length, 5,
      `ACC-UI-23 ${fake.scheduled.length} of 5 out-of-order chunks reached the graph — none may be dropped`);
    const order = fake.scheduled.map((s) => s.buffer.marker);
    assert.deepEqual(order, [0, 1, 2, 3, 4],
      `ACC-UI-23 chunks played in arrival order ${order} rather than seq order`);
  });

  test('ACC-UI-23 a late-arriving chunk 0 releases everything queued behind it', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    fake.setTime(0);
    for (const seq of [1, 2, 3]) await a.push(chunk('u3', seq));
    assert.equal(fake.scheduled.length, 0,
      'ACC-UI-23 chunks 1..3 were played before chunk 0 arrived');
    await a.push(chunk('u3', 0));
    assert.equal(fake.scheduled.length, 4, 'ACC-UI-23 all four released once seq 0 landed');
    assert.deepEqual(fake.scheduled.map((s) => s.buffer.marker), [0, 1, 2, 3], 'ACC-UI-23 in order');
  });

  test('ACC-UI-23 out-of-order chunks stay gapless once released', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    fake.setTime(0);
    for (const seq of [3, 1, 0, 2]) await a.push(chunk('u4', seq));
    for (let i = 1; i < fake.scheduled.length; i++) {
      const gap = fake.scheduled[i].at - (fake.scheduled[i - 1].at + fake.scheduled[i - 1].buffer.duration);
      assert.ok(Math.abs(gap) < 1e-9, `ACC-UI-22/23 gap ${gap} after reordering`);
    }
  });

  test('ACC-VOICE-63 a chunk that is not a standalone WAV is rejected, not played as noise', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    const headerless = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    await a.push({ utteranceId: 'u5', seq: 0, mime: 'audio/wav', b64: headerless.toString('base64'), ms: 10 });
    assert.equal(fake.scheduled.length, 0, 'ACC-VOICE-63 a non-WAV payload was scheduled for playback');
  });

  test('ACC-UI-25 replay re-plays the stored chunks in seq order', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    fake.setTime(0);
    for (const seq of [1, 0, 2]) await a.push(chunk('u6', seq));
    a.end('u6');
    assert.ok(a.hasAudio(['u6']), 'ACC-UI-25 the chunks were stored for replay');
    fake.scheduled.length = 0;
    await a.replay(['u6']);
    assert.deepEqual(fake.scheduled.map((s) => s.buffer.marker), [0, 1, 2], 'ACC-UI-25 replay is in seq order');
  });

  test('ACC-UI-27/26 muting stops audio reaching the graph but keeps it replayable', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    a.setMuted(true);
    for (let i = 0; i < 3; i++) await a.push(chunk('u7', i));
    assert.equal(fake.scheduled.length, 0, 'ACC-UI-27 audio played while muted');
    assert.ok(a.hasAudio(['u7']), 'ACC-UI-26 muted audio is still stored so replay works after unmuting');
  });

  test('ACC-UI-22 a stalled queue restarts the cursor rather than scheduling in the past', async () => {
    const a = new MondayAudio();
    fake.scheduled.length = 0;
    fake.setTime(0);
    await a.push(chunk('u8', 0));
    const first = fake.scheduled[0].at;
    fake.advance(60);                       // a long network stall
    await a.push(chunk('u8', 1));
    const second = fake.scheduled[1].at;
    assert.ok(second >= 60, `ACC-UI-22 the second chunk was scheduled at ${second}, in the past (now 60)`);
    assert.ok(second > first, 'ACC-UI-22 monotonic');
  });
});

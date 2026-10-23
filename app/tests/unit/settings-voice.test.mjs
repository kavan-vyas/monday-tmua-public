// ACC-SETV-01..12 — the voice settings, at the layer that actually sends words
// to the Python worker.
//
// A prosody slider that moves a number in .state.json and never reaches the
// synthesiser is worse than no slider. These tests capture the requests voice.js
// puts on the wire, so "the rate control works" means the worker was told.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeSandbox } from '../helpers/sandbox.mjs';
import { MOODS } from '../helpers/assertions.mjs';
import { makeFakePython, requestsFrom, tmpDir, until } from '../helpers/fake-worker.mjs';

const boxes = [];
const dirs = [];
after(() => {
  boxes.forEach((b) => b.dispose());
  dirs.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } });
});

/** A fresh voice.js in its own sandbox, with no worker behind it. */
async function loadVoice(tag) {
  const box = makeSandbox({ tag });
  boxes.push(box);
  const v = await box.imp('voice.js');
  return { v, box };
}

/**
 * A fresh voice.js talking to the fake worker, plus the frames it emitted.
 * `requests()` decodes those back into the exact speak requests that crossed
 * the pipe.
 */
async function loadSpeakingVoice(tag) {
  const dir = tmpDir(tag);
  dirs.push(dir);
  const prevPy = process.env.MONDAY_PYTHON;
  const prevMs = process.env.MONDAY_VOICE_READY_MS;
  process.env.MONDAY_PYTHON = makeFakePython(dir);
  process.env.MONDAY_VOICE_READY_MS = '6000';
  const box = makeSandbox({ tag });
  boxes.push(box);
  const v = await box.imp('voice.js');
  if (prevPy === undefined) delete process.env.MONDAY_PYTHON; else process.env.MONDAY_PYTHON = prevPy;
  if (prevMs === undefined) delete process.env.MONDAY_VOICE_READY_MS; else process.env.MONDAY_VOICE_READY_MS = prevMs;

  const events = [];
  const ready = await v.startVoice({ onAudio: (e) => events.push(e) });
  return { v, events, ready, requests: () => requestsFrom(events) };
}

describe('§settings — prosody reaches the synthesiser', () => {
  test('ACC-SETV-01 the defaults are the untouched tts/prosody.py preset', async () => {
    const { v } = await loadVoice('sv1');
    const o = v.getVoiceOptions();
    assert.equal(o.rate, 1, 'ACC-SETV-01 rate');
    assert.equal(o.longForm, true, 'ACC-SETV-01 longForm');
    for (const m of MOODS) {
      assert.deepEqual(v.prosodyFor(m), { rate: 1, pause: 1 },
        `ACC-SETV-01 ${m} must plan identically to before these settings existed`);
    }
  });

  test('ACC-SETV-02 the global rate multiplies every mood', async () => {
    const { v } = await loadVoice('sv2');
    v.setVoiceOptions({ rate: 1.2 });
    for (const m of MOODS) {
      assert.equal(v.prosodyFor(m).rate, 1.2, `ACC-SETV-02 ${m} did not follow the global rate`);
    }
  });

  test('ACC-SETV-03 a per-mood rate compounds with the global one', async () => {
    const { v } = await loadVoice('sv3');
    v.setVoiceOptions({ rate: 1.2, prosody: { sharp: { rate: 1.25, pause: 0.5 }, gentle: { rate: 0.8, pause: 2 } } });
    assert.equal(v.prosodyFor('sharp').rate, 1.5, 'ACC-SETV-03 sharp = 1.2 x 1.25');
    assert.equal(v.prosodyFor('sharp').pause, 0.5, 'ACC-SETV-03 pause is per-mood only, never scaled globally');
    assert.equal(v.prosodyFor('gentle').rate, 0.96, 'ACC-SETV-03 gentle = 1.2 x 0.8');
    assert.equal(v.prosodyFor('gentle').pause, 2, 'ACC-SETV-03 gentle pause');
    assert.equal(v.prosodyFor('focused').rate, 1.2, 'ACC-SETV-03 a mood with no entry gets the global rate alone');
  });

  test('ACC-SETV-04 no combination of settings can hand Kokoro an impossible speed', async () => {
    const { v } = await loadVoice('sv4');
    v.setVoiceOptions({ rate: 99, prosody: { sharp: { rate: 99, pause: 99 } } });
    assert.ok(v.prosodyFor('sharp').rate <= 2, 'ACC-SETV-04 rate must be capped at 2x');
    assert.ok(v.prosodyFor('sharp').pause <= 3, 'ACC-SETV-04 pause must be capped at 3x');
    v.setVoiceOptions({ rate: -50, prosody: { sharp: { rate: 0, pause: 0 } } });
    assert.ok(v.prosodyFor('sharp').rate >= 0.5, 'ACC-SETV-04 rate must have a floor');
    assert.ok(v.prosodyFor('sharp').pause >= 0.3, 'ACC-SETV-04 pause must have a floor');
  });

  test('ACC-SETV-05 garbage in setVoiceOptions never throws and never lands', async () => {
    const { v } = await loadVoice('sv5');
    v.setVoiceOptions({ rate: 1.3 });
    v.setVoiceOptions({ rate: 'fast', longForm: 'sure', maxChars: null, prosody: 'loud' });
    assert.equal(v.getVoiceOptions().rate, 1.3, 'ACC-SETV-05 a junk write reset a real setting');
    assert.equal(v.getVoiceOptions().longForm, true, 'ACC-SETV-05 longForm');
    v.setVoiceOptions(null);
    v.setVoiceOptions();
    assert.equal(v.getVoiceOptions().rate, 1.3, 'ACC-SETV-05 still standing');
  });

  test('ACC-SETV-06 an unknown mood cannot be given prosody', async () => {
    const { v } = await loadVoice('sv6');
    v.setVoiceOptions({ prosody: { seductive: { rate: 2 } } });
    assert.ok(!('seductive' in v.getVoiceOptions().prosody), 'ACC-SETV-06');
    assert.deepEqual(v.prosodyFor('seductive'), { rate: 1, pause: 1 },
      'ACC-SETV-06 an unknown mood falls back to focused, unscaled');
  });

  test('ACC-SETV-07 getVoiceOptions hands back a copy, not the live object', async () => {
    const { v } = await loadVoice('sv7');
    const o = v.getVoiceOptions();
    o.rate = 99;
    o.prosody.sharp = { rate: 99, pause: 99 };
    assert.equal(v.getVoiceOptions().rate, 1, 'ACC-SETV-07 the settings were mutable from outside');
    assert.equal(v.prosodyFor('sharp').rate, 1, 'ACC-SETV-07 prosody was mutable from outside');
  });
});

describe('§settings — the audio cache', () => {
  test('ACC-SETV-08 stats report the real directory, and zero when it is empty', async () => {
    const { v, box } = await loadVoice('sv8');
    const st = v.voiceCacheStats();
    assert.equal(typeof st.dir, 'string', 'ACC-SETV-08 dir');
    assert.equal(st.files, 0, 'ACC-SETV-08 a fresh sandbox has no cached audio');
    assert.equal(st.bytes, 0, 'ACC-SETV-08 bytes');
    assert.ok(!st.dir.includes('..'), 'ACC-SETV-08 the reported path must be resolved');
    assert.ok(box, 'sandbox');
  });

  test('ACC-SETV-09 clearing deletes the wavs and nothing else', async () => {
    const { v } = await loadVoice('sv9');
    const dir = v.voiceCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a'.repeat(64) + '.wav'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(dir, 'b'.repeat(64) + '.wav'), Buffer.alloc(1024));
    // Two things that are NOT rendered audio and must survive.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
    fs.mkdirSync(path.join(dir, 'subdir'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'subdir', 'nested.wav'), Buffer.alloc(16));

    const before = v.voiceCacheStats();
    assert.equal(before.files, 2, 'ACC-SETV-09 the two wavs are counted');
    assert.equal(before.bytes, 3072, 'ACC-SETV-09 and their bytes');

    const r = v.clearVoiceCache();
    assert.equal(r.removed, 2, 'ACC-SETV-09 both wavs removed');
    assert.equal(r.after.files, 0, 'ACC-SETV-09 the cache is empty afterwards');
    assert.ok(fs.existsSync(path.join(dir, 'notes.txt')), 'ACC-SETV-09 a non-wav file was deleted');
    assert.ok(fs.existsSync(path.join(dir, 'subdir', 'nested.wav')),
      'ACC-SETV-09 the clear recursed into a subdirectory — it must not');
  });

  test('ACC-SETV-10 clearing a cache that does not exist is a no-op, not a throw', async () => {
    const { v } = await loadVoice('sv10');
    const r = v.clearVoiceCache();
    assert.equal(r.removed, 0, 'ACC-SETV-10');
  });
});

describe('§settings — voice.js still degrades to silence', () => {
  test('ACC-SETV-11 the prosody settings do not make voice a dependency', async () => {
    const { v } = await loadVoice('sv11');
    v.setVoiceOptions({ rate: 1.4, longForm: false, maxChars: 100 });
    // No worker was ever started: every one of these must be a quiet no-op.
    const id = await v.speak({ text: 'One. Two. Three.', mood: 'sharp', mode: 'DRILL' });
    assert.equal(typeof id, 'string', 'ACC-SETV-11 speak() still returns an utterance id');
    const s = v.createSpeechStream({ mood: 'sharp', mode: 'DRILL' });
    s.push('Something. ');
    s.end();
    s.cancel();
    await v.stopVoice();
  });

  test('ACC-SETV-12 EXAM is still silent whatever the prosody settings say', async () => {
    const { v } = await loadVoice('sv12');
    const heard = [];
    await v.startVoice({ onAudio: (e) => heard.push(e) }).catch(() => {});
    v.setVoiceOptions({ rate: 1.4, longForm: true });
    await v.speak({ text: 'This must not be spoken.', mood: 'clinical', mode: 'EXAM' });
    assert.deepEqual(heard.filter((e) => e.type === 'audio_chunk'), [],
      'ACC-SETV-12 EXAM emitted audio');
    await v.stopVoice();
  });
});

describe('§settings — what actually crosses the pipe', () => {
  test('ACC-SETV-13 every chunk carries the rate and pause the settings asked for', async () => {
    const { v, ready, requests } = await loadSpeakingVoice('sv13');
    assert.equal(ready, true, 'ACC-SETV-13 the fake worker did not come up');
    v.setVoiceOptions({ rate: 1.2, prosody: { sharp: { rate: 1.25, pause: 0.5 } } });
    await v.speak({ text: 'First sentence here. Second sentence here. Third one.', mood: 'sharp', mode: 'DRILL' });
    assert.ok(await until(() => requests().length >= 3), 'ACC-SETV-13 the worker never received three chunks');
    const reqs = requests();
    for (const r of reqs) {
      assert.equal(r.mood, 'sharp', 'ACC-SETV-13 mood');
      assert.equal(r.rate, 1.5, 'ACC-SETV-13 the speaking rate never reached the synthesiser');
      assert.equal(r.pause, 0.5, 'ACC-SETV-13 the pause scale never reached the synthesiser');
    }
    assert.deepEqual(reqs.map((r) => r.seq), [0, 1, 2], 'ACC-SETV-13 chunks arrive in order');
    await v.stopVoice();
  });

  test('ACC-SETV-14 a default install sends 1.0 / 1.0 — the preset, untouched', async () => {
    const { v, requests } = await loadSpeakingVoice('sv14');
    await v.speak({ text: 'Nothing has been configured.', mood: 'focused', mode: 'DRILL' });
    assert.ok(await until(() => requests().length >= 1), 'ACC-SETV-14 nothing was sent');
    assert.equal(requests()[0].rate, 1, 'ACC-SETV-14 rate');
    assert.equal(requests()[0].pause, 1, 'ACC-SETV-14 pause');
    await v.stopVoice();
  });

  test('ACC-SETV-15 "short lines only" speaks the opening and then goes quiet', async () => {
    const { v, requests } = await loadSpeakingVoice('sv15');
    v.setVoiceOptions({ longForm: false, maxChars: 60 });
    const long = Array.from({ length: 8 }, (_, i) => `This is explanation sentence number ${i} of a long answer.`).join(' ');
    await v.speak({ text: long, mood: 'focused', mode: 'DRILL' });
    assert.ok(await until(() => requests().length >= 1), 'ACC-SETV-15 nothing was spoken at all');
    await new Promise((r) => setTimeout(r, 250));
    const spoken = requests();
    assert.ok(spoken.length >= 1, 'ACC-SETV-15 the opening line must always be spoken');
    assert.ok(spoken.length <= 2,
      `ACC-SETV-15 the cap did not hold — ${spoken.length} chunks were spoken past a 60-character limit`);
    await v.stopVoice();
  });

  test('ACC-SETV-16 with long form on, the whole answer is spoken', async () => {
    const { v, requests } = await loadSpeakingVoice('sv16');
    v.setVoiceOptions({ longForm: true, maxChars: 60 });
    const long = Array.from({ length: 6 }, (_, i) => `This is explanation sentence number ${i} of a long answer.`).join(' ');
    await v.speak({ text: long, mood: 'focused', mode: 'DRILL' });
    assert.ok(await until(() => requests().length >= 6),
      `ACC-SETV-16 only ${requests().length} of 6 sentences were spoken with the gate open`);
    await v.stopVoice();
  });

  test('ACC-SETV-17 the streaming path honours the same settings', async () => {
    const { v, requests } = await loadSpeakingVoice('sv17');
    v.setVoiceOptions({ rate: 0.8, prosody: { gentle: { rate: 1, pause: 1.5 } } });
    const s = v.createSpeechStream({ mood: 'gentle', mode: 'DRILL' });
    s.push('The first idea is this. ');
    s.push('And here is the second one. ');
    s.end();
    assert.ok(await until(() => requests().length >= 2), 'ACC-SETV-17 the stream sent nothing');
    for (const r of requests()) {
      assert.equal(r.rate, 0.8, 'ACC-SETV-17 rate');
      assert.equal(r.pause, 1.5, 'ACC-SETV-17 pause');
    }
    await v.stopVoice();
  });

  test('ACC-SETV-18 a rate change lands on the next sentence, with no restart', async () => {
    const { v, requests } = await loadSpeakingVoice('sv18');
    await v.speak({ text: 'Before the change.', mood: 'focused', mode: 'DRILL', utteranceId: 'a' });
    assert.ok(await until(() => requests().length >= 1), 'ACC-SETV-18 first utterance');
    v.setVoiceOptions({ rate: 1.4 });
    await v.speak({ text: 'After the change.', mood: 'focused', mode: 'DRILL', utteranceId: 'b' });
    assert.ok(await until(() => requests().length >= 2), 'ACC-SETV-18 second utterance');
    const [first, second] = requests();
    assert.equal(first.rate, 1, 'ACC-SETV-18 the first line was spoken at the old rate');
    assert.equal(second.rate, 1.4, 'ACC-SETV-18 the change did not take effect on the next line');
    await v.stopVoice();
  });
});

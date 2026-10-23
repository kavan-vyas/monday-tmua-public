// A minimal Web Audio double, enough to exercise MondayAudio's queue for real.
// It records every start(at) so gapless scheduling and seq ordering are observable.

export function installFakeAudio({ decodeMs = 100 } = {}) {
  const scheduled = [];         // { buffer, at }
  let currentTime = 0;

  class Param {
    constructor() { this.value = 1; }
    cancelScheduledValues() {}
    setTargetAtTime(v) { this.value = v; }
    setValueAtTime(v) { this.value = v; }
  }
  class Node {
    connect() { return this; }
    disconnect() {}
  }
  class GainNode extends Node { constructor() { super(); this.gain = new Param(); } }
  class AnalyserNode extends Node {
    constructor() { super(); this.fftSize = 1024; this.smoothingTimeConstant = 0; }
    getByteTimeDomainData(buf) { buf.fill(128); }
  }
  class BufferSource extends Node {
    constructor(ctx) { super(); this.ctx = ctx; this.buffer = null; this.onended = null; }
    start(at) { scheduled.push({ buffer: this.buffer, at }); }
    stop() {}
  }
  class FakeContext {
    constructor() { this.state = 'running'; this.destination = new Node(); }
    get currentTime() { return currentTime; }
    createGain() { return new GainNode(); }
    createAnalyser() { return new AnalyserNode(); }
    createBufferSource() { return new BufferSource(this); }
    resume() { return Promise.resolve(); }
    /** Decode is faked: the tag we care about is the chunk's identity + duration. */
    async decodeAudioData(arrayBuffer) {
      const bytes = new Uint8Array(arrayBuffer);
      if (bytes.length < 12) throw new Error('not audio');
      const tag = String.fromCharCode(...bytes.subarray(0, 4));
      if (tag !== 'RIFF') throw new Error('not a RIFF file');
      // Recover the marker byte the test stamped into the data chunk.
      return { duration: decodeMs / 1000, marker: bytes[bytes.length - 1], length: bytes.length };
    }
  }

  const prevWindow = globalThis.window;
  globalThis.window = {
    AudioContext: FakeContext,
    addEventListener() {}, removeEventListener() {},
  };

  return {
    scheduled,
    advance(t) { currentTime += t; },
    setTime(t) { currentTime = t; },
    restore() {
      if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
    },
  };
}

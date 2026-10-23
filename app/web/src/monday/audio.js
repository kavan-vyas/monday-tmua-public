// ═══════════════ MONDAY — Web Audio playback queue ═══════════════
// Consumes the `audio_chunk` / `audio_end` events from plangamma.md §C3:
//   audio_chunk { utteranceId, seq, mime:'audio/wav', b64, ms }
//   audio_end   { utteranceId }
//
// Chunks are sentence-sized and arrive while the model is still talking, so the
// queue has to (a) tolerate out-of-order `seq`, (b) schedule back-to-back with
// no click or gap, and (c) expose one AnalyserNode the orb can read so the ring
// moves with the real waveform instead of a faked animation.
//
//   source(s) ──► gain ──► analyser ──► destination
//
// Everything is best-effort: if the AudioContext cannot start (no user gesture
// yet) or a chunk fails to decode, we drop it and keep the app working. Voice is
// an enhancement, never a dependency.

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// A hair of lead time so the first chunk is scheduled in the future, not in the
// past — scheduling at exactly currentTime produces an audible click.
const LEAD = 0.06;

export class MondayAudio {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.analyser = null;
    this.volume = 0.9;
    this.muted = false;
    this.ducked = false; // mute-while-typing
    /** utteranceId → { chunks: Map<seq, AudioBuffer>, next: seq expected, ended, sources:Set } */
    this.utts = new Map();
    /** utteranceId → [{seq, b64, mime}] kept verbatim so ▶ replay is free */
    this.raw = new Map();
    this.nextStart = 0;
    this.playing = 0; // count of scheduled-but-not-finished sources
    this.listeners = new Set();
    this.blocked = false;   // context can't run yet (no gesture) — surfaced to the UI
    this.pending = [];      // chunks held while blocked, flushed on unlock (never dropped)
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  /** Safe to call repeatedly; the first call inside a user gesture is the one
   *  that actually unlocks audio on Safari/Chrome. */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch { return null; }
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.72;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this._applyGain();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) { try { fn(this); } catch {} } }

  // ── mixing ─────────────────────────────────────────────────────────────────
  _applyGain() {
    if (!this.gain || !this.ctx) return;
    const target = this.muted || this.ducked ? 0 : this.volume;
    const g = this.gain.gain;
    // short ramp, not a step — a hard cut on a live buffer clicks
    try {
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setTargetAtTime(target, this.ctx.currentTime, 0.03);
    } catch { g.value = target; }
  }

  setVolume(v) { this.volume = Math.min(1, Math.max(0, Number(v) || 0)); this._applyGain(); }
  setMuted(m) { this.muted = !!m; this._applyGain(); if (this.muted) this.stopAll(); }
  setDucked(d) { this.ducked = !!d; this._applyGain(); }

  get speaking() { return this.playing > 0; }

  /** Peak-ish level 0..1 from the live waveform. The orb calls this per frame. */
  level() {
    if (!this.analyser || this.playing === 0) return 0;
    const n = this.analyser.fftSize;
    if (!this._buf || this._buf.length !== n) this._buf = new Uint8Array(n);
    this.analyser.getByteTimeDomainData(this._buf);
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(this._buf[i] - 128) / 128;
      if (d > peak) peak = d;
      sum += d * d;
    }
    const rms = Math.sqrt(sum / n);
    return Math.min(1, rms * 2.4 + peak * 0.35);
  }

  // ── ingest ─────────────────────────────────────────────────────────────────
  /** @param {{utteranceId:string, seq:number, mime:string, b64:string, ms:number}} ev */
  async push(ev, { store = true } = {}) {
    if (!ev?.b64) return;
    if (store) {
      const list = this.raw.get(ev.utteranceId) ?? [];
      list.push({ seq: ev.seq ?? list.length, b64: ev.b64, mime: ev.mime });
      this.raw.set(ev.utteranceId, list);
      if (this.raw.size > 40) this.raw.delete(this.raw.keys().next().value); // bounded
    }
    if (this.muted) return; // still stored, so ▶ replay works after unmuting
    const ctx = this.ensure();
    if (!ctx) return;
    // Wait for the context to actually be running. ensure() fires resume() but does
    // not await it, and currentTime does not advance while suspended — so scheduling
    // into a suspended context silently loses the audio instead of delaying it.
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch {}
      if (ctx.state !== 'running') {
        // HOLD, don't drop. The boot line and often the first reply arrive before the
        // user's first gesture; a suspended context can't play them, but dropping them
        // is why "I never hear Monday" happens. Buffer and flush the moment we unlock.
        this.pending.push(ev);
        if (this.pending.length > 60) this.pending.shift(); // bounded
        if (!this.blocked) { this.blocked = true; this._emit(); }
        return;
      }
    }
    if (this.blocked) { this.blocked = false; this._emit(); }

    let buf;
    try {
      const bytes = b64ToBytes(ev.b64);
      buf = await ctx.decodeAudioData(bytes.buffer);
    } catch (err) {
      console.warn('[monday-audio] chunk failed to decode', ev.utteranceId, ev.seq, err);
      return;
    }

    const u = this._utt(ev.utteranceId);
    u.chunks.set(ev.seq ?? u.next, buf);
    this._flush(ev.utteranceId);
  }

  end(utteranceId) {
    const u = this.utts.get(utteranceId);
    if (u) { u.ended = true; this._flush(utteranceId); }
  }

  /** Replay chunks that were held while the context was blocked. Called on unlock. */
  flushPending() {
    if (!this.pending.length || !this.ctx || this.ctx.state !== 'running') return;
    const items = this.pending; this.pending = [];
    if (this.blocked) { this.blocked = false; this._emit(); }
    for (const ev of items) this.push(ev, { store: false }); // already stored on first arrival
  }

  _utt(id) {
    let u = this.utts.get(id);
    if (!u) { u = { chunks: new Map(), next: 0, ended: false, sources: new Set() }; this.utts.set(id, u); }
    return u;
  }

  /** Play everything that is contiguously available from `next` onward. */
  _flush(id) {
    const u = this.utts.get(id);
    if (!u) return;
    while (u.chunks.has(u.next)) {
      const buf = u.chunks.get(u.next);
      u.chunks.delete(u.next);
      u.next += 1;
      this._schedule(buf, u);
    }
    if (u.ended && u.chunks.size === 0 && u.sources.size === 0) this.utts.delete(id);
  }

  _schedule(buf, u) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    // Gapless: each chunk starts exactly where the previous one ended. If the
    // queue has drained (network stall) we restart the cursor rather than
    // scheduling in the past, which would play everything at once.
    const now = ctx.currentTime;
    if (this.nextStart < now + 0.005) this.nextStart = now + LEAD;
    const at = this.nextStart;
    this.nextStart += buf.duration;
    this.playing += 1;
    u?.sources.add(src);
    const wasIdle = this.playing === 1;
    src.onended = () => {
      this.playing = Math.max(0, this.playing - 1);
      u?.sources.delete(src);
      if (this.playing === 0) this._emit();
    };
    try { src.start(at); } catch { this.playing = Math.max(0, this.playing - 1); return; }
    if (wasIdle) this._emit();
  }

  // ── controls ───────────────────────────────────────────────────────────────
  stopAll() {
    for (const u of this.utts.values()) {
      for (const s of u.sources) { try { s.stop(); } catch {} }
      u.sources.clear();
      u.chunks.clear();
    }
    this.utts.clear();
    this.playing = 0;
    this.nextStart = 0;
    this._emit();
  }

  hasAudio(utteranceIds = []) { return utteranceIds.some((id) => (this.raw.get(id)?.length ?? 0) > 0); }

  /** ▶ on a message: re-decode the stored chunks and play them in order. */
  async replay(utteranceIds = []) {
    this.stopAll();
    const ctx = this.ensure();
    if (!ctx) return;
    const wasMuted = this.muted;
    if (wasMuted) { this.muted = false; this._applyGain(); }
    for (const id of utteranceIds) {
      const list = (this.raw.get(id) ?? []).slice().sort((a, b) => a.seq - b.seq);
      const replayId = `${id}#replay${Date.now()}`;
      for (let i = 0; i < list.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        await this.push({ utteranceId: replayId, seq: i, mime: list[i].mime, b64: list[i].b64 }, { store: false });
      }
      this.end(replayId);
    }
  }
}

export const audio = new MondayAudio();

// One-shot unlock: browsers refuse to start an AudioContext outside a gesture,
// and the very first thing Monday wants to do is speak its boot line.
if (typeof window !== 'undefined') {
  // Keep trying until the context is genuinely running. resume() is async and can
  // be rejected — WebKit gates AudioContext behind a gesture separately from the
  // <audio> autoplay policy — so a one-shot listener that removes itself after the
  // first attempt leaves the app permanently silent if that attempt loses the race.
  const EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
  const unlock = () => {
    const ctx = audio.ensure();
    if (!ctx) return;
    const done = () => {
      if (ctx.state !== 'running') return;
      audio.flushPending(); // play anything held during the pre-gesture race
      for (const e of EVENTS) window.removeEventListener(e, unlock, true);
    };
    if (ctx.state === 'running') return done();
    ctx.resume().then(done).catch(() => {});
  };
  for (const e of EVENTS) window.addEventListener(e, unlock, true);
}

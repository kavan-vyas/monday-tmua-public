#!/usr/bin/env python3
"""Monday's voice worker.

A long-lived process that speaks newline-delimited JSON over stdin/stdout and
keeps Kokoro warm, because cold start is the entire latency budget: loading the
model costs seconds, synthesising a sentence costs a fraction of one.

Per utterance:

  1. strip markdown
  2. segment prose vs. maths ($..$, $$..$$, \\(..\\), \\[..\\])
  3. normalise every maths span through convert_latex  <- the step nothing else has
  4. plan prosody from the mood preset (prosody.py)
  5. synthesise each span against the Monday voice tensor, splice silences at 24 kHz
  6. post-process per mood with ffmpeg, then cache by sha256

PROTOCOL (one JSON object per line, both directions)

  ->  {"op":"speak","utteranceId":"u1","seq":0,"text":"...","mood":"focused",
       "rate":1.0,"pause":1.0}     rate/pause optional, default 1.0 = the preset
  ->  {"op":"cancel","utteranceId":"u1"}
  ->  {"op":"ping","id":"p1"}
  ->  {"op":"shutdown"}

  <-  {"type":"ready","ms":4210,"voiceHash":"...","moods":[...]}
  <-  {"type":"audio","utteranceId":"u1","seq":0,"mime":"audio/wav","b64":"...",
       "ms":1840,"cached":false,"spoken":"..."}
  <-  {"type":"skipped","utteranceId":"u1","seq":0}          (cancelled)
  <-  {"type":"error","utteranceId":"u1","seq":0,"message":"..."}
  <-  {"type":"pong","id":"p1"}

Nothing but protocol JSON is ever written to fd 1; every library that thinks it
owns stdout is redirected to stderr at import time.

CLI

  python3 app/tts/monday_tts.py --once "Given $f(x)=x^2$, find $f'(2)$." --mood sharp --play
  python3 app/tts/monday_tts.py --once "..." --dry-run
  python3 app/tts/monday_tts.py --serve
  python3 app/tts/monday_tts.py --purge-cache
"""

import argparse
import base64
import hashlib
import io
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import warnings  # noqa: E402

warnings.filterwarnings("ignore")

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402

from prosody import (  # noqa: E402
    DEFAULT_MOOD, MOODS, PLAN_VERSION, describe, plan, preset, preset_name,
)

APP_DIR = HERE.parent
CACHE_DIR = Path(os.environ.get("MONDAY_VOICE_CACHE", APP_DIR / ".voicecache"))
VOICE_PT = HERE / "voices" / "monday.pt"
VOICE_META = HERE / "voices" / "monday.json"
LEXICON = HERE / "maths_lexicon.json"
LINEBANK = HERE / "linebank.json"

SR = 24000
CACHE_CAP_BYTES = int(os.environ.get("MONDAY_VOICE_CACHE_MB", "200")) * 1024 * 1024
FFMPEG = os.environ.get("FFMPEG_BIN", "/opt/homebrew/bin/ffmpeg")
REPO_ID = "hexgrad/Kokoro-82M"
LANG_CODE = "b"
FALLBACK_VOICE = "bm_george"  # if voices/monday.pt has not been built yet


# --------------------------------------------------------------------- stdout

# Kokoro, torch and huggingface_hub all feel free to print. Take fd 1 away from
# them before anything else imports.
_PROTO_OUT = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(2, 1)
sys.stdout = sys.stderr

_send_lock = threading.Lock()


def send(obj):
    line = json.dumps(obj, ensure_ascii=False)
    with _send_lock:
        _PROTO_OUT.write(line + "\n")
        _PROTO_OUT.flush()


def log(*a):
    print("[monday-tts]", *a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------- cache

def cache_key(items, mood, voice_hash):
    payload = json.dumps(
        {"v": PLAN_VERSION, "sr": SR, "mood": preset_name(mood),
         "voice": voice_hash, "items": items},
        sort_keys=True, ensure_ascii=False, separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def cache_path(key):
    return CACHE_DIR / f"{key}.wav"


def cache_get(key):
    p = cache_path(key)
    try:
        data = p.read_bytes()
    except OSError:
        return None
    try:  # touch: mtime is the LRU clock
        os.utime(p, None)
    except OSError:
        pass
    return data


_writes_since_trim = 0


def cache_put(key, data):
    global _writes_since_trim
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = cache_path(key).with_suffix(".part")
    try:
        tmp.write_bytes(data)
        tmp.replace(cache_path(key))
    except OSError as e:
        log("cache write failed:", e)
        return
    _writes_since_trim += 1
    if _writes_since_trim >= 20:
        _writes_since_trim = 0
        lru_trim()


def lru_trim(cap=CACHE_CAP_BYTES):
    """Evict oldest-touched wavs until the cache fits under the cap."""
    try:
        files = [(p.stat().st_mtime, p.stat().st_size, p)
                 for p in CACHE_DIR.glob("*.wav")]
    except OSError:
        return 0
    total = sum(s for _, s, _ in files)
    if total <= cap:
        return 0
    files.sort(key=lambda t: t[0])
    freed = 0
    for _, size, p in files:
        if total - freed <= cap:
            break
        try:
            p.unlink()
            freed += size
        except OSError:
            pass
    log(f"cache: evicted {freed / 1e6:.1f} MB (was {total / 1e6:.1f} MB, cap {cap / 1e6:.0f} MB)")
    return freed


def cache_stats():
    try:
        files = list(CACHE_DIR.glob("*.wav"))
    except OSError:
        return 0, 0
    return len(files), sum(p.stat().st_size for p in files)


# -------------------------------------------------------------- ffmpeg colour

def _ffmpeg_filters(p):
    """The per-mood chain that makes moods sound like different people-moods
    rather than the same read at different speeds. Base speed is already applied
    in Kokoro (which changes duration without touching pitch); this is pitch,
    dynamics and tone only."""
    f = []
    pitch = p["pitch"]
    if abs(pitch) > 1e-6:
        r = 1.0 + pitch
        f.append(f"asetrate={int(round(SR * r))}")
        f.append(f"aresample={SR}")
        f.append(f"atempo={1.0 / r:.6f}")
    th, ratio, atk, rel, makeup_db = p["comp"]
    f.append(
        f"acompressor=threshold={th}dB:ratio={ratio}:attack={atk}:release={rel}"
    )
    if abs(makeup_db) > 1e-6:
        f.append(f"volume={makeup_db}dB")
    if abs(p["shelf_db"]) > 1e-6:
        f.append(f"highshelf=f=3200:g={p['shelf_db']}")
    f.append("alimiter=limit=0.97")
    return ",".join(f)


_ffmpeg_ok = None


def ffmpeg_available():
    global _ffmpeg_ok
    if _ffmpeg_ok is None:
        try:
            subprocess.run([FFMPEG, "-version"], capture_output=True, timeout=10)
            _ffmpeg_ok = True
        except Exception as e:
            log(f"ffmpeg unavailable ({e}); moods will differ in pace only")
            _ffmpeg_ok = False
    return _ffmpeg_ok


TARGET_PEAK = 0.90


def normalise(audio):
    """Kokoro comes out around -10 dBFS, which is too quiet to hear over a fan
    and too quiet for the compressor thresholds below to mean anything. Bring
    the peak up first so the mood chain operates in the range it was tuned for.
    """
    if audio.size == 0:
        return audio
    peak = float(np.max(np.abs(audio)))
    if peak <= 1e-6:
        return audio
    return audio * (TARGET_PEAK / peak)


def post_process(audio, p):
    """float32 mono @24k -> float32 mono @24k, mood-coloured. Never fatal."""
    audio = normalise(audio)
    if not ffmpeg_available():
        return audio
    chain = _ffmpeg_filters(p)
    if not chain:
        return audio
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
           "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "pipe:0",
           "-af", chain, "-f", "f32le", "-ar", str(SR), "-ac", "1", "pipe:1"]
    try:
        r = subprocess.run(cmd, input=audio.astype(np.float32).tobytes(),
                           capture_output=True, timeout=60)
        if r.returncode != 0 or not r.stdout:
            log("ffmpeg failed:", r.stderr.decode("utf-8", "replace")[:300])
            return audio
        return np.frombuffer(r.stdout, dtype=np.float32).copy()
    except Exception as e:
        log("ffmpeg error:", e)
        return audio


def to_wav_bytes(audio):
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 1.0:
        audio = audio / peak
    buf = io.BytesIO()
    sf.write(buf, audio.astype(np.float32), SR, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ------------------------------------------------------------------- renderer

class Cancelled(Exception):
    pass


class Renderer:
    def __init__(self, device=None):
        self.pipeline = None
        self.voice = None
        self.voice_hash = "unbuilt"
        self.device = device

    # -- setup -------------------------------------------------------------
    def load(self):
        t0 = time.time()
        from kokoro import KPipeline
        import torch

        device = self.device or os.environ.get("MONDAY_TTS_DEVICE") or "mps"
        try:
            if device == "mps" and not torch.backends.mps.is_available():
                device = "cpu"
            self.pipeline = KPipeline(lang_code=LANG_CODE, repo_id=REPO_ID, device=device)
        except Exception as e:
            log(f"device {device!r} failed ({e}); falling back to cpu")
            device = "cpu"
            self.pipeline = KPipeline(lang_code=LANG_CODE, repo_id=REPO_ID, device="cpu")
        self.device = device

        try:
            from lexicon import apply_lexicon
            n = apply_lexicon(self.pipeline, LEXICON)
            log(f"lexicon: {n} maths entries patched into the gold lexicon")
        except Exception as e:
            log("lexicon load failed (rare words will be guessed):", e)

        self._load_voice(torch)
        log(f"loaded in {time.time() - t0:.1f}s on {device}, voice_hash={self.voice_hash}")
        return time.time() - t0

    def _load_voice(self, torch):
        if VOICE_PT.exists():
            try:
                t = torch.load(VOICE_PT, map_location="cpu", weights_only=True)
                self.voice = t.to(torch.float32).cpu().contiguous()
                if VOICE_META.exists():
                    self.voice_hash = json.loads(VOICE_META.read_text()).get("voice_hash", "?")
                else:
                    self.voice_hash = hashlib.sha256(
                        self.voice.numpy().tobytes()).hexdigest()[:16]
                return
            except Exception as e:
                log("monday.pt failed to load:", e)
        log(f"voices/monday.pt missing — falling back to {FALLBACK_VOICE}. "
            f"Run: python3 app/tts/build_voice.py")
        self.voice = FALLBACK_VOICE
        self.voice_hash = FALLBACK_VOICE

    def warm(self):
        try:
            t0 = time.time()
            self._synth("Right. Let's begin.", 1.0)
            log(f"warm-up synthesis {time.time() - t0:.1f}s")
        except Exception as e:
            log("warm-up failed:", e)

    # -- synthesis ---------------------------------------------------------
    @staticmethod
    def _trim(a, keep_ms=25):
        """Kokoro pads roughly 300 ms of lead and 450 ms of tail onto every
        chunk it generates. Left alone that swamps the whole prosody plan — a
        deliberate 200 ms lead-in becomes half a second of dead air, and four
        spans add three seconds of nothing. Trim to the actual speech, keep a
        few milliseconds so plosive onsets survive, and let the plan own timing.
        """
        if a.size == 0:
            return a
        peak = float(np.max(np.abs(a)))
        if peak <= 0:
            return a[:0]
        thr = max(peak * 0.02, 0.004)
        nz = np.nonzero(np.abs(a) > thr)[0]
        if nz.size == 0:
            return a[:0]
        keep = int(SR * keep_ms / 1000.0)
        return a[max(0, nz[0] - keep):min(a.size, nz[-1] + keep + 1)]

    def _synth(self, text, speed):
        chunks = []
        for r in self.pipeline(text, voice=self.voice, speed=float(speed)):
            a = getattr(r, "audio", None)
            if a is None:
                continue
            chunks.append(np.asarray(a, dtype=np.float32).reshape(-1))
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return self._trim(np.concatenate(chunks))

    def render(self, text, mood=DEFAULT_MOOD, should_cancel=None, use_cache=True,
               rate=1.0, pause=1.0):
        """-> (wav_bytes, duration_ms, cached, spoken_text, plan_items)

        `rate` / `pause` are the user's prosody settings, forwarded from the
        Node side on each speak request. They land in the plan items, and the
        cache key is derived from the items — so two different rate settings
        cache separately and neither can serve the other's audio.
        """
        p = preset(mood)
        items, spoken, meta = plan(text, mood, rate=rate, pause=pause)
        if not any(i["t"] == "say" for i in items):
            return None, 0, False, spoken, items

        key = cache_key(items, mood, self.voice_hash)
        if use_cache:
            hit = cache_get(key)
            if hit is not None:
                ms = _wav_ms(hit)
                return hit, ms, True, spoken, items

        parts = []
        for item in items:
            if should_cancel and should_cancel():
                raise Cancelled()
            if item["t"] == "pause":
                parts.append(np.zeros(int(SR * item["ms"] / 1000.0), dtype=np.float32))
                continue
            a = self._synth(item["text"], item["speed"])
            if a.size and item["gain_db"]:
                a = a * (10.0 ** (item["gain_db"] / 20.0))
            if a.size:
                parts.append(a)

        if not parts:
            return None, 0, False, spoken, items
        audio = np.concatenate(parts)
        audio = post_process(audio, p)
        wav = to_wav_bytes(audio)
        if use_cache:
            cache_put(key, wav)
        return wav, int(round(1000 * len(audio) / SR)), False, spoken, items


def _wav_ms(wav_bytes):
    try:
        info = sf.info(io.BytesIO(wav_bytes))
        return int(round(1000 * info.frames / info.samplerate))
    except Exception:
        return int(round(1000 * max(0, len(wav_bytes) - 44) / (2 * SR)))


# --------------------------------------------------------------------- server

def serve(renderer):
    reqs = queue.Queue()
    cancelled = set()
    cancel_lock = threading.Lock()
    stop = threading.Event()

    def is_cancelled(uid):
        with cancel_lock:
            return uid in cancelled

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception as e:
                send({"type": "error", "message": f"bad json: {e}"})
                continue
            op = msg.get("op")
            if op == "shutdown":
                stop.set()
                reqs.put(None)
                return
            if op == "cancel":
                uid = msg.get("utteranceId")
                if uid:
                    with cancel_lock:
                        cancelled.add(uid)
                        if len(cancelled) > 256:
                            cancelled.clear()
                            cancelled.add(uid)
                continue
            if op == "ping":
                send({"type": "pong", "id": msg.get("id"),
                      "queued": reqs.qsize(), "ready": True})
                continue
            reqs.put(msg)
        stop.set()
        reqs.put(None)

    threading.Thread(target=reader, daemon=True, name="stdin-reader").start()

    while not stop.is_set():
        msg = reqs.get()
        if msg is None:
            break
        uid = msg.get("utteranceId") or ""
        seq = msg.get("seq", 0)
        if is_cancelled(uid):
            send({"type": "skipped", "utteranceId": uid, "seq": seq})
            continue
        try:
            t0 = time.time()
            wav, ms, cached, spoken, _ = renderer.render(
                msg.get("text", ""), msg.get("mood", DEFAULT_MOOD),
                should_cancel=lambda: is_cancelled(uid),
                rate=msg.get("rate", 1.0), pause=msg.get("pause", 1.0),
            )
            if wav is None:
                send({"type": "skipped", "utteranceId": uid, "seq": seq,
                      "reason": "nothing speakable"})
                continue
            send({
                "type": "audio", "utteranceId": uid, "seq": seq,
                "mime": "audio/wav", "b64": base64.b64encode(wav).decode("ascii"),
                "ms": ms, "cached": cached, "spoken": spoken,
                "renderMs": int((time.time() - t0) * 1000),
            })
        except Cancelled:
            send({"type": "skipped", "utteranceId": uid, "seq": seq})
        except Exception as e:
            import traceback
            log(traceback.format_exc())
            send({"type": "error", "utteranceId": uid, "seq": seq, "message": str(e)})

    log("shutting down")


# ------------------------------------------------------------------------ cli

def cmd_once(args, renderer):
    wav, ms, cached, spoken, items = renderer.render(
        args.once, args.mood, use_cache=not args.no_cache,
        rate=args.rate, pause=args.pause)
    print(f"spoken text: {spoken}", file=sys.stderr)
    if wav is None:
        print("nothing speakable", file=sys.stderr)
        return 1
    out = Path(args.out or (CACHE_DIR / f"once_{preset_name(args.mood)}.wav"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(wav)
    print(f"mood: {preset_name(args.mood)}  cached: {cached}  "
          f"duration: {ms / 1000:.2f}s  size: {len(wav)} bytes", file=sys.stderr)
    print(f"saved: {out}", file=sys.stderr)
    if args.plan:
        print(describe(items), file=sys.stderr)
    if args.play:
        subprocess.run(["/usr/bin/afplay", str(out)], check=False)
    return 0


def cmd_linebank(args, renderer):
    """Pre-render every fixed line so the instant path is a pure cache read."""
    if not LINEBANK.exists():
        print(f"no linebank at {LINEBANK}", file=sys.stderr)
        return 1
    bank = json.loads(LINEBANK.read_text(encoding="utf-8"))
    lines = bank.get("lines", [])
    todo = []
    for entry in lines:
        moods = entry.get("moods") or [entry.get("mood", DEFAULT_MOOD)]
        for m in moods:
            todo.append((entry["id"], entry["text"], m))
    t0 = time.time()
    hits = 0
    for i, (lid, text, mood) in enumerate(todo, 1):
        try:
            _, ms, cached, _, _ = renderer.render(text, mood)
            hits += 1 if cached else 0
            print(f"  [{i}/{len(todo)}] {lid} ({mood}) "
                  f"{'cached' if cached else f'{ms}ms rendered'}", file=sys.stderr)
        except Exception as e:
            print(f"  [{i}/{len(todo)}] {lid} ({mood}) FAILED: {e}", file=sys.stderr)
    n, size = cache_stats()
    print(f"line bank warm: {len(todo)} lines ({hits} already cached) in "
          f"{time.time() - t0:.1f}s; cache now {n} files / {size / 1e6:.1f} MB",
          file=sys.stderr)
    return 0


def main():
    ap = argparse.ArgumentParser(description="Monday's TTS worker")
    ap.add_argument("--serve", action="store_true", help="run the NDJSON worker on stdin/stdout")
    ap.add_argument("--once", metavar="TEXT", help="synthesise one utterance and exit")
    ap.add_argument("--linebank", action="store_true", help="pre-render app/tts/linebank.json into the cache")
    ap.add_argument("--mood", default=DEFAULT_MOOD, choices=sorted(MOODS))
    ap.add_argument("--play", action="store_true", help="play the result with afplay")
    ap.add_argument("--rate", type=float, default=1.0, help="speaking-rate multiplier (0.5-2.0)")
    ap.add_argument("--pause", type=float, default=1.0, help="pause-length multiplier (0.3-3.0)")
    ap.add_argument("--plan", action="store_true", help="print the prosody plan")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and exit, no model load")
    ap.add_argument("--out", help="output wav path for --once")
    ap.add_argument("--no-cache", action="store_true")
    ap.add_argument("--device", choices=["mps", "cpu"], default=None)
    ap.add_argument("--purge-cache", action="store_true")
    ap.add_argument("--cache-stats", action="store_true")
    args = ap.parse_args()

    if args.purge_cache:
        n = 0
        for p in CACHE_DIR.glob("*.wav"):
            p.unlink()
            n += 1
        print(f"purged {n} cached wavs from {CACHE_DIR}", file=sys.stderr)
        return 0

    if args.cache_stats:
        n, size = cache_stats()
        print(f"{CACHE_DIR}: {n} files, {size / 1e6:.1f} MB "
              f"(cap {CACHE_CAP_BYTES / 1e6:.0f} MB)", file=sys.stderr)
        return 0

    if args.dry_run:
        if not args.once:
            print("--dry-run needs --once TEXT", file=sys.stderr)
            return 2
        items, spoken, meta = plan(args.once, args.mood, rate=args.rate, pause=args.pause)
        print(f"spoken text: {spoken}", file=sys.stderr)
        print(describe(items), file=sys.stderr)
        print(json.dumps(meta), file=sys.stderr)
        return 0

    renderer = Renderer(device=args.device)
    load_ms = renderer.load()

    if args.once:
        return cmd_once(args, renderer)
    if args.linebank:
        return cmd_linebank(args, renderer)
    if args.serve:
        renderer.warm()
        send({"type": "ready", "ms": int(load_ms * 1000),
              "voiceHash": renderer.voice_hash, "device": renderer.device,
              "moods": sorted(MOODS), "planVersion": PLAN_VERSION})
        serve(renderer)
        return 0

    ap.print_help(sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())

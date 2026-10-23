"""Render a video's narration with Qwen3-TTS: one continuous take per line, one fixed voice.

    ~/qwen3-tts/.venv/bin/python app/video/narrate_qwen.py <video_dir> <out_dir> [keys...]

Each line of <video_dir>/script.py is spoken whole (via spoken.py, so maths is already
plain English) instead of being cut into clauses and spliced, which is what made the
Kokoro narration sound choppy. out_dir gets audio/<key>.wav and durations.json, the same
contract common.py reads. Naming keys re-renders just those lines.
"""
import importlib.util
import json
import zlib
import os
import sys
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from spoken import spoken  # noqa: E402

MODEL = os.environ.get("QWEN_TTS_MODEL", "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit")
SPEAKER = os.environ.get("QWEN_TTS_SPEAKER", "ryan")
INSTRUCT = os.environ.get(
    "QWEN_TTS_INSTRUCT",
    "Speak fluently and naturally, like a confident teacher talking to one student. "
    "Smooth, connected phrasing at a normal conversational pace.",
)
LEAD, TAIL = 0.08, 0.15   # seconds of silence kept around each line
TARGET_DBFS = -18.0
TAKES = 3         # sampling varies take to take; keep the most fluent of up to this many
GOOD_WPM = 140    # a take at least this fast with no long hold is accepted straight away


def trim(a, sr, thresh=0.01):
    idx = np.where(np.abs(a) > thresh)[0]
    if not idx.size:
        return a
    s = max(0, idx[0] - int(LEAD * sr))
    e = min(len(a), idx[-1] + int(TAIL * sr))
    return a[s:e]


def tighten(a, sr, max_gap=0.38, floor_db=-40.0):
    """Shorten every pause longer than max_gap to max_gap, so a line flows as one phrase.

    The model sometimes holds a comma for over a second; that, not the voice, is what
    makes maths narration sound halting. Cuts land mid-silence with a 10 ms crossfade.
    """
    hop = int(0.01 * sr)
    n = len(a) // hop
    if n < 3:
        return a
    rms = np.sqrt(np.mean(a[: n * hop].reshape(n, hop) ** 2, axis=1))
    quiet = 20 * np.log10(rms + 1e-9) < floor_db + 20 * np.log10(np.max(np.abs(a)) + 1e-9)
    keep = int(max_gap / 0.01)
    out, pos, i = [], 0, 0
    while i < n:
        if not quiet[i]:
            i += 1
            continue
        j = i
        while j < n and quiet[j]:
            j += 1
        if j - i > keep and i > 0 and j < n:
            cut_s = (i + keep // 2) * hop
            cut_e = (j - keep // 2) * hop
            out.append(a[pos:cut_s])
            pos = cut_e
        i = j
    out.append(a[pos:])
    x = 160  # 10 ms at 16 kHz-ish; harmless at 24 kHz
    res = out[0]
    for seg in out[1:]:
        if len(res) > x and len(seg) > x:
            fade = np.linspace(1, 0, x, dtype=np.float32)
            res = np.concatenate([res[:-x], res[-x:] * fade + seg[:x] * (1 - fade), seg[x:]])
        else:
            res = np.concatenate([res, seg])
    return res


def longest_hold(a, sr, floor_db=-40.0):
    """Longest pause inside the line, in seconds, before tightening."""
    hop = int(0.01 * sr)
    n = len(a) // hop
    if n < 3:
        return 0.0
    rms = np.sqrt(np.mean(a[: n * hop].reshape(n, hop) ** 2, axis=1))
    quiet = 20 * np.log10(rms + 1e-9) < floor_db + 20 * np.log10(np.max(np.abs(a)) + 1e-9)
    best = run = 0
    for q in quiet:
        run = run + 1 if q else 0
        best = max(best, run)
    return best * 0.01


def level(a):
    rms = np.sqrt(np.mean(a ** 2)) or 1e-9
    a = a * (10 ** (TARGET_DBFS / 20) / rms)
    peak = np.max(np.abs(a))
    return a * (0.97 / peak) if peak > 0.97 else a


def main():
    video, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    only = set(sys.argv[3:])
    spec = importlib.util.spec_from_file_location("script", video / "script.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)

    (out / "audio").mkdir(parents=True, exist_ok=True)
    dpath = out / "durations.json"
    durations = json.loads(dpath.read_text()) if dpath.exists() else {}
    model = load_model(MODEL)
    sr = model.sample_rate
    for key, text in script.SEGMENTS.items():
        if only and key not in only:
            continue
        if not only and key in durations and (out / "audio" / f"{key}.wav").exists():
            continue  # resume
        line = spoken(key, text)
        kw = dict(text=line, lang_code="english", temperature=0.6, split_pattern="\u0000")
        if "CustomVoice" in MODEL:
            kw.update(voice=SPEAKER, instruct=INSTRUCT)
        else:
            kw.update(instruct=INSTRUCT)
        n_words = len(line.split())
        best = None
        for take in range(TAKES):
            mx.random.seed(zlib.crc32(f"{key}:{take}{os.environ.get('SEED_SALT', '')}".encode()))
            raw = trim(np.concatenate([np.array(r.audio, dtype=np.float32) for r in model.generate(**kw)]), sr)
            hold = longest_hold(raw, sr)
            a = level(tighten(raw, sr))
            wpm = n_words / (len(a) / sr) * 60
            score = wpm - 40 * max(0.0, hold - 0.8)
            if best is None or score > best[0]:
                best = (score, a, wpm, hold, take)
            if wpm >= GOOD_WPM and hold < 0.8:
                break
        _, a, wpm, hold, take = best
        audio_write(str(out / "audio" / f"{key}.wav"), a, sr)
        durations[key] = round(len(a) / sr, 3)
        dpath.write_text(json.dumps(durations, indent=1))
        print(f"{key:12s} {durations[key]:6.2f}s {wpm:4.0f}wpm take{take} hold{hold:.2f}  {line[:60]}", flush=True)
    print("total", round(sum(durations[k] for k in script.SEGMENTS if k in durations) / 60, 2), "min")


if __name__ == "__main__":
    main()

"""Transcribe every narration wav with Whisper and flag lines that don't match what was meant.

    python3 app/video/check_narration.py <video_dir> <out_dir> [keys...]

Neural TTS occasionally skips, repeats or garbles words; this catches it so the line can be
re-rendered. Prints a word error rate per line and writes check.json next to durations.json.
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

import mlx_whisper

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from spoken import spoken  # noqa: E402

NUM = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six",
       "7": "seven", "8": "eight", "9": "nine", "10": "ten"}


def words(s):
    s = s.lower().replace("-", " ")
    s = re.sub(r"[^a-z0-9' ]", " ", s)
    return [NUM.get(w, w) for w in s.split()]


def wer(ref, hyp):
    d = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(hyp, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[-1] / max(1, len(ref))


def main():
    video, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
    only = set(sys.argv[3:])
    spec = importlib.util.spec_from_file_location("script", video / "script.py")
    script = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(script)
    cpath = out / "check.json"
    res = json.loads(cpath.read_text()) if cpath.exists() else {}
    for key, text in script.SEGMENTS.items():
        if only and key not in only:
            continue
        ref = spoken(key, text)
        hyp = mlx_whisper.transcribe(str(out / "audio" / f"{key}.wav"), language="en",
                                     path_or_hf_repo="mlx-community/whisper-large-v3-turbo")["text"].strip()
        e = wer(words(ref), words(hyp))
        res[key] = {"wer": round(e, 3), "heard": hyp}
        cpath.write_text(json.dumps(res, indent=1))
        print(f"{'!!' if e > 0.12 else 'ok'} {key:12s} {e:5.2f}  {hyp[:100]}", flush=True)


if __name__ == "__main__":
    main()

"""Render a video's narration with Monday's voice and record each line's length.

    app/tts/.venv/bin/python app/video/narrate.py <video_dir> <out_dir> [keys...]

<video_dir>/script.py holds SEGMENTS; out_dir gets audio/<key>.wav and durations.json.
Naming keys re-renders just those lines.
"""
import importlib.util
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "tts"))
from monday_tts import Renderer  # noqa: E402

video, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
only = set(sys.argv[3:])
spec = importlib.util.spec_from_file_location("script", video / "script.py")
script = importlib.util.module_from_spec(spec)
spec.loader.exec_module(script)

(out / "audio").mkdir(parents=True, exist_ok=True)
dpath = out / "durations.json"
durations = json.loads(dpath.read_text()) if only and dpath.exists() else {}
r = Renderer()
r.load()
for key, text in script.SEGMENTS.items():
    if only and key not in only:
        continue
    wav, ms, _, spoken, _ = r.render(text, "focused", rate=1.06)
    (out / "audio" / f"{key}.wav").write_bytes(wav)
    durations[key] = round(ms / 1000, 3)
    print(f"{key:8s} {ms/1000:6.2f}s  {spoken[:90]}", flush=True)
dpath.write_text(json.dumps(durations, indent=1))
print("total", round(sum(durations.values()) / 60, 2), "min")

#!/usr/bin/env python3
"""Build Monday's voice.

Kokoro's own `load_voice("a,b")` averages voice packs equally. Monday is not an
equal average of anything, so we build the tensor ourselves from a weighted sum
and save it. The result is a voice that exists nowhere else, is reproducible
from this script, and costs nothing.

Run:
    python3 app/tts/build_voice.py                  # default blend
    python3 app/tts/build_voice.py --weights bm_george=0.62,bm_lewis=0.38
    python3 app/tts/build_voice.py --list           # show cached voice packs
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import torch

HERE = Path(__file__).resolve().parent
VOICES_DIR = HERE / "voices"
OUT = VOICES_DIR / "monday.pt"
META = VOICES_DIR / "monday.json"

# Tuned by ear. george carries the low, unhurried, slightly bored authority;
# lewis adds the edge and the crisper consonants that keep maths intelligible.
# Anything past ~0.45 lewis starts to sound impatient rather than dry.
DEFAULT_WEIGHTS = {"bm_george": 0.62, "bm_lewis": 0.38}

LANG_CODE = "b"  # British English
REPO_ID = "hexgrad/Kokoro-82M"


def parse_weights(spec):
    out = {}
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            raise SystemExit(f"bad --weights entry {part!r}, expected name=weight")
        name, _, w = part.partition("=")
        out[name.strip()] = float(w)
    if not out:
        raise SystemExit("--weights produced no entries")
    return out


def load_packs(weights):
    from kokoro import KPipeline

    # model=False: we only need the voice loader, not 313 MB of weights.
    pipeline = KPipeline(lang_code=LANG_CODE, repo_id=REPO_ID, model=False)
    packs = {}
    for name in weights:
        pack = pipeline.load_single_voice(name)
        packs[name] = pack.to(torch.float32).cpu()
        print(f"  loaded {name:<12} shape={tuple(packs[name].shape)}")
    return packs


def blend(packs, weights, normalise=True):
    total = sum(weights.values())
    if normalise and abs(total - 1.0) > 1e-6:
        print(f"  weights sum to {total:.4f}; normalising")
        weights = {k: v / total for k, v in weights.items()}
    shapes = {tuple(p.shape) for p in packs.values()}
    if len(shapes) != 1:
        raise SystemExit(f"voice packs disagree on shape: {shapes}")
    acc = None
    for name, pack in packs.items():
        term = pack * weights[name]
        acc = term if acc is None else acc + term
    return acc.to(torch.float32).contiguous(), weights


def voice_hash(tensor):
    """Stable fingerprint of the voice, mixed into every cache key."""
    return hashlib.sha256(tensor.numpy().tobytes()).hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser(description="Build Monday's blended Kokoro voice")
    ap.add_argument("--weights", default=None, help="e.g. bm_george=0.62,bm_lewis=0.38")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--no-normalise", action="store_true", help="do not rescale weights to sum 1")
    ap.add_argument("--list", action="store_true", help="list voice packs already in the HF cache")
    args = ap.parse_args()

    if args.list:
        from huggingface_hub import constants  # noqa: F401
        import glob
        pat = str(Path.home() / ".cache/huggingface/hub/models--hexgrad--Kokoro-82M/snapshots/*/voices/*.pt")
        for p in sorted(glob.glob(pat)):
            print(Path(p).stem)
        return 0

    weights = parse_weights(args.weights) if args.weights else dict(DEFAULT_WEIGHTS)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    print("building Monday's voice")
    print("  blend: " + " + ".join(f"{w:g}*{n}" for n, w in weights.items()))
    packs = load_packs(weights)
    tensor, weights = blend(packs, weights, normalise=not args.no_normalise)

    existed = out.exists()
    torch.save(tensor, out)
    vh = voice_hash(tensor)
    META.write_text(
        json.dumps(
            {
                "weights": weights,
                "shape": list(tensor.shape),
                "dtype": str(tensor.dtype),
                "voice_hash": vh,
                "lang_code": LANG_CODE,
                "repo_id": REPO_ID,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    size_kb = out.stat().st_size / 1024
    print(f"  {'rewrote' if existed else 'wrote'} {out}  ({size_kb:.0f} KB)")
    print(f"  wrote   {META}")
    print(f"  shape={tuple(tensor.shape)} dtype={tensor.dtype} voice_hash={vh}")
    print(f"  mean={tensor.mean().item():+.6f} std={tensor.std().item():.6f}")
    print("done. Cached audio keyed on the old voice_hash is now stale and will")
    print("simply miss; run `python3 app/tts/monday_tts.py --purge-cache` to reclaim it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

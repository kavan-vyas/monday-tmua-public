# Monday's voice — maths-aware local TTS

Kokoro-82M, British English, running on MPS, entirely offline and free. The
thing that makes it worth having is not the model: it is that `\frac{x^2-1}{x-2}`
comes out as *"x squared minus one, over x minus two"* with a beat either side,
rather than as the noise every commercial TTS makes of it.

Vendored from an earlier maths-TTS project (copied, not linked, so
the project stays self-contained) and extended with the prosody, mood and
worker layers.

## Files

| file | what it is |
|---|---|
| `latex_to_speech.py` | deterministic regex converter, LaTeX → spoken English. Fractions, roots, powers, bounded integrals/sums/limits, matrices, Greek, blackboard-bold, accents, trig/log. **Local addition:** derivative primes, so `f'(2)` is "f prime of 2" rather than "f 2". |
| `maths_lexicon.json` | 240 maths words → British IPA. |
| `lexicon.py` | IPA → misaki's alphabet, patched into Kokoro's gold lexicon at runtime. |
| `prosody.py` | the 6 mood presets and the text → synthesis-plan planner. Pure Python, no torch. |
| `build_voice.py` | builds the blended Monday voice tensor → `voices/monday.pt`. |
| `monday_tts.py` | the long-lived worker: NDJSON on stdin/stdout, ffmpeg mood colouring, sha256 audio cache. |
| `linebank.json` | Monday's fixed lines (boot greetings, verdict stems, timer alerts, mode announcements, nudge openers). |
| `build_linebank.mjs` | `npm run voice:build` — builds the voice, then pre-renders every fixed line into the cache. |
| `tests/` | 52 tests: the converter, the lexicon's phoneme mapping through the real G2P, and the prosody planner. |

## Usage

```sh
python3 app/tts/build_voice.py                            # 0.62*bm_george + 0.38*bm_lewis
python3 app/tts/monday_tts.py --once "$f'(2)$" --mood sharp --play
python3 app/tts/monday_tts.py --once "..." --dry-run      # plan only, no model load
python3 app/tts/monday_tts.py --serve                     # the worker voice.js drives
python3 app/tts/monday_tts.py --cache-stats
python3 app/tts/monday_tts.py --purge-cache
node app/tts/build_linebank.mjs                           # npm run voice:build
python3 -m pytest app/tts/tests/
```

## The pipeline, per utterance

1. **Protect maths, then strip markdown.** In that order: `_x_`, `*` and `\[`
   are all markdown *and* LaTeX, so the maths spans come out behind sentinels
   first and go back in afterwards.
2. **Normalise each maths span** through `convert_latex`.
3. **Plan prosody** from the mood preset (`prosody.py`):
   - maths spans at `0.88 ×` base speed with a **200 ms lead-in and 260 ms
     trailing pause** — the listener needs a beat to load an expression and a
     beat to finish parsing it. This is the single biggest intelligibility win
     in spoken mathematics;
   - ±3 % sentence-level speed jitter, **seeded from the sentence text** so the
     plan stays deterministic and the audio cache still hits;
   - 60–140 ms at clause boundaries, 320 ms at sentence ends, 500 ms at
     paragraph breaks, all scaled per mood;
   - `*starred*` words become their own span at `0.92 ×` and +1.5 dB.
4. **Synthesise** each span against the Monday tensor and splice `np.zeros`
   silences at 24 kHz. Kokoro pads ~300 ms of lead and ~450 ms of tail onto
   every chunk it generates, so each span is trimmed to its actual speech first
   — otherwise the padding swamps the whole plan.
5. **Post-process per mood** with ffmpeg: pitch (`asetrate`/`aresample`/
   `atempo`), compressor, high-shelf, limiter. Measured spectral centroid runs
   from 2142 Hz (grave) to 3352 Hz (sharp) on identical text, so the moods are
   audibly different people-moods rather than the same read at different speeds.
6. **Cache** to `app/.voicecache/<sha256(plan + voice hash + mood)>.wav`,
   LRU-capped at 200 MB. Cached replay of a two-sentence utterance is ~50 ms.

## Moods

| mood | speed | pitch | tone |
|---|---|---|---|
| focused | 1.00 | 0 | neutral, light compression |
| sharp | 1.06 | +1.5 % | brighter shelf, tighter compression |
| gentle | 0.93 | −1.5 % | softer, pauses ×1.35, shelf rolled off |
| clinical | 1.02 | 0 | flat, minimal pauses, no jitter |
| wry | 0.98 | +0.5 % | longer clause pauses — the deadpan beat |
| grave | 0.90 | −2.5 % | dark, slow, long sentence pauses |

## Notes

- The blend weights in `build_voice.py` are a starting point, tuned by ear:
  george carries the low unhurried authority, lewis the edge and the crisper
  consonants that keep maths intelligible. Past ~0.45 lewis it starts to sound
  impatient. Rebuilding with different weights changes `voice_hash`, which
  silently invalidates every cached wav — run `--purge-cache` to reclaim it.
- **`espeak-ng` is not installed.** It is misaki's out-of-vocabulary G2P
  fallback. The lexicon covers maths vocabulary, so this only affects rare words
  and proper names. `brew install espeak-ng` is a recommendation, not a
  requirement — nothing here needs it.
- Extend the lexicon by adding plain `"word": "IPA"` pairs to
  `maths_lexicon.json` and running the tests, which validate the charset mapping.

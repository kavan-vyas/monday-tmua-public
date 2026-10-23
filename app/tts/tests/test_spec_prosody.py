"""Spec-derived prosody tests — plangamma.md §A1, criteria ACC-VOICE-01..44.

Written by agent E from the specification, NOT from prosody.py. The numbers below
are the spec's numbers. Where the spec modifies a value per mood it says so
explicitly, and only those modifications are allowed:

    gentle    "pauses x1.35"
    clinical  "minimal pauses, no jitter"
    wry       "longer clause pauses"
    grave     "long sentence pauses"

Anything the mood table does NOT name must equal the §A1 step-3 default. That
reading is what the assertions below encode. See app/tests/ACCEPTANCE.md,
ambiguity A-5.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

TTS = Path(__file__).parent.parent
sys.path.insert(0, str(TTS))

import prosody  # noqa: E402
from prosody import MOODS, plan, preset  # noqa: E402

# ---------------------------------------------------------------- §A1 step 3
# The defaults, straight out of the spec.
SPEC = {
    "math_speed": 0.88,        # "math spans at 0.88x base speed"
    "math_lead_ms": 200,       # "a 200 ms lead-in"
    "math_tail_ms": 260,       # "and a 260 ms trailing pause"
    "jitter": 0.03,            # "+/-3% sentence-level speed jitter"
    "clause_lo": 60,           # "60-140 ms at commas/em dashes"
    "clause_hi": 140,
    "sentence_ms": 320,        # "320 ms at sentence ends"
    "para_ms": 500,            # "500 ms at paragraph breaks"
}
EMPH_SPEED = 0.92              # "*starred* words ... at 0.92x"
EMPH_GAIN_DB = 1.5             # "... and +1.5 dB"
SAMPLE_RATE = 24000            # "concatenate with np.zeros silences at 24 kHz"
GENTLE_PAUSE_SCALE = 1.35      # gentle: "pauses x1.35"

# §A1 step 5 — mood | speed | pitch
SPEED_PITCH = {
    "focused": (1.00, 0.0),
    "sharp": (1.06, +0.015),
    "gentle": (0.93, -0.015),
    "clinical": (1.02, 0.0),
    "wry": (0.98, +0.005),
    "grave": (0.90, -0.025),
}

# Moods whose row names NO pause change, so every pause must be the default.
UNMODIFIED_PAUSES = ["focused", "sharp"]


# ============================================================ mood preset table

class TestMoodPresetTable:
    def test_acc_voice_36_all_six_moods_have_a_preset(self):
        assert set(MOODS) == set(SPEED_PITCH), "ACC-VOICE-36"

    @pytest.mark.parametrize("mood,expected", SPEED_PITCH.items())
    def test_acc_voice_30_35_speed_and_pitch(self, mood, expected):
        speed, pitch = expected
        p = preset(mood)
        assert p["speed"] == pytest.approx(speed), f"ACC-VOICE-3x {mood} speed"
        assert p["pitch"] == pytest.approx(pitch), f"ACC-VOICE-3x {mood} pitch"

    def test_acc_voice_37_no_two_moods_sound_the_same(self):
        pairs = [(preset(m)["speed"], preset(m)["pitch"]) for m in MOODS]
        assert len(set(pairs)) == len(MOODS), "ACC-VOICE-37 two moods share a (speed, pitch)"

    def test_acc_voice_33_clinical_has_no_jitter(self):
        assert preset("clinical")["jitter"] == 0, "ACC-VOICE-33 clinical: 'no jitter'"

    def test_acc_voice_33_clinical_pauses_are_minimal(self):
        c, f = preset("clinical"), preset("focused")
        assert c["sentence_ms"] < f["sentence_ms"], "ACC-VOICE-33 clinical sentence pause"
        assert c["para_ms"] < f["para_ms"], "ACC-VOICE-33 clinical paragraph pause"
        assert c["clause_ms"][1] < f["clause_ms"][1], "ACC-VOICE-33 clinical clause pause"

    def test_acc_voice_34_wry_has_longer_clause_pauses(self):
        assert preset("wry")["clause_ms"][1] > preset("focused")["clause_ms"][1], \
            "ACC-VOICE-34 wry: 'longer clause pauses — the deadpan beat'"

    def test_acc_voice_35_grave_has_longer_sentence_pauses(self):
        assert preset("grave")["sentence_ms"] > preset("focused")["sentence_ms"], \
            "ACC-VOICE-35 grave: 'long sentence pauses'"


# ============================================================ §A1 step 3 defaults

class TestUnmodifiedPauseDefaults:
    """focused is the unmodified baseline; sharp's row changes tone only."""

    @pytest.mark.parametrize("mood", UNMODIFIED_PAUSES)
    def test_acc_voice_15_clause_pauses_are_60_to_140_ms(self, mood):
        lo, hi = preset(mood)["clause_ms"]
        assert (lo, hi) == (SPEC["clause_lo"], SPEC["clause_hi"]), (
            f"ACC-VOICE-15 {mood} clause pauses are {lo}-{hi} ms; §A1 says 60-140 ms and "
            f"the {mood} row names no pause change"
        )

    @pytest.mark.parametrize("mood", UNMODIFIED_PAUSES)
    def test_acc_voice_16_sentence_pause_is_320_ms(self, mood):
        got = preset(mood)["sentence_ms"]
        assert got == SPEC["sentence_ms"], (
            f"ACC-VOICE-16 {mood} sentence pause is {got} ms; §A1 says 320 ms and the "
            f"{mood} row names no pause change"
        )

    @pytest.mark.parametrize("mood", UNMODIFIED_PAUSES)
    def test_acc_voice_17_paragraph_pause_is_500_ms(self, mood):
        got = preset(mood)["para_ms"]
        assert got == SPEC["para_ms"], (
            f"ACC-VOICE-17 {mood} paragraph pause is {got} ms; §A1 says 500 ms and the "
            f"{mood} row names no pause change"
        )

    @pytest.mark.parametrize("mood", ["focused", "sharp", "wry"])
    def test_acc_voice_11_12_math_bracket_is_200_and_260(self, mood):
        p = preset(mood)
        assert (p["math_lead_ms"], p["math_tail_ms"]) == (SPEC["math_lead_ms"], SPEC["math_tail_ms"]), (
            f"ACC-VOICE-11/12 {mood} brackets maths with "
            f"{p['math_lead_ms']}/{p['math_tail_ms']} ms; §A1 says 200/260 ms"
        )

    @pytest.mark.parametrize("mood", MOODS)
    def test_acc_voice_10_math_spans_are_always_0_88(self, mood):
        got = preset(mood)["math_speed"]
        assert got == pytest.approx(SPEC["math_speed"]), (
            f"ACC-VOICE-10 {mood} speaks maths at {got}x; §A1 states 0.88x unconditionally "
            "and no mood row overrides it"
        )

    @pytest.mark.parametrize("mood", [m for m in MOODS if m != "clinical"])
    def test_acc_voice_13_jitter_is_three_percent(self, mood):
        got = preset(mood)["jitter"]
        assert got == pytest.approx(SPEC["jitter"]), (
            f"ACC-VOICE-13 {mood} jitter is +/-{got:.0%}; §A1 says +/-3% and only clinical "
            "is excused ('no jitter')"
        )


class TestGentlePauseScaling:
    """gentle is the one mood the spec gives a pause NUMBER for: x1.35."""

    def test_acc_voice_32_sentence_pause_is_focused_times_1_35(self):
        want = round(SPEC["sentence_ms"] * GENTLE_PAUSE_SCALE)
        got = preset("gentle")["sentence_ms"]
        assert abs(got - want) <= 1, f"ACC-VOICE-32 gentle sentence pause {got} != {want}"

    def test_acc_voice_32_paragraph_pause_is_focused_times_1_35(self):
        want = round(SPEC["para_ms"] * GENTLE_PAUSE_SCALE)
        got = preset("gentle")["para_ms"]
        assert abs(got - want) <= 1, f"ACC-VOICE-32 gentle paragraph pause {got} != {want}"

    def test_acc_voice_32_clause_pauses_are_focused_times_1_35(self):
        lo, hi = preset("gentle")["clause_ms"]
        assert abs(lo - round(SPEC["clause_lo"] * GENTLE_PAUSE_SCALE)) <= 1, \
            f"ACC-VOICE-32 gentle clause lo {lo}"
        assert abs(hi - round(SPEC["clause_hi"] * GENTLE_PAUSE_SCALE)) <= 1, \
            f"ACC-VOICE-32 gentle clause hi {hi}"

    def test_acc_voice_32_math_bracket_is_scaled_the_same_way(self):
        p = preset("gentle")
        want_lead = round(SPEC["math_lead_ms"] * GENTLE_PAUSE_SCALE)
        want_tail = round(SPEC["math_tail_ms"] * GENTLE_PAUSE_SCALE)
        assert abs(p["math_lead_ms"] - want_lead) <= 1, (
            f"ACC-VOICE-32 gentle maths lead-in is {p['math_lead_ms']} ms. gentle scales "
            f"pauses by 1.35, so it should be {want_lead}; unscaled it should be 200. "
            "It is neither, while the trailing pause IS scaled — the two do not agree."
        )
        assert abs(p["math_tail_ms"] - want_tail) <= 1, \
            f"ACC-VOICE-32 gentle maths tail {p['math_tail_ms']} != {want_tail}"

    def test_acc_voice_32_gentle_is_slower_and_softer_than_focused(self):
        assert preset("gentle")["speed"] < preset("focused")["speed"], "ACC-VOICE-32 slower"
        assert preset("gentle")["shelf_db"] < preset("focused")["shelf_db"], \
            "ACC-VOICE-32 'shelf rolled off'"


# ============================================================ the planned output

TEXT = (
    "Given $f(x)=\\frac{x^2-1}{x-2}$, find the derivative at two. "
    "That is a quotient, so use the quotient rule. Then *check* the sign.\n\n"
    "Second paragraph, with a clause, and another clause here."
)


def pauses(items, why):
    return [i["ms"] for i in items if i["t"] == "pause" and i["why"] == why]


def says(items, kind=None):
    return [i for i in items if i["t"] == "say" and (kind is None or i["kind"] == kind)]


class TestPlannedPipeline:
    def test_acc_voice_03_maths_becomes_its_own_span(self):
        items, _, meta = plan(TEXT, "focused")
        assert meta["n_math"] >= 1, "ACC-VOICE-03 no maths span was segmented"
        assert says(items, "math"), "ACC-VOICE-03"

    def test_acc_voice_04_maths_is_normalised_to_spoken_english(self):
        items, spoken, _ = plan(TEXT, "focused")
        m = says(items, "math")[0]["text"]
        assert "\\frac" not in m and "^" not in m, f"ACC-VOICE-04 raw LaTeX survived: {m}"
        assert "over" in m, f"ACC-VOICE-04 the fraction was not spoken as 'over': {m}"
        assert "squared" in m, f"ACC-VOICE-04 the power was not spoken: {m}"

    def test_acc_voice_02_markdown_is_stripped_before_synthesis(self):
        items, spoken, _ = plan("# Heading\n\nSome **bold** and `code` and [a link](http://x).", "focused")
        assert "#" not in spoken and "**" not in spoken and "`" not in spoken, \
            f"ACC-VOICE-02 markdown reached the synthesiser: {spoken!r}"

    def test_acc_voice_10_the_planned_math_speed_is_base_times_0_88(self):
        items, _, _ = plan(TEXT, "focused")
        base = preset("focused")["speed"]
        for s in says(items, "math"):
            assert s["speed"] == pytest.approx(base * SPEC["math_speed"], abs=1e-4), \
                f"ACC-VOICE-10 maths planned at {s['speed']}"

    def test_acc_voice_11_12_every_math_span_is_bracketed(self):
        items, _, _ = plan(TEXT, "focused")
        idxs = [n for n, i in enumerate(items) if i["t"] == "say" and i["kind"] == "math"]
        for n in idxs:
            before = items[n - 1] if n else None
            after = items[n + 1] if n + 1 < len(items) else None
            assert before and before["t"] == "pause" and before["ms"] >= SPEC["math_lead_ms"], \
                "ACC-VOICE-11 no 200 ms lead-in before a maths span"
            assert after and after["t"] == "pause" and after["ms"] >= SPEC["math_tail_ms"], \
                "ACC-VOICE-12 no 260 ms trailing pause after a maths span"

    def test_acc_voice_13_every_sentence_speed_is_within_three_percent(self):
        base = preset("focused")["speed"]
        lo, hi = base * (1 - SPEC["jitter"]), base * (1 + SPEC["jitter"])
        for n in range(40):
            items, _, _ = plan(f"Sentence number {n} runs along here. And a second one follows it.", "focused")
            for s in says(items, "prose"):
                assert lo - 1e-6 <= s["speed"] <= hi + 1e-6, \
                    f"ACC-VOICE-13 prose speed {s['speed']} outside +/-3% of {base}"

    def test_acc_voice_14_jitter_is_not_degenerate(self):
        speeds = set()
        for n in range(40):
            items, _, _ = plan(f"Sentence number {n} runs along here.", "focused")
            speeds.update(s["speed"] for s in says(items, "prose"))
        assert len(speeds) > 1, "ACC-VOICE-14 every sentence got the same speed — delivery is metronomic"

    def test_acc_voice_33_clinical_delivery_is_exactly_the_base_speed(self):
        base = preset("clinical")["speed"]
        for n in range(20):
            items, _, _ = plan(f"Sentence number {n} runs along here.", "clinical")
            for s in says(items, "prose"):
                assert s["speed"] == pytest.approx(base, abs=1e-6), \
                    f"ACC-VOICE-33 clinical jittered to {s['speed']}"

    def test_acc_voice_15_clause_pauses_stay_inside_the_band(self):
        lo, hi = preset("focused")["clause_ms"]
        assert (lo, hi) == (SPEC["clause_lo"], SPEC["clause_hi"])
        for n in range(30):
            items, _, _ = plan(
                f"First clause number {n}, second clause here, and a third clause as well.", "focused")
            for ms in pauses(items, "clause"):
                assert SPEC["clause_lo"] <= ms <= SPEC["clause_hi"], \
                    f"ACC-VOICE-15 clause pause of {ms} ms outside 60-140 ms"

    def test_acc_voice_16_17_sentence_and_paragraph_pauses(self):
        items, _, _ = plan(
            "One sentence here. Two sentences here.\n\nA new paragraph starts here.", "focused")
        assert SPEC["sentence_ms"] in pauses(items, "sentence"), \
            f"ACC-VOICE-16 sentence pauses were {pauses(items, 'sentence')}, expected 320 ms"
        assert SPEC["para_ms"] in pauses(items, "paragraph"), \
            f"ACC-VOICE-17 paragraph pauses were {pauses(items, 'paragraph')}, expected 500 ms"

    def test_acc_voice_18_starred_words_get_their_own_span(self):
        items, _, _ = plan("You must *check* the sign before you move on.", "focused")
        emph = says(items, "emph")
        assert len(emph) == 1, f"ACC-VOICE-18 expected one emphasis span, got {len(emph)}"
        assert emph[0]["text"] == "check", f"ACC-VOICE-18 span text is {emph[0]['text']!r}"

    def test_acc_voice_19_emphasis_is_spoken_at_0_92(self):
        items, _, _ = plan("You must *check* the sign.", "focused")
        base = preset("focused")["speed"]
        assert says(items, "emph")[0]["speed"] == pytest.approx(base * EMPH_SPEED, abs=1e-4), \
            "ACC-VOICE-19"

    def test_acc_voice_20_emphasis_is_plus_1_5_db(self):
        items, _, _ = plan("You must *check* the sign.", "focused")
        assert says(items, "emph")[0]["gain_db"] == pytest.approx(EMPH_GAIN_DB), "ACC-VOICE-20"

    def test_acc_voice_21_the_asterisks_are_never_spoken(self):
        _, spoken, _ = plan("You must *check* the sign.", "focused")
        assert "*" not in spoken, f"ACC-VOICE-21 asterisks reached the voice: {spoken!r}"

    def test_acc_voice_18_module_constants_match_the_spec(self):
        assert prosody.EMPH_SPEED == pytest.approx(EMPH_SPEED), "ACC-VOICE-19"
        assert prosody.EMPH_GAIN_DB == pytest.approx(EMPH_GAIN_DB), "ACC-VOICE-20"

    def test_plan_is_deterministic_so_the_cache_is_sound(self):
        a = plan(TEXT, "sharp")
        b = plan(TEXT, "sharp")
        assert a == b, "the same text and mood must give byte-identical plans"

    @pytest.mark.parametrize("mood", MOODS)
    def test_every_mood_plans_without_error(self, mood):
        items, spoken, meta = plan(TEXT, mood)
        assert items and spoken, f"{mood} produced an empty plan"
        assert meta["mood"] == mood


# ============================================================ sample rate + cache

class TestSampleRateAndCache:
    """monday_tts imports kokoro/torch and reassigns fd 1, so it is exercised in a
    child process rather than imported into the pytest session."""

    RUNNER = (
        "import os, sys, json;"
        "sys.path.insert(0, {tts!r});"
        "os.environ['MONDAY_VOICE_CACHE'] = {cache!r};"
        "import monday_tts as M;"
    )

    def _run(self, body, cache_dir):
        code = self.RUNNER.format(tts=str(TTS), cache=str(cache_dir)) + body
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=600)
        assert r.returncode == 0, f"child failed:\n{r.stdout}\n{r.stderr}"
        return r.stderr  # monday_tts moves fd 1 to fd 2 on import

    def test_acc_voice_05_sample_rate_is_24_khz(self, tmp_path):
        out = self._run("print('SR=%d' % M.SR, file=sys.stderr)", tmp_path)
        assert f"SR={SAMPLE_RATE}" in out, f"ACC-VOICE-05 sample rate is not 24 kHz: {out}"

    def test_acc_voice_40_41_cache_key_is_sha256_of_plan_voice_and_preset(self, tmp_path):
        body = (
            "items,_,_ = M.plan('One line of text.', 'focused');"
            "k1 = M.cache_key(items, 'focused', 'VOICEHASH');"
            "k2 = M.cache_key(items, 'focused', 'VOICEHASH');"
            "k3 = M.cache_key(items, 'sharp', 'VOICEHASH');"
            "k4 = M.cache_key(items, 'focused', 'OTHERVOICE');"
            "items2,_,_ = M.plan('A different line of text.', 'focused');"
            "k5 = M.cache_key(items2, 'focused', 'VOICEHASH');"
            "print(json.dumps([k1,k2,k3,k4,k5]), file=sys.stderr)"
        )
        keys = None
        for line in self._run(body, tmp_path).splitlines():
            if line.startswith("["):
                keys = json.loads(line)
        assert keys, "no key output"
        k1, k2, k3, k4, k5 = keys
        for k in keys:
            assert re.fullmatch(r"[0-9a-f]{64}", k), f"ACC-VOICE-41 not a sha256 hex digest: {k}"
        assert k1 == k2, "ACC-VOICE-40 the key is not stable for identical inputs"
        assert k1 != k3, "ACC-VOICE-40 changing the preset must change the key"
        assert k1 != k4, "ACC-VOICE-40 changing the voice hash must change the key"
        assert k1 != k5, "ACC-VOICE-40 changing the spoken text must change the key"

    def test_acc_voice_41_cache_files_are_sha256_dot_wav(self, tmp_path):
        body = (
            "p = M.cache_path('a' * 64);"
            "print('PATH=' + p.name, file=sys.stderr)"
        )
        out = self._run(body, tmp_path)
        name = [l for l in out.splitlines() if l.startswith("PATH=")][0][5:]
        assert re.fullmatch(r"[0-9a-f]{64}\.wav", name), f"ACC-VOICE-41 cache filename {name}"

    def test_acc_voice_42_a_repeat_render_is_a_cache_hit(self, tmp_path):
        body = (
            "M.cache_put('b' * 64, b'RIFFxxxxWAVEfmt payload');"
            "hit = M.cache_get('b' * 64);"
            "print('HIT=%s' % (hit is not None), file=sys.stderr)"
        )
        assert "HIT=True" in self._run(body, tmp_path), "ACC-VOICE-42 a stored entry did not read back"

    def test_acc_voice_43_44_lru_trim_evicts_least_recently_used_first(self, tmp_path):
        # Ten 1 MB files, touched so that 'old' is the least recently USED (not the
        # least recently created), then trimmed to a 5 MB cap.
        body = (
            "import time, os;"
            "blob = b'R' * (1024 * 1024);"
            "names = ['%064x' % i for i in range(10)];"
            "M.CACHE_DIR.mkdir(parents=True, exist_ok=True);"
            "[M.cache_path(n).write_bytes(blob) for n in names];"
            "now = time.time();"
            # names[0] created first but touched last -> most recently used
            "[os.utime(M.cache_path(n), (now - 1000 + i, now - 1000 + i)) for i, n in enumerate(reversed(names))];"
            "freed = M.lru_trim(cap=5 * 1024 * 1024);"
            "left = sorted(p.stem for p in M.CACHE_DIR.glob('*.wav'));"
            "total = sum(p.stat().st_size for p in M.CACHE_DIR.glob('*.wav'));"
            "print('LEFT=' + ','.join(left), file=sys.stderr);"
            "print('TOTAL=%d' % total, file=sys.stderr)"
        )
        out = self._run(body, tmp_path)
        left = [l for l in out.splitlines() if l.startswith("LEFT=")][0][5:].split(",")
        total = int([l for l in out.splitlines() if l.startswith("TOTAL=")][0][6:])
        assert total <= 5 * 1024 * 1024, f"ACC-VOICE-44 cache is {total} bytes, over the 5 MB cap"
        # The most recently used entries must be the survivors.
        survivors = {int(n, 16) for n in left}
        assert survivors <= {0, 1, 2, 3, 4}, (
            f"ACC-VOICE-43 LRU kept {sorted(survivors)}; the most recently used are 0..4"
        )

    def test_acc_voice_44_the_default_cap_is_200_mb(self, tmp_path):
        out = self._run("print('CAP=%d' % M.CACHE_CAP_BYTES, file=sys.stderr)", tmp_path)
        cap = int([l for l in out.splitlines() if l.startswith("CAP=")][0][4:])
        assert cap == 200 * 1024 * 1024, f"ACC-VOICE-43 the LRU cap is {cap / 1e6:.0f} MB, spec says ~200 MB"

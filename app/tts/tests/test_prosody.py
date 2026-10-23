"""Tests for Monday's prosody planner and the primes added to the converter.

No torch, no kokoro, no ffmpeg: the part of the voice that carries the
character is the part that must stay fast to test.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from latex_to_speech import convert_latex  # noqa: E402
from prosody import (  # noqa: E402
    MOODS, clause_split, plan, sentence_split, strip_markdown, protect_math,
)


def says(items):
    return [i for i in items if i["t"] == "say"]


def pauses(items):
    return [i for i in items if i["t"] == "pause"]


class TestPrimes:
    """f'(2) must be 'f prime of 2'; Kokoro says nothing for a bare apostrophe."""

    def test_first_derivative(self):
        assert convert_latex(r"$f'(2)$") == "f prime of 2"

    def test_second_derivative(self):
        assert convert_latex(r"$f''(x)=0$") == "f double prime of x equals 0"

    def test_prose_apostrophes_survive(self):
        assert convert_latex("It's Sam's turn.") == "It's Sam's turn."


class TestMarkdown:
    def test_headings_bullets_links_removed(self):
        out = strip_markdown("## Step one\n\n- do a thing\n- see [the docs](http://x.y)")
        assert "#" not in out and "http" not in out
        assert "do a thing" in out and "the docs" in out

    def test_emphasis_becomes_a_sentinel(self):
        out = strip_markdown("look at the **discriminant** now")
        assert "\x01discriminant\x01" in out

    def test_code_fences_dropped(self):
        assert "print" not in strip_markdown("before\n```\nprint(1)\n```\nafter")

    def test_maths_is_protected_before_stripping(self):
        text = r"the value $a_1 * b_2$ and *this*"
        protected, spans = protect_math(text)
        assert spans == [r"a_1 * b_2"]
        # the * inside the maths span must not have been read as markdown
        assert "\x01" not in protected


class TestSplitting:
    def test_abbreviations_do_not_split(self):
        assert len(sentence_split("Use e.g. the chain rule. Then stop.")) == 2

    def test_clause_runts_are_glued_back(self):
        # "Well," is a runt and must not become its own synthesis unit
        assert clause_split("Well, that is a much longer clause here") == [
            "Well, that is a much longer clause here"
        ]

    def test_clauses_split_when_both_sides_are_substantial(self):
        out = clause_split("the first clause runs on a while, the second clause also runs on")
        assert len(out) == 2
        assert out[0].endswith(",")  # punctuation stays put for the intonation contour


class TestPlan:
    TEXT = r"Given $f(x)=\frac{x^2-1}{x-2}$, find $f'(2)$."

    def test_math_is_converted_not_read_literally(self):
        _, spoken, _ = plan(self.TEXT)
        assert "f of x equals x squared minus 1 over x minus 2" in spoken
        assert "f prime of 2" in spoken
        assert "frac" not in spoken and "$" not in spoken

    def test_math_spans_are_bracketed_by_pauses(self):
        items, _, _ = plan(self.TEXT, "focused")
        for i, item in enumerate(items):
            if item["t"] == "say" and item["kind"] == "math":
                assert items[i - 1]["t"] == "pause" and items[i - 1]["ms"] >= 200
                if i + 1 < len(items):
                    assert items[i + 1]["t"] == "pause" and items[i + 1]["ms"] >= 260

    def test_math_is_slower_than_prose(self):
        items, _, _ = plan(self.TEXT, "focused")
        math = [i["speed"] for i in says(items) if i["kind"] == "math"]
        prose = [i["speed"] for i in says(items) if i["kind"] == "prose"]
        assert max(math) < min(prose)

    def test_emphasis_is_its_own_span(self):
        items, _, _ = plan("Look at the *discriminant* now.")
        emph = [i for i in says(items) if i["kind"] == "emph"]
        assert len(emph) == 1
        assert emph[0]["text"] == "discriminant"
        assert emph[0]["gain_db"] == pytest.approx(1.5)
        assert emph[0]["speed"] < 1.0

    def test_deterministic(self):
        a, sa, _ = plan(self.TEXT, "wry")
        b, sb, _ = plan(self.TEXT, "wry")
        assert a == b and sa == sb   # jitter is seeded from the text, so caching works

    def test_jitter_is_within_three_percent(self):
        items, _, _ = plan("One sentence here. Another sentence here. A third one here.", "focused")
        for i in says(items):
            if i["kind"] == "prose":
                assert 0.97 <= i["speed"] <= 1.03

    def test_clinical_has_no_jitter(self):
        items, _, _ = plan("One sentence here. Another sentence here.", "clinical")
        speeds = {i["speed"] for i in says(items) if i["kind"] == "prose"}
        assert len(speeds) == 1

    def test_list_lines_get_their_own_beat(self):
        items, _, _ = plan("- first, factorise\n- then check the sign")
        texts = [i["text"] for i in says(items)]
        assert any("factorise" in t for t in texts)
        assert not any("factorise" in t and "check" in t for t in texts)

    def test_paragraph_pause_is_longest(self):
        items, _, _ = plan("First para here.\n\nSecond para here.", "focused")
        assert max(p["ms"] for p in pauses(items)) == MOODS["focused"]["para_ms"]

    def test_gentle_is_slower_and_pauses_longer_than_sharp(self):
        g, _, mg = plan(self.TEXT, "gentle")
        s, _, ms = plan(self.TEXT, "sharp")
        assert max(i["speed"] for i in says(g)) < max(i["speed"] for i in says(s))
        assert mg["silence_ms"] > ms["silence_ms"]

    def test_every_mood_plans(self):
        for mood in MOODS:
            items, spoken, meta = plan(self.TEXT, mood)
            assert says(items) and spoken and meta["mood"] == mood

    def test_unknown_mood_falls_back_to_focused(self):
        assert plan(self.TEXT, "furious")[2]["mood"] == "focused"

    def test_empty_and_unspeakable_input(self):
        for junk in ["", "   ", "\n\n", "---", "```\ncode\n```"]:
            items, _, _ = plan(junk)
            assert says(items) == []

    def test_no_span_starts_with_stray_punctuation(self):
        items, _, _ = plan(self.TEXT)
        assert all(not i["text"][0] in ",;:." for i in says(items))

    def test_no_sentinels_leak_into_spoken_text(self):
        _, spoken, _ = plan("Mix *this* and $x^2$ and **that**.")
        assert "\x00" not in spoken and "\x01" not in spoken

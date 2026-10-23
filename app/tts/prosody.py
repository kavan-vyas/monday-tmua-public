"""Monday's prosody planner.

Pure text in, a synthesis plan out. No torch, no kokoro, no ffmpeg — which is
the point: the part of the voice that actually carries the character is the
part you can unit-test in 20 milliseconds.

A plan is a flat list of items:

    {'t': 'say',   'text': str, 'speed': float, 'gain_db': float, 'kind': str}
    {'t': 'pause', 'ms': int, 'why': str}

`kind` is one of 'prose' | 'math' | 'emph'. The renderer synthesises each 'say'
against the Monday voice tensor at the item's speed, applies its gain, and
splices `ms` of digital silence for each 'pause'.

Why the pauses matter: spoken mathematics is the one register where a listener
genuinely cannot keep up without them. An expression needs a beat before it to
signal "stop parsing English, start parsing maths", and a beat after it to
finish. That 200 ms / 260 ms bracket is the single biggest intelligibility win
in the whole pipeline, and no general-purpose TTS does it.
"""

import hashlib
import random
import re

from latex_to_speech import _MATH_SEGMENT, convert_math

PLAN_VERSION = 3  # bump to invalidate every cached wav

# ---------------------------------------------------------------- mood presets

# speed        base rate handed to Kokoro (changes duration, not pitch)
# pitch        fractional resample shift, applied in ffmpeg (+0.015 = +1.5%)
# shelf_db     high-shelf gain at 3.2 kHz — "brightness"
# comp         (threshold_db, ratio, attack_ms, release_ms, makeup_db)
# jitter       sentence-level speed wobble, +/- this fraction
# clause_ms    (lo, hi) pause at commas / semicolons / em dashes
# sentence_ms  pause at sentence ends
# para_ms      pause at paragraph breaks
# math_speed   multiplier applied to base speed inside a maths span
# math_lead_ms / math_tail_ms   the bracket around a maths span
MOODS = {
    # Default. Level, economical, quietly attentive.
    "focused": dict(
        speed=1.00, pitch=0.0, shelf_db=0.5,
        comp=(-18.0, 3.0, 8, 180, 1.5),
        jitter=0.03, clause_ms=(60, 140), sentence_ms=320, para_ms=500,
        math_speed=0.88, math_lead_ms=200, math_tail_ms=260,
    ),
    # Dry needling. Faster, brighter, tighter — someone who has decided you can
    # keep up and is mildly interested in whether you do.
    "sharp": dict(
        speed=1.06, pitch=0.015, shelf_db=2.5,
        comp=(-22.0, 4.0, 5, 120, 2.0),
        jitter=0.03, clause_ms=(55, 120), sentence_ms=270, para_ms=430,
        math_speed=0.88, math_lead_ms=200, math_tail_ms=260,
    ),
    # Slower, warmer, edge removed. Pauses x1.35 so it never feels chased.
    "gentle": dict(
        speed=0.93, pitch=-0.015, shelf_db=-2.0,
        comp=(-16.0, 2.2, 20, 260, 1.0),
        jitter=0.03, clause_ms=(80, 190), sentence_ms=432, para_ms=675,
        math_speed=0.88, math_lead_ms=250, math_tail_ms=350,
    ),
    # EXAM mode. Almost no personality: flat, minimal pauses, no jitter at all.
    "clinical": dict(
        speed=1.02, pitch=0.0, shelf_db=0.0,
        comp=(-20.0, 2.5, 10, 150, 1.2),
        jitter=0.0, clause_ms=(40, 40), sentence_ms=200, para_ms=300,
        math_speed=0.90, math_lead_ms=160, math_tail_ms=220,
    ),
    # The deadpan beat. Long clause pauses are the entire joke delivery system.
    "wry": dict(
        speed=0.98, pitch=0.005, shelf_db=1.0,
        comp=(-18.0, 3.0, 8, 200, 1.5),
        jitter=0.03, clause_ms=(110, 250), sentence_ms=380, para_ms=560,
        math_speed=0.88, math_lead_ms=200, math_tail_ms=260,
    ),
    # Rare, so it lands. Dark, slow, long sentence pauses, no jokes.
    "grave": dict(
        speed=0.90, pitch=-0.025, shelf_db=-3.0,
        comp=(-15.0, 2.0, 25, 320, 0.8),
        jitter=0.02, clause_ms=(90, 200), sentence_ms=520, para_ms=820,
        math_speed=0.88, math_lead_ms=240, math_tail_ms=320,
    ),
}
DEFAULT_MOOD = "focused"

EMPH_SPEED = 0.92   # *starred* words get their own span...
EMPH_GAIN_DB = 1.5  # ...slightly slower and slightly louder.


def preset(mood):
    return MOODS.get((mood or "").lower(), MOODS[DEFAULT_MOOD])


def preset_name(mood):
    m = (mood or "").lower()
    return m if m in MOODS else DEFAULT_MOOD


# ------------------------------------------------------------- markdown strip

MATH_SENTINEL = "\x00"   # \x00 M <index> \x00
EMPH_SENTINEL = "\x01"   # \x01 text \x01

_FENCE = re.compile(r"```.*?```|~~~.*?~~~", re.DOTALL)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_AUTOLINK = re.compile(r"<(https?://[^>]+)>")
_BARE_URL = re.compile(r"https?://\S+")
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_QUOTE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_HR = re.compile(r"^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$", re.MULTILINE)
_TABLE_SEP = re.compile(r"^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?\s*$", re.MULTILINE)
_BULLET = re.compile(r"^\s*[-+*]\s+", re.MULTILINE)
_ORDERED = re.compile(r"^\s*\d{1,3}[.)]\s+", re.MULTILINE)
_STRIKE = re.compile(r"~~(.+?)~~", re.DOTALL)
_BOLD = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_ITALIC = re.compile(r"(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)")
_ESCAPED = re.compile(r"\\([*_`~\[\]()#+.!-])")


def protect_math(text):
    """Pull every $..$ / $$..$$ / \\(..\\) / \\[..\\] span out behind a sentinel."""
    spans = []

    def repl(m):
        inner = next(g for g in m.groups() if g is not None)
        spans.append(inner)
        return f"{MATH_SENTINEL}M{len(spans) - 1}{MATH_SENTINEL}"

    return _MATH_SEGMENT.sub(repl, text), spans


def strip_markdown(text):
    """Remove markup that should not be read aloud, keeping emphasis as a sentinel.

    Assumes maths has already been pulled out behind sentinels — otherwise
    `_x_`, `*`, and `\\[` would all be misread as markup.
    """
    t = _FENCE.sub(" ", text)
    t = _TABLE_SEP.sub("", t)
    t = _HR.sub("", t)
    t = _IMAGE.sub(r"\1", t)
    t = _LINK.sub(r"\1", t)
    t = _AUTOLINK.sub(" a link ", t)
    t = _BARE_URL.sub(" a link ", t)
    t = _INLINE_CODE.sub(r"\1", t)
    t = _HEADING.sub("", t)
    t = _QUOTE.sub("", t)
    t = _BULLET.sub("", t)
    t = _ORDERED.sub("", t)
    t = _STRIKE.sub(r"\1", t)
    t = _BOLD.sub(EMPH_SENTINEL + r"\1" + EMPH_SENTINEL, t)
    t = _ITALIC.sub(EMPH_SENTINEL + r"\1" + EMPH_SENTINEL, t)
    t = t.replace("|", ", ")
    t = _ESCAPED.sub(r"\1", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


# --------------------------------------------------------------- segmentation

_DASH = re.compile(r"\s*(?:—|–|(?<=\s)--(?=\s))\s*")
_SPLIT_CAND = re.compile(r"([.!?…]+[)\"'\]]*)(\s+|$)")
_ABBREV_TAIL = re.compile(
    r"(?:^|[\s(\"'])(?:e\.g|i\.e|etc|vs|cf|approx|resp|no|fig|eq|ch|pp|"
    r"Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|[A-Za-z])$"
)


def sentence_split(text):
    """Split on sentence boundaries, refusing to be fooled by 'e.g.' or initials."""
    out, start = [], 0
    for m in _SPLIT_CAND.finditer(text):
        head = text[start:m.start(1)]
        if _ABBREV_TAIL.search(head):
            continue
        piece = text[start:m.end(1)].strip()
        if piece:
            out.append(piece)
        start = m.end(2)
    tail = text[start:].strip()
    if tail:
        out.append(tail)
    return out


def clause_split(text, min_words=4):
    """Split at commas/semicolons/colons, then glue back any runt fragments.

    Punctuation stays attached to the left-hand fragment, so Kokoro still
    produces a continuing (non-final) intonation contour on it rather than
    reading each clause as its own sentence.
    """
    parts, last = [], 0
    for m in re.finditer(r"(?<=[,;:])\s+", text):
        seg = text[last:m.start()].strip()
        if seg:
            parts.append(seg)
        last = m.end()
    tail = text[last:].strip()
    if tail:
        parts.append(tail)
    if not parts:
        return []
    merged = [parts[0]]
    for p in parts[1:]:
        if _words(p) < min_words or _words(merged[-1]) < min_words:
            merged[-1] = f"{merged[-1]} {p}"
        else:
            merged.append(p)
    return merged


def _words(s):
    return len([w for w in re.split(r"\s+", s) if w])


_TOKEN = re.compile(
    MATH_SENTINEL + r"M(\d+)" + MATH_SENTINEL
    + r"|" + EMPH_SENTINEL + r"(.+?)" + EMPH_SENTINEL,
    re.DOTALL,
)


def _tokenize(sentence, math_spans):
    """Split one sentence into ('prose'|'math'|'emph', text) runs."""
    out, pos = [], 0
    for m in _TOKEN.finditer(sentence):
        if m.start() > pos:
            out.append(("prose", sentence[pos:m.start()]))
        if m.group(1) is not None:
            idx = int(m.group(1))
            src = math_spans[idx] if idx < len(math_spans) else ""
            out.append(("math", convert_math(src)))
        else:
            out.append(("emph", m.group(2)))
        pos = m.end()
    if pos < len(sentence):
        out.append(("prose", sentence[pos:]))
    return [(k, t) for k, t in out if t and t.strip()]


def _clean_prose(text):
    """Prose still gets LaTeX commands converted, but bare symbols left alone.

    Same contract as `convert_latex`'s fallback: outside $..$ we do not want
    every hyphen in 'well-known' announced as 'minus'.
    """
    t = text
    if "\\" in t or re.search(r"[\^_]\{", t):
        t = convert_math(t, verbalize_symbols=False)
    t = t.replace(MATH_SENTINEL, " ").replace(EMPH_SENTINEL, " ")
    t = re.sub(r"[`*|]+", " ", t)  # any markdown that survived the strip
    t = re.sub(r"\s+([,.;:?!])", r"\1", t)
    return re.sub(r"\s+", " ", t).strip()


def _speakable(text):
    """Anything with no letter or digit in it produces junk or silence."""
    return bool(re.search(r"[A-Za-z0-9]", text))


def _rng(seed_text):
    h = hashlib.sha1(seed_text.encode("utf-8")).hexdigest()
    return random.Random(int(h[:16], 16))


# ---------------------------------------------------------------------- plan

# Settings-pane bounds. The preset is the character; these only stretch it.
RATE_RANGE = (0.5, 2.0)     # multiplies the mood's base speed
PAUSE_RANGE = (0.3, 3.0)    # multiplies every planned silence


def _clamp(v, lo, hi, default=1.0):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    if n != n:              # NaN
        return default
    return max(lo, min(hi, n))


def plan(text, mood=DEFAULT_MOOD, rate=1.0, pause=1.0):
    """Text (markdown + LaTeX) -> (plan, spoken_text, meta).

    Deterministic: the same text and mood always yield byte-identical plans,
    including the 'random' jitter, which is what makes the audio cache sound.

    `rate` and `pause` are the user's prosody settings (settings pane ->
    config.voice.rate / config.voice.prosody[mood]). They scale the mood preset
    rather than replacing it: 1.0 / 1.0 reproduces the preset exactly, so a
    default install plans byte-identically to before these arguments existed —
    and because the cache key is derived from the plan items, a changed setting
    invalidates exactly the affected cache entries and nothing else.
    """
    p = preset(mood)
    name = preset_name(mood)
    rate = _clamp(rate, *RATE_RANGE)
    pause_scale = _clamp(pause, *PAUSE_RANGE)

    protected, math_spans = protect_math(text or "")
    stripped = strip_markdown(protected)

    items = []

    def pause(ms, why):
        ms = int(round(ms * pause_scale))
        if ms <= 0:
            return
        # Adjacent pauses take the max rather than stacking; a maths span at the
        # end of a sentence should get one considered beat, not two glued ones.
        if items and items[-1]["t"] == "pause":
            if ms > items[-1]["ms"]:
                items[-1] = {"t": "pause", "ms": ms, "why": why}
            return
        items.append({"t": "pause", "ms": ms, "why": why})

    def say(kind, txt, speed, gain_db=0.0):
        # Kokoro is unhappy outside roughly half to double speed, and no prosody
        # setting is allowed to push it there.
        speed = max(0.5, min(2.0, speed * rate))
        txt = re.sub(r"\s+", " ", txt).strip()
        # A fragment that begins with a comma is the tail of a clause a maths
        # span interrupted; the pause already did that work.
        txt = re.sub(r"^[,;:.]+\s*", "", txt)
        if not txt or not _speakable(txt):
            return
        items.append({
            "t": "say", "kind": kind, "text": txt,
            "speed": round(speed, 4), "gain_db": round(gain_db, 2),
        })

    paragraphs = [q for q in re.split(r"\n\s*\n", stripped) if q.strip()]
    for pi, para in enumerate(paragraphs):
        # A hard line break inside a paragraph is nearly always a list item once
        # the bullet has been stripped. Reading "first, factorise then check" as
        # one breath is wrong; each line gets its own sentence beat.
        lines = [ln.strip() for ln in para.split("\n") if ln.strip()]
        for li, line in enumerate(lines):
            sentences = sentence_split(line)
            for si, sent in enumerate(sentences):
                rng = _rng(f"{name}|{pi}|{li}|{si}|{sent}")
                wobble = 1.0 + (rng.uniform(-p["jitter"], p["jitter"]) if p["jitter"] else 0.0)
                for kind, raw in _tokenize(sent, math_spans):
                    if kind == "math":
                        pause(p["math_lead_ms"], "math-lead")
                        say("math", raw, p["speed"] * p["math_speed"])
                        pause(p["math_tail_ms"], "math-tail")
                    elif kind == "emph":
                        say("emph", _clean_prose(raw), p["speed"] * EMPH_SPEED, EMPH_GAIN_DB)
                    else:
                        prose = _clean_prose(_DASH.sub(", ", raw))
                        clauses = clause_split(prose)
                        for ci, clause in enumerate(clauses):
                            if ci:
                                lo, hi = p["clause_ms"]
                                pause(rng.randint(lo, hi) if hi > lo else lo, "clause")
                            say("prose", clause, p["speed"] * wobble)
                if si < len(sentences) - 1:
                    pause(p["sentence_ms"], "sentence")
            if li < len(lines) - 1:
                pause(p["sentence_ms"], "line")
        if pi < len(paragraphs) - 1:
            pause(p["para_ms"], "paragraph")

    while items and items[-1]["t"] == "pause":
        items.pop()

    spoken = " ".join(i["text"] for i in items if i["t"] == "say")
    meta = {
        "mood": name,
        "rate": round(rate, 4),
        "pause": round(pause_scale, 4),
        "plan_version": PLAN_VERSION,
        "n_say": sum(1 for i in items if i["t"] == "say"),
        "n_math": sum(1 for i in items if i["t"] == "say" and i["kind"] == "math"),
        "silence_ms": sum(i["ms"] for i in items if i["t"] == "pause"),
    }
    return items, spoken, meta


def describe(items):
    """Human-readable plan dump for --dry-run."""
    out = []
    for i in items:
        if i["t"] == "pause":
            out.append(f"  ({i['ms']:>4} ms {i['why']})")
        else:
            g = f" {i['gain_db']:+.1f}dB" if i["gain_db"] else ""
            out.append(f"  [{i['kind']:<5} x{i['speed']:.3f}{g}] {i['text']}")
    return "\n".join(out)

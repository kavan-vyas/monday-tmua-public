"""Shared Manim base for the narrated TMUA videos.

A scene's timing comes from its narration: `say(key, beats...)` starts the line's audio,
plays the beats, then waits out the rest of the line. VIDEO_OUT points at the directory
narrate.py wrote (audio/<key>.wav + durations.json).
"""
import json
import os
from pathlib import Path

from manim import *

OUT = Path(os.environ.get("VIDEO_OUT", "."))
DUR = json.loads((OUT / "durations.json").read_text()) if (OUT / "durations.json").exists() else {}
AUD = OUT / "audio"

config.background_color = "#14161b"
ACCENT = YELLOW
GOOD = GREEN_C
BAD = RED_C
SOFT = GREY_B


class Narrated(Scene):
    def say(self, key, *beats, tail=0.3):
        d = DUR[key]
        self.add_sound(str(AUD / f"{key}.wav"))
        used = 0.0
        for b in beats:
            if isinstance(b, (int, float)):
                self.wait(b)
                used += b
                continue
            anims, rt = b if isinstance(b, tuple) else (b, 1.0)
            if not isinstance(anims, (list, tuple)):
                anims = [anims]
            self.play(*anims, run_time=rt)
            used += rt
        rest = d - used + tail
        if rest > 0.04:
            self.wait(rest)

    def section(self, n, title, sub=None):
        """A short on-screen section card (no narration of its own)."""
        num = Text(str(n), font_size=110, weight=BOLD, color=ACCENT)
        t = Text(title, font_size=40).next_to(num, DOWN, buff=0.3)
        g = VGroup(num, t)
        if sub:
            g.add(Text(sub, font_size=26, color=SOFT).next_to(t, DOWN, buff=0.2))
        self.play(FadeIn(g.move_to(ORIGIN), shift=UP * 0.3), run_time=0.7)
        self.wait(0.9)
        self.play(FadeOut(g), run_time=0.5)
        tag = Text(title, font_size=22, color=ACCENT).to_corner(UR, buff=0.3)
        self.add(tag)
        return tag

    def rule(self, text, color=ACCENT):
        t = Tex(text, font_size=36)
        box = SurroundingRectangle(t, color=color, buff=0.22, corner_radius=0.1)
        return VGroup(box, t)

    def clear(self):
        if self.mobjects:
            self.play(*[FadeOut(m) for m in self.mobjects], run_time=0.6)

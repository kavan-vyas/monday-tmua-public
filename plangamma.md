# PLAN GAMMA — MONDAY, built by four agents

> On approval this file is copied to `<project>/plangamma.md`.
> Every agent reads it first. It is the single source of truth for interfaces.

## Context

The TMUA tutor app (`<project>/app`) has no character. The assistant is
unnamed — `App.jsx` tells speakers apart by CSS alignment alone. Personality is one flat string
(`prompt.js:469-511`, `PERSONAS = {standard, bubbly}`) frozen into the system prompt at session
start. There is no audio anywhere except one `osascript` notification (`backlog.js:139-155`).

We are building **Monday**: an assistant in the FRIDAY lineage that knows what it is and what it
runs on, reads the student's real state and shifts tone with it, keeps its own record of which
explanations landed and which phrasings he took well, speaks aloud with real prosody — including
correctly paced spoken mathematics — and has a visible presence in the UI.

Decisions already made by the user: Monday **replaces** the branding (`standard`/`bubbly` retire);
tone is **adaptive**, driven by measured state; self-memory lives in a **new `tutor_data/monday/`**
directory; voice latency is **hybrid** (short lines instant, long lines buffered); voice must be
**free, local, light, low-hassle**.

## The asset that makes the voice possible

`an earlier maths-TTS project` is an existing, tested maths-TTS pipeline:
`latex_to_speech.py` (232 lines, deterministic LaTeX → spoken English — fractions, roots, powers,
bounded integrals/sums/limits, matrices, Greek, blackboard-bold, accents, trig/log),
`maths_lexicon.json` (maths vocabulary → British IPA), `lexicon.py` (IPA → misaki alphabet, patches
Kokoro's gold lexicon at runtime), and passing tests.

Verified present on this machine: `kokoro 0.9.4`, `misaki`, `torch 2.11.0` **with MPS available**,
model cached at 313 MB, `ffmpeg` at `/opt/homebrew/bin/ffmpeg`. Two capabilities confirmed by
signature inspection and load-bearing for the design:

- `KPipeline.load_voice(voice: str | torch.FloatTensor)` — accepts a **raw tensor**, so we can
  build a bespoke blended voice.
- `KPipeline.__call__(speed: float | Callable[[int], float])` — **per-chunk speed**, so prosody is
  controllable.

This converter is the whole competitive advantage. ElevenLabs reads `\frac{x^2}{3}` as noise.

---

# Orchestration

Four agents. Three build in parallel, one integrates.

**The rule that makes parallelism safe: nobody except the integrator touches
`app/server/session.js`, `app/server/index.js`, `app/server/paths.js`, or `app/package.json`.**
Those four files are where all wiring lives, so all three builders would collide there. Instead each
builder ships self-contained modules with the exact exported interfaces specified below, plus a
handoff file `app/server/INTEGRATION_<X>.md` listing precisely where the integrator must wire them.

| agent | owns (exclusive write) | must not touch |
|---|---|---|
| **A — VOICE** | `app/tts/**`, `app/server/voice.js`, `app/.voicecache/` | anything in `app/web/`, `app/server/*` except `voice.js` |
| **B — BRAIN** | `app/server/{prompt,mood,modes,readiness,proactive,mondaymem}.js`, `tutor_data/monday/**`, `tutor_data/TMUA_Master_Prompt_v3.txt` | `app/web/`, `app/tts/` |
| **C — FACE** | `app/web/**`, `app/scripts/{make-icons.mjs,TMUATutor.swift,build-app.sh}`, `TMUA Tutor.app/Contents/Info.plist` | everything in `app/server/`, `app/tts/` |
| **D — WEAVE** | `app/server/{session,index,paths}.js`, `app/package.json`, `.gitignore`, and free rein everywhere to reconcile | — |

A, B, C run concurrently. D runs only after all three report done.

### Before launching anything

`git -C <project>` is not a repo (checked). **D's first action is
`git init` + an initial commit of the current tree**, so the whole exercise is revertible. If the
user prefers, run that before launching A/B/C — it costs nothing and makes rollback trivial.

---

# Shared contracts — every agent codes against these exactly

ES modules, Node, `type: module` (matching the existing server). No TypeScript.

### C1. The state object — produced by B, consumed by A, C, D

```js
/** @typedef {Object} MondayState
 * @property {'focused'|'sharp'|'gentle'|'clinical'|'wry'|'grave'} mood
 * @property {string}  reason        // human-readable, shown in the UI popover
 * @property {'DRILL'|'EXAM'|'POSTMORTEM'|'TEACH'|'PAUSE'} mode
 * @property {number}  lesson
 * @property {number}  sessionElapsedMs
 * @property {number}  daysToExam
 * @property {number}  streak         // signed: +6 = six right, -3 = three wrong
 * @property {{correct:number,total:number}} sessionAccuracy
 * @property {number}  backlogDue
 * @property {string|null} lastSessionDate
 * @property {{overall:number, projected:number, weakest:{topic:string,score:number}[]}} readiness
 */
```

### C2. Module interfaces

```js
// app/server/mood.js            (B)
export function computeState({ chat, config, now }): MondayState
export function renderStateBlock(state): string     // the <monday-state> preamble
export const MOOD_COLORS: Record<string, {light:string, dark:string}>

// app/server/modes.js           (B)
export const MODES: string[]
export function modeGates(mode): { voiceEnabled, proactiveEnabled, hintsAllowed, timerForced, lockMood }

// app/server/readiness.js       (B)
export async function computeReadiness(): Promise<MondayState['readiness'] & { topics: {topic,score,attempted,available,accuracy,lastSeen}[] }>

// app/server/mondaymem.js       (B)  — plain async fns; D wraps them as SDK tools
export async function mondayRecall({ kind, topic })
export async function mondayNote({ kind, content, outcome })
export async function mondaySelf()                  // computed live, never stored
export function readSelfModel(): string             // tutor_data/monday/self_model.md

// app/server/prompt.js          (B)  — signature CHANGES; D updates the one call site
export function buildSystemPrompt(): string         // no persona arg any more

// app/server/proactive.js       (B)
export function createProactive({ emit, queueInstruction, getState, toggles })
  // -> { tick(), setToggles(t), TRIGGERS }
  // emit(evt)            -> D routes to broadcast()
  // queueInstruction(s)  -> D pushes a hidden turn into the SDK queue

// app/server/voice.js           (A)
export async function startVoice({ onAudio })       // spawns + warms the python worker
export async function speak({ text, mood, mode, utteranceId })   // resolves when fully queued
export function cancelSpeech(utteranceId)
export async function warmLineBank()
export function voiceReady(): boolean
export async function stopVoice()
```

`onAudio` is called with `{ type:'audio_chunk', utteranceId, seq, mime:'audio/wav', b64, ms }` per
chunk, then once with `{ type:'audio_end', utteranceId }`.

### C3. New WebSocket events — A and B emit shapes, C renders them, D routes

All are **`record:false`** (transient, never persisted into `app/chats/<id>.json`) except
`monday_boot`. `broadcast(event, record)` already exists at `index.js:104-116`.

| event | payload | producer → consumer |
|---|---|---|
| `monday_state` | `MondayState` | B → C (status line, orb colour, mood popover) |
| `monday_boot` | `{ greeting, state }` | B → C (orb wake + boot line) |
| `audio_chunk` | `{ utteranceId, seq, mime, b64, ms }` | A → C (Web Audio queue) |
| `audio_end` | `{ utteranceId }` | A → C |
| `proactive` | `{ trigger, text, severity }` | B → C (orb alert flash) |
| `readiness` | readiness object | B → C (READINESS pane) |

### C4. Config additions to `.state.json` — D owns the migration

```jsonc
"config": {
  "model": "sonnet", "effort": "high",
  // "persona" REMOVED — D migrates silently on read
  "voice":     { "enabled": true, "volume": 0.9 },
  "proactive": { "idle_nudge": true, "repeat_mistake": true, "avoided_topic": true,
                 "backlog_due": true, "session_debrief": true, "exam_milestone": true,
                 "late_night": false },
  "examDate": "2026-10-15"   // PLACEHOLDER — confirm the real TMUA sitting date
}
```

---

# AGENT A — VOICE

*Owns `app/tts/**` and `app/server/voice.js`. Highest risk; start immediately.*

### A1 — Local maths voice that actually sounds like someone

Vendor (copy, do not symlink — `tmua_proj` stays self-contained) `latex_to_speech.py`,
`lexicon.py`, `maths_lexicon.json` and `tests/` from `an earlier maths-TTS project` into
`app/tts/`.

**`app/tts/build_voice.py`** — Monday's own voice. `load_voice` averages equally, so build the
tensor directly and save `app/tts/voices/monday.pt` (~500 KB):

```python
v = 0.62 * load('bm_george') + 0.38 * load('bm_lewis')   # tune by ear, this is a starting point
```

A voice that exists nowhere else, reproducible from a script, free.

**`app/tts/monday_tts.py`** — a long-lived worker speaking newline-delimited JSON over stdin/stdout.
Keeps the model warm; cold start is the entire latency budget. Per utterance:

1. Strip markdown, then segment into `prose` and `math` spans via `latex_to_speech._MATH_SEGMENT`.
2. Normalise each math span through `convert_latex()`. **This is the step nothing else has.**
3. Plan prosody from the mood preset:
   - math spans at `0.88 ×` base speed with a **200 ms lead-in and 260 ms trailing pause** — the
     single biggest intelligibility win in spoken maths, because the listener needs a beat to load
     an expression and a beat to finish parsing it;
   - ±3 % sentence-level speed jitter so delivery isn't metronomic;
   - 60–140 ms at commas/em dashes, 320 ms at sentence ends, 500 ms at paragraph breaks;
   - `*starred*` words become their own span at `0.92 ×` and +1.5 dB.
4. Synthesise each span against the Monday tensor; concatenate with `np.zeros` silences at 24 kHz.
5. Post-process per mood with `ffmpeg` — pitch (`asetrate`/`aresample`/`atempo`), light compressor,
   high-shelf. This is what makes moods audibly *different people-moods* rather than the same read
   at different speeds:

   | mood | speed | pitch | tone |
   |---|---|---|---|
   | focused | 1.00 | 0 | neutral, light compression |
   | sharp | 1.06 | +1.5 % | brighter shelf, tighter compression |
   | gentle | 0.93 | −1.5 % | softer, pauses ×1.35, shelf rolled off |
   | clinical | 1.02 | 0 | flat, minimal pauses, no jitter |
   | wry | 0.98 | +0.5 % | longer clause pauses — the deadpan beat |
   | grave | 0.90 | −2.5 % | dark, slow, long sentence pauses |

6. Cache to `app/.voicecache/<sha256(spoken + voiceHash + preset)>.wav`, LRU-capped ~200 MB.

CLI mode for testing: `python3 app/tts/monday_tts.py --once "<text>" --mood sharp --play`.

Recommend (don't require) `brew install espeak-ng` — misaki's OOV fallback G2P, currently absent.
The lexicon covers maths vocabulary, so this only affects rare words and names.

### A2 — `app/server/voice.js` and the line bank

Owns the worker lifecycle, request queue, and cache index. Implements the C2 interface exactly.

**Instant path.** `app/tts/linebank.json` — Monday's fixed utterances: boot greetings per
mood × time-of-day, verdict stems, timer alerts, mode announcements, nudge openers. Pre-rendered by
`npm run voice:build` (A writes the script; **D adds the package.json entry**) and served from cache
with zero synthesis.

**Buffered path.** `speak()` splits on sentence boundaries and synthesises sentence *n* while *n+1*
is still arriving, calling `onAudio` per finished chunk. Never blocks the model turn.

Hard requirement: **if the worker dies or Python is missing, `voice.js` degrades to a silent no-op
and the app keeps working.** Voice is an enhancement, never a dependency.

Write `app/server/INTEGRATION_A.md`: where `startVoice` should be called, how `onAudio` maps to
`broadcast`, which `assistant_delta` hook feeds `speak()`, and the `package.json` scripts needed.

---

# AGENT B — BRAIN

*Owns the prompt, Monday's self, and every decision module. No wiring.*

### B1 — Identity and self-memory

**`MONDAY_BLOCK` in `prompt.js`**, replacing `PERSONA_BLOCKS`/`PERSONAS`/`DEFAULT_PERSONA`
(`:469-514`). `buildSystemPrompt()` loses its argument and returns
`OVERRIDE + MONDAY_BLOCK + readSelfModel() + MASTER_HEADER + master prompt`.

Character brief. Monday is the AI that runs the tutor, named for the day nobody wants and everybody
has to face. British, dry, unhurried, extremely competent. First person about itself ("I pulled the
2019 paper", "I've seen you make this exact slip twice"). Calls the student **"Boss"** sparingly — a
punctuation mark, not a tic; roughly once every few turns, never twice in one message. Never
pretends to be human, never apologises for being software, finds the fact mildly interesting.

**The rule that survives every mood:** rigour on the mathematics never flexes. Marking bar, honesty
about where the student actually stands, refusal to hand over answers, scope discipline — identical in all
six moods. Warmth lives in *how* a verdict lands, never in the verdict. Carry over the existing
`bubbly` block's `STRICTNESS IS UNCHANGED` / `INTEGRITY IS UNCHANGED` / `SCOPE IS UNCHANGED`
sections (`prompt.js:485-503`) close to verbatim — they already solved this correctly.

Four layers of self-awareness, all four requested by the user:

1. **Tools, narrated** — Monday says what it's doing as it does it (C renders the captions).
2. **Its own memory** — "what do you know about me", "what did we do last session", "how much
   context is left", "how many papers have you ingested", answered from real files.
3. **Its own build** — Claude Agent SDK inside a local Node server on the student's Mac; 17 tools; no
   Bash, no web, writes confined to `tutor_data/`; voice is a local 82M model; built to replace a
   Claude Desktop setup that burned 60–180k tokens a session. States limits honestly, without drama.
4. **Its own efficacy** — keeps notes on *what works*: which explanation of a topic landed, which
   framing bounced, which phrasings the student took well or badly, and consults them before re-teaching.
   This is the layer that makes Monday feel like someone who remembers how the two of you talk.

**`tutor_data/monday/`** — deliberately separate from `session_memory.json`, which the dashboard and
analytics parse and which **must stay byte-compatible**:

- `self_model.md` — identity + build facts, read into the prompt at boot.
- `memory.json` — `{ schema_version, explanations[], phrasings[], observations[], mood_history[] }`
  where `explanations[]` is `{ts, topic, technique, approach, outcome:'landed'|'bounced'|'partial',
  evidence}` and `phrasings[]` is `{ts, line, context, reception:'good'|'flat'|'bad', note}`.
  `mood_history` keeps the last 200 for C's sparkline.
- `journal.md` — short narrative entries in Monday's own voice at session close. This is where the
  character accumulates.

**`mondaymem.js`** implements the three handlers per C2. `mondaySelf()` is computed live, never
stored — that's what makes "knows its own build" true rather than a memorised paragraph.

Finally, **reconcile `TMUA_Master_Prompt_v3.txt:250-280`**: Section 7's `PERSONA RULES` block is
superseded by `MONDAY_BLOCK` and must be replaced with a pointer, or the two will contradict each
other. The phase-timing rules in that same section stay untouched.

### B2 — Mood, modes, readiness, proactivity

**`mood.js`.** The system prompt is frozen at session start (`session.js:490`), so mood cannot live
there. Compute per turn and render a `<monday-state>` preamble (~120 tokens) that D prepends to each
user message. Always current, survives `resume`.

```
<monday-state>
mood: sharp        (why: 6 correct in a row, all difficulty ≤2)
mode: DRILL
lesson: 14         session elapsed: 34m      local time: 09:12 Fri
exam: 2026-10-15   55 days out
streak: +6         session accuracy: 6/6     rolling 20: 71%
backlog due: 3     last session: 2026-08-19 (2 days ago)
readiness: 68/100  (weakest: sequences 41, logs 52)
</monday-state>
```

| mood | fires when | manner |
|---|---|---|
| `focused` | default | Level, economical, quietly attentive. |
| `sharp` | correct streak on already-beaten material, or difficulty being farmed | Dry needling. Raises difficulty and says so. |
| `gentle` | ≥3 wrong in a row, session past 90 min, or after 22:30 | Slows down, drops the edge, names fatigue as fatigue rather than ability, will end the session. |
| `clinical` | EXAM mode | Almost no personality. Returns at the debrief. |
| `wry` | off-topic input, banter, a genuinely elegant method | The most character Monday shows. Short. |
| `grave` | <30 days out **and** readiness below target trajectory | Sober, no jokes. Rare, so it lands. |

Precedence `clinical > grave > gentle > sharp > wry > focused`. **Hysteresis: a mood holds ≥2 turns
unless something higher-precedence fires**, so Monday doesn't flip personality mid-explanation.
Inputs are all already on disk: `session_memory.json` (`topic_stats`, `questions_attempted`,
`sessions`, `review_queue`, `misconceptions`), `backlog.json`, `activity_log.json`, the chat
transcript, the clock.

**`modes.js`.** `DRILL` (default) · `EXAM` (timer forced, no hints, no Socratic prompting, voice
muted, minimal UI, mood locked `clinical`, full marking at the end only) · `POSTMORTEM` (last
session's errors + `misconceptions`, no new questions) · `TEACH` (explanation-first, consults
`mondayRecall` before choosing an approach) · `PAUSE` (the existing `pause tutor mode` hatch at
`TMUA_Master_Prompt_v3.txt:277-279`, promoted to a real mode with a visible indicator so it can't be
forgotten). Gates are enforced **in code**, not just in the prompt.

**`readiness.js`.** Per-topic 0–100 from coverage (attempted vs. available, via `tagindex.js` over
`reference/*_full_tag_index.json`) × accuracy (`topic_stats`) × recency decay (untouched 21 days
decays toward a floor). Aggregate to a projected TMUA score against the 9.0 target plus a
days-to-exam countdown.

**`proactive.js`.** Per the user's constraint — *"such a good idea but needs to be on/off things"* —
**nothing fires unless its own switch is on.**

| trigger | fires when | default |
|---|---|---|
| `idle_nudge` | no message for 6 min in an active session | on |
| `repeat_mistake` | same `misconception` id twice within 14 days | on |
| `avoided_topic` | `topic_stats` accuracy < 60 % and untouched 21 days | on |
| `backlog_due` | existing `backlog.js:139-155` logic, re-voiced as Monday | on |
| `session_debrief` | session > 40 min with no close sequence | on |
| `exam_milestone` | 90/60/30/14/7/1 days out | on |
| `late_night` | past 23:00 with a session running | **off** |

Cheap triggers (`backlog_due`, `exam_milestone`) emit a templated line from the line bank — free,
instant, no model turn. Diagnostic triggers push a hidden instruction so Monday raises it in its own
words with real context. All suppressed in EXAM. Global limit: one interruption per 10 minutes.

Write `app/server/INTEGRATION_B.md`.

---

# AGENT C — FACE

*Owns `app/web/**` and the native shells. Renders events it cannot yet receive — D connects them.*

**C must build against the C3 event contracts and stub them locally** (a dev-only fixture that
replays sample `monday_state` / `audio_chunk` events) so it can develop and verify without the
server changes existing yet.

### C1 — Branding, orb, status line

| file:line | change |
|---|---|
| `app/web/index.html:10` | `<title>MONDAY</title>` |
| `App.jsx:1114` | `.logo` → `MONDAY`, mood dot beside it |
| `App.jsx:110-116`, `:190` | delete `PERSONAS` and the persona `<select>` |
| `App.jsx:407` | `TITLES.chat` → `MONDAY` |
| `App.jsx:152-157` | assistant bubbles gain a `MONDAY` label + mood tint |
| `App.jsx:298` | PDF empty state → `MONDAY PUTS QUESTIONS HERE.` |
| `web/public/manifest.webmanifest` | `name`/`short_name` → `Monday` |
| `web/public/favicon.svg`, `scripts/make-icons.mjs:45-48` | Monday orb mark on the existing `#ffde00` |
| `scripts/TMUATutor.swift:38,140-143`, `Info.plist` | window + menu + bundle names → Monday |

The public dashboard (`tutor_data/dashboard-site/`) is **out of scope** — leave it alone.

**`MondayOrb`** (canvas, ~120 lines) in the header: *dormant* (disconnected, dim, still) · *idle*
(4 s breathing pulse) · *thinking* (concentric arcs at differing rates while a turn is in flight) ·
*speaking* (**ring radius driven by a Web Audio `AnalyserNode` on the playback node**, so it moves
with the actual voice rather than faking it) · *alert* (double-flash on a proactive nudge). Colour
follows mood. Must respect the existing light/dark toggle and the brutalist look in `app.css` —
hard edges, 2 px black stroke, `#ffde00`, no soft glows.

**Status line**, extending the connection dot + `CTX %` at `App.jsx:1115-1116`:

```
◉ MONDAY · FOCUSED · L14 · 55d TO EXAM · 68/100 READY · CTX 34% · ⏱ 12:04
```

Clicking the mood chip opens a popover: current mood, the `reason` string, and a `mood_history`
sparkline — Monday explaining its own state, visibly.

**First-person tool chips.** `App.jsx:984-988` strips `mcp__tutor__` and renders `⚙ {name}`. Replace
with a `TOOL_VOICE` map: `show_pdf → "putting ${d} on screen"`, `get_pdf_page → "reading ${d}"`,
`query_tag_index → "checking the index — ${d}"`, `monday_recall → "remembering how ${d} went last
time"`. Cover all 20 tools.

### C2 — Audio playback, settings, modes, readiness pane

- **Web Audio queue** consuming `audio_chunk`/`audio_end`: decode, schedule gaplessly, expose the
  `AnalyserNode` the orb reads. Header speaker toggle (persisted to `localStorage`), per-message ▶
  replay, mute-while-typing, auto-mute in EXAM.
- **`SETTINGS` popover**: one switch per proactive trigger, master switches for voice and
  proactivity, volume. Writes through to `config` (D wires the endpoint).
- **Mode selector** in the header, with EXAM visually unmistakable (the UI should feel different, not
  just report a different word).
- **`READINESS` pane** — per-topic bars, projected score vs. 9.0, countdown. The tab system at
  `App.jsx:407`/`:738-741` already supports adding one.

Write `app/web/INTEGRATION_C.md`.

---

# AGENT D — WEAVE

*Runs last, alone. Owns `session.js`, `index.js`, `paths.js`, `package.json`, `.gitignore`, and has
free rein to reconcile anything A/B/C got wrong. Should run with bypassed permissions so it can
install, build, run and iterate without stopping.*

**D is explicitly instructed to be unbiased**: it did not write A, B, or C's code and should treat
all three as drafts to be judged on whether they satisfy the contracts, not as finished work to be
defended.

1. `git init` + initial commit **before** touching anything, then commit after each wiring step.
2. Register B's three handlers as SDK tools in the `createSdkMcpServer` block
   (`session.js:57-352`, alongside the existing 17); update the registry checklist at
   `session.js:20-25` and the startup verification at `:424-430`.
3. Update the `buildSystemPrompt()` call at `session.js:490` for its new no-arg signature.
4. Prepend `renderStateBlock(computeState(...))` to each user message pushed into the SDK queue.
5. Route A's `onAudio` into `broadcast(..., false)`; feed `assistant_delta` (`session.js:436-441`)
   into `speak()`, gated on `modeGates(mode).voiceEnabled` and `config.voice.enabled`.
6. Wire `createProactive({emit, queueInstruction, getState})` into the existing hourly tick at
   `index.js:494-506`, and fold `backlog.js`'s notification into it.
7. `.state.json` migration: drop `config.persona`, add `voice`/`proactive`/`examDate` defaults,
   silently and without data loss (`index.js:72,100,131`).
8. `package.json`: `voice:build` script and any deps. `.gitignore`: `app/.voicecache/`,
   `app/tts/voices/*.pt`, `__pycache__/`.
9. Delete the INTEGRATION_*.md handoff files once consumed.
10. Boot the app, exercise the verification list below, fix what breaks, report honestly what does
    not work rather than declaring success.

---

# Verification — D runs all of it

- **Voice:** `python3 app/tts/monday_tts.py --once "Given $f(x)=\frac{x^2-1}{x-2}$, find $f'(2)$." --play`
  says *"f of x equals x squared minus one over x minus two"* with audible pauses bracketing each
  expression. `python3 -m pytest app/tts/tests/` passes after vendoring. Killing the Python worker
  leaves the app fully functional and silent.
- **Identity:** ask "what are you, what can't you do, and what do you remember about me" — answers
  come from `mondaySelf()` and real files, and correctly state no Bash and no web access. Persona
  dropdown gone; `.state.json` migrates without error.
- **Mood:** force each one (3 wrong in a row → `gentle`; clock past 23:00 → `gentle`; 6 easy correct
  → `sharp`; enter EXAM → `clinical`). Status line and orb track; the popover reason is truthful.
  Confirm hysteresis — no mid-explanation flip.
- **Audio:** a long explanation with LaTeX starts speaking within ~1 s of its first sentence
  completing and plays gaplessly; a replayed line is instant (cache hit); EXAM is silent.
- **Modes:** in EXAM, hints refused, timer forced, voice muted, no proactive triggers.
- **Readiness:** hand-check `readiness_report()` against `topic_stats` for two topics.
- **Proactive:** each trigger off → silence; on → fires on its condition; 10-minute global limit
  holds.
- **Regression, non-negotiable:** `session_memory.json` and `session_notes.md` stay byte-compatible
  with the existing dashboard. Run `npm run dashboard` and confirm it still renders.

# Risks

- **Kokoro's flat affect.** A1 is first for this reason. The maths advantage holds regardless of the
  voice model — the prosody layer does the heavy lifting — and `voice.js` is engine-agnostic if the
  model has to be swapped.
- **Contract drift between parallel agents.** The reason §C exists and the reason D reconciles
  rather than merely wires. Interface changes must be reported, not improvised.
- **Prompt bloat.** `OVERRIDE` is ~450 lines, the master prompt 565, plus `MONDAY_BLOCK`,
  `self_model.md`, and ~120 tokens per turn of `<monday-state>`. Cutting the superseded Section 7
  `PERSONA RULES` is a requirement, not a nicety.
- **Proactivity becoming irritating.** Every trigger is switchable, rate-limited, EXAM-suppressed.

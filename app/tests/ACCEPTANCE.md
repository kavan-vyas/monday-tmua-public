# ACCEPTANCE CRITERIA — Monday (Plan Gamma)

**Provenance.** Every criterion below was derived by reading `plangamma.md` ONLY. At the time this
file was written and committed, no file under `app/server/`, `app/web/` or `app/tts/` had been
opened by the author (Agent E). This commit exists to put that ordering on record. Expected values
come from the specification; where the specification is silent or self-contradictory the ambiguity
is recorded in `---

# ANNOTATED PAPERS + R2DREW PANEL — server side

**Provenance.** Everything from ACC-ANN, ACC-TOOL and ACC-HTTP below was derived from the approved
plan `now-you-see-within-jazzy-penguin.md` — §1.1 (traps 1–2), §1.3, §1.4, §1.5, §1.6, §2.3 and
§3.2 — not from the implementation. Where the plan and the code disagreed, the disagreement is
recorded in `## Plan corrections` at the foot of this section rather than silently resolved.

## ACC-ANN — §1.3/§1.4 annotation storage  [U] `tests/unit/annotations.test.mjs`

| ID | Criterion | Expected |
|---|---|---|
| ACC-ANN-01 | The key is the file's POSITION in `file_manifest.json`, not its path | `tmua/2019/p1`, `source:'manifest'` |
| ACC-ANN-02 | A paper and its solutions do not collide | `tmua/2019/p1` vs `tmua/2019/p1_solutions` |
| ACC-ANN-03 | A PDF absent from the manifest falls back to a path hash | `path/<16 hex>`, `source:'path'` |
| ACC-ANN-04 | **Annotations survive a re-file.** Annotate, move the paper in the manifest, re-read | same key, same marks, `source_path` follows the manifest |
| ACC-ANN-05 | Documents land at `tutor_data/annotations/<key>.json` with a `schema_version` | key flattened to one filename; `schema_version: 1` |
| ACC-ANN-06 | An atomic write leaves no partial file and no stray temp file | committed file always parses; no `*.tmp-*` remain |
| ACC-ANN-07 | The temp file is a sibling of the target, so `rename` is a real atomic swap | tmp derived from `abs`; commit is `renameSync(tmp, abs)` |
| ACC-ANN-08 | A crashed writer's temp file is invisible to the reader | 0 marks read |
| ACC-ANN-09 | A corrupt document reads as empty rather than throwing mid-session | well-formed empty doc |
| ACC-ANN-10 | A repeated autosave costs no write | second save `changed:false` |
| ACC-ANN-11 | The student's 800 ms autosave cannot wipe a mark Monday just drew | both authors' marks survive |
| ACC-ANN-12 | `scope:'all'` is the explicit page-replace escape hatch | page replaced wholesale |
| ACC-ANN-13 | A page that empties is deleted, not left as `[]` | key absent from `pages` |
| ACC-ANN-14 | Coordinates are PDF user space: **y is bottom-up** | high y ⇒ "top", low y ⇒ "bottom" |
| ACC-ANN-15 | A bounding box is computed in the same space as its points | `[minX,minY,maxX,maxY]` |
| ACC-ANN-16 | Marks with no usable geometry are refused, not stored as junk | `null` |
| ACC-ANN-17 | Monday's marks carry a colour distinct from the student's | `MONDAY_COLOR !== STUDENT_COLOR` |
| ACC-ANN-18 | The model-facing rendering gives highlight text verbatim, ink as a page region, arrows with notes | no raw coordinate arrays in the output |
| ACC-ANN-19 | An empty page says so plainly and names the page | matches `/no annotations/i` |
| ACC-ANN-20 | A region computed against an assumed A4 says the size was not recorded | `page size not recorded` |

## ACC-TOOL — §1.5/§1.6/§2.3/§3.2 the tools Monday calls  [I] `tests/integration/monday-tools.test.mjs`

| ID | Criterion | Expected |
|---|---|---|
| ACC-TOOL-01 | Every name in the test contract list is registered in `session.js` | no missing |
| ACC-TOOL-02 | Nothing is registered that the contract list does not name | no extra |
| ACC-TOOL-03 | The tool count `prompt.js` states equals the number registered | equal |
| ACC-TOOL-04 | Every new tool appears in the prompt catalogue | `mcp__tutor__<name>` present |
| ACC-TOOL-05 | `read_annotations` resolves a paper by path, question id or manifest key | all resolve to `tmua/2019/p1` |
| ACC-TOOL-06 | An unresolvable paper is reported, not silently ignored | matches `/cannot work out which paper/i` |
| ACC-TOOL-07 | `annotate_pdf` stores `author:"monday"` in a distinct colour and broadcasts so the pane updates live | `annotations_changed` event with page + author |
| ACC-TOOL-08 | `read_annotations` reads back highlight text and arrow notes, not coordinates | text present, no `[[` arrays |
| ACC-TOOL-09 | Unusable marks are refused with a message that says what was needed | matches `/not usable｜needs/i` |
| ACC-TOOL-10 | `clear_annotations` defaults to Monday's own marks and leaves the student's working alone | the student's mark survives |
| ACC-TOOL-11 | `show_video` mirrors `show_pdf`: broadcast `{videoId, t, note}` **and** text back to the model | both |
| ACC-TOOL-12 | EXAM suppresses `show_video` — refusal text **and** no broadcast | refused, no event |
| ACC-TOOL-12b | The gate is `modeGates(...).videoAllowed`, so it cannot drift from the other EXAM locks | false in EXAM, true elsewhere |
| ACC-TOOL-13 | A malformed video id is refused rather than opened | nothing broadcast |
| ACC-TOOL-14 | `find_video` maps a trap onto a real indexed video; an empty result says "not indexed" | both |
| ACC-TOOL-15 | `add_paper` refuses non-PDFs, missing files and paths outside the project root | three refusals |
| ACC-TOOL-16 | `file_to_library` MOVES a non-paper into `tutor_data/library/<topic>/` and writes the journal note | file moved, journal contains the note |
| ACC-TOOL-17 | `MONDAY_BLOCK` carries the marks-not-grades rule | `MARKS AND ACCURACY, NEVER GRADES` |
| ACC-TOOL-18 | The readiness projection stays available for planning — the rule is about speech, not data | `projected` still numeric |

## ACC-HTTP — §1.1/§1.4/§1.6 the HTTP surface  [E] `tests/e2e/http-surface.test.mjs`

| ID | Criterion | Expected |
|---|---|---|
| ACC-HTTP-01 | An asset that exists is still served | 200 + its bytes |
| ACC-HTTP-02 | An asset that does NOT exist 404s instead of returning `index.html` with a 200 | 404, body is not the shell |
| ACC-HTTP-03 | The rule covers any path asking for a file, not only `/assets/` | `.js .mjs .css .woff2 .bcmap` all 404 |
| ACC-HTTP-04 | An extensionless client route still gets `index.html` — the SPA is not broken | 200 + shell |
| ACC-HTTP-05 | `.mjs` is served as JavaScript, or a module worker refuses to run | `content-type` matches `/javascript/` |
| ACC-HTTP-06 | `GET /api/annotations` on an unmarked paper returns an empty, well-formed document | `schema_version:1`, manifest key, `pages:{}` |
| ACC-HTTP-07 | A path outside the project root is refused on both verbs | 403 |
| ACC-HTTP-08 | `POST` stores marks, page sizes and highlight text; they survive a re-read | round trip intact |
| ACC-HTTP-09 | A `sendBeacon` flush posts `text/plain` and must still be accepted | 200, marks landed |
| ACC-HTTP-10 | Re-posting the same marks is idempotent and writes nothing | `changed:false`, nothing lost |
| ACC-HTTP-11 | Malformed JSON is a 400, and the stored document is untouched | 400, document intact |
| ACC-HTTP-12 | The document is written under `tutor_data/annotations` and leaves no temp file | file present, no `*.tmp-*` |
| ACC-HTTP-13 | A dropped PDF lands in the inbox and is NOT filed, registered or classified | `filed:false`, file still in inbox, manifest byte-identical, no `major exams/` tree, no `[paper]` log |
| ACC-HTTP-14 | `index.js` no longer contains an implicit auto-ingest path | no `acceptPaper`, no `enqueuePaper(` |

## Plan corrections

Places the plan turned out to be wrong once the code was open. Recorded rather than silently fixed.

- **P-1 — `insideTutorData` on the annotation endpoints.** §1.4 says the endpoints are "guarded by
  `insideTutorData`". Applied to the `path` query argument that would refuse every real paper: the
  PDFs live under `major exams/`, outside `tutor_data/`. The guard is applied where it belongs —
  to the file being WRITTEN, which must always land inside `tutor_data/annotations/`. The PDF path
  is guarded by `insideRoot`, as every other PDF endpoint is.
- **P-2 — `readiness_report`.** §3.2 says Monday "can cite [the projected grade] via
  `readiness_report`". There is no such tool and never was. The projection reaches Monday through
  the `<monday-state>` block on every single turn (`mood.js` renders `projected 7.4 vs 9.0
  target`), and the `grave` mood's stated reason is phrased in grades. The prompt rule is therefore
  written against the state block, which is the channel that actually exists.
- **P-3 — the technique vocabulary is 57 values, not 54.** §2.3 states 54. Counted from the live
  indexes: `topic` 14 ✓, `trap_type` 24 ✓, `technique` 57.
- **P-4 — `add_paper` runs `organise.js`, not `ingest.js` alone.** §1.6 says it "runs the existing
  `ingest.js` pipeline unchanged". `ingest.js` registers and classifies but does not FILE, and a
  PDF sitting in `tutor_data/inbox/` has to be moved into the collection first. The full pipeline
  the dropzone used to run is `organise.js`'s `enqueuePaper` (identify → file → register →
  classify → merge), which wraps `ingest.js`. `add_paper` calls exactly that, unchanged. Only the
  trigger moved, which is what the plan actually asked for.
- **P-5 — no verifiable video timestamps exist.** §2.3 asks for "video + timestamp ranges". Every
  id, title and duration in `video_index.json` was read from the live playlist, but none of those
  videos publishes chapter markers or a timestamped description, so no segment boundary could be
  verified. The seed therefore contains whole-video entries only, and says so in its own
  `provenance` field. Invented ranges would have looked precise and sent the student to the wrong
  minute.

---

## ACC-EXAM — computer-based test exam simulator  [U] `tests/unit/exam.test.mjs`

The simulator delivers the ten JZ mock papers under exam conditions and records the sitting.
The criteria below are about the RECORD, not the arithmetic: the answer key must never reach
the browser before the sitting ends, a reload must cost neither time nor answers, an
untranscribed paper must be refused rather than half-delivered, and finishing must write
exactly one activity row and one backlog item per question that earned one, however many
times it is called.

| ID | Criterion | Expected |
| --- | --- | --- |
| ACC-EXAM-01 | The registry lists every paper, transcribed or not | 10 rows, always |
| ACC-EXAM-02 | `transcribed` is derived from the question count, not the file's own field | a file claiming "full" with 9 questions reads as `partial` |
| ACC-EXAM-03 | `has_answers` reflects the answer file on disk | true with a key, false without |
| ACC-EXAM-04 | An untranscribed paper cannot be sat | rejects, mentions transcription |
| ACC-EXAM-05 | An unknown or traversing paper id is refused | rejects as unknown paper |
| ACC-EXAM-06 | Timing options | real 4500s, jz 7200s, untimed null |
| ACC-EXAM-07 | 25% extra time | 5625s; untimed stays null |
| ACC-EXAM-08 | **The answer key is not in the sitting payload** | no `correctAnswer`, no `answer`, no `jz_difficulty` — on create *and* on resume |
| ACC-EXAM-09 | Shuffle reorders without losing or duplicating | 20 questions, 1–20 present exactly once |
| ACC-EXAM-10 | The event log exists from the first instant | first line is `sitting_start` |
| ACC-EXAM-11 | Starting a sitting forces EXAM mode | `setMode('EXAM')` called |
| ACC-EXAM-12 | A mode hook that throws does not lose the sitting | sitting is still readable |
| ACC-EXAM-13 | An answer write survives a reload | answer, flag and seen all read back |
| ACC-EXAM-14 | An answer can be cleared | choice null leaves no answer |
| ACC-EXAM-15 | Events append and replay in order | 4 events, original order |
| ACC-EXAM-16 | A torn last line does not destroy the log | earlier events still replay |
| ACC-EXAM-17 | A bad sitting id never reaches the filesystem | throws "bad sitting id" |
| ACC-EXAM-18 | Rest breaks pause the clock | two closed breaks = 90s; an unclosed break still counts |
| ACC-EXAM-19 | Results are refused while the sitting runs | throws "still running" |
| ACC-EXAM-20 | Scoring, grade conversion, per-question derivation | 17/20 → 34/40 → "8.1–8.3"; changes and multi-page solutions preserved |
| ACC-EXAM-21 | An unmarked paper invents no answers | `raw` null, `gradeLabel` null, every `correct` null |
| ACC-EXAM-22 | Finishing writes one activity row and NOTHING into the backlog | 1 entry, no `correct` field; backlog untouched — JZ mocks are harder than the real test by design, so missing them is not a catalogue of gaps |
| ACC-EXAM-23 | Finishing twice does not double the record | still 1 row, 1 item |
| ACC-EXAM-24 | The sitting itself keeps the per-question clock | `summary.questions[].timeSec > 0`, and the report names the question |

Over the wire, `ACC-HTTP-15..20` in `tests/e2e/http-surface.test.mjs` repeat the load-bearing
ones against a real socket: the registry, starting a sitting with no answers in the payload,
409 on an untranscribed paper, `sendBeacon`'s `text/plain` telemetry, results refused until
finish, and `/exam` reaching the SPA shell rather than a 404.

## Spec ambiguities` at the foot of this file and the test is written against the
best reading of the spec — never against whatever the code happens to emit.

Legend: **[U]** unit · **[I]** integration · **[E]** e2e · **[M]** manual / not machine-checkable.

---

## ACC-STATE — §C1 MondayState shape

The object returned by `computeState({ chat, config, now })`.

| ID | Criterion | Expected |
|---|---|---|
| ACC-STATE-01 | `mood` is present and is one of exactly six values | `focused｜sharp｜gentle｜clinical｜wry｜grave` |
| ACC-STATE-02 | `reason` is present and is a `string`, human-readable (shown in the UI popover) | non-empty string |
| ACC-STATE-03 | `mode` is present and is one of exactly five values | `DRILL｜EXAM｜POSTMORTEM｜TEACH｜PAUSE` |
| ACC-STATE-04 | `lesson` is a `number` | typeof `number`, finite |
| ACC-STATE-05 | `sessionElapsedMs` is a `number`, non-negative | typeof `number`, `>= 0` |
| ACC-STATE-06 | `daysToExam` is a `number` | typeof `number`, finite |
| ACC-STATE-07 | `streak` is a **signed** `number`: `+6` = six right, `-3` = three wrong | typeof `number`, integer, may be negative |
| ACC-STATE-08 | `sessionAccuracy` is `{correct:number, total:number}` | both numeric, `correct <= total`, both `>= 0` |
| ACC-STATE-09 | `backlogDue` is a `number` | typeof `number`, `>= 0` |
| ACC-STATE-10 | `lastSessionDate` is `string｜null` — never `undefined` | `typeof === 'string'` or `=== null` |
| ACC-STATE-11 | `readiness` is `{overall:number, projected:number, weakest:{topic:string,score:number}[]}` | `overall`/`projected` numeric; `weakest` an array of `{topic:string,score:number}` |
| ACC-STATE-12 | `computeState` is pure w.r.t. its `now` argument: the same inputs with the same `now` produce the same `mood`/`mode`/`daysToExam` | deterministic |
| ACC-STATE-13 | `computeState` accepts the documented named-argument object `{ chat, config, now }` and does not throw on a minimal/empty chat | no throw |

## ACC-C2 — §C2 exported module surface

Each module must export exactly the named symbols with the specified kind. (Signature/arity is
checked where the spec fixes it; extra exports are permitted, missing ones are not.)

| ID | Module | Criterion |
|---|---|---|
| ACC-C2-01 | `mood.js` | exports `computeState` (function) |
| ACC-C2-02 | `mood.js` | exports `renderStateBlock` (function) returning `string` |
| ACC-C2-03 | `mood.js` | exports `MOOD_COLORS` — a `Record<mood, {light:string, dark:string}>` with an entry for **all six** moods, each having `light` and `dark` string values |
| ACC-C2-04 | `modes.js` | exports `MODES` — an array of strings equal as a set to the five modes |
| ACC-C2-05 | `modes.js` | exports `modeGates(mode)` returning an object with **all five** keys `voiceEnabled, proactiveEnabled, hintsAllowed, timerForced, lockMood` |
| ACC-C2-06 | `modes.js` | `modeGates` returns booleans for the four boolean gates; `lockMood` is a mood string or a falsy value |
| ACC-C2-07 | `readiness.js` | exports `computeReadiness` — async, resolving to `{overall, projected, weakest, topics}` where `topics[]` entries have `{topic, score, attempted, available, accuracy, lastSeen}` |
| ACC-C2-08 | `mondaymem.js` | exports async `mondayRecall({kind, topic})` |
| ACC-C2-09 | `mondaymem.js` | exports async `mondayNote({kind, content, outcome})` |
| ACC-C2-10 | `mondaymem.js` | exports async `mondaySelf()` |
| ACC-C2-11 | `mondaymem.js` | exports `readSelfModel(): string` reading `tutor_data/monday/self_model.md` |
| ACC-C2-12 | `prompt.js` | exports `buildSystemPrompt()` taking **no persona argument** (`fn.length === 0`) and returning a string |
| ACC-C2-13 | `prompt.js` | no longer exports `PERSONAS`, `PERSONA_BLOCKS` or `DEFAULT_PERSONA` — the personas are retired |
| ACC-C2-14 | `prompt.js` | `buildSystemPrompt()` output is `OVERRIDE + MONDAY_BLOCK + readSelfModel() + MASTER_HEADER + master prompt` — it contains the self-model text and the master prompt text |
| ACC-C2-15 | `proactive.js` | exports `createProactive({emit, queueInstruction, getState, toggles})` returning `{ tick, setToggles, TRIGGERS }` |
| ACC-C2-16 | `voice.js` | exports `startVoice({onAudio})` (async), `speak({text,mood,mode,utteranceId})` (async), `cancelSpeech(utteranceId)`, `warmLineBank()` (async), `voiceReady(): boolean`, `stopVoice()` (async) |

## ACC-WS — §C3 WebSocket event contracts

| ID | Criterion | Expected |
|---|---|---|
| ACC-WS-01 | `monday_state` payload is a full `MondayState` | satisfies all ACC-STATE-01..11 |
| ACC-WS-02 | `monday_boot` payload is `{ greeting, state }` | `greeting` string, `state` a MondayState |
| ACC-WS-03 | `audio_chunk` payload is `{ utteranceId, seq, mime, b64, ms }` | exactly these fields; `mime === 'audio/wav'` |
| ACC-WS-04 | `audio_end` payload is `{ utteranceId }` | matches the `utteranceId` of the preceding chunks |
| ACC-WS-05 | `proactive` payload is `{ trigger, text, severity }` | `trigger` one of the 7 trigger ids; `text` a string |
| ACC-WS-06 | `readiness` payload is the readiness object | satisfies ACC-STATE-11 |
| ACC-WS-07 | **All new events are broadcast with `record:false` EXCEPT `monday_boot`** | `broadcast(evt, false)` for `monday_state`, `audio_chunk`, `audio_end`, `proactive`, `readiness`; `monday_boot` is the sole recorded one |
| ACC-WS-08 | No `record:false` event ever appears in `app/chats/<id>.json` | transient events are absent from the persisted transcript |

## ACC-CFG — §C4 config schema and `.state.json` migration

| ID | Criterion | Expected |
|---|---|---|
| ACC-CFG-01 | Migration **removes** `config.persona` | `'persona' in config === false` after migration |
| ACC-CFG-02 | Migration adds `config.voice` defaults | `{ enabled: true, volume: 0.9 }` |
| ACC-CFG-03 | Migration adds `config.proactive` with all seven switches | `idle_nudge:true, repeat_mistake:true, avoided_topic:true, backlog_due:true, session_debrief:true, exam_milestone:true, late_night:false` |
| ACC-CFG-04 | `late_night` specifically defaults **off** | `proactive.late_night === false` |
| ACC-CFG-05 | Migration adds `config.examDate` as an ISO `YYYY-MM-DD` date string | present, ISO-shaped (see ambiguity A-2 on the exact value) |
| ACC-CFG-06 | Migration preserves `config.model` and `config.effort` verbatim | unchanged values |
| ACC-CFG-07 | **No data loss**: every key present in the pre-Monday `.state.json` other than `config.persona` survives migration with an identical value — including keys outside `config` | deep-equal on all non-`persona` pre-existing keys |
| ACC-CFG-08 | Migration is silent: reading a pre-Monday `.state.json` does not throw or warn-fail | no throw |
| ACC-CFG-09 | Migration is idempotent: migrating an already-migrated state is a no-op | second pass deep-equals the first |
| ACC-CFG-10 | An existing user value for a migrated key is **not** clobbered by the default (e.g. `voice.enabled:false` stays false) | user values win over defaults |

---

## ACC-VOICE — Agent A, voice and prosody

### Pipeline

| ID | Criterion | Expected |
|---|---|---|
| ACC-VOICE-01 | The per-utterance pipeline has the 6 specified steps: strip markdown → segment prose/math via `_MATH_SEGMENT` → `convert_latex()` each math span → plan prosody from the mood preset → synthesise + concatenate with `np.zeros` silences at **24 kHz** → post-process per mood with `ffmpeg` → cache | all six observable |
| ACC-VOICE-02 | Markdown is stripped before segmentation | markdown syntax characters do not reach the synthesiser as spoken text |
| ACC-VOICE-03 | Math spans are detected using `latex_to_speech._MATH_SEGMENT` | `$...$` / LaTeX regions become `math` spans, surrounding text `prose` spans |
| ACC-VOICE-04 | Each math span is normalised through `convert_latex()` — e.g. `\frac{x^2-1}{x-2}` speaks as "x squared minus one over x minus two" | converted English, not raw LaTeX |
| ACC-VOICE-05 | Sample rate for concatenation silences is 24 000 Hz | `24000` |

### Prosody (§A1 step 3)

| ID | Criterion | Expected |
|---|---|---|
| ACC-VOICE-10 | Math spans are spoken at **0.88 ×** the base speed | multiplier `0.88` |
| ACC-VOICE-11 | Each math span is preceded by a **200 ms lead-in** silence | `200` ms |
| ACC-VOICE-12 | Each math span is followed by a **260 ms trailing pause** | `260` ms |
| ACC-VOICE-13 | Sentence-level speed jitter is **±3 %** | per-sentence speed ∈ `[0.97, 1.03] ×` the mood base speed; never outside |
| ACC-VOICE-14 | Jitter is non-degenerate — delivery is not metronomic | across many sentences, more than one distinct speed value is produced |
| ACC-VOICE-15 | Clause pauses (commas, em dashes) are **60–140 ms** | every clause pause ∈ `[60, 140]` ms |
| ACC-VOICE-16 | Sentence-end pauses are **320 ms** | `320` ms |
| ACC-VOICE-17 | Paragraph-break pauses are **500 ms** | `500` ms |
| ACC-VOICE-18 | `*starred*` words become **their own span** | a distinct span, not merged into the surrounding prose span |
| ACC-VOICE-19 | A starred span is spoken at **0.92 ×** | multiplier `0.92` |
| ACC-VOICE-20 | A starred span is amplified by **+1.5 dB** | gain `+1.5` dB |
| ACC-VOICE-21 | The asterisks themselves are not spoken | `*` absent from the span's spoken text |

### Mood preset table (§A1 step 5)

| ID | mood | speed | pitch | tone requirement |
|---|---|---|---|---|
| ACC-VOICE-30 | `focused` | `1.00` | `0` | neutral, light compression |
| ACC-VOICE-31 | `sharp` | `1.06` | `+1.5 %` | brighter shelf, tighter compression |
| ACC-VOICE-32 | `gentle` | `0.93` | `−1.5 %` | softer; **pauses × 1.35**; shelf rolled off |
| ACC-VOICE-33 | `clinical` | `1.02` | `0` | flat; minimal pauses; **no jitter** (jitter disabled entirely) |
| ACC-VOICE-34 | `wry` | `0.98` | `+0.5 %` | **longer clause pauses** than `focused` — the deadpan beat |
| ACC-VOICE-35 | `grave` | `0.90` | `−2.5 %` | dark, slow, **longer sentence pauses** than `focused` |
| ACC-VOICE-36 | — | A preset exists for **all six** moods and no others are required | six keys |
| ACC-VOICE-37 | — | Mood presets are audibly distinct: no two moods share the same `(speed, pitch)` pair | six distinct pairs |

### Cache (§A1 step 6)

| ID | Criterion | Expected |
|---|---|---|
| ACC-VOICE-40 | Cache key is `sha256(spoken + voiceHash + preset)` | changing **any** of the three inputs changes the key |
| ACC-VOICE-41 | Cache filename is `<sha256hex>.wav` under `app/.voicecache/` | 64 hex chars + `.wav` |
| ACC-VOICE-42 | Identical (text, voice, preset) hits the cache — no re-synthesis | second call is a cache hit |
| ACC-VOICE-43 | Cache is LRU-capped at ~200 MB: exceeding the cap evicts **least-recently-used** entries first | oldest-used evicted; newest retained |
| ACC-VOICE-44 | After a trim the cache size is at or below the cap | `<= 200 MB` |

### Degradation (§A2 — hard requirement)

| ID | Criterion | Expected |
|---|---|---|
| ACC-VOICE-50 | If Python is missing, `startVoice()` **resolves** (does not reject, does not hang) | settles within a bounded time |
| ACC-VOICE-51 | With Python missing, `voiceReady()` returns `false` | `false` |
| ACC-VOICE-52 | With Python missing, `speak()` resolves without throwing and emits no audio | no throw, `onAudio` never called |
| ACC-VOICE-53 | If the worker **dies mid-session**, subsequent `speak()` calls are silent no-ops rather than throwing | no throw |
| ACC-VOICE-54 | `cancelSpeech()` and `stopVoice()` are safe to call when voice was never started | no throw |
| ACC-VOICE-55 | The app keeps working with voice dead — voice is an enhancement, never a dependency | server boot + chat unaffected |

### Audio transport (§C2 / §C3)

| ID | Criterion | Expected |
|---|---|---|
| ACC-VOICE-60 | `onAudio` is called per chunk with `{type:'audio_chunk', utteranceId, seq, mime:'audio/wav', b64, ms}` and finally once with `{type:'audio_end', utteranceId}` | exact shapes |
| ACC-VOICE-61 | `seq` starts at **0** for each utterance | first chunk `seq === 0` |
| ACC-VOICE-62 | `seq` is **contiguous** — increments by exactly 1, no gaps | `[0,1,2,…,n-1]` |
| ACC-VOICE-63 | `b64` decodes to a **complete standalone WAV**: bytes 0–3 `RIFF`, bytes 8–11 `WAVE` | header verified on **every** chunk, not just the first |
| ACC-VOICE-64 | The declared `RIFF` chunk size equals `fileLength - 8` | self-consistent header |
| ACC-VOICE-65 | Each chunk contains a `fmt ` chunk and a `data` chunk — i.e. it is independently decodable | present |
| ACC-VOICE-66 | `ms` is a positive number — the chunk's duration | `> 0` |
| ACC-VOICE-67 | `audio_end` arrives exactly once per utterance, after the last chunk | ordering held |
| ACC-VOICE-68 | `speak()` resolves when fully queued, and never blocks the model turn | resolves promptly |
| ACC-VOICE-69 | `speak()` splits on sentence boundaries and streams chunk *n* while *n+1* is still synthesising | ≥2 chunks for a multi-sentence input |
| ACC-VOICE-70 | Line-bank utterances are served from cache with zero synthesis (`warmLineBank`) | instant path |
| ACC-VOICE-71 | `cancelSpeech(utteranceId)` stops further chunks for that utterance only | other utterances unaffected |

---

## ACC-MOOD — Agent B, mood engine

| ID | Criterion | Expected |
|---|---|---|
| ACC-MOOD-01 | Exactly six moods exist | `focused, sharp, gentle, clinical, wry, grave` |
| ACC-MOOD-02 | `focused` is the **default** — it fires when nothing else does | fallback mood |
| ACC-MOOD-03 | `sharp` fires on a correct streak on already-beaten material, or on difficulty being farmed | e.g. streak `+6`, all difficulty ≤ 2 → `sharp` |
| ACC-MOOD-04 | `gentle` fires on **≥3 wrong in a row** | streak `-3` → `gentle` |
| ACC-MOOD-05 | `gentle` fires when the session is **past 90 min** | `sessionElapsedMs > 90*60*1000` → `gentle` |
| ACC-MOOD-06 | `gentle` fires **after 22:30** local | local clock ≥ 22:30 → `gentle` |
| ACC-MOOD-07 | `clinical` fires in **EXAM** mode | mode `EXAM` → `clinical`, unconditionally |
| ACC-MOOD-08 | `wry` fires on off-topic input, banter, or a genuinely elegant method | `wry` |
| ACC-MOOD-09 | `grave` fires when **`daysToExam < 30` AND readiness is below target trajectory** — both required | `<30` days alone must NOT produce `grave` if readiness is on track |
| ACC-MOOD-10 | Precedence is `clinical > grave > gentle > sharp > wry > focused` | when two conditions hold, the higher-precedence mood wins |
| ACC-MOOD-11 | Precedence check: EXAM + 3-wrong-in-a-row → `clinical` (not `gentle`) | `clinical` |
| ACC-MOOD-12 | Precedence check: `grave` conditions + `sharp` conditions → `grave` | `grave` |
| ACC-MOOD-13 | Precedence check: `gentle` conditions + `sharp` conditions → `gentle` | `gentle` |
| ACC-MOOD-14 | Precedence check: `sharp` conditions + `wry` conditions → `sharp` | `sharp` |
| ACC-MOOD-15 | **Hysteresis**: a mood holds for **≥2 turns** — it cannot be replaced on the very next turn by an equal- or lower-precedence mood | mood unchanged at turn *n+1* |
| ACC-MOOD-16 | Hysteresis is **overridden** by a strictly higher-precedence mood firing | e.g. entering EXAM flips to `clinical` immediately |
| ACC-MOOD-17 | `reason` is truthful — it names the condition that actually fired (e.g. a `-3` streak reason mentions the wrong answers, not a fabricated cause) | reason corresponds to the firing condition |
| ACC-MOOD-18 | `MOOD_COLORS` covers all six moods with `{light, dark}` colour strings | six entries |

### `<monday-state>` block format (§B2)

| ID | Criterion | Expected |
|---|---|---|
| ACC-MOOD-30 | `renderStateBlock` output opens with `<monday-state>` and closes with `</monday-state>` | exact tags |
| ACC-MOOD-31 | It contains a `mood:` line carrying the mood and a parenthesised `(why: …)` reason | `mood: sharp        (why: …)` |
| ACC-MOOD-32 | It contains a `mode:` line | `mode: DRILL` |
| ACC-MOOD-33 | It reports `lesson:`, `session elapsed:` and `local time:` | all three labels present |
| ACC-MOOD-34 | It reports `exam:` with the date and the days-out count | `exam: 2026-10-15   55 days out` shape |
| ACC-MOOD-35 | It reports `streak:` (signed) and `session accuracy:` as `c/t` | both present |
| ACC-MOOD-36 | It reports `backlog due:` and `last session:` | both present |
| ACC-MOOD-37 | It reports `readiness:` as `N/100` with a `weakest:` list | present |
| ACC-MOOD-38 | The block is compact — the spec budgets ~120 tokens | ≤ ~900 characters |
| ACC-MOOD-39 | Values in the block are the state's real values, not placeholders | block values equal the `MondayState` fields |
| ACC-MOOD-40 | The mood is computed per turn and NOT frozen into the system prompt | `buildSystemPrompt()` contains no mood value |

## ACC-MODE — Agent B, modes and gates

| ID | Criterion | Expected |
|---|---|---|
| ACC-MODE-01 | Exactly six modes | `DRILL, EXAM, POSTMORTEM, TEACH, CONSOLIDATION, PAUSE` |
| ACC-MODE-02 | `DRILL` is the default mode | default |
| ACC-MODE-03 | EXAM: `timerForced === true` | timer forced |
| ACC-MODE-04 | EXAM: `hintsAllowed === false` | no hints, no Socratic prompting |
| ACC-MODE-05 | EXAM: `voiceEnabled === false` | voice muted |
| ACC-MODE-06 | EXAM: `lockMood === 'clinical'` | mood locked clinical |
| ACC-MODE-07 | EXAM: `proactiveEnabled === false` — all triggers suppressed | suppressed |
| ACC-MODE-08 | The gates are enforced **in code**, not merely stated in the prompt | code-level enforcement observable without a model call |
| ACC-MODE-09 | `PAUSE` is a real mode with gates (the `pause tutor mode` hatch promoted) — proactivity off | `proactiveEnabled === false` |
| ACC-MODE-10 | `DRILL` allows voice and proactivity | `voiceEnabled === true`, `proactiveEnabled === true` |
| ACC-MODE-11 | `TEACH` allows hints (explanation-first) | `hintsAllowed === true` |
| ACC-MODE-12 | `POSTMORTEM` allows hints and does not force the timer | `hintsAllowed === true`, `timerForced === false` |
| ACC-MODE-13 | `modeGates` on an unknown mode does not throw; it returns a safe default gate object | no throw |
| ACC-MODE-14 | Only EXAM locks the mood; other modes leave `lockMood` falsy | falsy for the other four |

## ACC-READY — Agent B, readiness

| ID | Criterion | Expected |
|---|---|---|
| ACC-READY-01 | Per-topic score is on **0–100** | `0 <= score <= 100` for every topic |
| ACC-READY-02 | Score is **coverage × accuracy × recency-decay** — all three factors materially participate | changing any one factor changes the score |
| ACC-READY-03 | Coverage = attempted vs. available, sourced from `tagindex.js` over `reference/*_full_tag_index.json` | `attempted`/`available` present per topic |
| ACC-READY-04 | Accuracy comes from `topic_stats` in `session_memory.json` | `accuracy` per topic |
| ACC-READY-05 | Recency decay: a topic untouched for 21 days decays **toward a floor** — never to zero, never below the floor | decayed score `>` 0 and monotonically decreasing with staleness |
| ACC-READY-06 | Higher accuracy ⇒ higher score, all else equal | monotonic in accuracy |
| ACC-READY-07 | Higher coverage ⇒ higher score, all else equal | monotonic in coverage |
| ACC-READY-08 | More recent contact ⇒ higher score, all else equal | monotonic in recency |
| ACC-READY-09 | `overall` aggregates the per-topic scores and is on 0–100 | `0 <= overall <= 100` |
| ACC-READY-10 | `projected` is a projected **TMUA score** against the **9.0 target** — on the TMUA scale (roughly 1–9), not 0–100 | `<= 9.0`-scale value |
| ACC-READY-11 | `weakest` lists the lowest-scoring topics, ascending by score | sorted ascending, each `{topic, score}` |
| ACC-READY-12 | A days-to-exam countdown accompanies the readiness aggregate | `daysToExam` available on state |
| ACC-READY-13 | `computeReadiness()` **reads only** — it does not write to `session_memory.json` or any tutor_data file | no mutation |
| ACC-READY-14 | `computeReadiness()` resolves rather than throwing when a data file is missing/empty | no throw |

## ACC-PROACTIVE — Agent B, proactive triggers

| ID | Criterion | Expected |
|---|---|---|
| ACC-PROACTIVE-01 | Exactly **seven** triggers exist | `idle_nudge, repeat_mistake, avoided_topic, backlog_due, session_debrief, exam_milestone, late_night` |
| ACC-PROACTIVE-02 | **Nothing fires unless its own switch is on** — every trigger is individually switchable | toggle off ⇒ silence |
| ACC-PROACTIVE-03 | Defaults: six on, `late_night` **off** | `late_night:false`, rest `true` |
| ACC-PROACTIVE-04 | `idle_nudge` fires when there is **no message for 6 min** in an active session | 6 min |
| ACC-PROACTIVE-05 | `repeat_mistake` fires when the **same `misconception` id occurs twice within 14 days** | 14 days |
| ACC-PROACTIVE-06 | `avoided_topic` fires when `topic_stats` accuracy **< 60 %** and the topic is **untouched 21 days** — both required | 60 % / 21 days |
| ACC-PROACTIVE-07 | `backlog_due` re-voices the existing `backlog.js` notification logic as Monday | fires on due backlog |
| ACC-PROACTIVE-08 | `session_debrief` fires when the session exceeds **40 min** with no close sequence | 40 min |
| ACC-PROACTIVE-09 | `exam_milestone` fires at **90/60/30/14/7/1** days out and nowhere else | exactly those six values |
| ACC-PROACTIVE-10 | `late_night` fires **past 23:00** with a session running — and only when explicitly switched on | 23:00 |
| ACC-PROACTIVE-11 | **All triggers are suppressed in EXAM mode**, including ones whose switch is on | zero emissions in EXAM |
| ACC-PROACTIVE-12 | EXAM suppression is enforced in code, not merely in the prompt | observable without a model call |
| ACC-PROACTIVE-13 | **Global rate limit: at most one interruption per 10 minutes**, across all triggers combined | second trigger within 10 min is suppressed |
| ACC-PROACTIVE-14 | After 10 minutes have elapsed, a further interruption is permitted | fires again |
| ACC-PROACTIVE-15 | Cheap triggers (`backlog_due`, `exam_milestone`) emit a templated line and cost **no model turn** | `emit` used, `queueInstruction` NOT used |
| ACC-PROACTIVE-16 | Diagnostic triggers push a **hidden instruction** so Monday raises it in its own words | `queueInstruction` used |
| ACC-PROACTIVE-17 | `setToggles(t)` updates the switches at runtime, taking effect on the next `tick()` | effective |
| ACC-PROACTIVE-18 | `TRIGGERS` is exposed and enumerates the seven trigger ids | seven |
| ACC-PROACTIVE-19 | Emitted events match the `proactive` payload `{trigger, text, severity}` | ACC-WS-05 |
| ACC-PROACTIVE-20 | `tick()` with all toggles off emits nothing regardless of conditions | silence |

---

## ACC-UI — Agent C, the face

| ID | Criterion | Expected |
|---|---|---|
| ACC-UI-01 | `web/index.html` title is `MONDAY` | `<title>MONDAY</title>` |
| ACC-UI-02 | The header `.logo` reads `MONDAY` with a mood dot beside it | present |
| ACC-UI-03 | `TITLES.chat` is `MONDAY` | present |
| ACC-UI-04 | The persona `<select>` and the `PERSONAS` constant are **deleted** from `App.jsx` | absent |
| ACC-UI-05 | Assistant bubbles carry a `MONDAY` label and a mood tint | present |
| ACC-UI-06 | The PDF empty state reads `MONDAY PUTS QUESTIONS HERE.` | exact string |
| ACC-UI-07 | `manifest.webmanifest` `name` and `short_name` are `Monday` | exact |
| ACC-UI-08 | The Swift shell and `Info.plist` use Monday names (window, menu, bundle) | no `TMUA Tutor` window/menu naming left |
| ACC-UI-09 | No `bubbly` / `standard` persona strings survive anywhere in `app/web/` | zero occurrences |
| ACC-UI-10 | `MondayOrb` implements exactly five states: `dormant, idle, thinking, speaking, alert` | five |
| ACC-UI-11 | `dormant` = disconnected, dim, still | per spec |
| ACC-UI-12 | `idle` = 4 s breathing pulse | `4` s period |
| ACC-UI-13 | `thinking` = concentric arcs at differing rates while a turn is in flight | per spec |
| ACC-UI-14 | `speaking` = ring radius driven by a Web Audio `AnalyserNode` on the playback node — real amplitude, not faked | `AnalyserNode` referenced |
| ACC-UI-15 | `alert` = double-flash on a proactive nudge | per spec |
| ACC-UI-16 | Orb colour follows the mood (via `MOOD_COLORS`) | mood-driven |
| ACC-UI-17 | Orb respects the light/dark toggle and the brutalist look: hard edges, 2 px stroke, `#ffde00`, **no soft glows** | no blur/shadow/glow in the orb draw |
| ACC-UI-18 | A `TOOL_VOICE` map gives **first-person captions for all 20 tools** | 20 entries |
| ACC-UI-19 | Captions are first-person present-participle, e.g. `show_pdf → "putting ${d} on screen"`, `get_pdf_page → "reading ${d}"`, `query_tag_index → "checking the index — ${d}"`, `monday_recall → "remembering how ${d} went last time"` | those four exact captions |
| ACC-UI-20 | The old `⚙ {name}` raw-tool-name rendering is gone | absent |
| ACC-UI-21 | Every tool registered in `session.js` has a `TOOL_VOICE` entry — no tool renders as a bare id | full coverage |
| ACC-UI-22 | Audio is scheduled **gaplessly** in a Web Audio queue | contiguous scheduling, no gaps |
| ACC-UI-23 | Out-of-order `seq` is **tolerated** — chunks are reordered/buffered, not dropped or played out of order | reordering logic present |
| ACC-UI-24 | Header speaker toggle persists to `localStorage` | persisted |
| ACC-UI-25 | Per-message ▶ replay exists | present |
| ACC-UI-26 | Mute-while-typing | present |
| ACC-UI-27 | **Auto-mute in EXAM** — the UI mutes itself when mode is EXAM | muted |
| ACC-UI-28 | `SETTINGS` popover has one switch per proactive trigger (7), master switches for voice and proactivity, and volume | 7 + 2 + volume |
| ACC-UI-29 | Settings write through to `config` via the server endpoint (persisted, not only local) | POST to config endpoint |
| ACC-UI-30 | Settings survive a reload | persisted |
| ACC-UI-31 | A mode selector exists in the header | present |
| ACC-UI-32 | **EXAM is visually unmistakable** — a distinct visual state, not just a different word | dedicated EXAM styling |
| ACC-UI-33 | A `READINESS` pane exists with per-topic bars, projected score vs 9.0, and the countdown | present |
| ACC-UI-34 | Clicking the mood chip opens a popover with the mood, the `reason` string and a `mood_history` sparkline | present |
| ACC-UI-35 | The status line renders `◉ MONDAY · <MOOD> · L<n> · <n>d TO EXAM · <n>/100 READY · CTX <n>% · ⏱ <mm:ss>` | all seven segments |
| ACC-UI-36 | The public dashboard (`tutor_data/dashboard-site/`) is untouched — out of scope | unmodified |

---

## ACC-SELF — self-knowledge (must be true, not memorised)

| ID | Criterion | Expected |
|---|---|---|
| ACC-SELF-01 | `mondaySelf()` is **computed live** — its output changes when the underlying state changes | two calls across a state change differ |
| ACC-SELF-02 | `mondaySelf()` output is **not** a stored/memorised paragraph read verbatim from disk | not byte-identical to any single stored file section |
| ACC-SELF-03 | The **tool count** `mondaySelf()` reports equals the number of tools actually registered in `session.js` | counts match exactly (see ambiguity A-1) |
| ACC-SELF-04 | It states the build honestly: Claude Agent SDK inside a local Node server on the student's Mac | present |
| ACC-SELF-05 | It states **no Bash** access | stated |
| ACC-SELF-06 | It states **no web** access | stated |
| ACC-SELF-07 | It states writes are confined to `tutor_data/` | stated |
| ACC-SELF-08 | It states the voice is a local 82M model | stated |
| ACC-SELF-09 | It reports live context/memory facts from real files (e.g. how many papers ingested, last session) rather than constants | derived from files |
| ACC-SELF-10 | `readSelfModel()` reads `tutor_data/monday/self_model.md` and returns its content | file-backed |
| ACC-SELF-11 | `buildSystemPrompt()` embeds `readSelfModel()`'s content | contained |
| ACC-SELF-12 | The retired `PERSONA RULES` block in `TMUA_Master_Prompt_v3.txt` §7 is replaced by a pointer, so the two cannot contradict | old persona rules gone; phase-timing rules retained |

## ACC-MEM — Monday's own memory store

| ID | Criterion | Expected |
|---|---|---|
| ACC-MEM-01 | `tutor_data/monday/` exists and is separate from `session_memory.json` | separate directory |
| ACC-MEM-02 | `memory.json` has shape `{schema_version, explanations[], phrasings[], observations[], mood_history[]}` | all five keys |
| ACC-MEM-03 | `explanations[]` entries are `{ts, topic, technique, approach, outcome, evidence}` with `outcome ∈ {landed, bounced, partial}` | exact |
| ACC-MEM-04 | `phrasings[]` entries are `{ts, line, context, reception, note}` with `reception ∈ {good, flat, bad}` | exact |
| ACC-MEM-05 | `mood_history` retains the **last 200** entries — appending a 201st drops the oldest | length capped at 200 |
| ACC-MEM-06 | `journal.md` exists for narrative session-close entries | present |
| ACC-MEM-07 | `mondayNote` appends without destroying prior entries | prior entries intact |
| ACC-MEM-08 | `mondayRecall({kind, topic})` returns prior entries filtered by kind and topic | filtered |
| ACC-MEM-09 | `mondayRecall` on an unknown topic returns an empty result rather than throwing | no throw |
| ACC-MEM-10 | Monday's memory writes never touch `session_memory.json` | untouched |

## ACC-REG — regression, non-negotiable

| ID | Criterion | Expected |
|---|---|---|
| ACC-REG-01 | `tutor_data/memory/session_memory.json` stays **byte-compatible** with the dashboard: no top-level key removed, no key renamed, no type changed | schema preserved |
| ACC-REG-02 | `session_notes.md` stays byte-compatible with the dashboard's parser | format preserved |
| ACC-REG-03 | Reading/booting Monday does not rewrite `session_memory.json` | file unchanged by a read path |
| ACC-REG-04 | `backlog.json` and `activity_log.json` retain their existing shape | preserved |
| ACC-REG-05 | The test suite itself never mutates real student data — all writes go to temp copies | `git status` clean for `tutor_data/**` after the suite |

## ACC-INT — cross-module integration (§D wiring)

| ID | Criterion | Expected |
|---|---|---|
| ACC-INT-01 | `renderStateBlock(computeState(...))` is prepended to each **user message pushed into the SDK queue** | present in the SDK-bound text |
| ACC-INT-02 | **The state block does NOT reach `broadcast`** — it must not land in `chats/<id>.json` and must not become the chat title (the `sendUser` asymmetry) | `<monday-state>` absent from every broadcast payload and from the persisted chat file |
| ACC-INT-03 | The chat title derived from the first user message is the user's own text, never the state block | title free of `<monday-state>` |
| ACC-INT-04 | B's three handlers are registered as SDK tools alongside the existing ones | `monday_recall`, `monday_note`, `monday_self` registered |
| ACC-INT-05 | The startup registry checklist / verification lists the new tools | consistent |
| ACC-INT-06 | `buildSystemPrompt()` is called with **no argument** at its call site | no persona passed |
| ACC-INT-07 | `onAudio` is routed into `broadcast(..., false)` | record false |
| ACC-INT-08 | `assistant_delta` feeds `speak()`, gated on `modeGates(mode).voiceEnabled` **and** `config.voice.enabled` | both gates required |
| ACC-INT-09 | With `config.voice.enabled === false`, no `speak()` occurs even in DRILL | silent |
| ACC-INT-10 | In EXAM, no `speak()` occurs even with `config.voice.enabled === true` | silent |
| ACC-INT-11 | EXAM **simultaneously** mutes voice AND suppresses every proactive trigger, both in code | both |
| ACC-INT-12 | `createProactive` is wired into the periodic tick | ticked |
| ACC-INT-13 | `.gitignore` covers `app/.voicecache/`, `app/tts/voices/*.pt`, `__pycache__/` | three entries |
| ACC-INT-14 | The `INTEGRATION_*.md` handoff files are deleted once consumed | absent |
| ACC-INT-15 | A `POST /api/config` endpoint exists for the settings write-through | present |

## ACC-E2E — live server behaviour

| ID | Criterion | Expected |
|---|---|---|
| ACC-E2E-01 | The server boots on a configurable port (tests must not fight the real app on :3941) | boots on a spare port |
| ACC-E2E-02 | A connecting WebSocket client receives a `monday_boot` event with `{greeting, state}` | received |
| ACC-E2E-03 | The `state` in `monday_boot` satisfies the full MondayState contract | valid |
| ACC-E2E-04 | `monday_state` events observed on the socket satisfy the MondayState contract | valid |
| ACC-E2E-05 | Nothing broadcast with `record:false` appears in the persisted chat file | absent |
| ACC-E2E-06 | The server boots successfully with voice unavailable | boots |
| ACC-E2E-07 | Server shutdown is clean — no orphaned Python worker | clean |

---

## Spec ambiguities

Recorded rather than resolved by reading the implementation.

- **A-1 — the tool count.** §B1 layer 3 says Monday knows it has **"17 tools"**. §D step 2 says B's
  three handlers are registered **"alongside the existing 17"**, and §C1 requires first-person
  captions for **"all 20 tools"**. 17 + 3 = 20, so the "17" in the self-model text is stale the
  moment D wires the new tools. ACC-SELF-03 is therefore written as the *invariant* — the reported
  count must equal the count actually registered in `session.js` — rather than against a literal
  17 or 20. A hard-coded literal anywhere is itself a violation of "computed live, never memorised".
- **A-2 — `examDate`.** §C4 gives `"2026-10-15"` and explicitly annotates it
  `// PLACEHOLDER — confirm the real TMUA sitting date`; the `<monday-state>` sample also uses
  2026-10-15. Since the spec disclaims its own value, ACC-CFG-05 asserts presence and ISO shape, and
  ACC-MOOD-34 asserts the *shape* of the exam line rather than a specific date. Any date is
  acceptable provided every consumer (state block, status line, countdown, dashboard) agrees on the
  same one — disagreement between two countdowns would be a real defect.
- **A-3 — clause pause selection.** "60–140 ms at commas/em dashes" is a range with no rule for
  picking within it. Tested as an inclusive bound on every clause pause.
- **A-4 — jitter distribution.** "±3 % sentence-level speed jitter" fixes the bound but not the
  distribution. Tested as: every sentence speed within ±3 % of the mood base, and not all identical.
  `clinical` specifies "no jitter", so for clinical every sentence speed must equal the base exactly.
- **A-5 — mood-scaled pauses.** `gentle` says "pauses ×1.35" and `clinical` "minimal pauses",
  `wry` "longer clause pauses", `grave` "long sentence pauses" — only gentle gets a number. Tested
  as ordering relations against `focused` rather than absolute values, except gentle's 1.35.
  It is also unspecified whether the ×1.35 applies before or after the 60–140 ms clause bound; the
  bound is read as the *base* range, so a gentle clause pause may legitimately exceed 140 ms.
- **A-6 — "below target trajectory"** for `grave` is not defined numerically. Tested as: a clearly
  on-track readiness inside 30 days must NOT be `grave`, and a clearly failing one must be.
- **A-7 — hysteresis counting.** "holds ≥2 turns" does not say whether the count is turns of the
  chat or invocations of `computeState`. Tested against consecutive `computeState` calls over a
  growing chat, which is the only observable the contract offers.
- **A-8 — LRU cap "~200 MB"** is approximate. Tested as: after a trim, total size ≤ 200 MB, and the
  least-recently-*used* file is the one evicted (not merely the oldest-created).
- **A-9 — `projected`.** "a projected TMUA score against the 9.0 target" implies the 1–9 TMUA scale,
  while `overall` is 0–100. Tested as `projected <= 9` on the TMUA scale; if the implementation uses
  0–100 for both, that is a contract reading to flag rather than silently accept.
- **A-10 — `monday_boot` recording.** §C3's "All are record:false … except `monday_boot`" implies
  `monday_boot` IS persisted. That is asserted as written, though it means the boot greeting enters
  the chat transcript.
- **A-11 — `severity`** on the `proactive` payload has no enumerated value set in the spec. Tested
  only for presence and type.
- **A-12 — voice `pitch` units.** The mood table gives pitch as a percentage (`+1.5 %`), and §A1
  step 5 names `asetrate`/`aresample`/`atempo`. Tested as a per-mood numeric pitch parameter whose
  sign and ordering match the table, not as a specific ffmpeg filter string.

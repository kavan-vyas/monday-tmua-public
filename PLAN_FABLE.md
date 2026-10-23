# Monday — completion plan (Fable)

Budget for the remaining work is small and hard-capped — **this plan assumes not
everything below gets built**, and orders the work so the highest-value, lowest-risk
pieces land first and are safe to stop after. Every numbered step ends with the app in
a working, committed state.

Baseline verified before writing this plan: `npm test` → **353/353 passing**, `npm run
build` clean, in `<project>/app`.

**Delegation mechanism.** The main session (Opus, running interactively, not drawing
on this budget) is available via `SendMessage({to:"main", message:"..."})` for
anything mechanical: pane-registration boilerplate, running `npm test`/`npm run
build` and reporting failures, restarting the server, rebuilding `Monday.app`
(`zsh app/scripts/build-app.sh`), git operations, reading a file and reporting exact
line contents, curl/WebSocket verification probes, copying assets, mechanical
find-and-replace. Every step below is tagged **Hard — keep** (judgement, design,
correctness-sensitive — do it directly) or **Mechanical — delegate to main** (typing,
once the contract is fully specified). When a step is delegated, hand main the exact
spec from this document, not a paraphrase — it has no memory of this conversation
until messaged.

---

## Corrections to the approved plan

The approved plan (`an earlier approved plan`) has
six known errors. Five were found and fixed by the server-side agent and are recorded
in `app/tests/ACCEPTANCE.md` under `## Plan corrections`; restated here so this
document is self-contained:

- **P-1.** `insideTutorData` guards the annotation *write target*
  (`tutor_data/annotations/<key>.json`), not the PDF `path` argument — the PDFs live
  under `major exams/`, outside `tutor_data/`. The PDF path is guarded by
  `insideRoot` instead. Already implemented this way in `server/index.js`.
- **P-2.** There is no `readiness_report` tool. The projected grade reaches Monday via
  the `<monday-state>` block every turn (`server/mood.js`). The marks-not-grades rule
  in `MONDAY_BLOCK` (`server/prompt.js`, line ~608) is written against that channel.
- **P-3.** The technique vocabulary in `tagindex.js` is 57 values, not 54.
- **P-4.** `add_paper` runs `organise.js`'s `enqueuePaper` (identify → file → register
  → classify → merge), which wraps `ingest.js` — not `ingest.js` alone.
- **P-5.** `tutor_data/reference/video_index.json` has no verified timestamps — every
  entry is whole-video, `provenance` field says so. Real segments get added as videos
  are watched.
- **P-6 — found while planning the frontend.** §1.2 of the approved plan has pen /
  highlighter / free text inherited from pdf.js's `AnnotationEditorLayer` (which owns
  its own undo stack), with a *separate* hand-built arrow layer and *its own* undo
  stack on top. That's two parallel serialization systems feeding one schema, two undo
  stacks to keep in sync, and an eraser that has to hit-test across both. It also
  doesn't match what's already been built: `app/web/src/monday/pdfEngine.js` ships
  `distanceTo()` — one eraser hit-test that already spans `ink`, `arrow`, and
  bbox-based marks uniformly. That only makes sense with one overlay, not two.
  **Correction: build one custom annotation overlay (canvas + a thin DOM layer)
  owning all four mark types, one undo/redo stack, one eraser.** Drop the idea of
  adopting pdf.js's `AnnotationEditorLayer`. "Feels like Firefox's editor" was a means
  to an end (marks that persist correctly and mean something to Monday), not a
  requirement in itself.

---

## Confirmed already done — do not redo, do not re-verify by reading again

- `pdfjs-dist@^5.7.284` installed; `app/web/public/cmaps/` and `standard_fonts/`
  populated; `.mjs .wasm .bcmap .pfb` in the MIME table; `/assets/*` and any
  file-extension path 404 instead of SPA-fallback (`server/index.js:261-275`).
- `GET/POST /api/annotations` live (`server/index.js:378-407`), correctly guarded
  (P-1), broadcasts `annotations_changed`, accepts `sendBeacon`, idempotent.
- `server/annotations.js` exports `MARK_TYPES`, `MONDAY_COLOR` (`#e0533d`),
  `STUDENT_COLOR` (`#1b6ef3`) — duplicate these two hex values client-side, they're
  server-only and not importable by Vite.
- `server/video.js` + `show_video`/`find_video` MCP tools live
  (`server/session.js:646-685`); `modeGates(...).videoAllowed` false in EXAM
  (`server/modes.js`), wired into the tool handler.
- `app/web/src/monday/pdfEngine.js`: `loadDocument`, `renderScale(zoom)` →
  `{css,device,dpr}`, `toPdf`/`toCss` coordinate conversion (correct — via
  `viewport.convertToPdfPoint`/`convertToViewportPoint`, respects rotation and
  MediaBox origin), `bboxOf`, `textInRect`, `distanceTo`, `newId`. **Reuse as-is.**
- No frontend code exists yet for video or grades (confirmed by grep — zero hits).
- `MOODS = ['focused','sharp','gentle','clinical','wry','grave']` (5 modes:
  DRILL/EXAM/POSTMORTEM/TEACH/PAUSE) are real, computed, and already drive UI + the
  system prompt block per turn — the *machinery* for personality is not missing, only
  its expression in the actual prose Monday writes (see Step 0C).
- `mondayRecall`/`mondayNote`/`mondaySelf` are registered tools, already instructed in
  `session.js` ("CALL THIS BEFORE re-teaching any topic he has struggled with";
  "Record what just happened... in the same turn") — the machinery for the efficacy
  record exists and is wired to first-person tool narration in chat
  (`toolCaption()`). The gap is model *compliance*, not missing code — fixable mainly
  through the prompt, not new tools (see Step 0C).
- Settings pane (`SettingsPane.jsx`) already has 7 sections: Voice, Model, Modes,
  Proactivity, Appearance, Study, Data. Per-trigger proactive toggles already exist
  (`.state.json` shows `idle_nudge, repeat_mistake, avoided_topic, backlog_due,
  session_debrief, exam_milestone, late_night` individually switchable).
- `TMUATutor.swift:31`, `cfg.mediaTypesRequiringUserActionForPlayback = []`, is
  present and correct. **Never regress this in any Swift change.**
- `mergeConfig`/`mergeVoice` (`server/session.js:260-287`) merge key-by-key, so a
  sparse patch cannot clear a sibling field — this is solid, tested (`ACC-CFG-07`
  referenced in comments) infrastructure. Current `.state.json` shows
  `voice.enabled:true` right now — the reported "found false" bug is not currently
  reproducing and its root cause is not yet confirmed (see Step 0A).

---

## Priority order

0. **The three under-delivered items** — sound, verbosity, personality. These affect
   *every* session the student has, unlike any of the new panes. Land first, always.
1. **PDF annotation** — the long pole among new features, unlocks three already-built
   MCP tools that are currently dead code.
2. **Video pane, web-only** — unlocks two more already-built tools. Pure frontend.
3. **Grades pane** — small, isolated, cheap, high owner-value.
4. **Settings expansion** — audit server-side knobs not yet exposed in the UI, expose
   them. Cheap once audited.
5. **Swift native video panel** — real value only inside `Monday.app`; the web pane
   from step 2 already degrades gracefully without it. Hardest to verify without a
   live GUI session. First candidate to cut.
6. **UI cohesion across all four surfaces** (app, `dashboard.html`, `dashboard-site/`,
   Mac bundle) — descoped below to a scoped consistency pass, not a redesign. Second
   candidate to cut, and the honest recommendation is: don't attempt a ground-up
   revamp against a hard budget cap when "never lose a feature" is the explicit
   worst-case.

If the budget stops after step 0, the sessions the student actually has every day are fixed,
which is worth more than any single new pane. If it stops after step 1, the
single most-requested missing feature is done. Both are legitimate places to stop.

---

## Step 0A — sound: diagnose the whole chain, make it robust

**Hard — keep.** Chain: `app/tts/monday_tts.py` (Kokoro worker) → `server/voice.js` →
`broadcast(audio_chunk)` → `web/src/monday/audio.js` → Web Audio.

What's already been checked and looks correct (confirm, don't blindly redo):
- `audio.js`'s unlock listener (`web/src/monday/audio.js:227-246`) already retries
  correctly — it only removes itself once `ctx.state === 'running'`, not on the first
  attempt regardless of outcome. The "one-shot listener" bug as described does not
  match the code as it stands now.
- `audio.js push()` (`:105-140`) already `await`s `ctx.resume()` before scheduling,
  and sets `this.blocked = true` + emits a change event if the context still isn't
  running rather than silently dropping the chunk — so there's a hook for the UI to
  show "blocked" state (check whether anything actually *renders* `audio.blocked` —
  grep `.blocked` usage in `App.jsx`/`StatusLine.jsx`; if nothing surfaces it, that's
  the real gap: the signal exists, the UI doesn't show it).
- `TMUATutor.swift:31` is present, correct, unregressed.
- `server/index.js:505-514` (`/api/speak`) 409s if `cfg.voice?.enabled === false` or
  `modeGates(cfg.mode).voiceEnabled` is false — this is a deliberate refusal
  (EXAM/off), not a bug, but confirm the client actually shows *why* it 409'd rather
  than failing silently.
- `mergeConfig`/`mergeVoice` merge key-by-key server-side, so a stale client patch
  restoring an old `volume` alongside a correct `enabled` wouldn't corrupt anything
  except that one stale field — the merge logic itself is not the likely bug.

**Leading hypothesis for the "`voice.enabled` found false, cause unknown" report, not
yet confirmed — verify before fixing:** two independent UI surfaces write the same
field. The header speaker button (`App.jsx:1554`) and `SettingsPane.jsx:306`'s Voice
toggle both call `postConfig({voice:{...voice, enabled: v}})`, spreading the
*client's locally-held* `voice` object rather than patching a single field. If two
config-changing actions fire close together (e.g. a proactivity toggle and the mute
button, or two rapid clicks) built from React closures capturing slightly different
snapshots of `voice`, the later `set_config` message can silently re-assert a stale
`enabled` value the user didn't intend. `DEFAULT_VOICE = {enabled:true, volume:0.9}`
(`constants.js:79`) rules out a bad default, so this would only bite on a genuine
race. **Diagnostic protocol:** add a temporary server-side log line on every
`voice.enabled` transition (`before → after`, with the raw patch that caused it) in
`setConfig()` (`server/session.js:1081-1099`), reproduce by rapidly toggling
mute/settings, read the log, confirm or rule out the race. If confirmed, fix by having
both the header button and the Settings toggle send a **single-field** patch
(`{voice:{enabled:v}}`) built from the *server-echoed* `config` event's most recent
value, never from a value that could be stale by more than one render — or simpler and
more robust regardless of root cause: make `setConfig` refuse to flip `voice.enabled`
false→true or true→false unless the patch's `voice` object contains *only* the
`enabled` key (i.e. an explicit, minimal toggle), never as a side effect of a patch
whose primary intent was something else.

**Definition of done — this must be genuinely bulletproof, not "probably fine":**
- No code path can flip `config.voice.enabled` except an explicit user action on the
  mute button or the Settings toggle. Verify by reading every call site of
  `postConfig`/`onSettingsPatch`/`setConfig` (server) that touches `voice` — not just
  the two known ones — and confirming each sends a minimal, intentional patch.
- When voice is blocked for any reason (context suspended, no interpreter, EXAM mode,
  explicitly muted), the UI shows *why*, visibly, not just silence. Wire `audio.blocked`
  (already emitted) into `StatusLine.jsx` or the speaker button's tooltip/icon state —
  currently unclear whether anything consumes it; check first.
- Manual test, real evidence: fresh app launch, click nothing, Monday's boot greeting
  is heard on the first try. Toggle mute/unmute ten times rapidly, confirm state
  never desyncs from what the button shows. Enter and leave EXAM mode, confirm voice
  resumes correctly on exit rather than staying stuck off.

**Verify:** `npm test` 353/353 if any shared module changes. **Commit** (even if the
outcome is "confirmed no bug reproduces, added the missing UI-blocked-state
indicator" — that's still real, valuable, committable work).

## Step 0B — verbosity: dedupe the prompt, tighten the instruction

**Hard — keep.** `server/prompt.js` builds the system prompt as `OVERRIDE +
MONDAY_BLOCK + readSelfModel() + MASTER_HEADER + master prompt`
(`buildSystemPrompt()`, `prompt.js:771-772`). Measured just now:
`OVERRIDE` = 34,814 chars, `MONDAY_BLOCK` = 15,120 chars, master prompt
(`tutor_data/TMUA_Master_Prompt_v3.txt`) = 33,665 chars. Total ≈ 84k+ chars, roughly
matching the ~19.7k-token figure. `OVERRIDE`'s own header says it "Supersedes
conflicting parts of Sections 2, 3, 6 and 8" of the master prompt — but the master
prompt's sections 2 (File System and Paths), 3 (Error Handling), 6 (PDF Handling and
Question Cycle) and 8 (Email Protocol) are still sent in full underneath it. That's
real, measurable duplication, not just a verbosity feeling.

**Fix, in order:**
1. Read `OVERRIDE` in full and master-prompt sections 2/3/6/8 in full, side by side.
   For each rule in the master's 2/3/6/8, confirm whether `OVERRIDE` actually
   supersedes it (most will) or whether it covers an edge case `OVERRIDE` doesn't
   mention (keep those, nothing else).
2. Replace the *body* of master-prompt sections 2/3/6/8 with a one-line pointer
   ("superseded — see ENVIRONMENT OVERRIDE above") plus whatever edge-case rules
   survived step 1. Keep the section headers/numbering intact — other sections likely
   reference them by number.
3. This is an edit to `tutor_data/TMUA_Master_Prompt_v3.txt`, not to the four files the
   HARD RULES name as untouchable (`session_memory.json`, `session_notes.md`,
   `backlog.json`, `activity_log.json`) — it's the prompt document itself, in scope.
   Still: read it fully before touching it, and don't remove anything not actually
   duplicated.
4. Separately, tighten `MONDAY_BLOCK` (`prompt.js`, lines ~532-766) with an explicit,
   concrete verbosity rule: short answers by default, no restating the question back,
   no "let me explain step by step" framing before the actual maths, a hard steer
   toward *answers that get to the maths*. This is a judgement call about exact
   wording — write it as a direct instruction with a bad-example/good-example pair
   (the master prompt likely already has this pattern elsewhere; match its style,
   don't invent a new instructional voice).

**Verify:** measure the new total system-prompt character count and report the
reduction. `npm test` 353/353 (prompt.js has no unit tests that assert exact content,
but confirm nothing asserts a specific `OVERRIDE`/`MONDAY_BLOCK` length or the tool
catalogue count — `ACC-TOOL-03`/`04` check tool registration, not prose, should be
unaffected). Manual: run a few real DRILL-mode exchanges, confirm answers are visibly
shorter and still correct. **Commit.**

## Step 0C — personality: make the moods audible, make the memory visible

**Hard — keep.** The state machine is real (six moods, five modes, all computed from
actual session data, all reaching the model every turn via the state block). The gap
is that mood is a *label*, not yet consistently a *register* the writing is actually
in. Rewrite the relevant persona instructions in `MONDAY_BLOCK` (read it in full
first — this plan hasn't quoted its current persona language, don't guess at what's
already there and duplicate it):

- FRIDAY-from-Iron-Man lineage, stated plainly once, not repeated: British, dry,
  unhurried, extremely competent, first person about itself, never pretends to be
  human, never breaks that it's software when asked directly.
- "Boss" — sparingly, as punctuation on a sentence, never as a verbal tic, **never
  twice in one message.** State this as a hard countable rule, not a vibe, since it's
  the kind of thing a model drifts on without one.
- Each of the six moods needs a *textural* instruction, not just "when mood=X, act
  X" — concretely, what changes in sentence length, word choice, and where warmth
  vs. bluntness sits: `focused` (short, declarative, no hedging), `sharp` (faster,
  more clipped, doesn't soften a correction), `gentle` (still exact, but the *landing*
  of a verdict is softer — never the verdict itself), `clinical` (driest of all,
  almost no personality showing, pure diagnosis), `wry` (dry humour is allowed here
  and basically nowhere else), `grave` (short, serious, no jokes, no "Boss"). Rigour
  on the maths never flexes across any of these — only tone does.
- Make the efficacy record an *instructed habit*, not just an available tool: add a
  rule that `mondayRecall` is called at the *start* of any topic that's come up
  before (the instruction to do this already exists at `session.js:791` as the tool's
  own description — check whether `MONDAY_BLOCK` itself also states this as a
  standing behavioural rule, not just leaves it to the tool description to carry the
  weight; tool descriptions are read differently than persona rules and are easy for
  a model to under-weight in practice).

**Verify:** manual — run through DRILL, TEACH, and a deliberately-provoked `grave`
scenario (falling behind schedule) in a live session, read the actual transcript back,
confirm the register genuinely differs and "Boss" never appears twice in one message.
This is fundamentally a taste judgement — flag it as such, don't pretend a test can
assert "sounds like FRIDAY." `npm test` 353/353. **Commit.**

---

## Step 1 — PDF annotation

**Hard — keep**, for the whole engine (coordinate math, drawing loop, undo/redo,
autosave race handling — all correctness-sensitive). Small pieces (see below) are
**mechanical — delegate to main** once contracts are fixed.

### 1.1 Renderer swap-in (no annotation yet)

Replace the body of `PdfTab` (`App.jsx:360-427`) with pdf.js canvas rendering,
extracted into a new file `app/web/src/monday/PdfAnnotator.jsx` (`App.jsx` is already
1753 lines — don't grow it further). `PdfTab` in `App.jsx` becomes a thin wrapper
keeping the existing `props`/`onProps` contract (`App.jsx:1501`).

- Load via `pdfEngine.loadDocument(pdf.path)`. Per page: a render canvas (pdf.js
  `page.render()`, HiDPI-sized via `pdfEngine.renderScale(zoom)`) plus an overlay
  canvas on top, same CSS size.
- Real per-page geometry from `page.getViewport({scale:1})` — drop the hardcoded
  `aspect-ratio: 210/297` in `app.css:270`.
- Wire `onProps` for real — persist `{zoom, page}` so switching tabs and back doesn't
  reset state.
- Keep every existing toolbar control (prev/next, zoom −/+, filename, "Open ↗").
  Losing a control here is exactly the failure mode the brief calls out as worst.
- The `openPdf`/`{path,page,ts}` nonce jump-to-page pattern (`App.jsx:1137-1158`,
  which is how `show_pdf` navigates) must keep working unchanged.

**Verify:** `npm run build` clean. Open several real PDFs: non-A4 papers now render at
correct aspect ratio (silently wrong before). Zoom, switch tabs, come back — state
persists. `find_in_pdf`/`get_pdf_page` (poppler, untouched) still work via a live
Monday call. `npm test` 353/353. **Commit.**

### 1.2 Annotation overlay — read-only render

**Mechanical once specced — delegate to main for the initial draw-loop scaffolding,
Fable reviews before commit.** `GET /api/annotations?path=...` on load. Draw ink as
strokes, highlight as translucent rects, arrow as line+arrowhead, freetext as a small
box — using `pdfEngine.toCss(viewport,x,y)` to convert stored PDF-space points to CSS
pixels. `author:"monday"` → `#e0533d`; everything else → `#1b6ef3`. No editing yet.

**Verify:** hand-post a JSON body (one mark of each type) via curl to
`/api/annotations` against a real paper, open it, confirm all four render correctly.
`cat` the on-disk JSON to confirm it matches. **Commit.**

### 1.3 Drawing tools + autosave

**Hard — keep.** Toolbar: Pen / Highlighter / Freetext / Eraser, plus a
saved/saving indicator (no dialogs, ever). `setPointerCapture` on every draw
interaction (nothing in the codebase does this yet).

- **Pen:** pointerdown→move→up, points converted via `pdfEngine.toPdf`, finalize
  `{type:'ink', paths, bbox:pdfEngine.bboxOf(paths), color:STUDENT_COLOR, width,
  author:'student', id:newId(), ts}`.
- **Highlighter:** drag a rect; on pointerup, `page.getTextContent()` (cache per
  page) + `pdfEngine.textInRect(...)` → `{type:'highlight', quads:[[x0,y0,x1,y1]],
  text, bbox, color, author, id, ts}`.
- **Freetext:** click places an inline `contenteditable`; blur commits.
- **Eraser:** pointerdown hit-tests via `pdfEngine.distanceTo(mark,x,y)` against a
  zoom-scaled threshold, removes the nearest hit.
- **Autosave:** debounced ~800ms, `POST /api/annotations` with `scope:'author'`
  (default — this is what stops the student's autosave from wiping a mark Monday
  drew seconds earlier) and `page_sizes` for touched pages. Forced flush via
  `navigator.sendBeacon` (not `fetch` — survives unmount) on: page change, tab
  close/unmount, pane blur, `visibilitychange`, `beforeunload`.

**Verify:** draw, close tab, reopen — mark intact (check the JSON directly). Zoom
300%, resize, drag pane to another column — marks stay registered. Kill the server
mid-debounce — file is either pre-stroke or fully written, never truncated. Manual
[M]: confirm no dialog *ever* appears on tab-close or app-quit. **Commit.**

### 1.4 Arrow + unified undo/redo

**Hard — keep.** Arrow uses the *same* overlay/marks array/eraser as 1.3 (per P-6),
not a separate layer. Undo/redo: one stack per open document,
`{op:'add'|'remove', page, mark}` inverse operations. Cmd+Z/Shift+Cmd+Z scoped to
PDF-pane focus/hover — check for an existing global keydown handler in `App.jsx`
before adding a new one blind.

**Verify:** draw/undo/redo, JSON and render agree at each step. `npm test`
353/353. **Commit.**

### 1.5 Live updates + real tool verification

**Hard — keep.** Add `case 'annotations_changed':` to `applyEvent`
(`App.jsx:1181`, alongside `case 'show_pdf':` at `:1203`) — on receipt, refetch
`/api/annotations` for any open PDF tab whose path matches, repaint without reload.

**Verify — live session, not yet done since there's been no frontend to test
against:** `show_pdf` opens the right page; `read_annotations` returns hand-drawn
marks; `annotate_pdf` draws and the pane updates **with no reload**; `clear_annotations`
removes only Monday's own marks. Confirm the SDK tool count still matches
`prompt.js`'s stated count. **Mechanical — delegate to main:** grep `App.jsx` for the
`/api/paper` POST call and the `paper-bar`/`setPaper(...)` local state
(`App.jsx:1646-1653`) — confirm no leftover copy implies auto-filing a dropped PDF
(per §1.6 of the approved plan, dropping now just opens it). Fix the string if there
is one. **Commit.** This closes out PDF annotation — safe stopping point.

---

## Step 2 — video pane, web-only

**Hard — keep**, for state wiring and the postMessage contract. **Mechanical —
delegate to main** for the IFrame component boilerplate once the contract is fixed.

`App.jsx` touch points, mirroring `openPdf` exactly:
- `TITLES` (`:509`): add `video: 'Video'`.
- `LAUNCH_VIEWS` (`:732`): add an entry.
- New `openVideo(videoId, t)` mirroring `openPdf` (`:1137-1158`), same tab-reuse and
  `ts`-nonce pattern.
- `applyEvent` (`:1181`): `case 'show_video': if (live) openVideo(ev.videoId, ev.t); break;`
  next to `case 'show_pdf':`. Server shape already fixed:
  `{type:'show_video', videoId, t, note}` (`server/session.js:684`).
- `renderTab` (`:1489`): `case 'video': return <VideoTab props={tab.props} onProps={...}/>;`
- Header button, following Backlog/Readiness (`:1619-1620`).
- **Not seeded into `defaultLayout()`** — opens on demand.

New file `app/web/src/monday/VideoTab.jsx`:
- `const native = !!window.webkit?.messageHandlers?.videoPane;`
- **In-browser:** YouTube IFrame Player (`https://www.youtube.com/iframe_api`),
  `player.seekTo(t,true)` on `props.t`/`props.ts` change.
- **Native:** no iframe, just a placeholder div reporting its rect. Fixed contract:
  `window.webkit.messageHandlers.videoPane.postMessage({ action:'show'|'hide'|'rect'|'load', rect:{x,y,w,h}, videoId, t })`
  — `rect` from `getBoundingClientRect()`, `'show'` on mount/becoming active tab,
  `'hide'` on unmount/tab switched away/column collapsed, `'load'` on videoId/t
  change, `'rect'` on any resize/scroll (`ResizeObserver`).
- EXAM: server already refuses the tool call; no frontend gate needed for the
  Monday-driven path. Manual open during EXAM left unrestricted (judgement call,
  flagged, not a spec violation either way).

**Verify:** play + seek in-browser. Live session: `find_video` → `show_video` opens
and seeks. EXAM refuses (text, no broadcast). `npm run build` clean. **Commit.**

---

## Step 3 — grades pane

**Hard — keep** for the pane wiring (identical to Step 2, low risk). **Mechanical —
delegate to main** for the table data entry and layout once this spec is fixed.

New `app/web/src/monday/gradeTable.js` — pure constant, the table from the approved
plan's §3.3, entered verbatim, preserving both flagged oddities: 13 and 12 both map to
2.0–2.2 (source error, kept as given); boundary overlaps at 27→5.9–6.0/28→6.0–6.1 and
22→4.9–5.1/23→5.2–5.3 (normal TMUA-sitting variance, kept as given). Export
`gradeForMarks(marks)` and `marksForGrade(target)` (reverse lookup) as pure functions.

New `app/web/src/monday/GradesTab.jsx`: full table with the 9.0 band (38–40) visually
highlighted ("three marks of headroom"); reverse lookup input; optional raw-mark
entry (`localStorage` only, never posted to the server); a simple visual of the 20–34
steepness (check `ReadinessTab.jsx` for the house convention on small in-app charts,
match it — no charting library).

`App.jsx`: `TITLES` (`:509`) add `grades:'Grades'`; `LAUNCH_VIEWS` (`:732`) add entry;
`renderTab` (`:1489`) add `case 'grades': return <GradesTab />;`; header button next
to Backlog/Readiness. **Not seeded into `defaultLayout()`.**

**Hard rule, verify by construction:** no new server route, no new MCP tool, nothing
under `tutor_data/`. `git diff --stat server/` must show zero changes after this step.

**Verify:** table matches §3.3 exactly cell-for-cell. Reverse lookup/mark entry
correct, `localStorage` round-trips. `npm run build` clean. **Commit.**

---

## Step 4 — settings expansion

**Hard — keep** for the audit (deciding what's worth exposing). **Mechanical —
delegate to main** for adding each confirmed-safe control once specced.

7 sections exist today: Voice, Model, Modes, Proactivity, Appearance, Study, Data.
"So much more control over everything" — audit `mergeConfig`/`DEFAULT_CONFIG`
(`server/session.js:260-287` and around) against what's actually reachable in
`SettingsPane.jsx`, and expose anything settable server-side that isn't yet in the
UI. Known candidate, confirmed from `.state.json`: `speech.prosody` has a
per-mood `{rate,pause}` object for all six moods — check whether `SettingsPane.jsx`'s
Voice section exposes only a single global rate/pause or the full per-mood matrix; if
only global, that's a real gap worth closing (per-mood prosody tuning is exactly the
kind of "more control" being asked for, and the data model already supports it).

**Verify:** every new control round-trips through `set_config` and persists to
`.state.json` correctly (confirm via the same merge-key-by-key logic already in
place — don't bypass it). `npm test` 353/353. `npm run build` clean. **Commit.**

---

## Step 5 (likely cut) — Swift native video panel

**Hard — keep.** Only worth doing if budget remains after 0–4 — it only improves the
experience inside `Monday.app`, and the web pane from Step 2 already degrades
correctly without it. Least verifiable step from here: no GUI session available to
launch the packaged app and watch a real logged-in YouTube session — verification is
necessarily manual, by the student, after the code is written (main can rebuild the bundle
via `zsh app/scripts/build-app.sh` and confirm it launches/connects, but not judge the
YouTube-chrome-removal behaviour).

Changes to `app/scripts/TMUATutor.swift` (194 lines, single `WKWebView` today):

1. **Second webview.** `videoWeb: WKWebView`, own `WKWebViewConfiguration` with
   `.websiteDataStore = .default()` (persists login across restarts) and, matching
   line 31 exactly, `mediaTypesRequiringUserActionForPlayback = []` on this config
   too. **Do not touch line 31 on the main webview's config.**
2. **Content blocking.** `WKContentRuleList` JSON (ad/tracker blocks +
   `css-display-none` for: home feed `ytd-browse[page-subtype="home"]`, sidebar
   `#related`/`ytd-watch-next-secondary-results-renderer`, comments `#comments`,
   Shorts `ytd-rich-shelf-renderer[is-shorts]`/`ytd-reel-shelf-renderer`, end-screens
   `.ytp-ce-element`/`.ytp-endscreen-content`). Compile via
   `WKContentRuleListStore.default().compileContentRuleList(...)`, add to
   `videoWeb.configuration.userContentController`. Plus a `WKUserScript` at
   `.atDocumentStart` injecting the same selectors as CSS, as a second layer.
3. **Its own navigation policy.** The existing `decidePolicyFor`
   (`TMUATutor.swift:107-118`) bounces all non-localhost navigation to Safari —
   correct for the main webview, wrong here. Both webviews can share the
   `AppDelegate` as `navigationDelegate` (the method receives the specific `WKWebView`
   as its first param) — branch: `if w === videoWeb { allow only youtube.com /
   googlevideo.com / ytimg.com / ggpht.com, cancel everything else; return }` before
   the existing logic.
4. **Rect messaging.** Register `WKScriptMessageHandler` named `"videoPane"` on the
   **main** webview's `userContentController` (the JS lives in the main page,
   `VideoTab.jsx` from Step 2). Implement `userContentController(_:didReceive:)`,
   parse `{action, rect, videoId, t}`:
   - `'show'`/`'rect'`: convert the web-page rect (top-left origin) to `NSRect`
     (bottom-left origin) against content-view bounds height, set `videoWeb.frame`,
     add as subview if not present, `isHidden = false`.
   - `'hide'`: `isHidden = true`.
   - `'load'`: navigate to `https://www.youtube.com/watch?v=\(videoId)&t=\(Int(t ?? 0))s`
     — the real logged-in site, not the embed player.

**Verify (manual, by the student):** login persists across restarts; feed/sidebar/comments/
Shorts/end-screens absent; a click can't navigate off YouTube; the panel tracks the
placeholder through resize and tab drag; hidden when its pane isn't active. If rect
tracking is janky, fall back to docking a fixed side region (the approved plan's own
fallback). **Commit** even if partial — content blocking without perfect rect-tracking
is still a real improvement.

---

## Step 6 (likely cut) — UI cohesion across all four surfaces

App, `tutor_data/dashboard.html`, `tutor_data/dashboard-site/` (public gitlink — **never
`git add` it**), and the Mac bundle. Given the budget and `App.jsx` at 1753 lines with
dozens of controls, a ground-up redesign is **not realistically safe** — the risk of
silently dropping a feature is the explicit worst case.

**Recommendation:** treat this as substantially addressed by building Steps 1–4
against the existing pane conventions (`app.css:140-145`: `.tab-fill` +
`.pane-toolbar` + `.pane-body`, existing tokens in `app/design/tokens.js`) rather than
as a separate pass — new panes read as part of the same system without touching
anything that already works.

**If and only if budget remains:** a **mechanical, delegate-to-main** pass — spacing/
button consistency audit against existing tokens across the four surfaces, zero
structural changes, zero removed controls. Not a redesign. If there isn't budget even
for this, skip it — it's cosmetic, not functional, and cosmetic is not what's owed
first.

---

## Verification summary

| Step | Automated | Manual (real evidence) |
|---|---|---|
| 0A sound | `npm test` | Boot greeting heard first try; mute toggle never desyncs; EXAM voice resumes correctly on exit |
| 0B verbosity | `npm test`, char-count before/after | Real DRILL exchanges visibly shorter, still correct |
| 0C personality | `npm test` | Live transcript across 3 moods reads as genuinely different registers; "Boss" never twice/message |
| 1.1 | `npm test`, `npm run build` | Non-A4 renders correctly; zoom/scroll persists across tab switch |
| 1.2 | — | Hand-posted mark renders correctly; `cat` the JSON |
| 1.3 | `npm test` | Draw→close→reopen persists; kill-mid-write leaves no partial file; no save dialog ever |
| 1.4 | `npm test` | Undo/redo matches file state at each step |
| 1.5 | — | Live session: all annotation/video tools called and observed working, no reload needed |
| 2 | `npm run build` | Live video plays+seeks in-browser; `show_video` opens/seeks; EXAM refuses |
| 3 | `git diff --stat server/` empty | Table matches §3.3 exactly; localStorage persists |
| 4 | `npm test` | New controls round-trip and persist correctly |
| 5 | — | Manual only, by the student, real packaged app |
| 6 | — | N/A if skipped, which is the expectation |

Never edit a test to make it pass. Never touch `tutor_data/memory/session_memory.json`,
`session_notes.md`, `backlog.json`, `activity_log.json`, or `git add tutor_data/dashboard-site`.
Commit messages: plain, authored solely by the user, no co-author trailer, ever.

---

## Delegation ledger (for whoever executes this plan)

Send to `main` via `SendMessage`, with the exact spec from the relevant step above
(not a paraphrase):
- Step 1.2's initial draw-loop scaffolding (Fable reviews before commit).
- Step 1.5's dropzone-copy grep-and-fix.
- Step 2's YouTube IFrame component boilerplate, once the postMessage contract is
  fixed.
- Step 3's `gradeTable.js` data entry and `GradesTab.jsx` layout.
- Step 4's mechanical control-exposure once each is individually specced.
- Every `npm test`/`npm run build` run and result report, across all steps.
- Every git commit (with the message Fable or the student supplies), status check, and the
  `Monday.app` rebuild/launch/connect check in Step 5.
- Step 6, entirely, if it happens at all.

Keep for Fable: the audio-chain diagnosis and its fix, the prompt dedup and rewrite
(0B/0C), the PDF annotation engine (1.1/1.3/1.4/1.5's logic), the video pane's state
wiring and postMessage contract design, the Swift panel's actual code, the settings
audit's judgement calls, and every "real evidence" verification that requires
interpreting behaviour rather than reading a pass/fail result.

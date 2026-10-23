# Server handoff — annotated papers, video, explicit ingest

Server side of `now-you-see-within-jazzy-penguin.md` (§1.1 traps 1–2, §1.3, §1.4, §1.5,
§1.6, §2.3, §3.2). Everything below is live on `main`. Nothing here touches `web/`,
`scripts/` or the Swift app.

---

## 1. What the frontend can now rely on

### Static serving (§1.1, traps 1–2)

- `.mjs`, `.wasm`, `.bcmap` and `.pfb` are in the MIME table (`index.js`). `.mjs` is
  served as `text/javascript`, so a pdf.js module worker will execute.
- **`/assets/*` returns a real 404**, and so does any path with a known asset extension
  (`.js .mjs .css .map .wasm .bcmap .pfb .png .jpg .jpeg .svg .ico .woff .woff2 .ttf
  .webmanifest`). Extensionless paths still fall through to `index.html`, so client-side
  routing is unaffected. A mis-pathed worker now fails as a 404 instead of as a parse
  error on the HTML shell.
- `web/public/cmaps/` and `web/public/standard_fonts/` will be served correctly if you
  copy them there — that part is yours.

### `GET /api/annotations?path=<abs pdf path>`

Returns the whole document:

```jsonc
{
  "schema_version": 1,
  "key": "tmua/2019/p1",
  "source_path": "/path/to/TMUA 2019 Paper 1.pdf",
  "updated_at": "2026-08-23T…",
  "page_sizes": { "7": [595.28, 841.89] },
  "pages": {
    "7": [
      { "id":"a1", "type":"ink",       "author":"student",  "color":"#1b6ef3", "width":1.6,
        "paths":[[x,y],…], "bbox":[x0,y0,x1,y1], "ts":… },
      { "id":"a2", "type":"highlight", "author":"student",  "color":"#ffd400",
        "quads":[[x0,y0,x1,y1],…], "text":"for all real x", "bbox":[…], "ts":… },
      { "id":"a3", "type":"arrow",     "author":"monday", "color":"#e0533d",
        "from":[x,y], "to":[x,y], "note":"the case you dropped", "bbox":[…], "ts":… },
      { "id":"a4", "type":"freetext",  "author":"student",  "text":"…", "at":[x,y], "bbox":[…], "ts":… }
    ]
  }
}
```

403 if the path is outside the project root. An absent or corrupt document reads back as
an empty one — never an error, never a 500.

### `POST /api/annotations`

```jsonc
{
  "path": "/abs/path/to.pdf",
  "pages": { "7": [ …marks… ] },
  "page_sizes": { "7": [595.28, 841.89] },   // optional but PLEASE send it
  "author": "student",                          // optional, default "student"
  "scope": "author"                           // optional, "author" (default) | "all"
}
```

Returns `{ ok, key, changed, marks }`.

**Five things the client must know:**

1. **Coordinates are PDF user space — points, origin bottom-left, y increasing
   UPWARDS.** Never send screen pixels. Convert with the pdf.js viewport
   (`viewport.convertToPdfPoint(x, y)`) before posting. This is the single thing that
   makes marks survive zoom, resize, DPR change and re-render, and it is the thing that
   lets Monday say "top third of the page" and be right.
2. **Send `page_sizes`** — `[width, height]` from `page.getViewport({scale:1})`. Without
   it, `read_annotations` describes regions against an assumed A4 and says so, which is
   honest but worse.
3. **`scope` defaults to `"author"`**, which merges: your POST replaces only the marks
   whose `author` matches and leaves everyone else's alone. That is deliberate — it means
   an 800 ms autosave cannot wipe a mark Monday drew thirty seconds earlier. Use
   `scope:"all"` only when the client genuinely is the whole truth for those pages.
4. **`sendBeacon` works.** The body is parsed regardless of `content-type`, so the
   `text/plain;charset=UTF-8` a beacon sends is accepted. Flush on unload without
   ceremony.
5. **It is idempotent and cheap.** An unchanged document is not rewritten (`changed:
   false` comes back). Re-posting on blur, page change, `visibilitychange` and unload
   costs one read and no write. Debounce for tidiness, not for safety.

`id` is optional on a posted mark — one is generated. Marks with no usable geometry are
dropped silently rather than stored as junk, so if a stroke vanishes, check you sent
`paths` / `quads` / `from`+`to` / `text` for its type.

### WebSocket events you will now receive

| event | when | payload |
|---|---|---|
| `annotations_changed` | Monday drew, cleared, or another client saved | `{ path, key, page?, author, added?, removed? }` |
| `show_video` | `show_video` tool | `{ videoId, t, note }` |
| `inbox_added` | anything lands in `tutor_data/inbox/` — **including PDFs now** | `{ path }` |
| `paper_progress` / `paper_done` | only during an explicit `add_paper` | unchanged shape |

`annotations_changed` is your cue to re-fetch that document and repaint. Monday's marks
are `author:"monday"` in `#e0533d`; the student's default to `#1b6ef3`.

### `show_video` contract (§2.3)

`{ type:'show_video', videoId, t, note }`. Mirror `openPdf`'s `{path, page, ts}` idiom —
add a `ts` nonce client-side so re-seeking the same timestamp re-fires. **Suppressed in
EXAM mode in the server**, so the pane will simply never be asked to open during a paper.

### Dropzone behaviour changed (§1.6)

`POST /api/paper` still accepts a dropped PDF and still puts it in `tutor_data/inbox/`,
but it now does **nothing else**: no identification, no filing, no manifest registration,
no classification. The response carries `filed: false` explicitly. Any UI copy that says
a dropped paper is "being processed" or "being classified" is now wrong — a drop just
lands. Papers get added when the student says a PDF is a paper and Monday calls `add_paper`;
anything else Monday files with `file_to_library`.

---

## 2. TOOL_VOICE captions

**Already done** — the captions for all seven new tools landed in
`web/src/monday/constants.js` and `npm test` is green at 261/261. Recorded here for the
five-file contract's sake; no action needed.

---

## 3. Tools, for anyone touching the contract

27 registered, up from 20. The list lives in **`server/toolnames.js`**, a leaf module.

> It was moved out of `session.js` because `prompt.js` states the count in the catalogue
> Monday reads about itself, and `session.js` imports `prompt.js`. Importing back the
> other way made a cycle that left `TOOL_COUNT` in the temporal dead zone whenever
> `session.js` was the entry point — `node server/index.js` failed outright. A leaf module
> has no cycle. **The stated count is computed from the list, never typed**, so it cannot
> go stale into a false fact Monday repeats about itself.

New: `read_annotations`, `annotate_pdf`, `clear_annotations`, `add_paper`,
`file_to_library`, `show_video`, `find_video`.

Adding one still means five places: `server/toolnames.js`, the tools array in
`session.js`, the `prompt.js` catalogue, `tests/helpers/assertions.mjs` (hand-written on
purpose — importing `toolnames.js` there would make the assertion tautological), and
`web/src/monday/constants.js`. `ACC-TOOL-01/02` now fail loudly if the first two drift.

---

## 4. Things worth knowing before you build on this

- **`tests/helpers/sandbox.mjs` now symlinks `app/design/`** into the sandbox. `mood.js`
  imports `../design/tokens.js`, and the sandbox copies `server/*.js` only. Any future
  server module that reaches into a sibling directory needs the same treatment or the
  whole suite goes red with `ERR_MODULE_NOT_FOUND`.
- **`tutor_data/reference/video_index.json`** holds 64 real videos from the R2Drew2 TMUA
  playlist — ids, titles and durations all read from the live playlist, none invented.
  **No timestamps are seeded**: none of those videos publishes chapter markers or a
  timestamped description, so no segment boundary could be verified. Every entry is
  therefore a whole-video entry, and the file says so in its own `provenance` field. Add
  real segments as videos get watched; the reader (`server/video.js`) already handles
  them.
- **Monday does not talk about grades any more** (§3.2). `MONDAY_BLOCK` now requires
  marks and accuracy in conversation. The readiness projection is untouched and still
  drives the `grave` mood and planning — only the commentary stopped. If the grades pane
  lands in the frontend, keep it exactly where the plan put it: a client-side constant,
  no endpoint, nothing under `tutor_data/`.
- **`tutor_data/library/<topic>/`** is a new tree, created on first use by
  `file_to_library`. Nothing reads it yet; a library pane would have something to show.

---

## 5. Verification

`npm test` — **261 tests, 261 passing** (baseline was 208). New:
`tests/unit/annotations.test.mjs` (20), `tests/integration/monday-tools.test.mjs` (19),
`tests/e2e/http-surface.test.mjs` (14). Criteria are tabulated in `tests/ACCEPTANCE.md`,
along with a `## Plan corrections` list of the five places the plan turned out to be wrong
once the code was open.

Not verified here, because it needs a live session and a built frontend: every tool
end-to-end against a real model, and annotation durability through an actual draw → close
tab → reopen cycle.

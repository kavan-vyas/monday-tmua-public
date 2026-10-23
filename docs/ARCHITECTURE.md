# Architecture

```
 Chrome (app window / PWA)                         Chrome (full-screen, /exam)
   React tiling workspace  ──WebSocket──┐            exam simulator
   web/src/App.jsx, monday/*            │            web/src/exam/*
                                        ▼                    │ HTTP /api/exam/*
                              Node server :3941  ◀───────────┘
                              server/index.js (HTTP + WS + file watcher)
               ┌──────────────┬────────┴─────────┬──────────────────┐
               ▼              ▼                  ▼                  ▼
      Agent SDK session   domain modules    poppler (pdftoppm)  Python TTS worker
      server/session.js   backlog, exam,    PDF → PNG cache     tts/monday_tts.py
      32 custom tools     board, readiness…                     (NDJSON over stdio)
               │              │
               └──────► tutor_data/ (JSON + Markdown, the only store) ◀── chokidar watch
```

- **No database.** Everything is a JSON/Markdown/JSONL file in `tutor_data/`. That keeps it git-diffable and
  hand-editable, and Claude can read it.
- **One process.** `node server/index.js` serves the built frontend from `web/dist`, the HTTP API and the WebSocket.
  It doesn't hot-reload. Restart it after any server change.
- **Claude** runs through `@anthropic-ai/claude-agent-sdk` and reuses the local Claude Code login. The tool
  guardrails: Read/Glob/Grep stay inside the project root, Write/Edit stay inside `tutor_data/`, and there's no Bash
  or web access.

## Request paths

| Path | Flow |
|---|---|
| Chat | WS message → `session.js` → SDK `query()` → streamed events → WS → chat pane; each event is also appended to `app/chats/<id>.json` |
| PDF view | Claude calls `show_pdf` → WS push → PDF pane; `get_pdf_page` rasterises one page and returns it to Claude as an image |
| Exam | `/exam` → `/api/exam/*` → `exam.js`; answers are kept in a file the sitting path never reads; telemetry goes to `sittings/<id>.events.jsonl` |
| Backlog | UI or tool → `backlog.js` (spaced repetition + pace gate) → `backlog.json` |
| Dashboard | `board.js` → `data/board.json` → static site in `tutor_data/dashboard-site` (GitHub Pages) |

## Server modules (`app/server/`)

| Module | Role |
|---|---|
| `index.js` | HTTP routes, WebSocket, chat store, file tree, chokidar watcher, inbox tracking, static serving |
| `session.js` | Agent SDK session, model/effort config, registers the custom tools, compaction + context events |
| `toolnames.js` | Canonical list of the 32 tool names (the prompt states the count it computes from this) |
| `prompt.js` | System prompt: master prompt v3 + environment override + persona |
| `papers.js` | **Paper registry.** The one place a paper's identity lives (see [PAPERS.md](PAPERS.md)) |
| `canonical.js` | One canonical question id (`JZ-A-P1-Q07`, `TMUA2023P1Q05` …) shared by every store |
| `exam.js` | Simulator: paper list, sitting lifecycle, telemetry, scoring, report |
| `examwindow.js` | Opens `/exam` in its own full-screen Chrome window |
| `examdate.js` | The exam date; the only writer of that field |
| `paperflow.js` | Guided per-question rework of a whole paper (QP → reveal MS + video → Y/M/N) |
| `backlog.js` | Spaced-repetition backlog, tiers, pace gate (`ENFORCE_PACE`), notifications |
| `backlogpaper.js` | Builds a sittable retry paper from open backlog items |
| `mutant.js` | Mutant papers: study documents built from the student record |
| `board.js` | "Clearance" model behind the published dashboard (improved %) |
| `dashboard.js` | Older dashboard derivation from `session_memory.json` |
| `readiness.js` | Per-topic readiness → projected score |
| `target.js` | The 8.5+ page: gap to target and the concrete tasks |
| `recommend.js` | Turns weak-topic analytics into drill recommendations |
| `tagindex.js` | Query layer over the MAT/TMUA/mock classification indexes |
| `pageindex.js`, `qpage.js` | Which page a question is on |
| `pdf.js` | `pdftoppm` rasterising + cache, `pdfinfo` page counts, PATH fix for Finder launches |
| `annotations.js` | Stores PDF-pane annotations |
| `ingest.js`, `triage.js`, `organise.js` | Drop-a-PDF intake: identify, file, register |
| `modes.js` | Session modes DRILL / EXAM / POSTMORTEM / TEACH / CONSOLIDATION / PAUSE and the gates on each |
| `scope.js` | Hard backstop: off-topic chat never reaches the tutor |
| `mood.js`, `mondaymem.js`, `proactive.js` | Monday's character: mood each turn, Monday's own memory, raising things unprompted |
| `voice.js` | TTS worker lifecycle, queue, cache index (silent in EXAM) |
| `video.js` | Video index reader (R2Drew2 walkthroughs etc.) |
| `calendar.js` | Read-only Google Calendar via iCal |
| `paths.js` | Project paths + path guards |

## Tutor tools (32)

PDF `show_pdf get_pdf_page find_in_pdf read_annotations annotate_pdf clear_annotations` ·
backlog `add_backlog list_backlog relabel_backlog remove_backlog complete_backlog read_backlog_notes write_backlog_note` ·
index `query_tag_index question_profile drill_set index_stats` ·
intake `audit_paper triage_pdf add_paper file_to_library` ·
media `show_video find_video` · time `get_schedule start_timer` ·
exams `exam_sittings sitting_report log_activity` ·
Monday `journal_note monday_recall monday_note monday_self`

## Frontend (`app/web/src/`)

- `App.jsx`: tiling workspace (tab groups in resizable columns, drag to split, persisted layout), chat, header.
- `monday/`: tabs and widgets: PaperFlow, Grades, Readiness, Target, Video, PDF annotator (pdf.js), orb, status
  line, settings.
- `exam/`: the simulator (takeover by pathname in `main.jsx`, its own stylesheet, with no house tokens leaking in).
- `design/tokens.js` → `npm run tokens` renders the design tokens into `tokens.css` and other surfaces.

## Other subsystems

- `app/tts/`: Kokoro-82M, offline. LaTeX → spoken English, mood prosody. See its README.
- `app/video/`: Manim scenes narrated in Monday's voice; `render.sh` builds a 1080p30 mp4.
- `Monday.app` / `scripts/TMUATutor.swift`: native launcher (`scripts/build-app.sh`).

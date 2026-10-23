# Monday — the TMUA tutor app

> Project docs live in [`../docs/`](../docs/): architecture, data, exam simulator, papers, scripts,
> operations and history. This file is the workspace UI tour. Some details below are from the July build;
> where they disagree, `docs/` is current.

Local web app replacing the Claude Desktop + filesystem-MCP tutor setup.
Node backend embeds the Claude Agent SDK (uses your Claude Code login); React
frontend is a brutalist, Obsidian-style tiling workspace: tab groups in
resizable columns (default four: FILES | TUTOR | NOTES | PDF).

## Run

Easiest: open **`Monday.app`** (project root) — starts the server if needed
and opens a standalone Chrome window. Drag it to the Dock or /Applications to
pin it (first launch of an unsigned app may need right-click → Open). The site
is also an installable PWA: in a normal Chrome tab use ⋮ → Install "Monday";
in Safari use File → Add to Dock.

Alternatives:

```bash
cd ~/claude-workspace/tmua_proj/app
npm run server        # then open http://localhost:3941
```

or double-click `Start Monday.command`.

After changing frontend code: `npm run build` then restart the server.
Frontend dev mode with hot reload: `npm run dev:web` (proxies to the server, which must also be running).
Icons/manifest are generated files: `node scripts/make-icons.mjs` regenerates `web/public/`.

## Workspace UI

- **Tabs**: drag a tab onto another group's tab bar to stack it there; drag onto
  the left/right 25% of a pane to split a new column (yellow snap preview shows
  where it lands). × closes a tab, ▁ collapses a column to a strip (click to
  expand). Drag the gap between columns to resize. Layout persists; RESET LAYOUT
  restores the default.
- **Header**: CHATS ▾ (chat archive — switch, delete, ✚ new), pane reopen buttons
  (FILES / TUTOR / NOTES / PDF), DASH, RESET LAYOUT, ◐ theme toggle, CTX gauge
  (context-window fill %), running cost.
- **Editing**: any .md/.json/.txt tab has VIEW/EDIT toggle; Cmd+S or SAVE writes
  to disk (server allows text-file saves anywhere in the project).

## How it works

- **Chat pane** — talks to the tutor (master prompt v3 + app override in `server/prompt.js`).
  Quick buttons: START/END SESSION, INBOX (badge shows unseen screenshot count;
  sends Claude the exact new file paths — free no-op message when empty),
  ✉ EMAIL (drafts a mailto: from the latest session report in session_notes.md).
  Model + effort dropdowns (default SONNET / HIGH) switch mid-conversation —
  the session resumes with the new settings on the next message.
  Chat renders full markdown + LaTeX (`$…$`, `$$…$$`, and `\(…\)` / `\[…\]`).
  Paste or drop screenshots straight into the input. ■ STOP interrupts a turn.
- **Chats** — every conversation is stored exactly, event-for-event, in
  `app/chats/<id>.json`. New/switch/delete from CHATS ▾; switching restores the
  full transcript and resumes the underlying SDK session.
- **Auto-compact** — the Claude Code engine compacts the conversation
  automatically as context fills; a chip in the chat marks each compaction and
  the header CTX badge shows live context usage after every turn.
- **PDF pane** — Claude calls `show_pdf(path, page)` to display question/solution
  pages (rendered via poppler `pdftoppm`, cached). Claude reads pages itself with
  `get_pdf_page` — no manual uploads, ever. Arrows page through; "Preview ↗" opens
  the real file.
- **Workspace pane** — live-rendered markdown (KaTeX + tables). Watches
  `tutor_data/` via chokidar; updates the moment Claude writes notes/homework.
- **File tree** — browse `major exams/` + `tutor_data/`. PDFs open in the PDF pane,
  .md/.json in the workspace, .html (dashboard) in a new tab. Bottom dropzone
  saves screenshots to `tutor_data/inbox/`.
- **Floating timer** — tiny draggable ⏱ widget, parks anywhere (position saved),
  follows the theme. Click it for 5/10/15-minute or custom timers; Claude's
  `start_timer(minutes, label)` shows there too (amber < 30s, pulsing red on expiry).
- **Persistence** — active chat id + model/effort config in `.state.json`; each
  chat in `app/chats/`. Everything survives server restarts.

## Guardrails

- Claude tools: Read/Glob/Grep limited to the project root; Write/Edit limited to
  `tutor_data/`; Bash/web access disabled.
- All HTTP file endpoints validate paths against the project root.

## Files

```
server/index.js       HTTP + WebSocket + chat store + file tree + watcher + inbox tracking
server/session.js     Agent SDK session, model/effort config, custom tools
                      (show_pdf, get_pdf_page, start_timer), compact + context events
server/prompt.js      Environment override + master prompt loader
server/pdf.js         pdftoppm rasterizing + caching, pdfinfo page counts
server/paths.js       Project paths + path-guard helpers
scripts/make-icons.mjs  Regenerates favicon/PWA icons/manifest into web/public/
web/                  Vite + React frontend (4-pane UI)
chats/                One JSON per conversation (exact event log + resume id)
.state.json           Active chat id, model/effort, inbox-seen list
../Monday.app         Double-clickable launcher (server + Chrome app window)
```

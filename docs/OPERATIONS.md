# Operations

## Setup from a fresh clone

```bash
git clone https://github.com/kavan-vyas/monday-tmua-public.git monday
cd monday/app
npm install
npm run build
npm run server                      # http://localhost:3941
brew install poppler                # pdftoppm / pdfinfo
npm run voice:setup                 # optional: Python venv for TTS (app/tts/.venv)
```

Not in git, so it gets regenerated: `node_modules/`, `web/dist/`, `tts/.venv/`, `tts/voices/*.pt`, `.voicecache/`,
`tutor_data/.backups/`, `*.bak-*`.

## Daily commands

| Task | Command |
|---|---|
| Start | `Monday.app`, `Start Monday.command`, or `npm run server` |
| Frontend dev (hot reload) | `npm run dev:web` (with the server also running) |
| After a frontend change | `npm run build`, then restart the server |
| After a server change | restart the server (no hot reload) |
| Tests | `npm test` · `npm run test:py` (TTS). Suites that need a paper collection skip without one |
| Publish dashboard | `npm run publish` |
| Voice broken? | `npm run voice:doctor` |

## Backups and restore

- Bulk writers (`session.js`, `ingest.js`, `examdate.js`, merge scripts) take a snapshot first into
  `tutor_data/.backups/` or `*.bak-*`.
- Commit your data, not only code: git is the real backup.
- Restore `app/.state.json` only while the server is stopped.

## Known gotchas

- A running server serves stale code after an edit, so restart it.
- Launched from Finder, the process `PATH` is minimal. `pdf.js` adds the Homebrew paths for poppler.
- pygame can't decode `.m4a`. Convert alert sounds to wav/ogg.
- The exam window is a real full-screen Chrome window. Use headless Chrome when testing.
- `String.replace` with a string replacement corrupts TeX (`$$` → `$`).
- A test sitting flips Monday's mode. Reset it afterwards.
- Build the launcher with `app/scripts/build-app.sh` (the compiled binary isn't committed).

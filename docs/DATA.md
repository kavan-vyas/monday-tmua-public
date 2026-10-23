# Data (`tutor_data/`)

Everything is a plain file. The public repo ships an empty skeleton: templates for the record, and the tag
indexes (tags only — no question text, descriptions or answer keys). The **source of truth** for each fact is listed below. Everything else is derived and can
be rebuilt.

## Sources of truth

| Fact | File |
|---|---|
| Every attempt logged (paper, question, right/wrong, time, bucket) | `activity_log.json` |
| Student record: shaky topics, misconceptions, notes per question | `memory/session_memory.json` |
| Spaced-repetition backlog (tier, due date, history, notes) | `backlog.json`, `backlog_takeaways.json` |
| Simulator sittings (state + every event) | `exams/sittings/<id>.json` + `<id>.events.jsonl` |
| Paper-flow reworks | `paperflow/<paperId>.json` |
| Session reports | `session_notes.md` |
| Monday's own memory/journal | `monday/memory.json`, `monday/journal.md`, `monday/self_model.md` |
| Exam date, config | `memory/session_memory.json`, `app/.state.json` (created on first run) |
| PDF annotations | `annotations/` |
| Chat transcripts | `app/chats/<id>.json` (exact event log + SDK resume id) |

## Paper facts

| Fact | File |
|---|---|
| Identity, PDFs, timing | `app/server/papers.js` (registry) |
| Folder per collection | `file_manifest.json` |
| Answer keys | `exams/answers/<paperId>.json` |
| Transcribed questions (sittable papers) | `exams/questions/<paperId>.json` |
| Transcription sources | `exams/source/{djs,euclid,official}/*.txt` → `scripts/build-djs.mjs` |
| Figures | `exams/figures/<paperId>_q<nn>.png` (`*.full.png` = whole page before crop) |
| Question → page | `exams/pageindex/<paperId>.json` |
| Classification shards | `exams/classification/<paperId>.json`, `reference/shards/` |
| Merged indexes | `reference/tmua_full_tag_index.json` (official, 400), `reference/mock_tag_index.json` (mocks, 1000), `reference/mat_full_tag_index.json` |
| Tag vocabulary | `reference/TAGGING_SPEC.md` |
| Videos | `reference/video_index.json`, `reference/video_search_cache.json` |

## Canonical question ids

All stores key questions through `app/server/canonical.js`. Examples:

```
TMUA2023P1Q05     official
JZ-A-P1-Q07       JZ mock
JC-25-P1-Q03      James Chen (also resolves the old "JAM test"/"quicktmua" names)
DJS-A0-P2-Q11     Daniel J Smith
EUC-SAMPLE-P1-Q13 Euclid sample
```

Never parse ids by hand. Use `canonical.js` and `papers.js`.

## Generated artefacts (rebuildable)

| Folder | Built by |
|---|---|
| `dashboard-site/` (optional, own git repo → GitHub Pages) | `npm run publish` |
| `mutant/`, `backlog-papers/` | `scripts/mutant-paper.mjs`, `backlog-paper.mjs`, `review-paper.mjs` |
| `analytics.json`, `dashboard.html` | dashboard derivation |

## Other folders

- `inbox/`: screenshot drop folder. The server tracks unseen files.
- `library/`: filed reference PDFs.
- `homework/`, `prompts/`: tutor-written homework and the prompt sources (`TMUA_Master_Prompt_v3.txt`).
- `*.bak-*`, `.backups/`: local safety copies taken before bulk writes. Ignored by git. Older `.bak-*` files that
  were already committed stay in history.

## Rules that held

- The app never reads spreadsheets. Anything pasted from an external tracker is written into `activity_log.json` /
  `session_memory.json` in the same session.
- Every wrong answer needs a backlog item or it can never be cleared on the board.

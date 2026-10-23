# Scripts (`app/scripts/`)

Run from `app/`. Most take a paper id or slug. Read the header comment of each script for its flags.

## Paper pipeline

| Script | Does |
|---|---|
| `ingest.mjs` (`npm run ingest`) | Reproducible paper ingest: audit → file → register |
| `build-djs.mjs <id>` | Transcription `.txt` → simulator questions/answers (DJS, Euclid samples, official) |
| `check-djs-tex.mjs` | Renders every maths island through KaTeX strict mode |
| `djs-figures.sh`, `crop-figures.mjs` | Full-page renders → cropped figures |
| `proof-sheet.mjs` | Each transcribed question side by side with its PDF page |
| `build-page-index.mjs` (`npm run pageindex`) | Question → page for every registry paper |
| `extract-official-answers.mjs` (`npm run answers:official`) | Official answer keys → `exams/answers/` |
| `validate-classification.mjs`, `merge-mock-classification.mjs` | Check shards against the vocabulary, then merge into `mock_tag_index.json` |
| `classify-djs.mjs`, `classify-official.mjs` | Compact classification → shard / official index |

## Study documents (LaTeX → PDF)

| Script | Output |
|---|---|
| `mutant-paper.mjs` (`npm run mutant`) | Mutant paper: misconceptions, rules and the questions ([MUTANT_PAPERS.md](../MUTANT_PAPERS.md)) |
| `backlog-paper.mjs` (`npm run backlog:paper`) | Sittable retry paper of open backlog items + MS |
| `review-paper.mjs build <slug>` | Explicit selection, each question followed by its answer → `major exams/tmua/review paper/` |
| `export-marked-paper.mjs` | A paper with the student's annotations burned into the pages |

## App / infra

| Script | Does |
|---|---|
| `publish-dashboard.mjs` (`npm run publish`) | Rebuild + push the Clearance dashboard to GitHub Pages |
| `build-tokens.mjs` (`npm run tokens`, runs on prebuild) | Design tokens → CSS |
| `make-icons.mjs` (`npm run icons`) | Icons + PWA manifest, with no dependencies |
| `build-app.sh`, `TMUATutor.swift` | Rebuild the native `Monday.app` |
| `launch-chrome-fallback.sh` | Launcher fallback: start the server, then open the Chrome app window |

## Voice and video

`npm run voice:setup | voice:doctor | voice:build | voice:test | voice:clean` (see `app/tts/README.md`).
Videos: `app/video/render.sh <scene>` renders Manim scenes at 1080p30, narrates them in Monday's voice
(`narrate.py`/`narrate_qwen.py`) and normalises loudness. Bring your own scenes.

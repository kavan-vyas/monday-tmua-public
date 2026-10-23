# Monday — a local AI tutor for the TMUA

Monday is a self-hosted prep system for the **TMUA** (Test of Mathematics for University Admission). It also covers
MAT and STEP. It's a local web app: an AI tutor running on the Claude Agent SDK inside a tiling workspace. Around the
tutor sit a computer-based exam simulator, a spaced-repetition backlog, analytics, a maths-aware voice, and a
pipeline that turns your own mistakes into study documents.

> Built for one student's exam season, then cleaned up for release. No personal data and no exam papers are included.

## Features

- **Tutor chat.** Claude with 32 custom tools. It reads question pages itself (it never invents questions), marks
  against mark schemes, logs every attempt and runs session modes (drill, exam, post-mortem, teach).
- **PDF pane.** pdf.js rendering, annotation (pen, highlighter, arrows, notes) and page rasterising on demand.
- **Exam simulator** (`/exam`). Full-screen, timed or untimed, with flag/review/navigator, colour schemes and
  per-click telemetry. It ends on an analysis report and feeds wrong answers straight into the backlog.
- **Backlog.** Spaced repetition (1 → 7 → 21 days) with a pace gate: correct-but-slow doesn't count as cleared.
- **Analytics.** Readiness per topic, a projected score, the gap to your target, and a publishable "Clearance"
  dashboard.
- **Built papers.** Mutant papers, backlog retry papers and review papers, made with LaTeX from your own record.
- **Voice.** Offline Kokoro TTS that reads LaTeX properly ("x squared minus one, over x minus two").
- **Tag indexes.** Topic, technique, trap and difficulty tags for 400 official TMUA, 180 MAT and 1000 mock questions.
  Tags only, no question text.

## Quick start

```bash
cd app
npm install
npm run build
npm run server         # http://localhost:3941
npm test
```

Requirements: macOS (Linux mostly works), Node ≥ 20, poppler (`pdftoppm`, `pdfinfo`), Google Chrome and a Claude
Code login, which the Agent SDK reuses. Optional: Python 3.11 + ffmpeg for voice (`npm run voice:setup`), LaTeX for
built papers, Manim for videos.

Then:
1. Put your name and target in `tutor_data/TMUA_Master_Prompt_v3.txt`.
2. Get papers from their publishers and file them under `major exams/`. See [docs/PAPERS.md](docs/PAPERS.md).
3. Transcribe any you want to sit in the simulator.

## Documentation

| Doc | Covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, every server module, the tutor's tools, the frontend |
| [docs/DATA.md](docs/DATA.md) | `tutor_data/` layout, sources of truth, canonical ids |
| [docs/EXAM-SIMULATOR.md](docs/EXAM-SIMULATOR.md) | `/exam`: flow, data, telemetry, side effects |
| [docs/PAPERS.md](docs/PAPERS.md) | Paper registry, adding a paper end to end |
| [docs/SCRIPTS.md](docs/SCRIPTS.md) | Build scripts and what they produce |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Setup, daily commands, backups, gotchas |
| [docs/HISTORY.md](docs/HISTORY.md) | How it was built, decisions, lessons |
| [app/README.md](app/README.md) | Workspace UI tour |
| [app/tts/README.md](app/tts/README.md) | The maths-aware TTS |
| [MUTANT_PAPERS.md](MUTANT_PAPERS.md) | Building mutant and backlog papers |
| [app/tests/ACCEPTANCE.md](app/tests/ACCEPTANCE.md) | Acceptance criteria the tests encode |

## Layout

```
app/          server/ (Node + Agent SDK), web/ (React + Vite), tts/, video/, scripts/, tests/
tutor_data/   empty record templates, tag indexes, prompts
docs/         documentation
tools/        legacy pdf-opener MCP (Claude Desktop era)
Monday.app    launcher bundle; build its binary with app/scripts/build-app.sh
```

## Not included

- **Exam papers, transcriptions and answer keys.** They're copyrighted by their publishers and authors.
- **Any study record**: chats, attempts, sittings, notes, scores.

TMUA, MAT and STEP are owned by their respective bodies. This project isn't affiliated with or endorsed by any exam
board or test-delivery provider.

## License

See [LICENSE](LICENSE).

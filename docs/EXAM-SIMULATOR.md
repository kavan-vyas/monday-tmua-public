# Exam simulator (`/exam`)

A computer-based test driver for sitting TMUA-style papers under exam conditions. Not affiliated with any test provider.

## Opening

Header **Exam** button → `POST /api/exam/open` → `examwindow.js` opens a dedicated **full-screen Chrome window**.
Always open it this way.

## Fidelity

- Chrome is styled by an original stylesheet, `web/public/sim/sim.css`. Colour schemes swap its tokens through
  `<html data-scheme>`.
- Maths is rendered by MathJax 4 + STIX2, served locally at `/vendor/`.
- `main.jsx` picks the exam stylesheet by pathname, so no house design token reaches this route.

## Flow

prestart → fullscreen → Welcome/NDA → overview (1-min clock) → Paper 1 intro → items → Review → End Review ×2 →
5-min interval → Paper 2 → final → `/exam/report` (house-styled analysis).

The clock holds at 0:00 instead of ending the sitting. A `time_expired` event is logged and he submits manually. The
report lists any answers selected after expiry.

## Data

| What | Where |
|---|---|
| Questions | `tutor_data/exams/questions/<paperId>.json` |
| Answers | `tutor_data/exams/answers/<paperId>.json`. The sitting path never opens this file, so the key never reaches the browser mid-exam |
| Sitting | `tutor_data/exams/sittings/<id>.json` |
| Telemetry | `<id>.events.jsonl`, append-only: selections, re-selections, dwell, revisits, flags, navigator opens, blur/idle, every click |

## Routes

`/api/exam/papers · sitting · answer · events · pause · resume · finish · results · sittings · figure · explain · open`

## On finish

1. Writes an activity row (`activity_log.json`).
2. Opens tier-1 backlog items for every wrong or flagged question, with real `seconds`.
3. Broadcasts `exam_finished`. Monday reads sittings with the `exam_sittings` / `sitting_report` tools.

## Side effects to know

Starting a sitting flips Monday into **EXAM** mode (voice silent, nothing escapes but a post-mortem request), and
finishing flips it to **POSTMORTEM**. The server holds `.state.json` in memory, so
restore that file only while the server is **stopped**, otherwise it gets overwritten on shutdown.

## Sittable papers

Any registry row whose questions and answers exist in `tutor_data/exams/`. The public repo ships none: transcribe
your own (see [PAPERS.md](PAPERS.md)). Papers without transcriptions are listed as "not transcribed yet".

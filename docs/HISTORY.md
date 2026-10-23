# History

How Monday was built over one exam season (2026).

## Timeline

| Stage | What |
|---|---|
| 1. Desktop tutor | Claude Desktop + filesystem MCP + an AppleScript PDF opener (`tools/pdf-opener`). A master prompt and JSON record. Uploading whole PDFs each session cost 60–180k tokens. |
| 2. Web app | Rebuilt as a local app on the Claude Agent SDK: chat, a PDF pane with on-demand page rasterising (~1–1.5k tokens per page), live notes, file tree, screenshot inbox. Then a tiling tab layout, chat archive, model/effort switching, auto-compact and a timer. |
| 3. Monday | Four parallel agents (`plangamma.md`) gave the tutor a character: maths-aware local voice (Kokoro), its own memory, mood, session modes, proactive nudges, a design-token system and a full UI redesign. An acceptance suite was written from the plan. |
| 4. Papers | PDF annotation (pdf.js), drop-a-PDF triage and ingest, the paper registry and canonical ids, a classification vocabulary and per-question tag indexes. |
| 5. Practice loop | Spaced-repetition backlog with a pace gate, the exam simulator with full telemetry, guided paper rework ("paper flow"), the Clearance dashboard, readiness and target pages, mutant/backlog/review papers. |
| 6. Polish | Simulator fidelity (review screen, navigator, colour schemes, clock rules), Manim videos narrated in Monday's voice. |

## Decisions that held up

- **Files, not a database.** Every store is diffable, hand-fixable and readable by Claude.
- **One registry, one canonical id.** Most data bugs came from ids parsed in several places. Centralising them in
  `papers.js` and `canonical.js` ended that class of bug.
- **Claude reads the page, never its memory.** It never generates or recalls question text; it rasterises the page.
- **Answers are physically separate from sittings**, so the key can't reach the browser mid-exam.
- **Tests encode the plan.** `app/tests/ACCEPTANCE.md` maps every criterion to a test.

## Lessons

- A long-running server hides code changes. Restart it after every edit.
- Commit data, not only code. Git is what recovers a folder that vanishes.
- Self-reported labels drift. Cross-check them against the question content.
- "Slipped" gets overused. Many slips are conceptual traps.
- Pace matters as much as accuracy. Correct-but-slow reworks stay on the backlog.

## Planning documents

- `plangamma.md`: the four-agent Monday build.
- `PLAN_FABLE.md`: a budget-capped completion plan.
- `app/server/HANDOFF_SERVER.md`: server handoff for annotations, video and explicit ingest.
- `MUTANT_PAPERS.md`: how built papers are made.

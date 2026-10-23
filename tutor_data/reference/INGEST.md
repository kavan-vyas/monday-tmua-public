# Adding a paper

## Just drop it in

Drag the PDF onto the app — the file panel's dropzone, or straight into the chat box —
and everything else happens by itself:

1. **Identified.** Filename first. If the name says nothing (`scan_0421.pdf`, `download
   (3).pdf`), it reads the paper itself and works out what it is.
2. **Filed.** Moved to where the collection keeps that paper and renamed to match —
   `major exams/tmua/2023/TMUA 2023 Paper 1.pdf`. Already have it? The dropped copy is
   discarded rather than duplicated.
3. **Registered** in `file_manifest.json`.
4. **Classified** — every question tagged and merged into the index.
5. **Announced** — the tutor is told it is ready and offers to start it.

A status bar bottom-left shows progress the whole way, because classification takes a few
minutes. Drop a pile at once: they queue and process one at a time. You can also copy PDFs
into `tutor_data/inbox/` in Finder — same pipeline.

Companion files (solutions, mark schemes, answer keys) can be dropped too, in any order.
They get filed next to their paper and picked up automatically when it is ingested.

## Or from the terminal

```
cd app
npm run ingest -- "/path/to/TMUA 2023 Paper 1.pdf"
```

The terminal route expects the file to be named conventionally; the drop route does not,
because it will read the paper to identify it.

## The four resources a paper needs

| resource | what it gives you | built by |
|---|---|---|
| `file_manifest.json` entry | the tutor can find the paths at all | ingest, deterministic |
| solutions/answer-key pairing | marking from a mark scheme instead of guessing | ingest, deterministic |
| a usable read path | `find_in_pdf` works, or "rasterise every page" is recorded | ingest, deterministic |
| classification shard + merged index | `query_tag_index`, `drill_set`, `question_profile` see its questions | Agent SDK, same spec as the original build |

## Commands

```
npm run ingest -- "<paper.pdf>"               audit → register → classify → merge
npm run ingest -- "<paper.pdf>" --audit       audit only, writes nothing
npm run ingest -- "<paper.pdf>" --dry-run     show what would change
npm run ingest -- "<paper.pdf>" --no-classify register only, classify later
npm run ingest -- "<paper.pdf>" --force       re-classify even if the shard is complete
npm run ingest -- --all "major exams"         audit the whole collection
```

Everything is safe to re-run. The audit never writes. Manifest registration only fills
blanks and backs up the manifest first. Classification refuses to overwrite a complete
shard unless you pass `--force`.

In a tutoring session you can also ask the tutor to `audit_paper` — it reports the same
audit and hands back the command above. It cannot run the command itself: classification
takes minutes, far longer than a tool call, and it has no Bash.

## What "reproducible" means here

Classification is not improvised per paper. It runs the same
[`TAGGING_SPEC.md`](TAGGING_SPEC.md) the original 540-question build used — same
controlled vocabulary, same id conventions, same difficulty rubric, same batch-of-5
checkpointing — and the shard is then merged and validated by `merge_shards.py` exactly
like every other shard. A paper ingested next year is tagged the same way as one
ingested today, so `drill_set` can link across them.

## What it handles, and what it does not

- **MAT** years and both specimens; **TMUA** years, practice and specimen, Paper 1 and 2.
- **STEP is not supported for classification.** The index schema is MAT/TMUA specific —
  20-question MCQ papers and MAT's Q1 A-J. STEP's long-form questions do not fit it. The
  audit says so plainly rather than pretending. Manifest registration and the PDF tools
  still work for STEP, so the tutor can present STEP questions; they just are not tagged.
- A paper with no solutions and no answer key is still classified, tagged
  `inferred_no_solution`, and the audit warns that the tutor cannot mark it from a mark
  scheme.
- A corrupt text layer (TMUA Practice P1/P2 are the known cases) is detected up front;
  the classifier is told to rasterise every page and read images instead. Slower, still
  accurate — but `find_in_pdf` stays unreliable for that paper, and the audit says so.

## How a randomly-named file gets identified

Deterministic filename parsing runs first and is free. Only when it leaves something
unknown — no exam, no year, no paper number — does the intake read the paper: the first
page of text, or a rasterised first page when the text layer is unusable, handed to Haiku
with a strict JSON-only reply. Verified: a copy of TMUA 2019 Paper 2 renamed
`scan_0421.pdf` came back as TMUA / 2019 / Paper 2 at 0.98 confidence and filed itself
correctly.

If it still cannot tell, it says so and leaves the file alone rather than filing it
somewhere wrong.

## Identification is filename-first, deliberately

Kind (paper / solutions / answer key / answer sheet / report / reference) is decided by
the **filename only**, never the page text. Every TMUA paper's cover reads "Additional
materials: Answer sheet" and TMUA 2016's cover mentions "practice" — consulting page text
reclassified real papers as their own companions and collided two papers onto one unit.
Both bugs were caught by sweeping the existing 36 papers and checking the mapping was
1:1. If you name a file unconventionally, the audit will show it: wrong question count,
missing companions, or "cannot place this paper".

## Verifying the whole collection

```
npm run ingest -- --all "major exams"
```

Reports every question paper as fully resourced, needing work, or unsupported. As of
2026-08-07: 36 MAT/TMUA papers fully resourced, 0 needing work, STEP skipped.

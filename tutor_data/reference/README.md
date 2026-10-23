# MAT/TMUA full classification index

Built 2026-08-06/07 from `tutor_data/prompts/classification_prompt.md`.

## Files

| file | what it is |
|---|---|
| `mat_full_tag_index.json` | 180 questions — MAT Question 1 parts A-J, 2007-2022 + both specimens |
| `tmua_full_tag_index.json` | 360 questions — TMUA Papers 1 and 2, 2016-2022 + practice + specimen |
| `TAGGING_SPEC.md` | the controlled vocabulary and rules every tagging run followed |
| `merge_shards.py` | validates the shards, normalises tags, computes cross_links, writes both indexes |
| `shards/` | one JSON per paper (or per 3 MAT years) — the raw per-unit output |
| `mock_tag_index.json` | 580 questions — the unofficial mocks, kept OUT of the two indexes above |

Rebuild both indexes from the shards at any time:

```
python3 tutor_data/reference/merge_shards.py          # writes both indexes
python3 tutor_data/reference/merge_shards.py --strict # non-zero exit if anything fails validation
```

`merge_shards.py` parses its vocabulary out of `TAGGING_SPEC.md` at run time, so the spec
is the single source of truth — editing the spec changes what validates.

## Where a question is on the page

`tutor_data/exams/pageindex/<paper_id>.json` records the page each question starts on, for
the question paper and for the mark scheme, for all 47 papers — the 29 in the registry and
the 18 official ones. `/api/question-page` reads it, so "open paper" lands on the question
instead of searching the PDF and guessing.

```
node app/scripts/build-page-index.mjs            # every paper
node app/scripts/build-page-index.mjs her_s1_p1  # one
node app/scripts/build-page-index.mjs --report   # coverage, writing nothing
```

Four sources, in order of authority: a hand transcription, the answer key's solution pages
(mark schemes), the paper's own numbering read off the text layer, and OCR of the left
margin for the papers whose text layer is glyph soup (TMUA 2016, 2017 Paper 1 and the
practice set). The
`source` field in each file records which was used. Re-run it after adding a paper.

## The mock index

`mock_tag_index.json` is a third index for unofficial mock papers. It is deliberately
separate: mixing mocks into the official indexes would corrupt every coverage and accuracy
figure computed from them.

| family | papers | questions |
|---|---|---|
| `EUC_P1` / `EUC_P2` | TMUA Euclid sets 1-4 + the R2Drew edition | 180 |
| `TYLER_P1` / `TYLER_P2` | Tyler Tutoring sets A-D | 160 |
| `HER_P1` / `HER_P2` | Heracles sets 1-3 | 120 |
| `JC_P1` / `JC_P2` | James Chen 2025 + 2026 customs | 80 |
| `ROSIE_P1` | Rosie set alpha paper 1 | 20 |
| `AF_P1` | Asher Falcon paper 1 | 20 |

Built from per-paper shards in `tutor_data/exams/classification/`, on the same
spec-is-the-source rule as the official indexes:

```
node app/scripts/validate-classification.mjs        # every shard against TAGGING_SPEC.md
node app/scripts/merge-mock-classification.mjs      # rebuild only the families that merged
```

Two fields exist only here. `off_spec` marks a question outside the TMUA content
specification — Rosie's set has four, Chen's papers eleven between them. `jz_tags` /
`jz_difficulty` carry JZ's own labels verbatim beside ours.

**Difficulty follows one rule per paper, never a classifier's mood.** Where the author
rates their own questions — JZ scores every question 5-9 out of 10 — the shard must NOT set
difficulty and the merge computes it as `round(rating / 2)` clamped to 1-5, keeping the raw
number in `jz_difficulty` so the mapping stays checkable. Where the author publishes no
rating at all (James Chen), the classifier assigns difficulty from TAGGING_SPEC's structural
rubric and the validator insists on a 1-5 integer — the same regime as Tyler, who publishes
no rating either. `app/server/papers.js` — the paper
registry — is what says which regime a paper is in, so neither rule can be applied to the
wrong paper.

Pipeline (note: `merge_shards.py` is NOT involved and still rejects any family outside
MAT/TMUA):

```
tutor_data/exams/classification/<paper_id>.json     one shard per paper
node app/scripts/validate-classification.mjs        vocabulary + registry checks
node app/scripts/merge-mock-classification.mjs      rebuilds the families that have shards
```

The merge replaces exactly the families whose shards ran and leaves the rest alone, so
re-classifying one paper cannot duplicate or disturb another.

## How it was produced

Every question was read from the actual paper PDF and its official worked solution, via
`pdftotext -layout`. Pages were rasterised with `pdftoppm` and read as images wherever the
text layer was unusable — the whole of TMUA Practice Papers 1 and 2 (corrupt font encoding),
and individual figure-dependent pages elsewhere. Work was split across per-paper agents, each
writing its own shard incrementally; the merge step is what turns 25 shards into 2 indexes.

## Three deviations from the original prompt, and why

1. **MAT trap tags are not sourced from examiner's reports.** The prompt assumed the MAT
   reports in `file_manifest.json` carry question-level commentary. They do not — they are
   2-3 page admissions-statistics documents (application counts, offer rates, a score
   histogram). Grepping 2010/2014/2018/2021/2022 for question-level or facility data returns
   nothing. MAT traps are therefore inferred from distractor structure: for each wrong option,
   what single plausible slip produces it. TMUA worked solutions *do* discuss wrong options
   explicitly, and those traps are real data.

2. **Difficulty is structural, not facility-calibrated.** No facility statistics exist for
   either exam in this collection, so `TAGGING_SPEC.md` defines a fixed 1-5 rubric plus a
   positional prior, applied identically by every run. Treat difficulty as a consistent
   ordering, not a measured student success rate.

3. **TMUA 2022 has no worked solutions.** Both 2022 papers were solved from scratch and each
   answer checked against the official answer key; all 40 agreed. They carry
   `verification_status: "answer_key_only"` — technique and trap tags there reflect our own
   solution, not an official one.

## Vocabulary drift control

Agents could propose new tags in a `new_tags` block. Genuinely new ideas were promoted into
`TAGGING_SPEC.md` (12 techniques, 2 traps added). Near-duplicate coinages for the same idea
are collapsed by `ALIASES` in `merge_shards.py` — e.g. `term_by_term_power_rule` →
`power_rule_differentiation`. Both indexes currently validate with zero off-vocabulary tags.

## Cross-links

`cross_links` is computed globally at merge time, never by the per-paper runs: two questions
link when they share at least one technique **and** at least one trap, ranked by overlap
(traps weighted double), capped at 6 per question. 176/180 MAT and 352/360 TMUA questions
have at least one link. These are the "same method, same way to get it wrong" clusters to
build targeted drill sets from.

## Not touched by this build

`mat_q1_tag_index.json`, `file_manifest.json`, `dashboard-site/data/*`, and the live tutor
record. This is a reference build, separate from session state.

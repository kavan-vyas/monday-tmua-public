# Built papers — how to make one

Two kinds of document get built out of the student's own record. They share the selection rules and
the delivery rules; they differ in what they are for.

| | what it is | he sits it? |
|---|---|---|
| **Mutant paper** | the analysis: misconceptions, rules, the exam test, plus the questions as printed | no — he reads it |
| **Backlog paper** | a whole paper of questions he got wrong and has not re-earned, plus its mark scheme | yes — cold, timed |

---

# Mutant papers

A **mutant paper** is a study document built out of the student's own record: the questions of one
kind that have actually cost him marks, with the rule he was missing and what to do about it
in the exam. Three exist — logic, graph shapes, counting — and when he asks for another
("you know the drill, mutant papers"), this is the drill.

**Every mutant paper is TWO PDFs that ship together.**

| | what it is | who writes it |
|---|---|---|
| `<Name> Misconceptions.pdf` | the analysis: his result, the question, the rule, the exam test | written by hand |
| `<Name> Questions (as printed).pdf` | the same questions, one per page, unmarked, to sit cold | generated |

Both go to **`~/Downloads`** *and* **`major exams/tmua/mutant papers/`**. The `.tex` source of
the analysis goes to the collection too. One without the other is not delivered.

---

## The rules that must never break

**1. Only papers he has actually sat.** Every question printed is a spoiler for the paper it
came from, and an unsat paper is a future mock he loses. The first logic set was thrown out
and rebuilt from scratch for exactly this — *"assume I have done NO james chen papers, redo
everything"*. `candidates()` derives the sat set from the ledger (a paper counts as sat when
it has all twenty rows) and cannot return anything else. Do not hand-edit around it.

**2. Never state an answer you have not checked.** Official answers come from
`tutor_data/exams/answers/tmua_<year>_p<n>.json`, extracted from the published keys. Mock
answers come from each collection's own mark scheme. Where a paper ships **no** mark scheme
(Rosie, Asher Falcon, Euclid R2Drew), work the answer out and **show the working in the
document** so he can check it.

**3. His words lead.** The sentence that makes these documents worth reading is his own note
saying what he did wrong. Quote it. The brief puts every note in front of you; if a question
has no note attached, it is a weaker entry than one that does.

**4. Wrong first.** Order the document by what it cost him: wrong, then still-open-in-backlog,
then shaky, then right-but-he-wrote-a-method-down. Questions he got right with no comment
belong in a mutant paper only as contrast.

**5. `\test` is an action.** "Be careful" is not a test. "Write $\binom{n}{r}a^{n-r}b^r$ as a
template before substituting", "check the formula at $n=1$", "build the table of sums first" —
something his hand does.

---

## The process

### 1. Gather the evidence

```
cd app
node scripts/mutant-paper.mjs brief <slug> \
    --topic combinatorics \
    --technique counting_by_cases,complement_counting,binomial_expansion \
    --trap double_counting
```

Filters are index fields (`topic`, `technique`, `trap_type`) and any match counts. Vocabulary
is in `tutor_data/reference/TAGGING_SPEC.md`. Cast wider than the topic name — a counting
question tagged `probability` is still a counting question, which is why `--technique` exists.

This writes `tutor_data/mutant/<slug>/`:

- **`brief.md`** — the candidate table and, per question, his note, the backlog entry, the
  index tags, the answer, and the page of the PDF it is on. **This is what you read.**
- `brief.json` — the same, machine-readable
- `questions.json` — the companion's page list, pre-filled with every candidate
- `paper.tex` — a copy of `app/templates/mutant-paper.tex` to write into

### 2. Read the papers

The brief gives page numbers. Read the actual questions and the actual mark schemes —
`pdftotext -layout -f <page> -l <page> "<pdf>" -`, and render the page to an image where the
text layer is glyph soup (several TMUA papers are). **Do not write about a question from its
index description.** The description is a label, not the question.

### 3. Write the analysis

Edit `tutor_data/mutant/<slug>/paper.tex`. Structure, in order:

1. **Title block** — how many questions, and *which papers they come from*, named.
2. **The "why this set exists" box** — the honest headline number and the pattern behind it.
   This is the paragraph that makes him read the rest. If the topic percentage flatters him,
   say so and say why.
3. **One section per idea**, not per question — two questions that fail the same way share a
   section. Each uses `\bit` `\eg` `\rulez` working `\ans` `\test`.
4. **The checklist**, always last, always `\newpage`, one line per rule in the order he'd use
   them.
5. **The provenance footer** — where the answers came from, where his results came from.

Voice: second person, flat, specific. No encouragement, no hedging. If his own diagnosis of a
miss is wrong ("silly mistake" for something that is a method gap), say that plainly.

### 4. Trim the companion

Edit `questions.json` down to the questions the analysis actually uses, in the order the
analysis uses them. Two fields matter:

- `crop: null` — the whole page, correct when the paper prints one question per page
- `crop: [0.03, 0.385]` — a vertical slice as a fraction of page height, for a paper that
  prints several. Render it and **look at it**: the crop must not clip the last option and
  must not leak the next question's first line.

Set `output_name` if the file should not be called `TMUA <title>`.

### 5. Build and place

```
node scripts/mutant-paper.mjs build <slug>
```

Compiles the analysis, renders and compiles the companion, copies both PDFs to `~/Downloads`
and to `major exams/tmua/mutant papers/`, and copies the `.tex` to the collection.

### 6. Check before you say it is done

- Render a page of each PDF and **look at it**. `\ans` inside a display, `\test` running on
  from the previous sentence, and overfull boxes all survive a clean compile.
- `build` treats a non-zero `pdflatex` exit as a failure, which it is. The first three of these
  documents were built while pdflatex was reporting `Command \box already defined` and carrying
  on anyway — the environment was named after a TeX primitive. It is `keybox` now. If the build
  stops, read `tutor_data/mutant/<slug>/paper.log`; do not work around it.
- Companion page count = questions + 1 (title page).
- `grep Overfull` the LaTeX log.
- Every paper named in the title block is in `satPapers()`.

---

## Where things live

| | |
|---|---|
| `app/server/mutant.js` | selection, page rendering, placement |
| `app/scripts/mutant-paper.mjs` | the `brief` / `build` CLI |
| `app/templates/mutant-paper.tex` | the shared preamble and the four commands |
| `app/scripts/extract-official-answers.mjs` | official keys → `tutor_data/exams/answers/` |
| `tutor_data/mutant/<slug>/` | working directory, one per paper |
| `major exams/tmua/mutant papers/` | the finished set, with sources |
| `app/tests/unit/mutant.test.mjs` | the rules above, enforced |

## The set so far

| paper | questions | built from |
|---|---|---|
| Logic Misconceptions | 24 | 2017 P2, 2018 P2, Tyler SA P2, Tyler SD P2 |
| Graph Shapes | 18 | 2016 P1, 2017 P2, 2018 P1/P2, Tyler A and D, Heracles 1 and 2 |
| Counting Misconceptions | 12 | 2017 P1/P2, 2020 P2, Heracles 1 and 2, Chen 2025 P1, Rosie, Asher Falcon |


---

# Backlog papers

He names topics and question types; this assembles **a whole paper** of them out of the open
backlog — questions he has already got wrong and not yet re-earned — and its mark scheme.
It exists to be **sat**, not read.

```
cd app
node scripts/backlog-paper.mjs build <slug> \
    --logic --include-exam MAT --size 20 --seed 20260921 \
    --title "TMUA Backlog Paper — Logic and MAT"
```

| flag | |
|---|---|
| `--topic` `--type` `--technique` `--trap` | index fields, comma-separated, any match counts |
| `--logic` | shorthand for the whole logic family: the topic, the four logic question types, the quantifier/contrapositive/truth-table techniques, and the necessary-vs-sufficient traps |
| `--include-exam MAT` | pull in **every** open item for that exam whether or not it matches |
| `--size` | a **floor**, not a cap (see below) |
| `--seed` | the shuffle seed; the same seed rebuilds the same paper |
| `--title` | the filename and the cover |

Output, to `~/Downloads` **and** `major exams/tmua/backlog paper/`:

- `<Title>.pdf` — cover, then one question per page
- `<Title> Answers.pdf` — cover, a table of where each question came from and why it is in
  the backlog, then one solution per page

## The rules

**1. `--size` is a floor.** Filters matching fewer than `size` are topped up from the rest of
the backlog by priority — most overdue, never reworked, `didnt_know` before `slipped`, harder
before easier. He asked for a whole paper; a half-empty one is not one. Filters matching more
produce a longer paper, because "everything to do with logic" means everything.

**2. Scattered, never sorted.** `shuffle()` mixes sources and topics from the seed. Grouping by
topic tells him what each question is before he reads it, which is the help the real exam
withholds — and on a logic paper, knowing a question is a logic one is most of the work.

**3. The mark scheme is the real pages.** Each solution is the published page for that
question, cropped to it. Only where a paper publishes none (Rosie, Asher Falcon, Euclid
R2Drew) is an answer written by hand, and the page says so in a box so he knows which he is
reading.

**4. Hand-written answers live in `written/`.** `tutor_data/backlog-papers/<slug>/written/<ref>.tex`,
one file per question, LaTeX fragments. They survive a rebuild — without that they would have
to be rewritten every time, which is how they would end up not being written at all. A missing
one prints a visible "not written yet" marker rather than a blank page.

**5. Not every question owns a page.** MAT puts two or three parts of Question 1 on a page,
Rosie prints three, and Tyler's mark scheme is handwritten over the question paper.
`sliceFor()` finds a question's vertical span from the PDF's own text layout — its label to
the next label — so a crop is derived rather than guessed. It cuts **above** the next
question: padding downwards leaks the next question's first line, which is both untidy and a
small spoiler.

**6. MAT is addressable, but only just.** MAT has no page index, so the part is found by
scanning for its own label. Three label styles exist across the years — papers write `A.`,
most solutions write `A:`, and 2021 writes a bare `A` — and matching only the first is why
every MAT mark-scheme page initially came back empty.

## Where things live

| | |
|---|---|
| `app/server/backlogpaper.js` | pool, filter, priority, shuffle, page slicing |
| `app/scripts/backlog-paper.mjs` | the `build` CLI |
| `tutor_data/backlog-papers/<slug>/` | working directory: images, sources, `written/`, `manifest.json` |
| `major exams/tmua/backlog paper/` | the finished papers |

## Built so far

| paper | questions | filter |
|---|---|---|
| Logic and MAT | 38 | `--logic --include-exam MAT` — 22 matched, 16 MAT pulled in |

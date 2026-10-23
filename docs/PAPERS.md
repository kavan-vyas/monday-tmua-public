# Papers

**No papers are included.** They're copyrighted by their publishers. Get official papers from the test provider's
website and mocks from their authors, then file them as below. `tutor_data/file_manifest.json` lists the expected paths.

## The registry

`app/server/papers.js` is the single source of truth for a paper's identity: id, title, family, id/canonical prefixes,
PDF paths, default timing (`standard`/`long`) and how its difficulty is set:

- `source`: the author rates questions (JZ: `round(rating / 2)`)
- `shard`: the classifier sets it

Nothing outside `papers.js` parses a paper id. The setup screen groups papers by `collection`. The shard validator and
the merge script read the same rows.

## Collections

| Collection | Ids | Transcribed (private build) | Key |
|---|---|---|---|
| Official TMUA 2016–2023 | `TMUA<y>P<n>Q<nn>` (index 400) | 2019, 2023 | official (2023 read off worked solutions) |
| TMUA 2025 (recalled) | not in the registry | no | AI-written, uncertain Qs flagged |
| JZ Maths A–E | `jz_<s>_p<n>` | yes (200) | MS |
| James Chen 2025/2026 | `jc_25_p1` … `jc_26_p2` | yes | solutions at back of the QP |
| Tyler A–D | `tyler_<s>_p<n>` | no | MS |
| Daniel J Smith A/A0/B/C/α | `djs_*` | yes | worked out where none was given |
| Euclid sets 1–4, R2Drew, samples | `euc_*` | samples only | samples: AI-written MS |
| Heracles 1–3, Rosie, Asher Falcon, Zach | classified | no | mixed |
| MAT, STEP | `major exams/mat`, `step` | n/a | n/a |

## Adding a paper end to end

1. File the PDFs: `major exams/tmua/<author>/set-<x>/<Author> Set <X> Paper <n> QP.pdf` (+ `MS.pdf`).
2. Add one registry row in `papers.js` and a branch in `canonical.js` if the id shape is new.
3. Add a `file_manifest.json` key for the collection.
4. Answers: `tutor_data/exams/answers/<id>.json`.
5. Page index: `npm run pageindex`.
6. Classify: write a shard → `npm run classify:validate` → `npm run classify:merge`.
7. Optionally make it sittable: transcribe it to `exams/source/<family>/<id>.txt` → `node scripts/build-djs.mjs <id>`
   → `node scripts/check-djs-tex.mjs` → crop figures (`djs-figures.sh`, `crop-figures.mjs`) →
   `node scripts/proof-sheet.mjs` to check the transcription against the page.
8. Run `npm test` (contracts, filetree, classification and exam tests cover the registry), then restart the server.

Gotcha: never use a *string* replacement in `String.replace` on TeX, because `$$` collapses to `$`. Use a function
replacement.

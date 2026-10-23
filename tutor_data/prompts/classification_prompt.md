# TASK: Build a full multi-category classification index for every MAT and TMUA question

## Context
Project root: <project root>/
Existing reference: tutor_data/mat_q1_tag_index.json — MAT Q1 only, ONE topic per part, no other metadata.
Paper/solution paths: tutor_data/file_manifest.json (MAT 2007-2022, MAT specimen x2, TMUA 2016-2022, TMUA practice, TMUA specimen).

Do NOT modify mat_q1_tag_index.json or file_manifest.json. Output new files (see "Output" below).

## Goal
Go through EVERY question in EVERY paper in file_manifest.json — MAT Q1 parts A-J (all years),
MAT specimen papers, and every TMUA Paper 1 + Paper 2 question (2016-2022 + practice + specimen)
— and produce a rich, multi-tag classification per question. Multiple tags per category are
allowed and expected where a question genuinely spans them. This replaces the current
single-topic-only tagging with something the tutor app and dashboard can actually filter,
diagnose, and drill on.

## Method
For each paper: open paper PDF and its solutions/mark scheme PDF. Read every question and its
official solution (do not classify from memory — read the actual page). Extract:
- exact topic(s) tested
- the technique(s) the official solution uses
- the type of reasoning demanded
- the likely trap(s) a strong-but-imperfect student falls into (cross-reference examiner's
  report where one exists in file_manifest — MAT has these for most years)

Work paper by paper, write incrementally (don't hold the whole run in memory), and checkpoint
output after each paper in case of interruption.

## Categories to tag (all multi-select except difficulty and verification_status)

1. **topic** (1+) — primary content area(s). Use exactly these keys, extend only if truly
   needed and document the addition: algebra, calculus, integration, trigonometry, logarithms,
   geometry, coordinate_geometry, graph_sketching, sequences_and_series, number_theory,
   functions, combinatorics, probability, logic_and_proof (TMUA Paper 2 needs this one, MAT
   rarely does).

2. **technique** (1+) — the specific method(s) the solution actually uses, e.g.
   completing_the_square, discriminant_condition, substitution, differentiation_from_first_principles,
   implicit_differentiation, integration_by_parts, integration_by_substitution, telescoping_series,
   binomial_expansion, modular_arithmetic, proof_by_contradiction, proof_by_induction,
   counterexample_construction, case_split, symmetry_argument, pigeonhole, optimisation_via_calculus,
   optimisation_via_AM-GM_or_inequality, graph_transformation, area_between_curves,
   simultaneous_equations, inequality_manipulation, log_law_manipulation, trig_identity_application,
   vector_or_coordinate_argument. Add new technique tags as needed — keep them specific and reusable
   across questions, not one-off descriptions.

3. **question_type** (1) — mcq_direct_calculation | mcq_eliminate_options | proof | disprove_or_counterexample
   | sufficiency_or_necessity | logical_deduction | graph_interpretation | modelling.

4. **cognitive_skill** (1+) — the underlying reasoning skill(s) independent of topic, e.g.
   algebraic_manipulation, case_analysis, spatial_visualisation, pattern_recognition,
   careful_reading_of_constraints, working_backwards_from_options, estimation_and_sanity_check,
   symbolic_bookkeeping, multi_step_chaining.

5. **trap_type** (0+) — the specific wrong turn(s) a student plausibly takes, sourced from the
   examiner's report where available, otherwise inferred from the structure of the question, e.g.
   sign_error, missed_case, domain_or_range_restriction_missed, boundary_term_dropped,
   misread_question, premature_termination_before_final_step, wrong_formula_recalled,
   extraneous_root_not_rejected, bounds_of_integration_wrong, division_by_zero_or_unsigned_variable,
   over-restrictive_case_assumption.

6. **difficulty** (1) — integer 1-5, calibrated against MAT/TMUA examiner's report facility data
   where available, otherwise estimated from structural complexity (number of steps, how hidden
   the key insight is).

7. **paper_section** (1, TMUA only) — P1_applications | P1_pure | P2_logic_and_proof. Omit for MAT.

8. **exam_family** (1) — MAT | TMUA_P1 | TMUA_P2.

9. **verification_status** (1) — mark_scheme_read (you opened and read the actual solution) |
   answer_key_only (2022 TMUA — no worked solution exists, answer only) | inferred_no_solution.
   Never mark mark_scheme_read unless you actually read that page this run.

10. **cross_links** (0+) — ids of other questions in this same index that test essentially the
    same technique+trap combination, so the tutor can group them for a targeted drill set later.

## Output
One JSON file per exam family, at:
  tutor_data/reference/mat_full_tag_index.json
  tutor_data/reference/tmua_full_tag_index.json

Schema per question:
```json
{
  "id": "MAT2016H",
  "paper": "MAT", "year": 2016, "part": "H",
  "topic": ["calculus", "integration"],
  "technique": ["area_between_curves", "inequality_manipulation"],
  "question_type": "mcq_eliminate_options",
  "cognitive_skill": ["algebraic_manipulation", "estimation_and_sanity_check"],
  "trap_type": ["bounds_of_integration_wrong"],
  "difficulty": 4,
  "paper_section": null,
  "exam_family": "MAT",
  "verification_status": "mark_scheme_read",
  "cross_links": ["MAT2013H"],
  "description": "one-line plain description of what's actually being tested"
}
```
Top-level: `{"generated": "<date>", "questions": [ ... ]}`.

## Rules
- Never fabricate a tag for a question you haven't actually read this run — read paper +
  solutions page for every single item before tagging it.
- Where MAT has an examiner's report (file_manifest → mat.<year>.report), read it and use its
  language for trap_type — this is real data on where students actually go wrong, better than
  guessing.
- TMUA 2022 has no worked solutions (file_manifest gap) — tag verification_status:
  "answer_key_only", technique/trap_type inferred only, flag difficulty as your best estimate.
- Keep tag vocabulary CONSISTENT — before inventing a new technique/trap/skill tag, check if an
  existing one already covers it. Keep a running vocabulary list at the top of each output file's
  generation log so tags don't fragment into near-duplicates.
- Do not touch tutor_data/dashboard-site/data/* or session_memory.json — this is a reference
  build only, separate from the live tutor record.
- Progress checkpoint after each paper (write file incrementally) so a crash doesn't lose the run.

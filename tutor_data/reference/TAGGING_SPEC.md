# TAGGING SPEC — MAT/TMUA full classification index

You are tagging one unit (one paper, or a small batch of MAT years). Read the actual
question text and the actual official solution for EVERY item before tagging it.
Never tag from memory. Never invent a question.

## How to read the PDFs

Text layer is clean on all of these papers (LaTeX-produced). Use:

    pdftotext -layout -f <first> -l <last> "<path>" -

Read the paper PDF for the question wording and options, and the solutions PDF for the
official method. If a question depends on a figure/graph that the text layer cannot
convey (you see stray glyph soup, a missing diagram, or the question says "as shown
below" and you cannot tell what is shown), rasterize just that page and look at it:

    pdftoppm -r 130 -png -f <page> -l <page> "<path>" <SCRATCH>/pg

then Read the produced PNG. Do this only when needed.

## Output

Write ONE JSON file to the shard path you were given. Nothing else. No prose in the file.

```json
{
  "unit": "<unit id you were given>",
  "generated": "2026-08-06",
  "new_tags": [ {"category": "technique", "tag": "some_new_tag", "why": "one line"} ],
  "questions": [ { ...schema below... } ]
}
```

`new_tags` may be empty. Only add a new tag when NO existing vocabulary entry fits;
keep it snake_case, specific, and reusable across questions — never a one-off
description of a single question.

## Per-question schema (all fields required, exact key order not important)

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
  "cross_links": [],
  "description": "one-line plain description of what is actually being tested"
}
```

- `cross_links` — ALWAYS write `[]`. Cross-linking is computed globally after merge.
- `paper_section` — MAT: `null`. TMUA P1: `P1_pure` or `P1_applications`. TMUA P2:
  `P2_logic_and_proof`.
- `exam_family` — `MAT` | `TMUA_P1` | `TMUA_P2`.
- `part` — MAT: the letter `A`..`J`. TMUA: the question number as a string, `"1"`..`"20"`.
- `year` — integer year, or `null` for specimen/practice units.
- `paper` — `MAT`, `MAT_specimen`, `TMUA_P1`, `TMUA_P2`.
- `verification_status` — `mark_scheme_read` only if you actually read the worked
  solution for that item in this run. `answer_key_only` if only a letter answer exists
  (TMUA 2022). `inferred_no_solution` if neither.
- `description` — plain English, no LaTeX, ≤ 25 words, says what is tested not what the
  answer is.

## Controlled vocabulary

### topic (1+)
algebra, calculus, integration, trigonometry, logarithms, geometry, coordinate_geometry,
graph_sketching, sequences_and_series, number_theory, functions, combinatorics,
probability, logic_and_proof

### question_type (exactly 1)
mcq_direct_calculation, mcq_eliminate_options, proof, disprove_or_counterexample,
sufficiency_or_necessity, logical_deduction, graph_interpretation, modelling

Guidance: `mcq_direct_calculation` = you compute the answer then find it in the list.
`mcq_eliminate_options` = the intended route is testing/ruling out the options.
TMUA P2 items about "which statement follows" → `logical_deduction`;
about necessary/sufficient conditions → `sufficiency_or_necessity`;
"which is a valid proof / where does this proof fail" → `proof`;
"which is a counterexample" → `disprove_or_counterexample`.

### technique (1+)
completing_the_square, discriminant_condition, substitution, differentiation_from_first_principles,
implicit_differentiation, integration_by_parts, integration_by_substitution, telescoping_series,
binomial_expansion, modular_arithmetic, proof_by_contradiction, proof_by_induction,
counterexample_construction, case_split, symmetry_argument, optimisation_via_calculus,
optimisation_via_AM-GM_or_inequality, graph_transformation, area_between_curves,
simultaneous_equations, inequality_manipulation, log_law_manipulation, trig_identity_application,
vector_or_coordinate_argument, factor_or_remainder_theorem, polynomial_root_relations,
geometric_series_sum, arithmetic_series_sum, recurrence_unrolling, pythagoras_or_trig_in_triangle,
circle_equation_manipulation, tangent_or_normal_line, stationary_point_analysis,
definite_integral_evaluation, counting_by_cases, complement_counting, parity_argument,
divisibility_argument, bounding_or_extreme_value_argument, quantifier_negation,
converse_or_contrapositive_analysis, truth_table_or_exhaustive_check, substitution_of_test_values,
sketching_to_count_intersections, absolute_value_case_analysis, exponential_law_manipulation,
change_of_base, transformation_of_summation_index, pigeonhole, power_rule_differentiation,
trapezium_rule_error_analysis, surd_rationalisation, particular_solution_from_initial_condition,
monotonicity_argument, prime_factorisation, leading_term_analysis, intermediate_value_argument,
convexity_argument, trapezium_rule_approximation, similar_triangle_scale_factor,
orthographic_view_reconstruction

### cognitive_skill (1+)
algebraic_manipulation, case_analysis, spatial_visualisation, pattern_recognition,
careful_reading_of_constraints, working_backwards_from_options, estimation_and_sanity_check,
symbolic_bookkeeping, multi_step_chaining, logical_precision, abstraction_from_specific_to_general,
numerical_fluency

### trap_type (0+)
sign_error, missed_case, domain_or_range_restriction_missed, boundary_term_dropped,
misread_question, premature_termination_before_final_step, wrong_formula_recalled,
extraneous_root_not_rejected, bounds_of_integration_wrong, division_by_zero_or_unsigned_variable,
over-restrictive_case_assumption, strict_vs_non_strict_inequality_confusion,
off_by_one_in_index_or_count, converse_assumed_from_implication,
necessary_confused_with_sufficient, quantifier_order_confused, plausible_distractor_from_partial_work,
units_or_scale_error, endpoint_or_edge_case_ignored, assumed_integer_or_positive_without_warrant,
double_counting, symmetry_wrongly_assumed, inequality_direction_reversal_ignored,
irreducibility_confused_with_primality

Sourcing traps: TMUA worked solutions often say explicitly why particular options are
wrong — use that, it is real data. MAT solutions rarely do, so infer traps from the
distractor options: for each wrong option, ask what single plausible slip produces it,
and tag that slip. 0-3 traps per question. Do not pad.

### difficulty (exactly 1, integer 1-5)
No facility statistics exist for these papers, so calibrate structurally, identically
across all units:

- 1 — one step, direct recall or substitution; a competent A-level student answers in <1 min.
- 2 — 2-3 routine steps, standard technique, nothing hidden.
- 3 — 3-5 steps, or one modest insight (spot the identity, split into cases), or an easy
  method made fiddly by bookkeeping.
- 4 — needs a non-obvious insight, or careful multi-case analysis, or chains two distinct
  topics; a strong student can still slip.
- 5 — heavy insight plus a long chain, or a subtle logical trap that fools most strong
  students.

Positional prior (start here, then adjust on the actual solution's length and how hidden
the key idea is): MAT Q1 A-C → 2, D-G → 3, H-J → 4. TMUA Q1-5 → 2, Q6-14 → 3, Q15-20 → 4.
A 1 or a 5 should be rare and earned.

## Hard rules

- Every item in the unit must appear exactly once. MAT Q1 = parts A-J (10 items).
  TMUA = questions 1-20 (20 items). If the paper genuinely has fewer, say so in the
  shard's `unit` note field and still emit what exists.
- MAT: tag Question 1 parts A-J ONLY. Ignore MAT long questions 2-7 entirely.
- Never mark `mark_scheme_read` for an item whose solution you did not read this run.
- Do not modify any file other than your own shard file.
- Emit valid JSON (no trailing commas, no comments, no markdown fence in the file).

// ACC-CLASS-01..07 — the JZ classification pipeline.
//
// The risk here is not that a classifier picks a debatable technique; it is that the
// pipeline silently accepts something it should not — a value outside the controlled
// vocabulary, a difficulty invented by whoever happened to classify that paper, or an
// answer that disagrees with the mark scheme. Every criterion below is a gate that
// actually fired during the build.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { vocabulary, validateShard } from '../../scripts/validate-classification.mjs';
import { difficultyFromJz } from '../../scripts/merge-mock-classification.mjs';
import { paperRow, questionId } from '../../server/papers.js';

const question = (over = {}) => ({
  id: 'JZ_SA_P1_Q01', ref: 'JZ SA P1 Q01',
  exam: 'TMUA', exam_family: 'JZ_P1', set: 'A', paper: 1, qnum: 1,
  paper_section: 'P1_pure',
  topic: ['algebra'],
  question_type: 'mcq_direct_calculation',
  technique: ['completing_the_square'],
  cognitive_skill: ['algebraic_manipulation'],
  trap_type: ['sign_error'],
  description: 'completing the square to find a minimum value',
  correct_answer: 'C',
  options_count: 6,
  jz_tags: ['General Algebra'],
  jz_difficulty: 5.5,
  verification_status: 'mark_scheme_read',
  cross_links: [],
  ...over,
});

/**
 * A shard for any registry paper. The header and every question id are derived from the
 * row, because the validator now checks them against the registry: a fixture that spells
 * its own ids can only ever test one paper, and the rules being tested here differ by
 * paper (a JZ shard must not set difficulty; a Chen shard must).
 */
const shardFor = (paperId, over = {}, qOver = {}) => {
  const row = paperRow(paperId);
  const carries = row.difficulty === 'source'
    ? { jz_tags: ['General Algebra'], jz_difficulty: 5.5 }
    : { jz_tags: null, jz_difficulty: null, difficulty: 3 };
  return {
    schema_version: 1,
    paper_id: row.id,
    set: row.set,
    paper: row.paper,
    questions: Array.from({ length: 20 }, (_, i) => question({
      id: questionId(row, i + 1),
      ref: `${row.title} Q${String(i + 1).padStart(2, '0')}`,
      qnum: i + 1,
      exam_family: row.family,
      set: row.set,
      paper: row.paper,
      paper_section: row.paper === 2 ? 'P2_logic_and_proof' : 'P1_pure',
      ...carries,
      ...(i === 0 ? qOver : {}),
    })),
    ...over,
  };
};

const shard = (over = {}, qOver = {}) => shardFor('tyler_a_p1', over, qOver);

describe('classification — the controlled vocabulary', () => {
  test('ACC-CLASS-01 the whole vocabulary parses out of TAGGING_SPEC, not just its first line', () => {
    // This is a regression guard with teeth: the section regex originally used /m, so `$`
    // matched every line ending and each list stopped after one line. Two thirds of the
    // vocabulary then read as invalid, which would have rejected correct classifications.
    const v = vocabulary();
    assert.equal(v.topic.size, 14);
    assert.equal(v.question_type.size, 8);
    assert.ok(v.technique.size >= 60, `technique list looks truncated: ${v.technique.size}`);
    assert.equal(v.cognitive_skill.size, 12);
    assert.equal(v.trap_type.size, 24);
    // Values that sit on a wrapped line, i.e. exactly what the bug ate.
    assert.ok(v.topic.has('logic_and_proof'));
    assert.ok(v.technique.has('orthographic_view_reconstruction'));
    assert.ok(v.trap_type.has('irreducibility_confused_with_primality'));
  });

  test('ACC-CLASS-02 a clean shard validates', () => {
    assert.deepEqual(validateShard(shard()), []);
  });

  test('ACC-CLASS-03 an invented vocabulary value is rejected', () => {
    for (const [field, bad] of [
      ['topic', 'mechanics'],
      ['technique', 'vibes_based_estimation'],
      ['cognitive_skill', 'intuition'],
      ['trap_type', 'silly_mistake'],
    ]) {
      const errs = validateShard(shard({}, { [field]: [bad] }));
      assert.ok(errs.some((e) => e.includes(bad)), `${field}="${bad}" should have been rejected`);
    }
    assert.ok(validateShard(shard({}, { question_type: 'vibes' })).some((e) => e.includes('vibes')));
  });

  test('ACC-CLASS-05 descriptions stay short and free of LaTeX', () => {
    assert.ok(validateShard(shard({}, { description: 'x '.repeat(30).trim() })).some((e) => /over 25 words/.test(e)));
    assert.ok(validateShard(shard({}, { description: 'find $x^2$ given the constraint' })).some((e) => /LaTeX/.test(e)));
  });

  test('ACC-CLASS-06 a classification that disagrees with the paper or the key is rejected', () => {
    const answers = { questions: [{ qnum: 1, answer: 'C', jz_difficulty: 5.5 }] };
    const questions = { questions: [{ qnum: 1, options: [1, 2, 3, 4, 5, 6] }] };
    assert.deepEqual(validateShard(shard(), { questions, answers }), []);
    assert.ok(validateShard(shard({}, { correct_answer: 'D' }), { questions, answers })
      .some((e) => /disagrees with the mark scheme/.test(e)));
    assert.ok(validateShard(shard({}, { options_count: 4 }), { questions, answers })
      .some((e) => /options_count/.test(e)));
    // Paper 2 has exactly one legal section.
    assert.ok(validateShard(shardFor('tyler_a_p2', {}, { paper_section: 'P1_pure' }))
      .some((e) => /P2_logic_and_proof/.test(e)));
  });

  test('ACC-CLASS-08 a shard must name a paper the registry knows', () => {
    const errs = validateShard(shard({ paper_id: 'jz_z_p9' }));
    assert.ok(errs.some((e) => /papers registry/.test(e)), errs.join('; '));
  });

  test('ACC-CLASS-09 difficulty is required, and must be 1-5', () => {
    // No author in the registry publishes a rating, so the classifier must supply a 1-5.
    // out-of-range value is an error, not a silent 3.
    assert.deepEqual(validateShard(shardFor('jc_25_p1')), []);
    assert.ok(validateShard(shardFor('jc_25_p1', {}, { difficulty: null }))
      .some((e) => /difficulty must be an integer 1-5/.test(e)));
    assert.ok(validateShard(shardFor('jc_25_p1', {}, { difficulty: 9 }))
      .some((e) => /difficulty must be an integer 1-5/.test(e)));
  });

  test('ACC-CLASS-10 a shard whose header contradicts the registry is rejected', () => {
    const errs = validateShard(shard({ set: 'B' }));
    assert.ok(errs.some((e) => /the registry says/.test(e)), errs.join('; '));
  });
});

describe('classification — difficulty mapping', () => {
});

describe('JZ — the one author who rates his own questions', () => {
  test('ACC-CLASS-04 a JZ shard may not set its own difficulty', () => {
    assert.ok(validateShard(shardFor('jz_a_p1', {}, { difficulty: 3 }))
      .some((e) => /difficulty must not be set/.test(e)),
      'difficulty is computed from JZ\'s rating so that separate passes cannot disagree');
  });

  test('ACC-CLASS-07 JZ\'s 5-9 maps onto the index\'s 1-5 by one fixed rule', () => {
    // Halve and round. JZ excluded all routine material, so its floor of 5 lands at 3 —
    // deliberately, because difficulty drives the backlog's pace budgets.
    assert.deepEqual(
      [5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9].map(difficultyFromJz),
      [3, 3, 3, 3, 4, 4, 4, 4, 5],
    );
    assert.equal(difficultyFromJz(20), 5, 'clamped at the top');
    assert.equal(difficultyFromJz(0.5), 1, 'clamped at the bottom');
    assert.equal(difficultyFromJz(null), 3, 'an unrated question defaults to the middle, not to zero');
  });
});

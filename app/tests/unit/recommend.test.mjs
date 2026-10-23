// ACC-REC-01..05 — what the "what to do next" panel is allowed to suggest.
//
// Three rules, each of which the old version broke:
//   1. A drill is labelled with the topic it was recommended FOR. Index questions carry
//      several tags, and printing the first one meant a question offered under "functions"
//      announced itself as "algebra", which reads as a bug in the recommendation.
//   2. A question he has already sat is not a drill. He has seen the answer, so it tests
//      memory, and anything he got wrong is already in the backlog.
//   3. A drill should not spend a paper he is saving. Pulling a question out of an unsat
//      paper costs him that paper as a future mock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, defaultTutorData } from '../helpers/sandbox.mjs';

/** A tag index with two topics, spread over one sat paper and one untouched paper. */
const INDEX = {
  questions: [
    // TMUA 2018 P2 — "sat", because the fixture record contains a question from it.
    { id: 'TMUA2018P2Q01', exam_family: 'TMUA_P2', year: 2018, part: 'P2 Q1', topic: ['algebra', 'functions'], difficulty: 2, description: 'sat paper, unseen question' },
    { id: 'TMUA2018P2Q02', exam_family: 'TMUA_P2', year: 2018, part: 'P2 Q2', topic: ['functions'], difficulty: 3, description: 'sat paper, also unseen' },
    { id: 'TMUA2018P2Q07', exam_family: 'TMUA_P2', year: 2018, part: 'P2 Q7', topic: ['functions'], difficulty: 1, description: 'sat paper, ALREADY ATTEMPTED' },
    // TMUA 2021 P2 — never touched, and being saved for a full mock.
    { id: 'TMUA2021P2Q01', exam_family: 'TMUA_P2', year: 2021, part: 'P2 Q1', topic: ['functions'], difficulty: 1, description: 'fresh paper, must not be spent' },
    { id: 'TMUA2021P2Q02', exam_family: 'TMUA_P2', year: 2021, part: 'P2 Q2', topic: ['probability'], difficulty: 1, description: 'the only probability question anywhere' },
  ],
};

function fixture() {
  const mem = defaultTutorData();
  mem['memory/session_memory.json'] = {
    ...mem['memory/session_memory.json'],
    topic_stats: {
      functions: { attempted: 10, correct: 5 },     // 50% — weak
      probability: { attempted: 4, correct: 1 },    // 25% — weak
      algebra: { attempted: 10, correct: 10 },      // 100% — not weak
    },
    questions_attempted: [
      { paper: 'TMUA', year: 2018, part: 'P2 Q7', topic: 'functions', correct: false },
    ],
  };
  mem['reference/tmua_full_tag_index.json'] = INDEX;
  mem['reference/mat_full_tag_index.json'] = { questions: [] };
  mem['reference/mock_tag_index.json'] = { questions: [] };
  mem['backlog.json'] = { items: [] };
  return mem;
}

describe('recommendations — what counts as a drill', () => {
  test('ACC-REC-01 only topics below the threshold are recommended, worst first', async () => {
    const sbx = makeSandbox({ tag: 'rec1', tutorData: fixture() });
    const { buildRecommendations } = await sbx.imp('recommend.js');
    const out = buildRecommendations();
    assert.deepEqual(out.recommendations.map((r) => r.topic), ['probability', 'functions']);
    sbx.dispose();
  });

  test('ACC-REC-02 a drill is labelled with the topic it was recommended for', async () => {
    const sbx = makeSandbox({ tag: 'rec2', tutorData: fixture() });
    const { buildRecommendations } = await sbx.imp('recommend.js');
    const functions = buildRecommendations().recommendations.find((r) => r.topic === 'functions');
    for (const d of functions.drill) {
      assert.equal(d.topic, 'functions', `${d.id} was offered under functions but labelled ${d.topic}`);
      assert.ok(Array.isArray(d.topics), 'the full tag list is still carried');
    }
    sbx.dispose();
  });

  test('ACC-REC-03 a question he has already sat is never a drill', async () => {
    const sbx = makeSandbox({ tag: 'rec3', tutorData: fixture() });
    const { buildRecommendations } = await sbx.imp('recommend.js');
    const functions = buildRecommendations().recommendations.find((r) => r.topic === 'functions');
    assert.ok(!functions.drill.some((d) => d.id === 'TMUA2018P2Q07'),
      'the attempted question came back as a drill');
    sbx.dispose();
  });

  test('ACC-REC-04 drills come from papers already sat, leaving fresh papers alone', async () => {
    const sbx = makeSandbox({ tag: 'rec4', tutorData: fixture() });
    const { buildRecommendations } = await sbx.imp('recommend.js');
    const functions = buildRecommendations().recommendations.find((r) => r.topic === 'functions');
    assert.ok(functions.drill.length > 0, 'no drill at all');
    for (const d of functions.drill) {
      assert.ok(d.id.startsWith('TMUA2018'), `${d.id} spends the untouched 2021 paper`);
      assert.equal(d.from_unsat_paper, false);
    }
    sbx.dispose();
  });

  test('ACC-REC-05 when a topic exists only in fresh papers, it is offered and flagged', async () => {
    // Probability lives solely in the untouched 2021 paper. Silence would be worse than a
    // suggestion, but the caller has to be able to see what it costs.
    const sbx = makeSandbox({ tag: 'rec5', tutorData: fixture() });
    const { buildRecommendations } = await sbx.imp('recommend.js');
    const prob = buildRecommendations().recommendations.find((r) => r.topic === 'probability');
    assert.equal(prob.drill.length, 1);
    assert.equal(prob.drill[0].id, 'TMUA2021P2Q02');
    assert.equal(prob.drill[0].from_unsat_paper, true, 'the cost was not flagged');
    sbx.dispose();
  });
});

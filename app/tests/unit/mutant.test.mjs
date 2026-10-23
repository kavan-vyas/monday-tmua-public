// ACC-MUT-01..08 — the rules a mutant paper must never break.
//
// These documents print questions out of papers he may not have sat yet, which is why the
// first one was thrown away and rebuilt ("assume I have done NO james chen papers, redo
// everything"). The selection rule is worth a test because it fails silently: a document
// built from an unsat paper looks perfect and costs him a future mock.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  satPapers, candidates, qidForIndexId, destinations, MUTANT_DIR, WEIGHT,
} from '../../server/mutant.js';
import { parseKey } from '../../scripts/extract-official-answers.mjs';
import { APP_DIR } from '../helpers/sandbox.mjs';

const DATA = path.join(APP_DIR, '..', 'tutor_data');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

dataDescribe('mutant papers — never spoil an unsat paper', () => {
  test('ACC-MUT-01 the sat set is derived from the ledger, not listed', () => {
    const mem = readJson(path.join(DATA, 'memory', 'session_memory.json'));
    const counted = new Map();
    for (const r of mem.questions_attempted ?? []) {
      if (!r.qid) continue;
      const p = String(r.qid).replace(/\s*Q\s*\d+\s*$/, '').trim();
      counted.set(p, (counted.get(p) ?? 0) + 1);
    }
    const expected = [...counted].filter(([, n]) => n >= 20).map(([p]) => p).sort();
    assert.deepEqual([...satPapers()].sort(), expected);
  });

  test('ACC-MUT-02 a part-logged paper does not count as sat', () => {
    // Nineteen rows means the record is incomplete, and an incomplete record is not evidence
    // that he has seen the pages. This is the conservative direction on purpose.
    const mem = readJson(path.join(DATA, 'memory', 'session_memory.json'));
    const counted = new Map();
    for (const r of mem.questions_attempted ?? []) {
      if (!r.qid) continue;
      const p = String(r.qid).replace(/\s*Q\s*\d+\s*$/, '').trim();
      counted.set(p, (counted.get(p) ?? 0) + 1);
    }
    for (const [paper, n] of counted) {
      if (n < 20) assert.ok(!satPapers().has(paper), `${paper} has ${n} rows but counts as sat`);
    }
  });

  test('ACC-MUT-03 no candidate ever comes from an unsat paper', () => {
    const sat = satPapers();
    // Deliberately wide: every topic in the vocabulary at once.
    const all = candidates({
      topics: ['algebra', 'calculus', 'integration', 'trigonometry', 'logarithms', 'geometry',
        'coordinate_geometry', 'graph_sketching', 'sequences_and_series', 'number_theory',
        'functions', 'combinatorics', 'probability', 'logic_and_proof'],
    });
    assert.ok(all.length > 0, 'the widest possible filter returned nothing');
    for (const q of all) {
      assert.ok(sat.has(q.paper), `${q.qid} comes from ${q.paper}, which he has not sat`);
    }
  });

  test('ACC-MUT-04 an empty filter returns nothing rather than everything', () => {
    // "No filters" must not silently mean "the whole index": that is how an unfiltered dump
    // of every question he has ever met would reach a document.
    assert.deepEqual(candidates({}), []);
    assert.deepEqual(candidates({ topics: [], techniques: [], traps: [] }), []);
  });
});

dataDescribe('mutant papers — ordering and identity', () => {
  test('ACC-MUT-05 wrong outranks open outranks shaky outranks noted', () => {
    assert.ok(WEIGHT.wrong > WEIGHT.open);
    assert.ok(WEIGHT.open > WEIGHT.shaky);
    assert.ok(WEIGHT.shaky > WEIGHT.noted);
    assert.ok(WEIGHT.noted > WEIGHT.plain);
    const rows = candidates({ topics: ['logic_and_proof'] });
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].weight >= rows[i].weight, 'candidates came back out of order');
    }
  });

  test('ACC-MUT-06 every index id used in a mutant paper maps to a ledger qid', () => {
    // The two naming schemes are bridged in exactly one place. A collection added to the
    // registry without a branch here would silently vanish from every future document.
    const samples = ['TMUA2018P2Q10', 'TMUAPRACP1Q11', 'JC_25_P1_Q20', 'TYLER_SD_P2_Q13',
      'HER_S2_P1_Q18', 'EUC_S3_P2_Q07', 'EUC_R2D_P1_Q09', 'ROSIE_SA_P1_Q03', 'AF_P1_Q05'];
    for (const id of samples) {
      assert.ok(qidForIndexId(id), `${id} has no ledger qid`);
    }
    // And the mapping must round-trip against the real ledger for the papers he has sat.
    const mem = readJson(path.join(DATA, 'memory', 'session_memory.json'));
    const known = new Set((mem.questions_attempted ?? []).map((r) => r.qid).filter(Boolean));
    const mock = readJson(path.join(DATA, 'reference', 'mock_tag_index.json')).questions ?? [];
    const sat = satPapers();
    for (const q of mock) {
      const qid = qidForIndexId(q.id);
      if (!qid) continue;
      const paper = qid.replace(/\s*Q\s*\d+\s*$/, '').trim();
      if (sat.has(paper)) assert.ok(known.has(qid), `${q.id} maps to "${qid}", which the ledger does not have`);
    }
  });
});

dataDescribe('mutant papers — delivery and answers', () => {
  test('ACC-MUT-07 both destinations, every time', () => {
    const [downloads, collection] = destinations('Example.pdf');
    assert.match(downloads, /Downloads\/Example\.pdf$/, 'the Downloads copy is missing');
    assert.equal(collection, path.join(MUTANT_DIR, 'Example.pdf'));
    assert.ok(fs.existsSync(MUTANT_DIR), 'the mutant papers folder does not exist');
  });

  test('ACC-MUT-08 the official answer keys parsed completely', () => {
    // A document that states the wrong answer is worse than one that states none. Both
    // answer-key layouts must survive: "1 C 1 A" side-by-side, and a bare "PAPER 1" heading
    // followed by a single column, which is the one that silently parsed as zero rows.
    const sideBySide = 'PAPER 1   PAPER 2\nQuestion Key Question Key\n' +
      [...Array(20)].map((_, i) => `   ${i + 1}   C   ${i + 1}   A`).join('\n');
    const single = 'PAPER 1\nQuestion Key\n' + [...Array(20)].map((_, i) => `  ${i + 1}   D`).join('\n');
    assert.equal(parseKey(sideBySide)[1].size, 20);
    assert.equal(parseKey(sideBySide)[2].get(7), 'A');
    assert.equal(parseKey(single)[1].size, 20, 'a bare "PAPER 1" heading did not open a column');

    // And the real files: every official paper he could be shown must have a stored key.
    const dir = path.join(DATA, 'exams', 'answers');
    for (const year of ['2017', '2018', '2019', '2020', '2021', '2022', 'prac', 'spec']) {
      for (const p of [1, 2]) {
        const f = path.join(dir, `tmua_${year}_p${p}.json`);
        assert.ok(fs.existsSync(f), `no stored answer key for tmua_${year}_p${p}`);
        const doc = readJson(f);
        assert.equal(doc.questions.length, 20, `tmua_${year}_p${p}: ${doc.questions.length} answers`);
        for (const q of doc.questions) assert.match(q.answer, /^[A-H]$/, `tmua_${year}_p${p} Q${q.qnum}`);
      }
    }
  });
});

// Needs the private paper collection and study record, which the public repo does not ship.
import { existsSync as __exists } from 'node:fs';
function dataDescribe(...a) {
  const has = __exists(new URL('../../../major exams/tmua/jz', import.meta.url));
  return (has ? describe : describe.skip)(...a);
}

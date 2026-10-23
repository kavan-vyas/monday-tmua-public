// ACC-EUC-01..09 — the Euclid collection, from the files on disk to the tag index.
//
// Euclid arrived as nine papers in one download: four numbered sets of two, plus a one-off
// "R2Drew edition" Paper 1. It is the first collection ingested after the reorganisation
// that gave every collection its own folder and every set a folder inside it, so these
// tests hold that shape as much as they hold Euclid.
//
// The two free sample papers (set "sample", added 2026-10-10) ship with no key at all: their
// answers were solved here and the mark scheme beside them is AI-written, so their answers
// are 'worked_no_key' rather than read off a PDF.
//
// Two things about the R2Drew edition are not mistakes and must not be "fixed":
//   * it ships no mark scheme at all, so its rows carry no correct_answer; and
//   * it has six options per question, whose labels are drawn with a broken font subset
//     and print as R 2 D r E W. They mean A B C D E F.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PAPERS, paperRow, canonicalId as registryCanonical } from '../../server/papers.js';
import { canonicalId, canonicalFromIndexId } from '../../server/canonical.js';
import { locate } from '../../server/pageindex.js';
import { APP_DIR } from '../helpers/sandbox.mjs';

const ROOT = path.join(APP_DIR, '..');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const EUCLID = PAPERS.filter((p) => p.collection === 'euclid');
const isSample = (row) => row.set === 'sample';

dataDescribe('euclid — the papers on disk', () => {
  test('ACC-EUC-01 all eleven papers are registered and every PDF exists', () => {
    assert.equal(EUCLID.length, 11, 'four sets of two, the R2Drew edition, and the two samples');
    for (const row of EUCLID) {
      assert.ok(fs.existsSync(row.qp), `${row.id}: missing question paper ${row.qp}`);
      if (row.ms) assert.ok(fs.existsSync(row.ms), `${row.id}: missing mark scheme ${row.ms}`);
    }
  });

  test('ACC-EUC-02 every paper lives under collection/set, never loose in the collection', () => {
    // The whole point of the reorganisation: a paper's set is a directory, not a substring
    // of its filename. A row that lost its set segment still resolves on disk — the files
    // would simply be in the wrong place — so the path is checked, not just existence.
    for (const row of EUCLID) {
      const rel = path.relative(path.join(ROOT, 'major exams', 'tmua'), row.qp);
      const [collection, set, file] = rel.split(path.sep);
      assert.equal(collection, 'euclid', `${row.id} is not under euclid/`);
      assert.equal(set, row.set === 'r2drew' ? 'r2drew' : `set-${row.set}`,
        `${row.id} sits in "${set}" but the registry says set ${row.set}`);
      assert.ok(file.endsWith('.pdf'), `${row.id} does not point at a PDF`);
    }
  });

  test('ACC-EUC-03 the R2Drew edition is registered with no mark scheme', () => {
    const r2d = paperRow('euc_r2drew_p1');
    assert.ok(r2d, 'the R2Drew edition is not in the registry');
    assert.equal(r2d.ms, null, 'a mark scheme was invented for a paper that has none');
    for (const row of EUCLID) {
      if (row.id !== 'euc_r2drew_p1') assert.ok(row.ms, `${row.id} lost its mark scheme`);
    }
  });
});

dataDescribe('euclid — canonical ids', () => {
  test('ACC-EUC-04 a human reference resolves to the right canonical id', () => {
    assert.equal(canonicalId('TMUA', 'Euclid S1 P1 Q7'), 'EUC-1-P1-Q07');
    assert.equal(canonicalId('TMUA', 'Euclid Set 4 Paper 2 Q20'), 'EUC-4-P2-Q20');
    // Both spellings of the one-off edition: he downloaded it as "r2d2".
    assert.equal(canonicalId('TMUA', 'Euclid R2Drew P1 Q3'), 'EUC-R2D-P1-Q03');
    assert.equal(canonicalId('TMUA', 'euclid r2d2 p1 q12'), 'EUC-R2D-P1-Q12');
    // The samples are their own set, never collapsed onto set 1.
    assert.equal(canonicalId('TMUA', 'Euclid Sample P2 Q9'), 'EUC-SAMPLE-P2-Q09');
  });

  test('ACC-EUC-05 the R2Drew edition is never mistaken for a numbered set', () => {
    // If it collapsed onto a number, twenty questions would share ids with a real set.
    const r2d = canonicalId('TMUA', 'Euclid R2Drew P1 Q05');
    assert.doesNotMatch(r2d, /^EUC-[1-4]-/, 'the R2Drew edition took a numbered set’s ids');
    assert.equal(canonicalFromIndexId('EUC_R2D_P1_Q05'), r2d, 'index id and reference disagree');
  });

  test('ACC-EUC-06 every registry row round-trips id → canonical → row', () => {
    for (const row of EUCLID) {
      for (const q of [1, 20]) {
        const cid = registryCanonical(row, q);
        const back = locate(cid);
        assert.deepEqual(back, { paperId: row.id, qnum: q }, `${cid} located as ${JSON.stringify(back)}`);
      }
    }
  });
});

dataDescribe('euclid — the data the app reads', () => {
  test('ACC-EUC-07 every marked paper has twenty answers, read from the PDF (or worked, for the samples)', () => {
    for (const row of EUCLID) {
      const file = path.join(ROOT, 'tutor_data', 'exams', 'answers', `${row.id}.json`);
      if (!row.ms) { assert.ok(!fs.existsSync(file), `${row.id} has an answer key but no mark scheme`); continue; }
      const doc = readJson(file);
      assert.equal(doc.questions.length, 20, `${row.id}: ${doc.questions.length} answers`);
      const nums = doc.questions.map((q) => q.qnum);
      assert.deepEqual(nums, [...Array(20)].map((_, i) => i + 1), `${row.id}: answers out of order`);
      for (const q of doc.questions) {
        assert.match(q.answer, /^[A-H]$/, `${row.id} Q${q.qnum}: answer ${q.answer}`);
        if (isSample(row)) assert.equal(q.verification, 'worked_no_key', `${row.id} Q${q.qnum}: the samples have no published key`);
        else assert.equal(q.confidence, 'read_from_pdf',
          `${row.id} Q${q.qnum} was inferred; the Euclid scheme prints the option letter outright`);
      }
    }
  });

  test('ACC-EUC-08 every question is classified, and the answer agrees with the key', () => {
    const index = readJson(path.join(ROOT, 'tutor_data', 'reference', 'mock_tag_index.json'));
    const euclid = index.questions.filter((q) => String(q.id).startsWith('EUC_'));
    assert.equal(euclid.length, 220, `${euclid.length} Euclid questions in the mock index`);

    for (const row of EUCLID) {
      const mine = euclid.filter((q) => q.id.startsWith(`${row.idPrefix}_`));
      assert.equal(mine.length, 20, `${row.id}: ${mine.length} classified`);
      const key = row.ms
        ? readJson(path.join(ROOT, 'tutor_data', 'exams', 'answers', `${row.id}.json`))
        : null;
      for (const q of mine) {
        assert.ok(q.difficulty >= 1 && q.difficulty <= 5, `${q.id}: difficulty ${q.difficulty}`);
        assert.ok(q.topic?.length, `${q.id}: no topic`);
        assert.ok(q.options_count >= 4 && q.options_count <= 8, `${q.id}: ${q.options_count} options`);
        if (key) {
          assert.equal(q.correct_answer, key.questions.find((k) => k.qnum === q.qnum).answer,
            `${q.id}: classification and mark scheme disagree`);
        } else {
          assert.equal(q.correct_answer, null, `${q.id}: an answer was invented for an unmarked paper`);
          assert.equal(q.verification_status, 'inferred_no_solution', `${q.id}: ${q.verification_status}`);
          assert.equal(q.options_count, 6, `${q.id}: the R2Drew edition has six options, not ${q.options_count}`);
        }
      }
    }
  });

  test('ACC-EUC-09 every question has a page, for the paper and for the scheme', () => {
    for (const row of EUCLID) {
      const idx = readJson(path.join(ROOT, 'tutor_data', 'exams', 'pageindex', `${row.id}.json`));
      for (let q = 1; q <= 20; q++) {
        assert.ok(idx.qp?.[q] > 0, `${row.id} Q${q}: no question-paper page`);
        if (row.ms) assert.ok(idx.ms?.[q] > 0, `${row.id} Q${q}: no mark-scheme page`);
      }
      // Pages must not go backwards: a question later in the paper cannot start earlier.
      const pages = [...Array(20)].map((_, i) => idx.qp[i + 1]);
      for (let i = 1; i < pages.length; i++) {
        assert.ok(pages[i] >= pages[i - 1], `${row.id}: Q${i + 1} on page ${pages[i]}, after Q${i} on ${pages[i - 1]}`);
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

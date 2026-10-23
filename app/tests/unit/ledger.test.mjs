// ACC-LED-01..06 — the question ledger has to add up.
//
// The ledger drifted quietly for months: it claimed 496 attempts against 382 stored rows
// because the same paper had been logged under two id schemes, one paper had been deleted
// from the tracker but not from the ledger, and two papers only ever had their interesting
// questions recorded. None of that was visible from any screen — the totals were stored
// numbers, not derived ones. These tests derive them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalId } from '../../server/canonical.js';
import { locate } from '../../server/pageindex.js';
import { paperRow } from '../../server/papers.js';
import { APP_DIR } from '../helpers/sandbox.mjs';

const DATA = path.join(APP_DIR, '..', 'tutor_data');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const mem = readJson(path.join(DATA, 'memory', 'session_memory.json'));
const rows = mem.questions_attempted ?? [];

/** "Tyler SD P2 Q13" → "Tyler SD P2". */
const paperOf = (qid) => String(qid).replace(/\s*Q\s*\d+\s*$/, '').trim();

dataDescribe('ledger — the stored totals are the rows', () => {
  test('ACC-LED-01 the headline counters match a recount', () => {
    const correct = rows.filter((r) => r.correct === true).length;
    assert.equal(mem.total_questions_attempted, rows.length,
      `stored total ${mem.total_questions_attempted} against ${rows.length} rows`);
    assert.equal(mem.total_correct, correct);
    assert.equal(mem.overall_accuracy, Math.round((correct / rows.length) * 1000) / 10);
  });

  test('ACC-LED-02 topic_stats is a partition of the rows, not a parallel tally', () => {
    // It used to be its own counter, drifting 84 attempts above the rows it described.
    const attempted = Object.values(mem.topic_stats ?? {}).reduce((n, t) => n + t.attempted, 0);
    const withTopic = rows.filter((r) => r.topic).length;
    assert.equal(attempted, withTopic, 'topic_stats counts questions the ledger does not hold');
    for (const [topic, t] of Object.entries(mem.topic_stats ?? {})) {
      const mine = rows.filter((r) => r.topic === topic);
      assert.equal(t.attempted, mine.length, `${topic}: attempted`);
      assert.equal(t.correct, mine.filter((r) => r.correct === true).length, `${topic}: correct`);
    }
  });
});

dataDescribe('ledger — one row per question, one scheme per paper', () => {
  test('ACC-LED-03 no question id appears twice', () => {
    const seen = new Map();
    for (const r of rows) {
      if (!r.qid) continue;
      seen.set(r.qid, (seen.get(r.qid) ?? 0) + 1);
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
    assert.deepEqual(dupes, [], `${dupes.length} question id(s) logged more than once`);
  });

  test('ACC-LED-04 a paper logged by qid is not also logged by year and part', () => {
    // The exact failure: "2017 P1 Q3" (qid) and paper TMUA / year 2017 / part "P1 Q3"
    // are the same question, counted twice, and no screen could show it.
    const byQid = new Set([...new Set(rows.filter((r) => r.qid).map((r) => paperOf(r.qid)))]
      .filter((p) => /^\d{4} P[12]$/.test(p)));
    const clashes = rows
      .filter((r) => !r.qid && r.paper === 'TMUA' && r.year != null && r.part)
      .map((r) => `${r.year} ${String(r.part).split(' ')[0]}`)
      .filter((p) => byQid.has(p));
    assert.deepEqual([...new Set(clashes)], [],
      'a paper is logged under both the qid scheme and the year/part scheme');
  });

  test('ACC-LED-05 a paper he has sat is logged complete, all twenty questions', () => {
    // A part-logged paper reads as a low score everywhere it is counted. Either the paper
    // was sat and all twenty are known, or it was not sat and none should be here.
    const byPaper = new Map();
    for (const r of rows) {
      if (!r.qid) continue;
      const p = paperOf(r.qid);
      byPaper.set(p, (byPaper.get(p) ?? 0) + 1);
    }
    const partial = [...byPaper].filter(([, n]) => n !== 20);
    assert.deepEqual(partial, [], `part-logged paper(s): ${partial.map(([p, n]) => `${p} (${n}/20)`).join(', ')}`);
  });
});

dataDescribe('ledger — every backlog row points at a real question', () => {
  test('ACC-LED-06 each item resolves to a paper the app can open', () => {
    const items = readJson(path.join(DATA, 'backlog.json')).items ?? [];
    const broken = [];
    for (const it of items) {
      if (it.exam === 'MAT' || it.exam === 'STEP') continue;   // lettered, resolved by search
      const loc = locate(canonicalId(it.exam ?? 'TMUA', String(it.ref)));
      if (!loc) { broken.push(`${it.ref} → no paper`); continue; }
      // Registry papers must have their PDF; official papers are resolved via the manifest.
      const row = paperRow(loc.paperId);
      if (row && !fs.existsSync(row.qp)) broken.push(`${it.ref} → missing ${row.qp}`);
      if (!(loc.qnum >= 1 && loc.qnum <= 20)) broken.push(`${it.ref} → question ${loc.qnum}`);
    }
    assert.deepEqual(broken, [], `${broken.length} backlog row(s) resolve to nothing`);
  });
});

// Needs the private paper collection and study record, which the public repo does not ship.
import { existsSync as __exists } from 'node:fs';
function dataDescribe(...a) {
  const has = __exists(new URL('../../../major exams/tmua/jz', import.meta.url));
  return (has ? describe : describe.skip)(...a);
}

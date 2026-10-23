// ACC-BLP-01..08 — backlog papers: the retry papers built out of what he still owes.
//
// The failure modes are quieter than a mutant paper's. A short paper still looks like a
// paper. A paper sorted by topic still looks shuffled at a glance. A mark scheme cropped one
// line too low still looks right until he reads the next question's opening line on it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  pool, select, shuffle, matches, priority, sliceFor, findPage, LOGIC, BACKLOG_PAPER_DIR,
} from '../../server/backlogpaper.js';
import { satPapers } from '../../server/mutant.js';
import { APP_DIR } from '../helpers/sandbox.mjs';

const DATA = path.join(APP_DIR, '..', 'tutor_data');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const LOGIC_FILTER = { topics: LOGIC.topics, types: LOGIC.types, techniques: LOGIC.techniques, traps: LOGIC.traps };

dataDescribe('backlog papers — what goes in', () => {
  test('ACC-BLP-01 the pool is open backlog items that resolve to a real page', () => {
    const rows = pool();
    assert.ok(rows.length > 20, `pool is only ${rows.length}`);
    for (const r of rows) {
      assert.equal(r.status, 'open', `${r.ref} is ${r.status}`);
      assert.ok(fs.existsSync(r.qp), `${r.ref}: question paper missing — ${r.qp}`);
      assert.ok(r.qp_page > 0, `${r.ref}: no question-paper page`);
      if (r.ms) assert.ok(fs.existsSync(r.ms), `${r.ref}: mark scheme missing — ${r.ms}`);
    }
  });

  test('ACC-BLP-02 a retry paper never shows a paper he has not sat', () => {
    // Same rule as a mutant paper, and it matters more here: this one he sits, so an unsat
    // paper would be spent AND spoiled in the same sitting.
    const sat = satPapers();
    for (const r of pool()) {
      if (r.kind !== 'tmua') continue;
      const paper = String(r.ref).replace(/\s*Q\s*\d+\s*$/, '').trim();
      assert.ok(sat.has(paper), `${r.ref} comes from ${paper}, which he has not sat`);
    }
  });

  test('ACC-BLP-03 size is a floor: a narrow filter is topped up, a wide one is not truncated', () => {
    const rows = pool();
    // A filter that matches almost nothing still yields a full paper.
    const narrow = select(rows, { topics: ['probability'], types: [], techniques: [], traps: [] }, { size: 20 });
    assert.equal(narrow.length, 20, `narrow filter gave ${narrow.length}`);
    // A filter that matches more than the floor keeps all of them. The filter is
    // built from whatever the backlog actually holds rather than named outright:
    // the first version asked for logic + MAT and asserted it exceeded twenty,
    // which stopped being true the day he closed the logic arm of the backlog
    // off a backlog paper. A test that fails because he did the work is a bad
    // test — what must hold is that a wide filter is never truncated.
    const everyTopic = [...new Set(rows.map((r) => r.topic).filter(Boolean))];
    const wideFilter = { topics: everyTopic, types: [], techniques: [], traps: [] };
    const matched = rows.filter((r) => matches(r, wideFilter)).length;
    assert.ok(matched > 20, `the whole backlog is only ${matched} — nothing can be "wide"`);
    const wide = select(rows, wideFilter, { size: 20 });
    assert.equal(wide.length, matched, 'a wide filter was truncated to the floor');
  });

  test('ACC-BLP-04 --include-exam pulls in every open item for that exam', () => {
    const rows = pool();
    const picked = select(rows, LOGIC_FILTER, { size: 20, includeAll: ['MAT'] });
    const wantedMat = rows.filter((r) => r.exam === 'MAT').map((r) => r.ref).sort();
    const gotMat = picked.filter((r) => r.exam === 'MAT').map((r) => r.ref).sort();
    assert.deepEqual(gotMat, wantedMat, 'some MAT items were left out');
  });

  test('ACC-BLP-05 the top-up is ordered by priority, not by chance', () => {
    const rows = pool();
    const picked = select(rows, { topics: ['probability'], types: [], techniques: [], traps: [] }, { size: 20 });
    const filler = picked.filter((r) => !matches(r, { topics: ['probability'], types: [], techniques: [], traps: [] }));
    for (let i = 1; i < filler.length; i++) {
      assert.ok(priority(filler[i - 1]) >= priority(filler[i]), 'the top-up came back out of priority order');
    }
    // Never reworked has to outrank an item he has already had another go at.
    const fresh = { due: '2026-01-01', history: [], bucket: 'didnt_know', tier: 1, insight: { difficulty: 3 } };
    const done = { ...fresh, history: [{ result: 'pass' }] };
    assert.ok(priority(fresh) > priority(done));
  });
});

dataDescribe('backlog papers — order and cropping', () => {
  test('ACC-BLP-06 the paper is scattered, and the same seed rebuilds it', () => {
    const rows = select(pool(), LOGIC_FILTER, { size: 20, includeAll: ['MAT'] });
    const a = shuffle(rows, 20260921).map((r) => r.ref);
    const b = shuffle(rows, 20260921).map((r) => r.ref);
    assert.deepEqual(a, b, 'the same seed gave a different paper');
    assert.notDeepEqual(a, shuffle(rows, 7).map((r) => r.ref), 'the seed changed nothing');
    assert.notDeepEqual(a, rows.map((r) => r.ref), 'the paper came out in selection order');
    // Not grouped: consecutive runs from one source would hand him the topic for free.
    const source = a.map((ref) => String(ref).replace(/\s*Q\s*\d+\s*$/, '').trim());
    let longest = 1, run = 1;
    for (let i = 1; i < source.length; i++) {
      run = source[i] === source[i - 1] ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    assert.ok(longest <= 3, `${longest} questions in a row came from the same paper`);
  });

  test('ACC-BLP-07 a crop cuts above the next question, never below it', () => {
    // The bug this replaced: padding downwards leaked the next question's first line onto
    // the page — untidy, and a small spoiler for a question further down the same paper.
    const man = readJson(path.join(DATA, 'file_manifest.json'));
    const mat = man.mat?.['2013']?.paper;
    if (!mat || !fs.existsSync(mat)) return;
    const page = findPage(mat, /^G\./, 2, 12);
    assert.ok(page, 'MAT 2013 part G was not found in the paper');
    const slice = sliceFor(mat, page, /^G\./, /^[A-J]\./);
    assert.ok(slice, 'a multi-part page returned no crop');
    const [top, bottom] = slice;
    assert.ok(top >= 0 && bottom <= 1 && bottom > top, `nonsense crop ${slice}`);
    assert.ok(bottom - top < 0.94, 'the crop is the whole page, so it did not find the next part');
  });

  test('ACC-BLP-08 a question that owns its page is not cropped', () => {
    // TMUA prints one per page. Cropping there can only lose something.
    const man = readJson(path.join(DATA, 'file_manifest.json'));
    const p2 = man.tmua?.['2020']?.p2;
    if (!p2 || !fs.existsSync(p2)) return;
    const idx = readJson(path.join(DATA, 'exams', 'pageindex', 'tmua_2020_p2.json'));
    const page = idx.qp['19'];
    assert.equal(sliceFor(p2, page, /^19[.\s]/, /^20[.\s]/), null,
      'a single-question page came back with a crop');
  });
});

dataDescribe('backlog papers — delivery', () => {
  test('ACC-BLP-09 the folder exists and holds paper and answers together', () => {
    assert.ok(fs.existsSync(BACKLOG_PAPER_DIR), 'the backlog paper folder does not exist');
    const files = fs.readdirSync(BACKLOG_PAPER_DIR).filter((f) => f.endsWith('.pdf'));
    const papers = files.filter((f) => !/ Answers\.pdf$/.test(f));
    for (const p of papers) {
      const answers = p.replace(/\.pdf$/, ' Answers.pdf');
      assert.ok(files.includes(answers), `${p} shipped without its mark scheme`);
    }
  });
});

dataDescribe('backlog papers — scattering does not rely on luck', () => {
  test('ACC-BLP-10 a backlog heavy in one paper still never deals a long run from it', () => {
    // ACC-BLP-06 only ever passed because the live backlog happened to shuffle well.
    // The day eight Heracles S1 P2 questions were logged it dealt four in a row.
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => ({ ref: `Heracles S1 P2 Q${i + 1}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ ref: `Euclid S1 P2 Q${i + 1}` })),
    ];
    for (let seed = 1; seed <= 200; seed++) {
      const src = shuffle(rows, seed).map((r) => r.ref.replace(/ Q\d+$/, ''));
      let run = 1, longest = 1;
      for (let i = 1; i < src.length; i++) { run = src[i] === src[i - 1] ? run + 1 : 1; longest = Math.max(longest, run); }
      assert.ok(longest <= 3, `seed ${seed} dealt ${longest} in a row`);
      assert.equal(src.length, rows.length, 'the shuffle lost a question');
    }
  });
});

// Needs the private paper collection and study record, which the public repo does not ship.
import { existsSync as __exists } from 'node:fs';
function dataDescribe(...a) {
  const has = __exists(new URL('../../../major exams/tmua/jz', import.meta.url));
  return (has ? describe : describe.skip)(...a);
}

// ACC-BKF-01..07 — the backlog's filter bar.
//
// The bar used to be eighteen toggle buttons in four groups, wrapping onto three lines, and
// it could only ask two questions: which exam, and which slice. It is now eight menus, and
// the ones that are new — source, topic, reason, stage, notes — all depend on classifying a
// row correctly, which is what these tests hold in place.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '../helpers/sandbox.mjs';
import { SOURCES, sourceOf } from '../../web/src/monday/sources.js';

const APP_JSX = fs.readFileSync(path.join(APP_DIR, 'web', 'src', 'App.jsx'), 'utf8');

describe('backlog filters — classifying where a question came from', () => {
  test('ACC-BKF-01 the canonical id decides the collection', () => {
    const cases = [
      ['TMUA-2018-P2-Q10', 'tmua', true],
      ['TMUA-PRAC-P1-Q11', 'tmua', true],
      ['MAT-2017-H', 'mat', true],
      ['HER-1-P1-Q07', 'heracles', false],
      ['TYLER-D-P2-Q09', 'tyler', false],
      ['JC-25-P1-Q11', 'chen', false],
      ['ROSIE-A-P1-Q02', 'rosie', false],
      ['AF-P1-Q05', 'af', false],
    ];
    for (const [cid, key, official] of cases) {
      const got = sourceOf({ cid, ref: 'irrelevant text' });
      assert.equal(got.key, key, `${cid} classified as ${got.key}`);
      assert.equal(got.official, official, `${cid} official flag`);
    }
  });

  test('ACC-BKF-02 a row with no canonical id falls back to its reference', () => {
    assert.equal(sourceOf({ ref: 'Heracles S1 P1 Q7' }).key, 'heracles');
    assert.equal(sourceOf({ ref: 'Hercules S2 P1 Q12' }).key, 'heracles');
    assert.equal(sourceOf({ ref: 'Tyler SD P2 Q9' }).key, 'tyler');
    assert.equal(sourceOf({ ref: '2018 P1 Q16' }).key, 'tmua');
    assert.equal(sourceOf({ ref: 'Chen Q11' }).key, 'chen');
  });

  test('ACC-BKF-03 official and mock are a clean partition of the known sources', () => {
    for (const s of SOURCES) assert.equal(typeof s.official, 'boolean', `${s.key} has no official flag`);
    const official = SOURCES.filter((s) => s.official).map((s) => s.key).sort();
    assert.deepEqual(official, ['mat', 'step', 'tmua'],
      'only the real exam boards count as official');
  });

  test('ACC-BKF-04 an unrecognisable row is "other", not silently mis-filed', () => {
    const got = sourceOf({ ref: 'something from a book' });
    assert.equal(got.key, 'other');
    assert.equal(got.official, false);
  });

  test('ACC-BKF-05 the real backlog classifies completely', () => {
    // Every row must land somewhere real: an "other" row would sit in no source filter and
    // be invisible to anyone browsing by collection.
    const file = path.join(APP_DIR, '..', 'tutor_data', 'backlog.json');
    if (!fs.existsSync(file)) return;
    const items = JSON.parse(fs.readFileSync(file, 'utf8')).items ?? [];
    const orphans = items.filter((i) => sourceOf(i).key === 'other');
    assert.deepEqual(orphans.map((i) => i.ref), [],
      `${orphans.length} backlog row(s) match no known collection`);
  });
});

describe('backlog filters — the bar itself', () => {
  test('ACC-BKF-06 every filter dimension is a menu', () => {
    for (const label of ['Show', 'Exam', 'Source', 'Topic', 'Reason', 'Stage', 'Notes', 'Sort']) {
      assert.match(APP_JSX, new RegExp(`<Picker label="${label}"`),
        `the ${label} filter is not a Picker`);
    }
  });

  test('ACC-BKF-07 the old toggle rows are gone', () => {
    // The specific pattern that made the bar unreadable: an array of [value, label] pairs
    // mapped straight into buttons, one per possible value.
    assert.doesNotMatch(APP_JSX, /\[\['due', 'Due'\]/, 'the scope toggle row survived');
    assert.doesNotMatch(APP_JSX, /\[\['ALL', 'All'\], \['TMUA'/, 'the exam toggle row survived');
    assert.doesNotMatch(APP_JSX, /notesOnly/, 'the old notes toggle state survived');
  });
});

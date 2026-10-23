// ACC-TREE-01..05 — the shape of the TMUA collection on disk.
//
// The rule is one line long: **one folder per collection, one folder per set inside it.**
// It is worth a test because it is the kind of rule that decays silently — a paper dropped
// loose in the collection folder still opens, so nothing complains until someone tries to
// tell from a path which set a question came from. These tests fail the moment the tree
// stops matching the registry, or the README stops matching the tree.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PAPERS } from '../../server/papers.js';
import { APP_DIR } from '../helpers/sandbox.mjs';

const TMUA = path.join(APP_DIR, '..', 'major exams', 'tmua');
const README = path.join(TMUA, 'README.md');

/** Directories directly under a path, ignoring dotfiles. */
const dirsIn = (p) => (fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort() : []);
const filesIn = (p) => fs.readdirSync(p, { withFileTypes: true })
  .filter((d) => d.isFile() && !d.name.startsWith('.')).map((d) => d.name).sort();

/** The mock collections, read off the registry rather than listed here. */
const COLLECTIONS = [...new Set(PAPERS.map((p) => p.collection))];
/** Folder name per collection, where it differs from the registry key. */
const FOLDER = { af: 'asher-falcon', djs: 'daniel-j-smith' };
const folderFor = (key) => FOLDER[key] ?? key;

dataDescribe('file tree — one folder per collection, one folder per set', () => {
  test('ACC-TREE-01 every registry collection has a folder of its own', () => {
    for (const key of COLLECTIONS) {
      const dir = path.join(TMUA, folderFor(key));
      assert.ok(fs.existsSync(dir), `collection "${key}" has no folder at ${dir}`);
    }
  });

  test('ACC-TREE-02 no paper sits loose in a collection folder', () => {
    // Every PDF must be one level deeper, inside a set folder. A loose file here is the
    // exact failure the reorganisation removed.
    for (const key of COLLECTIONS) {
      const dir = path.join(TMUA, folderFor(key));
      const loose = filesIn(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
      assert.deepEqual(loose, [], `${folderFor(key)}/ holds ${loose.length} loose PDF(s): ${loose.join(', ')}`);
    }
  });

  test('ACC-TREE-03 every set folder is a set the registry knows about', () => {
    // Both directions: a folder with no registry row is an orphan nobody can open, and a
    // registry row with no folder is a broken path.
    for (const key of COLLECTIONS) {
      const rows = PAPERS.filter((p) => p.collection === key);
      const expected = [...new Set(rows.map((r) => path.basename(path.dirname(r.qp))))].sort();
      assert.deepEqual(dirsIn(path.join(TMUA, folderFor(key))), expected,
        `${folderFor(key)}/ set folders disagree with the registry`);
    }
  });

  test('ACC-TREE-04 a set folder holds only its own papers', () => {
    for (const row of PAPERS) {
      const dir = path.dirname(row.qp);
      const pdfs = filesIn(dir).filter((f) => f.toLowerCase().endsWith('.pdf'));
      for (const f of pdfs) {
        assert.ok(PAPERS.some((p) => p.qp.endsWith(f) || p.ms?.endsWith(f)),
          `${path.relative(TMUA, dir)}/${f} belongs to no registry row`);
      }
    }
  });

  test('ACC-TREE-05 the README still draws the tree that is actually there', () => {
    // The README is the human answer to "where is what". A collection that appears on disk
    // and not in the README is the documentation quietly going stale.
    const readme = fs.readFileSync(README, 'utf8');
    for (const key of COLLECTIONS) {
      assert.match(readme, new RegExp(`\\b${folderFor(key)}/`),
        `the README never mentions ${folderFor(key)}/`);
    }
    for (const dir of ['practice/', 'specimen/', 'misc/', 'mutant papers/']) {
      assert.ok(readme.includes(dir), `the README never mentions ${dir}`);
    }
    // The tree block itself, so the file cannot lose the picture and keep the prose.
    assert.match(readme, /```\n?major exams\/tmua\//, 'the README has no file-tree diagram');
  });
});

// Needs the private paper collection and study record, which the public repo does not ship.
import { existsSync as __exists } from 'node:fs';
function dataDescribe(...a) {
  const has = __exists(new URL('../../../major exams/tmua/jz', import.meta.url));
  return (has ? describe : describe.skip)(...a);
}

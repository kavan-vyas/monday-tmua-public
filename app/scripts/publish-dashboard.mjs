// Rebuild the prep tracker and publish it. One command, because the reason the board
// silently went three weeks out of date was that there was no command at all:
// buildDashboard() only ran inside a live Monday session (session.js, every couple of
// turns), and nothing ever committed or pushed the result. Work done in any other tool
// left the published board frozen with no signal that it had stopped moving.
//
// Deliberately manual. The board is a record of his own work and pushing is outward
// facing, so this runs when he asks for it, not on a timer.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from '../server/dashboard.js';

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tutor_data', 'dashboard-site');
const git = (...args) => execFileSync('git', args, { cwd: SITE, encoding: 'utf8' }).trim();

const built = buildDashboard();
console.log(`rebuilt — ${built.questions} questions across ${built.topics} topics`);

const dirty = git('status', '--porcelain', 'data');
if (!dirty) {
  console.log('data/ is already current — nothing to publish.');
  process.exit(0);
}
console.log(dirty);

// --dry-run stops here, so the numbers can be checked before anything leaves the machine.
if (process.argv.includes('--dry-run')) {
  console.log('\ndry run — not committed, not pushed.');
  process.exit(0);
}

git('add', 'data');
git('commit', '-m', `dashboard update: ${new Date().toISOString().slice(0, 10)}`);
git('push', 'origin', 'HEAD');
console.log(`\npublished ${git('rev-parse', '--short', 'HEAD')} → ${git('rev-parse', '--abbrev-ref', 'HEAD')}`);
